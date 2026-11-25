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
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

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
        self.assertIn("consume-daily", patched)
        self.assertNotIn("no formal deploy swap, no upload", patched)
        self.assertNotIn("ADRRR_DIGEST_DIR/$PREFIX/latest.json", patched)
        deploy = patched.split("set +e", 1)[1].split("CF_RC=$?", 1)[0]
        self.assertNotIn("|| true", deploy)
        checker = (PKG / "patched" / "check_sections.sh").read_text()
        self.assertIn("FAIL-CLOSED: ls-remote failed during window", checker)
        self.assertIn('echo "WARN: ls-remote failed: $OUT"; exit 0', checker)
        self.assertIn("BUTTONDOWN_SKIP=1", checker)
        self.assertIn("ADRRR_WINDOW_ENTRY=1", checker)

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
        held = self._installed_host()
        artifacts = self._artifacts(held)
        self.assertEqual(self._arm(held, artifacts).returncode, 0)
        blocked = run([str(PKG / "rollback.sh"), str(held)], check=False)
        self.assertNotEqual(blocked.returncode, 0, blocked.stderr)
        self.assertIn("window pin still present", blocked.stderr)
        self.assertEqual(sha256(held / "publish.sh"), sha256(PKG / "patched/publish.sh"))
        self.assertEqual(run([
            "python3", str(PKG / "publish_window.py"), "abort", "--host", str(held),
        ], check=False).returncode, 0)
        self.assertEqual(run([str(PKG / "rollback.sh"), str(held)], check=False).returncode, 0)

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

    def test_window_uploads_pinned_bytes_and_replay_is_not_sha_alone(self):
        host = self._installed_host()
        artifacts = self._artifacts(host)
        approved = (artifacts / "news/latest.json").read_bytes()
        data = host / "data" / f"{DATE}.json"
        before_ns = data.stat().st_mtime_ns
        data_bytes = data.read_bytes()
        deployed_latest = (host / "deploy/news/latest.json").read_bytes()
        env = self._window_env(host)
        env["BUILD_SITE_BOOM"] = "1"
        env["GENERATOR_BOOM"] = "1"
        env["BUTTONDOWN_SKIP"] = "0"
        self.assertEqual(self._arm(host, artifacts).returncode, 0)
        inside = host / "not-outside"
        self._artifacts(host, inside)
        refused = self._arm(host, inside)
        self.assertNotEqual(refused.returncode, 0, refused.stderr)
        self.assertIn("outside the digest", refused.stderr)
        first = self._check(host, env)
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        self.assertIn("BUTTONDOWN_SKIP=1", first.stdout)
        self.assertIn("WINDOW: deployed and read back", first.stdout)
        self.assertIn("buttondown: skip (window transaction", first.stdout)
        self.assertFalse((host / "bd.log").exists())
        self.assertFalse((host / "build-site.flag").exists())
        self.assertFalse((host / "deploy.next").exists())
        self.assertEqual(data.stat().st_mtime_ns, before_ns)
        self.assertEqual(data.read_bytes(), data_bytes)
        self.assertEqual((host / "deploy/news/latest.json").read_bytes(), deployed_latest)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), 1)
        marker = (host / ".sections_deployed").read_text().splitlines()
        self.assertEqual(marker[0], self._head(host))
        self.assertTrue(marker[1].startswith("identity "))
        deployment_id = marker[1].split()[3]
        body = urllib.request.urlopen(
            env["ADRRR_READBACK_ORIGIN"] + f"/{deployment_id}/news/latest.json", timeout=5
        ).read()
        self.assertEqual(body, approved)
        paths = [item.split("/", 1)[1] for item in self.server.requests]
        self.assertIn("news/latest.json", paths)
        self.assertFalse(any(item.startswith("functions/") or item.endswith("_redirects") for item in paths))
        calls = len((host / "wrangler.log").read_text().splitlines())
        again = self._check(host, env)
        self.assertEqual(again.returncode, 0, again.stderr + again.stdout)
        self.assertIn("script+artifact identity", again.stdout)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls)
        self.assertEqual(data.read_bytes(), data_bytes)
        (host / "tools/og_images.py").write_bytes((host / "tools/og_images.py").read_bytes() + b"\n")
        drifted = self._check(host, env)
        self.assertEqual(drifted.returncode, 3, drifted.stderr + drifted.stdout)
        self.assertIn("script or functions drift", drifted.stderr)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls)
        self.assertEqual(data.read_bytes(), data_bytes)
        self.assertFalse((host / "bd.log").exists())

    def test_readback_must_match_before_marker_and_replay_repairs_public_bytes(self):
        host = self._installed_host()
        artifacts = self._artifacts(host)
        env = self._window_env(host)
        self.assertEqual(self._arm(host, artifacts).returncode, 0)
        env["WRANGLER_MODE"] = "lie"
        lied = self._check(host, env)
        self.assertNotEqual(lied.returncode, 0, lied.stdout + lied.stderr)
        self.assertIn("readback mismatch", lied.stdout + lied.stderr)
        self.assertIn("marker not written", lied.stdout)
        self.assertFalse((host / ".sections_deployed").exists())
        self.assertEqual(json.loads((host / ".publish_window_pin").read_text())["state"], "armed")
        env["WRANGLER_MODE"] = "noid"
        blind = self._check(host, env)
        self.assertNotEqual(blind.returncode, 0, blind.stdout + blind.stderr)
        self.assertIn("no deployment-specific", blind.stderr)
        self.assertFalse((host / ".sections_deployed").exists())
        env["WRANGLER_MODE"] = "nofunc"
        nofunc = self._check(host, env)
        self.assertNotEqual(nofunc.returncode, 0, nofunc.stdout + nofunc.stderr)
        self.assertIn("did not upload Functions bundle", nofunc.stderr)
        self.assertFalse((host / ".sections_deployed").exists())
        env["WRANGLER_MODE"] = "ok"
        published = self._check(host, env)
        self.assertEqual(published.returncode, 0, published.stderr + published.stdout)
        marker = (host / ".sections_deployed").read_text().splitlines()
        deployment_id = marker[1].split()[3]
        public = Path(env["WRANGLER_PUBLIC"]) / deployment_id / "news/latest.json"
        public.write_bytes(b'{"headline":"tampered"}\n')
        calls = len((host / "wrangler.log").read_text().splitlines())
        repaired = self._check(host, env)
        self.assertEqual(repaired.returncode, 0, repaired.stderr + repaired.stdout)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls + 1)
        repaired_id = (host / ".sections_deployed").read_text().splitlines()[1].split()[3]
        self.assertNotEqual(repaired_id, deployment_id)
        body = urllib.request.urlopen(
            env["ADRRR_READBACK_ORIGIN"] + f"/{repaired_id}/news/latest.json", timeout=5
        ).read()
        self.assertEqual(body, (artifacts / "news/latest.json").read_bytes())
        env["ADRRR_READBACK_ORIGIN"] = "http://127.0.0.1:1"
        offline = self._check(host, env)
        self.assertNotEqual(offline.returncode, 0, offline.stdout + offline.stderr)
        self.assertIn("readback transport", offline.stderr)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls + 1)

    def test_window_does_not_fall_through_when_pin_is_removed_or_remote_drifts(self):
        host = self._installed_host()
        artifacts = self._artifacts(host)
        env = self._window_env(host)
        env["BUILD_SITE_BOOM"] = "1"
        self.assertEqual(self._arm(host, artifacts).returncode, 0)
        data = host / "data" / f"{DATE}.json"
        before = data.read_bytes()
        (artifacts / "news/latest.json").write_bytes(b'{"headline":"other"}\n')
        drifted = self._publish(host, env)
        self.assertEqual(drifted.returncode, 3, drifted.stderr + drifted.stdout)
        self.assertIn("artifact", drifted.stderr)
        self.assertFalse((host / "wrangler.log").exists())
        self.assertEqual(data.read_bytes(), before)
        (artifacts / "news/latest.json").write_bytes(b'{"headline":"approved"}\n')
        src = host / "sections-src"
        head = self._head(host)
        (src / "extra.txt").write_text("next\n")
        run(["git", "-C", str(src), "add", "extra.txt"])
        run(["git", "-C", str(src), "commit", "-m", "advance"])
        run(["git", "-C", str(src), "push", "-q", "origin", "HEAD:main"])
        run(["git", "-C", str(src), "reset", "--hard", "HEAD~1"])
        self.assertEqual(self._head(host), head)
        ahead = self._check(host, env)
        self.assertEqual(ahead.returncode, 3, ahead.stderr + ahead.stdout)
        self.assertIn("drifted from pinned", ahead.stderr)
        self.assertEqual(self._head(host), head)
        self.assertFalse((host / "deploy.next").exists())
        run(["git", "-C", str(src), "push", "-q", "origin", "HEAD:main", "--force"])
        (host / ".publish_window_pin").unlink()
        held = self._publish(host, env)
        self.assertEqual(held.returncode, 3, held.stderr + held.stdout)
        self.assertIn("pin and hold", held.stderr)
        self.assertEqual(data.read_bytes(), before)
        self.assertFalse((host / "wrangler.log").exists())
        published = self._check(host, self._window_env(host))
        self.assertNotEqual(published.returncode, 0)
        (host / ".publish_window_hold").unlink()
        # No deployment yet, so both records gone is an abort. Daily publish may refresh.
        self.assertFalse((host / ".sections_deployed").exists())

    def test_commit_then_release_restores_morning_without_serving_replay(self):
        host = self._installed_host()
        artifacts = self._artifacts(host)
        env = self._window_env(host)
        self.assertEqual(self._arm(host, artifacts).returncode, 0)
        direct = self._publish(host, env)
        self.assertEqual(direct.returncode, 0, direct.stderr + direct.stdout)
        self.assertIn("BUTTONDOWN_SKIP=0", direct.stdout)
        self.assertFalse((host / "bd.log").exists())
        data = host / "data" / f"{DATE}.json"
        frozen_bytes = data.read_bytes()
        frozen_ns = data.stat().st_mtime_ns
        calls = len((host / "wrangler.log").read_text().splitlines())
        early = self._publish(host, env)
        self.assertEqual(early.returncode, 0, early.stderr + early.stdout)
        self.assertIn("no-op", early.stdout)
        self.assertEqual(data.stat().st_mtime_ns, frozen_ns)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls)
        self.assertFalse((host / "bd.log").exists())
        released = run([
            "python3", str(PKG / "publish_window.py"), "release-daily", "--host", str(host),
        ], env=env, check=False)
        self.assertEqual(released.returncode, 0, released.stderr + released.stdout)
        replay = self._check(host, env)
        self.assertEqual(replay.returncode, 0, replay.stderr + replay.stdout)
        self.assertIn("script+artifact identity", replay.stdout)
        self.assertEqual(data.read_bytes(), frozen_bytes)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls)
        self.assertFalse((host / "bd.log").exists())
        morning_env = self._env(host)
        morning_env["BUILD_SITE_FLAG"] = str(host / "build-site.flag")
        morning_env["GENERATOR_FLAG"] = str(host / "generator.flag")
        morning = self._publish(host, morning_env)
        self.assertEqual(morning.returncode, 0, morning.stderr + morning.stdout)
        self.assertNotEqual(data.stat().st_mtime_ns, frozen_ns)
        self.assertTrue((host / "bd.log").is_file())
        self.assertTrue((host / "build-site.flag").is_file())
        self.assertTrue((host / "generator.flag").is_file())
        self.assertFalse((host / ".publish_window_pin").exists())
        self.assertFalse((host / ".publish_window_hold").exists())
        self.assertEqual((host / ".sections_deployed").read_text().strip(), self._head(host))
        after = data.stat().st_mtime_ns
        calls = len((host / "wrangler.log").read_text().splitlines())
        later = self._check(host, self._env(host))
        self.assertEqual(later.returncode, 0, later.stderr + later.stdout)
        self.assertIn("unchanged", later.stdout)
        self.assertNotIn("script+artifact", later.stdout)
        self.assertEqual(data.stat().st_mtime_ns, after)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls)

    def test_marker_without_pin_refuses_refresh_until_resume(self):
        host = self._installed_host()
        artifacts = self._artifacts(host)
        env = self._window_env(host)
        self.assertEqual(self._arm(host, artifacts).returncode, 0)
        self.assertEqual(self._check(host, env).returncode, 0)
        (host / ".publish_window_pin").unlink()
        (host / ".publish_window_hold").unlink()
        data = (host / "data" / f"{DATE}.json").read_bytes()
        calls = len((host / "wrangler.log").read_text().splitlines())
        blocked = self._check(host, env)
        self.assertEqual(blocked.returncode, 3, blocked.stderr + blocked.stdout)
        self.assertIn("pin is gone", blocked.stdout + blocked.stderr)
        self.assertEqual((host / "data" / f"{DATE}.json").read_bytes(), data)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls)
        bad = self.tmp / "wrong-artifacts"
        self._artifacts(host, bad)
        (bad / "news/latest.json").write_bytes(b'{"headline":"nope"}\n')
        refused = run([
            "python3", str(PKG / "publish_window.py"), "resume",
            "--host", str(host), "--artifacts", str(bad), "--until", "2099-01-01T00:00:00+08:00",
        ], check=False)
        self.assertNotEqual(refused.returncode, 0, refused.stderr)
        self.assertFalse((host / ".publish_window_pin").exists())
        resumed = run([
            "python3", str(PKG / "publish_window.py"), "resume",
            "--host", str(host), "--artifacts", str(artifacts), "--until", "2099-01-01T00:00:00+08:00",
        ], check=False)
        self.assertEqual(resumed.returncode, 0, resumed.stderr + resumed.stdout)
        replay = self._check(host, env)
        self.assertEqual(replay.returncode, 0, replay.stderr + replay.stdout)
        self.assertIn("script+artifact identity", replay.stdout)
        self.assertEqual(len((host / "wrangler.log").read_text().splitlines()), calls)

    def test_ls_remote_failure_is_fail_closed_only_during_the_window(self):
        host = self._installed_host()
        (host / "sections_repo.json").write_text(json.dumps({"url": str(self.tmp / "missing.git"), "branch": "main"}))
        warned = self._check(host, self._env(host))
        self.assertEqual(warned.returncode, 0, warned.stderr + warned.stdout)
        self.assertIn("WARN: ls-remote failed", warned.stdout)
        self.assertFalse((host / "wrangler.log").exists())
        self.assertFalse((host / ".sections_deployed").exists())
        host = self._installed_host()
        artifacts = self._artifacts(host)
        self.assertEqual(self._arm(host, artifacts).returncode, 0)
        (host / "sections_repo.json").write_text(json.dumps({"url": str(self.tmp / "missing.git"), "branch": "main"}))
        stopped = self._check(host, self._window_env(host))
        self.assertEqual(stopped.returncode, 3, stopped.stderr + stopped.stdout)
        self.assertIn("FAIL-CLOSED: ls-remote failed during window", stopped.stdout)
        self.assertFalse((host / ".sections_deployed").exists())
        self.assertFalse((host / "wrangler.log").exists())

    def test_abort_returns_the_morning_path_and_frozen_env_cannot_skip_it(self):
        host = self._installed_host()
        artifacts = self._artifacts(host)
        self.assertEqual(self._arm(host, artifacts).returncode, 0)
        pin = json.loads((host / ".publish_window_pin").read_text())
        pin["until"] = "2000-01-01T00:00:00+00:00"
        (host / ".publish_window_pin").write_text(json.dumps(pin))
        expired = self._publish(host, self._env(host))
        self.assertEqual(expired.returncode, 3, expired.stderr + expired.stdout)
        self.assertIn("expired", expired.stderr)
        self.assertFalse((host / "wrangler.log").exists())
        self.assertFalse((host / "bd.log").exists())
        self.assertEqual(run([
            "python3", str(PKG / "publish_window.py"), "abort", "--host", str(host),
        ], check=False).returncode, 0)
        self.assertFalse((host / ".publish_window_pin").exists())
        leaked = self._publish(host, self._env(host) | {"ADRRR_PUBLISH_MODE": "frozen", "ADRRR_FROZEN_ROOT": str(artifacts)})
        self.assertEqual(leaked.returncode, 3, leaked.stderr + leaked.stdout)
        self.assertIn("not a morning run", leaked.stdout + leaked.stderr)
        self.assertFalse((host / "bd.log").exists())
        self.assertEqual((host / "data" / f"{DATE}.json").read_bytes().count(b"host headline"), 1)
        morning = self._publish(host, self._env(host))
        self.assertEqual(morning.returncode, 0, morning.stderr + morning.stdout)
        self.assertTrue((host / "bd.log").is_file())
        self.assertTrue((host / ".sections_deployed").is_file())
        self.assertNotIn("identity ", (host / ".sections_deployed").read_text())

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

    def test_check_sections_strips_frozen_env_and_pin_still_publishes_artifacts(self):
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
        self.assertFalse((host / "bd.log").exists())
        host = self._installed_host()
        artifacts = self._artifacts(host)
        data = (host / "data" / f"{DATE}.json").read_bytes()
        env = self._window_env(host)
        env["ADRRR_PUBLISH_MODE"] = "frozen"
        env["ADRRR_FROZEN_ROOT"] = str(frozen)
        env["BUILD_SITE_BOOM"] = "1"
        self.assertEqual(self._arm(host, artifacts).returncode, 0)
        armed = self._check(host, env)
        self.assertEqual(armed.returncode, 0, armed.stderr + armed.stdout)
        self.assertIn("WINDOW: deployed and read back", armed.stdout)
        self.assertIn("BUTTONDOWN_SKIP=1", armed.stdout)
        self.assertEqual((host / "data" / f"{DATE}.json").read_bytes(), data)
        self.assertFalse((frozen / "out").exists())
        self.assertFalse((host / "bd.log").exists())

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
        (host / "build_site.py").write_text(textwrap.dedent("""\
            def archive_html(days):
                import os
                flag = os.environ.get("BUILD_SITE_FLAG")
                if flag:
                    open(flag, "a").write("called\\n")
                if os.environ.get("BUILD_SITE_BOOM") == "1":
                    raise SystemExit("build_site should not run during a window publish")
                return "<html>archive</html>\\n"
        """))
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
        (scripts / "home-preview.mjs").write_text(textwrap.dedent("""\
            import { appendFileSync } from 'node:fs';
            if (process.env.GENERATOR_FLAG) appendFileSync(process.env.GENERATOR_FLAG, 'home\\n');
            if (process.env.GENERATOR_BOOM === '1') process.exit(97);
            process.exit(0);
        """))
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
            if [ "$mode" = "noid" ]; then echo "Deployment complete"; exit 0; fi
            id=$(python3 -c 'import secrets; print("d"+secrets.token_hex(8))')
            if [ -n "${WRANGLER_PUBLIC:-}" ]; then
              dest="${WRANGLER_PUBLIC}/${id}"
              mkdir -p "$dest"
              cp -a "$cwd"/. "$dest"/
              if [ "$mode" = "lie" ]; then printf 'TAMPER\\n' >> "$dest/news/latest.json"; fi
            fi
            echo "Deployment complete! Take a peek over at https://${id}.fixture.pages.dev"
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

    def _window_env(self, host):
        public = host / "public-bytes"
        public.mkdir(parents=True, exist_ok=True)
        env = self._env(host)
        env["WRANGLER_PUBLIC"] = str(public)
        env["ADRRR_READBACK_ORIGIN"] = self._serve(public)
        return env

    def _serve(self, public: Path) -> str:
        root = public.resolve()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                path = unquote(self.path.split("?", 1)[0]).lstrip("/")
                self.server.requests.append(path)
                rel = path.split("/", 1)[1] if "/" in path else ""
                name = rel.rsplit("/", 1)[-1] if rel else ""
                if rel.startswith("functions/") or name in ("_redirects", "_headers") or name.startswith("."):
                    self.send_error(404)
                    return
                file_path = (root / path).resolve()
                try:
                    file_path.relative_to(root)
                except ValueError:
                    self.send_error(404)
                    return
                if not file_path.is_file():
                    self.send_error(404)
                    return
                data = file_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, fmt, *args):
                return

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        httpd.requests = []
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        self.server = httpd
        return f"http://127.0.0.1:{httpd.server_address[1]}"

    def _artifacts(self, host: Path, dest: Path | None = None) -> Path:
        art = dest or (self.tmp / ("art-" + hashlib.sha256(os.urandom(8)).hexdigest()[:8]))
        (art / "functions").mkdir(parents=True, exist_ok=True)
        shutil.copy(host / "sections-src/functions/hello.js", art / "functions/hello.js")
        (art / "index.html").write_text("<html>approved-home</html>\n")
        (art / "_redirects").write_text("/latest /news/20261125/ 302\n")
        (art / "_headers").write_text("/news/latest.json\n  X-Robots-Tag: noindex\n")
        (art / "favicon.ico").write_bytes(b"ico")
        day = art / "news" / "20261125"
        day.mkdir(parents=True)
        (day / "index.html").write_text("<html>approved-day</html>\n")
        (art / "news/index.html").write_text("<html>approved-archive</html>\n")
        (art / "news/latest.json").write_text('{"headline":"approved"}\n')
        (art / "news/feed.xml").write_text("<feed>approved</feed>\n")
        return art

    def _arm(self, host: Path, artifacts: Path):
        return run([
            "python3", str(PKG / "publish_window.py"), "arm",
            "--host", str(host), "--artifacts", str(artifacts),
            "--until", "2099-01-01T00:00:00+08:00",
        ], check=False)

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
