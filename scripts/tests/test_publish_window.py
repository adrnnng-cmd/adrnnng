#!/usr/bin/env python3
"""Fixture path through the patched host scripts. No live /workspace/digest writes."""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PKG = ROOT / "host-window"
BASELINE = {
    "publish.sh": "fbc85d30fb90c14ab262d0aa40918617b45df6547616639cfc138e6fe51da6bb",
    "check_sections.sh": "293523484f92c3f0267c21b174f0c9efb27383ff91475bce5e486e8c4ddb4820",
    "tools/latest_json.py": "aba56c7d5d54587173492d970fe9c7486f421ef438df35d6f71789e8d0d6a338",
    "tools/og_images.py": "1758cf46369e84294938f25ea6c4574806525cfff5dd62da30a5dd0e9baac510",
    "tools/validate_wrap_urls.py": "3feba95fa1a26a9fe557c6671d09ed969d3df7f721d2a2d0356fe121e9b674b1",
}
DATE = "2026-11-25"
STORY = "https://www.bloomberg.com/news/articles/example"
GIT_ENV = {
    "GIT_AUTHOR_NAME": "window-test",
    "GIT_AUTHOR_EMAIL": "window-test@example.com",
    "GIT_COMMITTER_NAME": "window-test",
    "GIT_COMMITTER_EMAIL": "window-test@example.com",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(cmd, env=None, check=True):
    merged = os.environ.copy()
    merged.update(GIT_ENV)
    if env:
        merged.update(env)
    return subprocess.run(cmd, text=True, capture_output=True, env=merged, check=check)


class PublishWindowTest(unittest.TestCase):
    def setUp(self):
        self.assertFalse(Path("/workspace/digest").exists())
        self.tmp = Path(tempfile.mkdtemp(prefix="publish-window-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))

    def tearDown(self):
        self.assertFalse(Path("/workspace/digest").exists())

    def test_baseline_bytes_are_the_snapshot(self):
        for rel, digest in BASELINE.items():
            self.assertEqual(sha256(PKG / "baseline" / rel), digest, rel)
        patched = (PKG / "patched" / "publish.sh").read_text()
        self.assertIn('|| echo "WARN: latest.json failed (news still deploys)"', patched)
        self.assertIn("ERROR: wrap URL evidence gate failed", patched)
        self.assertIn("FAIL-CLOSED: sections-src is", patched)
        self.assertIn("BUTTONDOWN_SKIP", patched)
        self.assertNotIn("ADRRR_DIGEST_DIR/$PREFIX/latest.json", patched)
        deploy = patched.split("set +e", 1)[1].split("CF_RC=$?", 1)[0]
        self.assertNotIn("|| true", deploy)

    def test_default_latest_json_ignores_frozen_root_and_frozen_does_not_refresh(self):
        host = self.tmp / "host"
        frozen = self.tmp / "frozen"
        self._data_tree(host)
        self._data_tree(frozen)
        (host / "data" / f"{DATE}.json").write_text(self._story("host headline"))
        (frozen / "data" / f"{DATE}.json").write_text(self._story("frozen headline"))
        host_before = (host / "data" / f"{DATE}.json").stat().st_mtime_ns
        env = {"ADRRR_HOST_ROOT": str(host), "ADRRR_FROZEN_ROOT": str(frozen)}
        normal = run(
            ["python3", str(PKG / "patched/tools/latest_json.py"), DATE, str(self.tmp / "normal.json"), "--refresh"],
            env=env, check=False,
        )
        self.assertEqual(normal.returncode, 0, normal.stderr)
        written = json.loads((self.tmp / "normal.json").read_text())
        self.assertEqual(written["headline"], "host headline")
        self.assertNotEqual((host / "data" / f"{DATE}.json").stat().st_mtime_ns, host_before)
        frozen_before = sha256(frozen / "data" / f"{DATE}.json")
        frozen_mtime = (frozen / "data" / f"{DATE}.json").stat().st_mtime_ns
        wrapper = self.tmp / "frozen_run.py"
        wrapper.write_text(textwrap.dedent(f"""
            import os, runpy, sys, urllib.request
            def boom(*args, **kwargs):
                raise SystemExit(86)
            urllib.request.urlopen = boom
            os.environ["ADRRR_PUBLISH_MODE"] = "frozen"
            os.environ["ADRRR_FROZEN_ROOT"] = sys.argv[1]
            os.environ["ADRRR_HOST_ROOT"] = sys.argv[2]
            script = sys.argv[5]
            sys.argv = ["latest_json.py", sys.argv[3], sys.argv[4], "--refresh"]
            runpy.run_path(script, run_name="__main__")
        """))
        out = frozen / "out" / "latest.json"
        froze = run(["python3", str(wrapper), str(frozen), str(host), DATE, str(out), str(PKG / "patched/tools/latest_json.py")], check=False)
        self.assertEqual(froze.returncode, 0, froze.stderr)
        self.assertEqual(json.loads(out.read_text())["headline"], "frozen headline")
        self.assertEqual(sha256(frozen / "data" / f"{DATE}.json"), frozen_before)
        self.assertEqual((frozen / "data" / f"{DATE}.json").stat().st_mtime_ns, frozen_mtime)
        self.assertFalse((frozen / "cache").exists())
        refused = run(
            ["python3", str(wrapper), str(host), str(host), DATE, str(host / "latest.json"), str(PKG / "patched/tools/latest_json.py")],
            check=False,
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertFalse((host / "latest.json").exists())

    def test_soft_hero_default_attempts_network(self):
        host = self.tmp / "soft"
        self._data_tree(host)
        payload = json.loads(self._story("soft"))
        payload["og_images"][STORY]["hires"] = False
        payload["og_images"][STORY]["size"] = [1200]
        (host / "data" / f"{DATE}.json").write_text(json.dumps(payload))
        wrapper = self.tmp / "soft_run.py"
        wrapper.write_text(textwrap.dedent("""
            import os, sys, urllib.request
            calls = []
            def boom(req, timeout=20):
                calls.append(getattr(req, "full_url", str(req)))
                raise OSError("blocked")
            urllib.request.urlopen = boom
            os.environ["ADRRR_HOST_ROOT"] = sys.argv[1]
            os.environ.pop("ADRRR_PUBLISH_MODE", None)
            sys.path.insert(0, sys.argv[2])
            import og_images as og
            d = __import__("json").loads(open(sys.argv[3]).read())
            e = og.get(d, sys.argv[4], False)
            assert calls, "no network"
            assert e.get("method") == "none"
            assert not __import__("os").path.exists("/workspace/digest")
            print(len(calls))
        """))
        result = run([
            "python3", str(wrapper), str(host), str(PKG / "patched/tools"),
            str(host / "data" / f"{DATE}.json"), STORY,
        ], check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreater(int(result.stdout.strip()), 0)

    def test_install_rollback_lock_and_baseline_drift(self):
        host = self._host()
        self.assertNotEqual(run([str(PKG / "install.sh"), "/workspace/digest"], check=False).returncode, 0)
        self.assertFalse(Path("/workspace/digest").exists())
        bad = self._host()
        target = bad / "publish.sh"
        target.write_bytes(target.read_bytes() + b"\n# drifted\n")
        drifted = run([str(PKG / "install.sh"), str(bad)], env={"ADRRR_LOCK_WAIT": "1"}, check=False)
        self.assertNotEqual(drifted.returncode, 0, drifted.stderr)
        self.assertIn("not the snapshot baseline", drifted.stderr)
        self.assertTrue(target.read_text().endswith("# drifted\n"))
        installed = run([str(PKG / "install.sh"), str(host)], check=False)
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(sha256(host / "publish.sh"), sha256(PKG / "patched/publish.sh"))
        again = run([str(PKG / "install.sh"), str(host)], check=False)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("already patched", again.stdout)
        holder = subprocess.Popen(["flock", str(host / ".publish.lock"), "sleep", "30"])
        self.addCleanup(lambda: holder.kill())
        busy = run([str(PKG / "install.sh"), str(host)], env={"ADRRR_LOCK_WAIT": "1"}, check=False)
        holder.kill()
        holder.wait(timeout=5)
        self.assertNotEqual(busy.returncode, 0)
        self.assertIn("publish lock busy", busy.stderr)
        host2 = self._host()
        self.assertEqual(run([str(PKG / "install.sh"), str(host2)], check=False).returncode, 0)
        (host2 / "publish.sh").write_bytes((host2 / "publish.sh").read_bytes() + b"\n# after\n")
        refused = run([str(PKG / "rollback.sh"), str(host2)], check=False)
        self.assertNotEqual(refused.returncode, 0, refused.stderr)
        self.assertIn("changed after install", refused.stderr)
        host3 = self._host()
        self.assertEqual(run([str(PKG / "install.sh"), str(host3)], check=False).returncode, 0)
        self.assertEqual(run([str(PKG / "rollback.sh"), str(host3)], check=False).returncode, 0)
        self.assertEqual(sha256(host3 / "publish.sh"), BASELINE["publish.sh"])
        self.assertFalse((host3 / "tools/publish_window.py").exists())

    def test_morning_deploy_verifies_functions_and_mail_and_generator_warn_continues(self):
        host = self._installed_host()
        env = self._env(host)
        env["FAIL_SEO"] = "1"
        result = self._publish(host, env)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn("WARN: seo-meta failed", result.stdout)
        marker = (host / ".sections_deployed").read_text().strip()
        self.assertEqual(marker, self._head(host))
        self.assertTrue((host / "bd.log").is_file())
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), 1)
        # failed upload does not ack
        host = self._installed_host()
        env = self._env(host)
        env["WRANGLER_MODE"] = "fail"
        failed = self._publish(host, env)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("marker not written", failed.stdout)
        self.assertFalse((host / ".sections_deployed").exists())
        self.assertFalse((host / "bd.log").exists())
        # functions bundle missing does not ack
        host = self._installed_host()
        env = self._env(host)
        env["WRANGLER_MODE"] = "nofunc"
        nofunc = self._publish(host, env)
        self.assertNotEqual(nofunc.returncode, 0, nofunc.stdout)
        self.assertIn("did not upload Functions bundle", nofunc.stdout)
        self.assertFalse((host / ".sections_deployed").exists())
        self.assertFalse((host / "bd.log").exists())

    def test_wrap_gate_and_sha_mismatch_still_fail_closed(self):
        host = self._installed_host()
        data = json.loads((host / "data" / f"{DATE}.json").read_text())
        data["market_wrap"] = {"wraps": [{"window": "us-close", "label": "美股收市", "url": "https://www.bloomberg.com/news/articles/2026-11-25/example"}]}
        (host / "data" / f"{DATE}.json").write_text(json.dumps(data))
        blocked = self._publish(host, self._env(host))
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("wrap URL evidence gate failed", blocked.stdout + blocked.stderr)
        self.assertFalse((host / "deploy.next").exists())
        self.assertFalse((host / "wrangler.log").exists())
        host = self._installed_host()
        src = host / "sections-src"
        (src / "index.html").write_text("<html>other</html>\n")
        run(["git", "-C", str(src), "add", "index.html"])
        run(["git", "-C", str(src), "commit", "-m", "local only"])
        run(["git", "-C", str(src), "remote", "remove", "origin"])
        mismatched = self._publish(host, self._env(host))
        self.assertEqual(mismatched.returncode, 2, mismatched.stdout + mismatched.stderr)
        self.assertIn("FAIL-CLOSED: sections-src is", mismatched.stdout)
        self.assertFalse((host / ".sections_deployed").exists())

    def test_frozen_is_isolated_and_rerun_lists_mtime_without_content_drift(self):
        host = self._installed_host()
        frozen = self.tmp / "frozen-copy"
        self._copy_content(host, frozen)
        pin = host / ".publish_window_pin"
        self.assertEqual(run([
            "python3", str(PKG / "publish_window.py"), "write",
            "--host", str(host), "--until", "2099-01-01T00:00:00+08:00", "--out", str(pin),
        ], check=False).returncode, 0)
        data = host / "data" / f"{DATE}.json"
        before = data.stat().st_mtime_ns
        digest = sha256(data)
        public = sha256(host / "deploy/news/latest.json")
        env = self._env(host)
        env.update({
            "ADRRR_PUBLISH_MODE": "frozen",
            "ADRRR_FROZEN_ROOT": str(frozen),
            "BUTTONDOWN_SKIP": "0",
        })
        first = self._publish(host, env, dated=frozen / "site" / DATE)
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        self.assertIn("FROZEN:", first.stdout)
        self.assertEqual(data.stat().st_mtime_ns, before)
        self.assertEqual(sha256(data), digest)
        self.assertEqual(sha256(host / "deploy/news/latest.json"), public)
        self.assertFalse((host / "wrangler.log").exists())
        self.assertFalse((host / "bd.log").exists())
        self.assertFalse((host / ".sections_deployed").exists())
        out = frozen / "out"
        self.assertTrue((out / "news/latest.json").is_file())
        sys_path_manifest = self._manifest(out)
        frozen_data_mtime = (frozen / "data" / f"{DATE}.json").stat().st_mtime_ns
        second = self._publish(host, env, dated=frozen / "site" / DATE)
        self.assertEqual(second.returncode, 0, second.stderr + second.stdout)
        diff = self._diff(sys_path_manifest, self._manifest(out))
        self.assertEqual(diff["content"], [])
        self.assertEqual(diff["lastmod"], [])
        self.assertTrue(any(item["path"].endswith("latest.json") for item in diff["mtime"]))
        self.assertEqual((frozen / "data" / f"{DATE}.json").stat().st_mtime_ns, frozen_data_mtime)
        self.assertEqual(sha256(frozen / "data" / f"{DATE}.json"), sha256(host / "data" / f"{DATE}.json"))

    def test_pin_drift_stops_and_restore_then_deploys(self):
        host = self._installed_host()
        pin = host / ".publish_window_pin"
        self.assertEqual(run([
            "python3", str(PKG / "publish_window.py"), "write",
            "--host", str(host), "--until", "2099-01-01T00:00:00+08:00", "--out", str(pin),
        ], check=False).returncode, 0)
        data = host / "data" / f"{DATE}.json"
        data.write_text(data.read_text().replace("host headline", "drifted"))
        stopped = self._publish(host, self._env(host))
        self.assertEqual(stopped.returncode, 3, stopped.stdout + stopped.stderr)
        self.assertIn("STOP: drift", stopped.stderr)
        self.assertFalse((host / "wrangler.log").exists())
        self.assertFalse((host / ".sections_deployed").exists())
        pin.unlink()
        restored = self._publish(host, self._env(host))
        self.assertEqual(restored.returncode, 0, restored.stderr + restored.stdout)
        self.assertTrue((host / ".sections_deployed").is_file())
        self.assertTrue((host / "bd.log").is_file())

    def test_replay_pending_failure_then_success_then_unchanged(self):
        host = self._installed_host()
        env = self._env(host)
        env["WRANGLER_MODE"] = "fail"
        first = self._check(host, env)
        self.assertNotEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertFalse((host / ".sections_deployed").exists())
        self.assertFalse((host / "bd.log").exists())
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), 1)
        env["WRANGLER_MODE"] = "ok"
        second = self._check(host, env)
        self.assertEqual(second.returncode, 0, second.stderr + second.stdout)
        self.assertEqual((host / ".sections_deployed").read_text().strip(), self._head(host))
        self.assertFalse((host / "bd.log").exists(), "webhook path keeps BUTTONDOWN_SKIP=1")
        calls = len((host / "wrangler.log").read_text().splitlines())
        third = self._check(host, env)
        self.assertEqual(third.returncode, 0, third.stderr + third.stdout)
        self.assertIn("unchanged", third.stdout)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls)

    def test_check_sections_strips_frozen_mode_and_remote_drift_does_not_reset(self):
        host = self._installed_host()
        frozen = self.tmp / "not-used"
        self._copy_content(host, frozen)
        env = self._env(host)
        env["ADRRR_PUBLISH_MODE"] = "frozen"
        env["ADRRR_FROZEN_ROOT"] = str(frozen)
        result = self._check(host, env)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue((host / "wrangler.log").is_file())
        self.assertFalse((frozen / "out").exists())
        host = self._installed_host()
        pin = host / ".publish_window_pin"
        self.assertEqual(run([
            "python3", str(PKG / "publish_window.py"), "write",
            "--host", str(host), "--until", "2099-01-01T00:00:00+08:00", "--out", str(pin),
        ], check=False).returncode, 0)
        frozen = self.tmp / "frozen-drift"
        self._copy_content(host, frozen)
        bare = host / "origin.git"
        src = host / "sections-src"
        (src / "extra.txt").write_text("next\n")
        run(["git", "-C", str(src), "add", "extra.txt"])
        run(["git", "-C", str(src), "commit", "-m", "advance"])
        run(["git", "-C", str(src), "push", "-q", "origin", "HEAD:main"])
        run(["git", "-C", str(src), "reset", "--hard", "HEAD~1"])
        head = self._head(host)
        public = sha256(host / "deploy/news/latest.json")
        env = self._env(host)
        env.update({"ADRRR_PUBLISH_MODE": "frozen", "ADRRR_FROZEN_ROOT": str(frozen)})
        drifted = self._publish(host, env, dated=frozen / "site" / DATE)
        self.assertEqual(drifted.returncode, 3, drifted.stdout + drifted.stderr)
        self.assertIn("drifted from pinned", drifted.stdout)
        self.assertEqual(self._head(host), head)
        self.assertFalse((host / "deploy.next").exists())
        self.assertEqual(sha256(host / "deploy/news/latest.json"), public)
        self.assertTrue(bare.is_dir())

    def _story(self, title):
        return json.dumps({
            "date": DATE,
            "stories": [{"n": 1, "title": title, "body": "Hello。", "links": [{"url": STORY}]}],
            "og_images": {STORY: {
                "image_url": "/news/img/x.webp", "method": "search-copy", "hires": True,
                "size": [1600], "image_credit": "C", "orig_url": "https://img.example/x",
                "fetched_at": "2026-11-25T00:00:00",
            }},
        })

    def _data_tree(self, root: Path):
        (root / "data").mkdir(parents=True)
        (root / "netlify_config.json").write_text(json.dumps({
            "base_url": "https://news-chart.com", "site_id": "site", "path_prefix": "news",
        }))

    def _host(self):
        host = self.tmp / ("host-" + hashlib.sha256(os.urandom(8)).hexdigest()[:8])
        host.mkdir()
        for rel in ("publish.sh", "check_sections.sh"):
            shutil.copy(PKG / "baseline" / rel, host / rel)
        tools = host / "tools"
        tools.mkdir()
        for name in ("latest_json.py", "og_images.py", "validate_wrap_urls.py"):
            shutil.copy(PKG / "baseline/tools" / name, tools / name)
        self._data_tree(host)
        (host / "data" / f"{DATE}.json").write_text(self._story("host headline"))
        (host / "site" / DATE).mkdir(parents=True)
        (host / "site" / DATE / "index.html").write_text("<html>day</html>\n")
        (host / "deploy/news").mkdir(parents=True)
        (host / "deploy/news/latest.json").write_text("{}\n")
        (host / "cloudflare_config.json").write_text(json.dumps({"account_id": "acct", "project": "adrnnng"}))
        (host / ".cf_token").write_text("fixture-token\n")
        (host / ".buttondown_token").write_text("fixture-token\n")
        (host / "build_site.py").write_text("def archive_html(days):\n    return '<html>archive</html>\\n'\n")
        src = host / "sections-src"
        bare = host / "origin.git"
        run(["git", "init", "--bare", "-b", "main", str(bare)])
        run(["git", "init", "-b", "main", str(src)])
        (src / "index.html").write_text("<html>home</html>\n")
        (src / "_redirects").write_text("# repo\n")
        (src / "_headers").write_text("# headers\n")
        (src / "favicon.ico").write_bytes(b"ico")
        (src / "functions").mkdir()
        (src / "functions/hello.js").write_text("export function onRequest(){return new Response('ok')}\n")
        scripts = src / "scripts"
        scripts.mkdir()
        (scripts / "home-preview.mjs").write_text("process.exit(0)\n")
        (scripts / "seo-meta.mjs").write_text("if (process.env.FAIL_SEO === '1') process.exit(1)\n")
        (scripts / "news-feed.mjs").write_text(textwrap.dedent("""
            import { writeFileSync } from 'node:fs';
            const site = process.argv[process.argv.indexOf('--site') + 1];
            writeFileSync(site + '/news/feed.xml', '<feed/>\\n');
        """))
        (scripts / "build-sitemap.mjs").write_text(textwrap.dedent("""
            import { writeFileSync } from 'node:fs';
            const site = process.argv[process.argv.indexOf('--site') + 1];
            writeFileSync(site + '/sitemap-pages.xml', '<url><loc>/movers/</loc><lastmod>2026-11-24</lastmod></url>\\n');
        """))
        run(["git", "-C", str(src), "add", "."])
        run(["git", "-C", str(src), "commit", "-m", "init"])
        run(["git", "-C", str(src), "remote", "add", "origin", str(bare)])
        run(["git", "-C", str(src), "push", "-q", "origin", "HEAD:main"])
        (host / "sections_repo.json").write_text(json.dumps({"url": str(bare), "branch": "main"}))
        wrangler = tools / "cfwrangler/node_modules/.bin"
        wrangler.mkdir(parents=True)
        (wrangler / "wrangler").write_text(textwrap.dedent("""\
            #!/bin/bash
            mode=${WRANGLER_MODE:-ok}
            cwd="."
            prev=""
            for a in "$@"; do
              if [ "$prev" = "--cwd" ]; then cwd=$a; fi
              prev=$a
            done
            printf '%s\\n' "$mode" >> "${WRANGLER_LOG:?}"
            if [ "$mode" = "fail" ]; then echo "Deployment failed"; exit 1; fi
            if [ -d "$cwd/functions" ] && [ "$mode" != "nofunc" ]; then
              echo "Uploading Functions bundle"
            fi
            echo "Deployment complete"
            exit 0
        """))
        (wrangler / "wrangler").chmod((wrangler / "wrangler").stat().st_mode | stat.S_IEXEC)
        (tools / "buttondown_send.py").write_text(textwrap.dedent("""\
            import os, sys
            open(os.environ["BUTTONDOWN_LOG"], "w").write(sys.argv[1])
        """))
        return host

    def _installed_host(self):
        host = self._host()
        result = run([str(PKG / "install.sh"), str(host)], check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return host

    def _env(self, host):
        return {
            "ADRRR_HOST_ROOT": str(host),
            "ADRRR_LOCK_WAIT": "2",
            "BUTTONDOWN_LOG": str(host / "bd.log"),
            "WRANGLER_LOG": str(host / "wrangler.log"),
            "WRANGLER_MODE": "ok",
        }

    def _publish(self, host, env, dated=None):
        target = dated or (host / "site" / DATE)
        return run(["bash", str(host / "publish.sh"), str(target)], env=env, check=False)

    def _check(self, host, env):
        return run(["bash", str(host / "check_sections.sh")], env=env, check=False)

    def _head(self, host):
        return run(["git", "-C", str(host / "sections-src"), "rev-parse", "HEAD"]).stdout.strip()

    def _copy_content(self, host, dest):
        dest.mkdir()
        for name in ("data", "site", "netlify_config.json"):
            src = host / name
            if src.is_dir():
                shutil.copytree(src, dest / name)
            else:
                shutil.copy(src, dest / name)

    def _manifest(self, root):
        import importlib.util
        spec = importlib.util.spec_from_file_location("publish_window", PKG / "publish_window.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.tree_manifest(root)

    def _diff(self, before, after):
        import importlib.util
        spec = importlib.util.spec_from_file_location("publish_window", PKG / "publish_window.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.manifest_diff(before, after)


if __name__ == "__main__":
    unittest.main()
