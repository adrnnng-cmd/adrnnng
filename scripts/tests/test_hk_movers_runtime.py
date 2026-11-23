"""Tests for scripts/hk-movers/runtime: the suspend-aware supervisor, the publish gate, run_sync.sh, install/rollback.

The supervisor runs against an injected clock (wall and monotonic move separately, so a host freeze is a plain
function call) and real process trees: blocked collectors, collectors that ignore TERM, orphans that keep the sync
lock, children that leave their process group. Nothing here touches OpenD, KV or the network; curl is a stub.
"""
import fcntl
import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from datetime import datetime
from pathlib import Path

import importlib.util

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "scripts" / "hk-movers" / "runtime"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, RUNTIME / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sup_mod = load("hk_runtime_supervisor", "supervisor.py")
gate_mod = load("hk_runtime_gate", "publish_gate.py")
HKT = sup_mod.HKT


def hkt_epoch(text):
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=HKT).timestamp()


def alive(pid):
    fields = sup_mod._proc_fields(pid)
    return bool(fields) and fields[0] != "Z"


class FakeClock:
    """Wall and monotonic clocks the test moves by hand. sleep() advances both and also sleeps a few real ms."""

    def __init__(self, wall, stamp_file, on_sleep=None, real_sleep=0.004):
        self._wall = float(wall)
        self._mono = 1000.0
        self.wall_rate = 1.0
        self.ticks = 0
        self.on_sleep = on_sleep
        self.real_sleep = real_sleep
        self.stamp_file = Path(stamp_file)
        self._write()

    def wall(self):
        return self._wall

    def mono(self):
        return self._mono

    def _write(self):
        self.stamp_file.write_text("%d" % self._wall)

    def sleep(self, seconds):
        self.ticks += 1
        self._mono += seconds
        self._wall += seconds * self.wall_rate
        self._write()
        if self.on_sleep:
            self.on_sleep(self)
        time.sleep(self.real_sleep)

    def freeze(self, seconds):
        """The host was paused: the wall clock moves, the monotonic clock does not."""
        self._wall += seconds
        self._write()

    def step_wall(self, seconds):
        self._wall += seconds
        self._write()


AFTERNOON = hkt_epoch("2026-11-23 14:00:00")  # Monday, inside the afternoon window

BLOCKED = """\
#!/usr/bin/env bash
echo $$ >> "$HK_MOVERS_DIR/pids"
sleep 600 &
echo $! >> "$HK_MOVERS_DIR/pids"
wait
"""
IGNORES_TERM = """\
#!/usr/bin/env bash
trap '' TERM
echo $$ >> "$HK_MOVERS_DIR/pids"
sleep 600 &
echo $! >> "$HK_MOVERS_DIR/pids"
wait
"""
QUICK_OK = """\
#!/usr/bin/env bash
echo run >> "$HK_MOVERS_DIR/runs"
touch -d "@$(cat "$HK_MOVERS_DIR/clock.txt")" "$HK_MOVERS_DIR/latest.json"
"""
QUICK_FAIL = """\
#!/usr/bin/env bash
echo run >> "$HK_MOVERS_DIR/runs"
exit 1
"""
NO_PUBLISH = """\
#!/usr/bin/env bash
echo run >> "$HK_MOVERS_DIR/runs"
exit 0
"""
ORPHAN_HOLDS_LOCK = """\
#!/usr/bin/env bash
exec 8>"$HK_MOVERS_DIR/.sync.lock"
flock -n 8 || exit 0
sleep 600 &
echo $! >> "$HK_MOVERS_DIR/pids"
exit 1
"""
LEAVES_GROUP = """\
#!/usr/bin/env bash
exec 8>"$HK_MOVERS_DIR/.sync.lock"
flock -n 8 || exit 0
python3 -c 'import os,time; os.setpgid(0,0); open(os.environ["HK_MOVERS_DIR"]+"/pids","a").write("%d\\n" % os.getpid()); time.sleep(600)' &
sleep 0.3
exit 1
"""


class Rig:
    def __init__(self, case, script, wall=AFTERNOON, on_sleep=None, **cfg):
        self.tmp = tempfile.TemporaryDirectory()
        case.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.script = self.dir / "collect.sh"
        self.set_script(script)
        self.clock = FakeClock(wall, self.dir / "clock.txt", on_sleep)
        self.cfg = sup_mod.Config(self.dir, self.script, **cfg)
        self.sup = sup_mod.Supervisor(self.cfg, self.clock, env={"PATH": os.environ["PATH"]})
        case.addCleanup(self.reap)

    def set_script(self, body):
        self.script.write_text(body)
        self.script.chmod(0o755)

    def age_latest(self, seconds_ago):
        path = self.cfg.latest
        path.write_text("{}")
        stamp = self.clock.wall() - seconds_ago
        os.utime(str(path), (stamp, stamp))

    def pids(self):
        path = self.dir / "pids"
        return [int(x) for x in path.read_text().split()] if path.exists() else []

    def runs(self):
        path = self.dir / "runs"
        return len(path.read_text().split()) if path.exists() else 0

    def log(self):
        return self.cfg.log.read_text() if self.cfg.log.exists() else ""

    def reap(self):
        for pid in self.pids():
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


class ScheduleTests(unittest.TestCase):
    def test_window_matches_the_old_should_run(self):
        def at(text):
            return datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=HKT)

        cases = {
            "2026-11-23 09:19": False, "2026-11-23 09:20": True, "2026-11-23 12:06": True,
            "2026-11-23 12:07": False, "2026-11-23 12:54": False, "2026-11-23 12:55": True,
            "2026-11-23 16:16": True, "2026-11-23 16:17": False, "2026-11-23 03:00": False,
            "2026-11-21 14:00": False, "2026-11-22 14:00": False, "2026-11-27 14:00": True,
        }
        for text, expected in cases.items():
            self.assertEqual(sup_mod.in_window(at(text)), expected, text)

    def test_backoff_is_bounded(self):
        cfg = sup_mod.Config("/tmp")
        self.assertEqual([sup_mod.backoff_delay(cfg, n) for n in range(0, 7)], [0, 30, 60, 120, 120, 120, 120])

    def test_collector_and_data_files_are_untouched(self):
        want = {
            "scripts/hk_movers_sync.py": "bdff046b3bff8a8b24f013202a4cc696cd2eff5dcabd45f039bd15c8c19403d4",
            "scripts/hk_movers_returns.py": "963b47756ff2f20620f0d2a5724d78ce382c5cfd4bd001b3aa8e85f9465fdf1a",
            "scripts/hk_movers_rosters.py": "ee26a12b488cb838c71cdd7821d6a3a4361272f9ca3fc4307303235d879ac28b",
            "scripts/hk-movers/index-rosters.json": "ea559eb2f05bfd15476f3239c2d1cf803b6799f743c031dde9a4021946761e14",
        }
        for rel, digest in want.items():
            self.assertEqual(hashlib.sha256((ROOT / rel).read_bytes()).hexdigest(), digest, rel)


class DueTests(unittest.TestCase):
    def test_restart_guard_fresh_file_waits_and_stale_file_runs(self):
        rig = Rig(self, QUICK_OK)
        rig.age_latest(100)
        self.assertIsNone(rig.sup.cycle())
        self.assertEqual(rig.runs(), 0)
        rig.age_latest(301)
        self.assertEqual(rig.sup.cycle().kind, "ok")

    def test_missing_file_runs_and_is_logged_as_never(self):
        rig = Rig(self, QUICK_OK)
        self.assertEqual(rig.sup.cycle().kind, "ok")
        self.assertIn("syncing (file_age=999999s)...", rig.log())
        self.assertIn("sync OK", rig.log())

    def test_no_run_outside_the_window(self):
        rig = Rig(self, QUICK_OK, wall=hkt_epoch("2026-11-23 17:00:00"))
        self.assertIsNone(rig.sup.cycle())
        self.assertEqual(rig.runs(), 0)

    def test_file_dated_in_the_future_does_not_block_collection(self):
        rig = Rig(self, QUICK_OK)
        rig.age_latest(-7200)
        self.assertEqual(rig.sup.cycle().kind, "ok")

    def test_a_fresh_file_after_a_long_attempt_is_not_collected_again_at_once(self):
        # The old loop re-ran at once after a long attempt (now - last_attempt >= interval), 15:20:13 then 15:20:28.
        rig = Rig(self, QUICK_OK)
        rig.age_latest(400)
        self.assertEqual(rig.sup.cycle().kind, "ok")
        rig.clock.step_wall(0)
        rig.clock.sleep(15)
        self.assertIsNone(rig.sup.cycle())
        self.assertEqual(rig.runs(), 1)


class DeadlineTests(unittest.TestCase):
    def assert_gone(self, rig):
        for pid in rig.pids():
            self.assertFalse(alive(pid), "pid %d survived" % pid)
        self.assertFalse(sup_mod.lock_busy(rig.cfg.sync_lock), "sync lock leaked")

    def test_blocked_collector_is_ended_by_the_wall_deadline(self):
        rig = Rig(self, BLOCKED)
        outcome = rig.sup.cycle()
        self.assertEqual((outcome.kind, outcome.reason, outcome.exit_code), ("deadline", "wall-deadline", 124))
        self.assertTrue(180 <= outcome.elapsed < 184, outcome)
        self.assertEqual(len(rig.pids()), 2)
        self.assert_gone(rig)
        self.assertIn("sync WARN exit=124 reason=wall-deadline", rig.log())
        self.assertFalse(rig.cfg.latest.exists())

    def test_deadline_still_fires_when_the_wall_clock_is_stalled(self):
        rig = Rig(self, BLOCKED)
        rig.clock.wall_rate = 0.0
        outcome = rig.sup.cycle()
        self.assertEqual((outcome.kind, outcome.reason), ("deadline", "monotonic-deadline"))
        self.assert_gone(rig)

    def test_host_freeze_ends_the_attempt_at_once_instead_of_after_the_freeze(self):
        # The incident: the 14:02 collect stayed alive for 57 minutes of wall time because the 180 s timer was frozen.
        rig = Rig(self, BLOCKED, on_sleep=lambda c: c.freeze(3300) if c.ticks == 20 else None)
        outcome = rig.sup.cycle()
        self.assertEqual((outcome.kind, outcome.reason), ("suspend", "clock-jump"))
        self.assertLess(rig.clock.ticks, 40, "the loop kept supervising instead of ending the attempt at the jump")
        self.assert_gone(rig)
        self.assertIn("reason=clock-jump", rig.log())

    def test_after_the_freeze_a_fresh_collect_starts_and_publishes(self):
        rig = Rig(self, BLOCKED, on_sleep=lambda c: c.freeze(3300) if c.ticks == 20 else None)
        rig.age_latest(300)
        self.assertEqual(rig.sup.cycle().kind, "suspend")
        rig.set_script(QUICK_OK)
        self.assertIsNone(rig.sup.cycle(), "settle delay not respected")
        self.assertEqual(rig.runs(), 0)
        rig.clock.sleep(rig.cfg.settle)
        self.assertEqual(rig.sup.cycle().kind, "ok")
        self.assertEqual(rig.runs(), 1)
        self.assertEqual(rig.sup.fails, 0, "a freeze is not a failure and must not add backoff")
        self.assertGreaterEqual(rig.cfg.latest.stat().st_mtime, rig.clock.wall() - 5)
        self.assert_gone(rig)

    def test_freeze_between_cycles_is_logged_and_the_next_cycle_collects(self):
        rig = Rig(self, QUICK_OK)
        rig.age_latest(10)
        self.assertIsNone(rig.sup.cycle())
        rig.clock.freeze(3000)
        self.assertEqual(rig.sup.cycle().kind, "ok")
        self.assertIn("clock jumped", rig.log())

    def test_a_backward_wall_step_does_not_kill_a_healthy_collect(self):
        script = QUICK_OK.replace("touch", "sleep 0.15; touch")
        rig = Rig(self, script, on_sleep=lambda c: c.step_wall(-100) if c.ticks == 2 else None)
        rig.age_latest(400)
        self.assertEqual(rig.sup.cycle().kind, "ok")

    def test_collector_ignoring_term_is_killed_after_the_grace_period(self):
        rig = Rig(self, IGNORES_TERM)
        outcome = rig.sup.cycle()
        self.assertEqual(outcome.kind, "deadline")
        self.assertTrue(195 <= outcome.elapsed < 199, outcome)
        self.assert_gone(rig)

    def test_collector_that_obeys_term_is_not_held_for_the_grace_period(self):
        rig = Rig(self, BLOCKED)
        outcome = rig.sup.cycle()
        self.assertLess(outcome.elapsed, 184)

    def test_orphan_holding_the_sync_lock_is_swept(self):
        rig = Rig(self, ORPHAN_HOLDS_LOCK)
        outcome = rig.sup.cycle()
        self.assertEqual(outcome.kind, "failed")
        self.assertEqual(len(rig.pids()), 1)
        self.assert_gone(rig)
        self.assertIn("leftover process", rig.log())

    def test_child_that_leaves_the_process_group_is_found_by_its_session(self):
        rig = Rig(self, LEAVES_GROUP)
        outcome = rig.sup.cycle()
        self.assertEqual(outcome.kind, "failed")
        self.assertEqual(len(rig.pids()), 1)
        self.assert_gone(rig)

    def test_exit_zero_without_a_new_file_is_not_called_ok(self):
        rig = Rig(self, NO_PUBLISH)
        rig.age_latest(400)
        outcome = rig.sup.cycle()
        self.assertEqual((outcome.kind, outcome.reason), ("noop", "no-publish"))
        self.assertNotIn("sync OK", rig.log())
        self.assertEqual(rig.sup.fails, 1)

    def test_shutdown_ends_the_attempt_and_leaves_nothing(self):
        rig = Rig(self, BLOCKED, on_sleep=lambda c: rig.sup.stop() if c.ticks == 5 else None)
        outcome = rig.sup.cycle()
        self.assertEqual(outcome.kind, "shutdown")
        self.assert_gone(rig)


class RetryTests(unittest.TestCase):
    def test_persistent_failure_backs_off_instead_of_looping(self):
        rig = Rig(self, QUICK_FAIL)
        rig.age_latest(400)
        rig.sup.run(max_cycles=int(600 / rig.cfg.poll))
        self.assertGreaterEqual(rig.runs(), 3)
        self.assertLessEqual(rig.runs(), 7, "a failing collect must not be retried every poll")
        waits = [l for l in rig.log().splitlines() if "retry in" in l]
        self.assertIn("retry in 30s", waits[0])
        self.assertIn("retry in 60s", waits[1])
        self.assertIn("retry in 120s", waits[2])

    def test_success_clears_the_backoff(self):
        rig = Rig(self, QUICK_FAIL)
        rig.age_latest(400)
        rig.sup.cycle()
        self.assertEqual(rig.sup.fails, 1)
        rig.set_script(QUICK_OK)
        rig.clock.sleep(31)
        self.assertEqual(rig.sup.cycle().kind, "ok")
        self.assertEqual((rig.sup.fails, rig.sup.next_allowed), (0, 0.0))

    def test_held_sync_lock_means_no_second_collect(self):
        rig = Rig(self, QUICK_OK)
        rig.age_latest(400)
        fd = os.open(str(rig.cfg.sync_lock), os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            for _ in range(3):
                self.assertEqual(rig.sup.cycle().kind, "busy")
                rig.clock.sleep(15)
            self.assertEqual(rig.runs(), 0)
            self.assertEqual(rig.log().count("sync lock is held"), 1, "the log must not fill up while the lock is held")
        finally:
            os.close(fd)
        self.assertEqual(rig.sup.cycle().kind, "ok")
        self.assertEqual(rig.runs(), 1)


class GateTests(unittest.TestCase):
    NOW = AFTERNOON

    def doc(self, ago=10):
        stamp = datetime.fromtimestamp(self.NOW - ago, HKT).strftime("%Y-%m-%d %H:%M:%S")
        return {"schema_version": 1, "data_source": "live", "updated_at_hkt": stamp}

    def test_fresh_document_passes(self):
        self.assertIsNone(gate_mod.check(self.doc(30), self.NOW, start=self.NOW - 40, publish_by=self.NOW + 100))

    def test_the_incident_document_is_rejected(self):
        # Stamped 15:00:13 (collect start), finished 15:20:12.
        reason = gate_mod.check(self.doc(1199), self.NOW, start=self.NOW - 1200, publish_by=self.NOW + 100)
        self.assertTrue(reason.startswith("stale"), reason)

    def test_overdue_attempt_is_rejected_even_if_the_stamp_is_young(self):
        reason = gate_mod.check(self.doc(30), self.NOW, publish_by=self.NOW - 5)
        self.assertTrue(reason.startswith("overdue"), reason)

    def test_older_than_the_live_snapshot_is_rejected(self):
        live = self.NOW - 5
        self.assertTrue(gate_mod.check(self.doc(30), self.NOW, current_stamp=live).startswith("stale"))

    def test_stamp_from_before_the_attempt_is_rejected(self):
        self.assertTrue(gate_mod.check(self.doc(100), self.NOW, start=self.NOW - 20).startswith("stale"))

    def test_future_stamp_and_malformed_documents_are_rejected(self):
        self.assertTrue(gate_mod.check(self.doc(-500), self.NOW).startswith("invalid"))
        self.assertTrue(gate_mod.check({"schema_version": 1}, self.NOW).startswith("invalid"))
        self.assertTrue(gate_mod.check({"schema_version": 1, "updated_at_hkt": "yesterday"}, self.NOW).startswith("invalid"))
        self.assertTrue(gate_mod.check([], self.NOW).startswith("invalid"))


FAKE_COLLECTOR = """\
import json, os, sys, time
from datetime import datetime, timedelta, timezone
args = sys.argv[1:]
out = args[args.index("--out") + 1]
d = os.environ["HK_MOVERS_DIR"]
open(os.path.join(d, "collector-calls"), "a").write("call\\n")
fails = int(os.environ.get("FAKE_FAILS", "0"))
calls = len(open(os.path.join(d, "collector-calls")).read().split())
if calls <= fails:
    sys.exit(1)
if os.environ.get("FAKE_BLOCK"):
    open(os.path.join(d, "collector-pid"), "w").write(str(os.getpid()))
    time.sleep(600)
ago = int(os.environ.get("FAKE_STAMP_AGO", "5"))
stamp = datetime.now(timezone(timedelta(hours=8))) - timedelta(seconds=ago)
with open(out, "w") as fh:
    json.dump({"schema_version": 1, "data_source": "live", "updated_at_hkt": stamp.strftime("%Y-%m-%d %H:%M:%S"), "n": calls}, fh)
"""

STUB_CURL = """\
#!/usr/bin/env bash
echo "$@" > "$HK_MOVERS_DIR/curl-args"
for a in "$@"; do case "$a" in @*) cp "${a#@}" "$HK_MOVERS_DIR/curl-body";; esac; done
[ -n "${STUB_CURL_EXIT:-}" ] && exit "$STUB_CURL_EXIT"
if [ -n "${STUB_CURL_BODY:-}" ]; then echo "$STUB_CURL_BODY"; else echo '{"success":true}'; fi
"""

OLD_RUN_SYNC = """\
#!/usr/bin/env bash
ACCT=7b1182dd30b47ee48707e5705c8569f8
NS=f6577e29d4b249dea5a81b4f00443082
echo old run_sync
"""


class RunSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / "collector.py").write_text(FAKE_COLLECTOR)
        curl = self.dir / "curl"
        curl.write_text(STUB_CURL)
        curl.chmod(0o755)
        (self.dir / "token").write_text("TEST-TOKEN-VALUE\n")
        self.live = self.dir / "latest.json"
        self.live.write_text('{"live": "old"}')
        self.env = {
            "PATH": os.environ["PATH"], "HK_MOVERS_DIR": str(self.dir), "HK_MOVERS_PYTHON": sys.executable,
            "HK_MOVERS_COLLECTOR": str(self.dir / "collector.py"), "HK_MOVERS_CURL": str(curl),
            "HK_MOVERS_TOKEN_FILE": str(self.dir / "token"), "HK_MOVERS_KV_ACCOUNT_ID": "acct0",
            "HK_MOVERS_KV_NAMESPACE_ID": "ns0",
        }

    def run_sync(self, **extra):
        env = dict(self.env)
        env.update(extra)
        return subprocess.run([str(RUNTIME / "run_sync.sh")], env=env, capture_output=True, text=True, timeout=60)

    def assert_untouched(self):
        self.assertEqual(self.live.read_text(), '{"live": "old"}')
        self.assertEqual(list(self.dir.glob("latest.json.tmp*")), [])

    def test_fresh_collect_is_uploaded_with_the_same_contract_then_replaced(self):
        done = self.run_sync()
        self.assertEqual(done.returncode, 0, done.stderr)
        args = (self.dir / "curl-args").read_text()
        self.assertIn("-X PUT", args)
        self.assertIn("/accounts/acct0/storage/kv/namespaces/ns0/values/hk-movers%3Alatest.json", args)
        self.assertIn("Content-Type: application/json; charset=utf-8", args)
        self.assertEqual((self.dir / "curl-body").read_text(), self.live.read_text())
        self.assertEqual(json.loads(self.live.read_text())["n"], 1)
        self.assertEqual(list(self.dir.glob("latest.json.tmp*")), [])
        self.assertNotIn("TEST-TOKEN-VALUE", self.live.read_text())
        self.assertNotIn("TEST-TOKEN-VALUE", done.stdout + done.stderr)

    def test_overdue_collect_is_rejected_before_kv_and_before_the_local_replace(self):
        done = self.run_sync(FAKE_STAMP_AGO="1199")
        self.assertEqual(done.returncode, 3, done.stderr)
        self.assertIn("publish gate: rejected: stale", done.stderr)
        self.assertFalse((self.dir / "curl-args").exists(), "nothing may reach KV")
        self.assert_untouched()

    def test_attempt_past_its_publish_deadline_is_rejected(self):
        done = self.run_sync(HK_MOVERS_PUBLISH_BY_EPOCH="%d" % (time.time() - 5))
        self.assertEqual(done.returncode, 3)
        self.assertIn("overdue", done.stderr)
        self.assertFalse((self.dir / "curl-args").exists())
        self.assert_untouched()

    def test_document_older_than_the_live_one_is_rejected(self):
        self.live.write_text(json.dumps({"schema_version": 1, "updated_at_hkt": datetime.now(HKT).strftime("%Y-%m-%d %H:%M:%S")}))
        before = self.live.read_text()
        done = self.run_sync(FAKE_STAMP_AGO="60")
        self.assertEqual(done.returncode, 3)
        self.assertEqual(self.live.read_text(), before)
        self.assertFalse((self.dir / "curl-args").exists())

    def test_failed_upload_keeps_the_old_local_file_so_the_supervisor_retries(self):
        done = self.run_sync(STUB_CURL_EXIT="22")
        self.assertNotEqual(done.returncode, 0)
        self.assert_untouched()

    def test_kv_reporting_failure_keeps_the_old_local_file(self):
        done = self.run_sync(STUB_CURL_BODY='{"success":false}')
        self.assertEqual(done.returncode, 1)
        self.assertIn("kv upload failed", done.stderr)
        self.assert_untouched()

    def test_second_instance_exits_zero_without_collecting(self):
        fd = os.open(str(self.dir / ".sync.lock"), os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            done = self.run_sync()
        finally:
            os.close(fd)
        self.assertEqual(done.returncode, 0)
        self.assertFalse((self.dir / "collector-calls").exists())
        self.assert_untouched()

    def test_one_transient_collect_failure_is_retried(self):
        done = self.run_sync(FAKE_FAILS="1")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len((self.dir / "collector-calls").read_text().split()), 2)

    def test_no_retry_when_the_attempt_has_no_time_left(self):
        done = self.run_sync(FAKE_FAILS="1", HK_MOVERS_PUBLISH_BY_EPOCH="%d" % (time.time() + 10))
        self.assertEqual(done.returncode, 1)
        self.assertIn("no time left", done.stderr)
        self.assertEqual(len((self.dir / "collector-calls").read_text().split()), 1)
        self.assert_untouched()

    def test_term_removes_the_temp_file_and_releases_the_lock(self):
        env = dict(self.env, FAKE_BLOCK="1")
        proc = subprocess.Popen([str(RUNTIME / "run_sync.sh")], env=env, start_new_session=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                if (self.dir / "collector-pid").exists():
                    break
                time.sleep(0.05)
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
        self.assertEqual(proc.returncode, 143)
        self.assert_untouched()
        self.assertFalse(sup_mod.lock_busy(self.dir / ".sync.lock"))


class EndToEndTests(unittest.TestCase):
    """The real supervisor process on the real clock, a blocked collector and real signals."""

    def start(self, tmp, script):
        (tmp / "collect.sh").write_text(script)
        (tmp / "collect.sh").chmod(0o755)
        return subprocess.Popen(
            [sys.executable, str(RUNTIME / "supervisor.py"), "--dir", str(tmp), "--run-sync", str(tmp / "collect.sh"),
             "--timeout", "3", "--term-grace", "2", "--interval", "1", "--poll", "1", "--backoff-base", "1", "--always-run"],
            env=dict(os.environ, HK_MOVERS_DIR=str(tmp)), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def wait_for(self, predicate, seconds=20):
        end = time.time() + seconds
        while time.time() < end:
            if predicate():
                return True
            time.sleep(0.1)
        return False

    def test_blocked_collect_hits_the_deadline_then_sigterm_leaves_nothing(self):
        with tempfile.TemporaryDirectory() as name:
            tmp = Path(name)
            proc = self.start(tmp, BLOCKED)
            self.addCleanup(lambda: proc.poll() is None and proc.kill())
            log = tmp / "daemon.log"
            self.assertTrue(self.wait_for(lambda: log.exists() and "reason=wall-deadline" in log.read_text()), log.read_text() if log.exists() else "no log")
            self.assertTrue(self.wait_for(lambda: log.read_text().count("syncing") >= 2), "no fresh attempt after the deadline")
            self.assertEqual(int((tmp / "daemon.pid").read_text()), proc.pid)
            pids = [int(x) for x in (tmp / "pids").read_text().split()]
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=15)
            self.assertEqual(proc.returncode, 0)
            for pid in pids:
                self.assertFalse(alive(pid), "pid %d survived the supervisor" % pid)
            self.assertFalse(sup_mod.lock_busy(tmp / ".sync.lock"))
            self.assertFalse((tmp / "daemon.pid").exists())

    def test_a_second_supervisor_does_not_start_while_one_runs(self):
        with tempfile.TemporaryDirectory() as name:
            tmp = Path(name)
            first = self.start(tmp, QUICK_OK.replace('"@$(cat "$HK_MOVERS_DIR/clock.txt")"', '"now"'))
            self.addCleanup(lambda: first.poll() is None and first.kill())
            self.assertTrue(self.wait_for(lambda: (tmp / "daemon.pid").exists()))
            second = subprocess.run(
                [sys.executable, str(RUNTIME / "supervisor.py"), "--dir", str(tmp), "--once", "--always-run"],
                capture_output=True, text=True, timeout=20)
            self.assertEqual(second.returncode, 0)
            self.assertIn("another supervisor already holds", (tmp / "daemon.log").read_text())
            self.assertEqual(int((tmp / "daemon.pid").read_text()), first.pid)
            first.send_signal(signal.SIGTERM)
            first.wait(timeout=15)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        (self.dir / "hk_movers_sync.py").write_text("# collector\n")
        (self.dir / "daemon.sh").write_text("#!/usr/bin/env bash\necho old daemon\n")
        (self.dir / "run_sync.sh").write_text(OLD_RUN_SYNC)
        self.before = {p.name: p.read_bytes() for p in self.dir.iterdir()}

    def sh(self, name, *args):
        return subprocess.run(["bash", str(RUNTIME / name), "--dir", str(self.dir), *args], capture_output=True, text=True)

    def test_dry_run_changes_nothing(self):
        done = self.sh("install.sh", "--dry-run")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("dry run", done.stdout)
        self.assertEqual({p.name: p.read_bytes() for p in self.dir.iterdir()}, self.before)

    def test_install_backs_up_installs_and_rolls_back_byte_for_byte(self):
        done = self.sh("install.sh")
        self.assertEqual(done.returncode, 0, done.stderr)
        for name in ("supervisor.py", "publish_gate.py", "run_sync.sh", "daemon.sh"):
            self.assertEqual((self.dir / name).read_bytes(), (RUNTIME / name).read_bytes(), name)
            self.assertTrue((self.dir / name).stat().st_mode & stat.S_IXUSR, name)
        env = self.dir / "runtime.env"
        self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
        self.assertIn("HK_MOVERS_KV_ACCOUNT_ID=7b1182dd30b47ee48707e5705c8569f8", env.read_text())
        self.assertIn("HK_MOVERS_KV_NAMESPACE_ID=f6577e29d4b249dea5a81b4f00443082", env.read_text())
        self.assertEqual(list(self.dir.glob(".stage.*")), [])
        self.assertEqual((self.dir / "hk_movers_sync.py").read_bytes(), self.before["hk_movers_sync.py"])
        backups = list(self.dir.glob("rollout-runtime-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "daemon.sh").read_bytes(), self.before["daemon.sh"])
        self.assertEqual((backups[0] / "run_sync.sh").read_bytes(), self.before["run_sync.sh"])

        back = self.sh("rollback.sh", str(backups[0]))
        self.assertEqual(back.returncode, 0, back.stderr)
        restored = {p.name: p.read_bytes() for p in self.dir.iterdir() if p.is_file() and p.name != ".sync.lock"}
        self.assertEqual(restored, self.before)

    def test_install_refuses_while_a_collect_holds_the_lock(self):
        fd = os.open(str(self.dir / ".sync.lock"), os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            done = self.sh("install.sh")
        finally:
            os.close(fd)
        self.assertEqual(done.returncode, 75)
        self.assertEqual((self.dir / "run_sync.sh").read_bytes(), self.before["run_sync.sh"])
        self.assertFalse((self.dir / "supervisor.py").exists())
        self.assertEqual(list(self.dir.glob("rollout-runtime-*")), [])

    def test_install_refuses_without_the_collector_or_the_kv_ids(self):
        (self.dir / "hk_movers_sync.py").unlink()
        self.assertEqual(self.sh("install.sh").returncode, 2)
        (self.dir / "hk_movers_sync.py").write_text("# collector\n")
        (self.dir / "run_sync.sh").write_text("#!/usr/bin/env bash\n")
        done = subprocess.run(["bash", str(RUNTIME / "install.sh"), "--dir", str(self.dir)], capture_output=True, text=True,
                              env={"PATH": os.environ["PATH"]})
        self.assertEqual(done.returncode, 2)
        self.assertFalse((self.dir / "supervisor.py").exists())

    def test_repo_files_hold_no_credentials(self):
        for path in RUNTIME.iterdir():
            if not path.is_file():
                continue
            text = path.read_text(errors="ignore")
            self.assertNotIn("7b1182dd30b47ee48707e5705c8569f8", text, path.name)
            self.assertNotRegex(text, r"Bearer [A-Za-z0-9_\-]{20,}", path.name)


if __name__ == "__main__":
    unittest.main()
