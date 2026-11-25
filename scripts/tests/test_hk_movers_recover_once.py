import io
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "hk-movers" / "runtime"))

import recover_once as once  # noqa: E402

HKT = timezone(timedelta(hours=8))
RUNTIME = "/workspace/futu/hk-movers"


def at(hour, minute, second=0):
    return datetime(2026, 11, 25, hour, minute, second, tzinfo=HKT)


def world(**kwargs):
    base = {
        "runtime_dir": RUNTIME,
        "now": at(14, 40),
        "stamp": at(11, 49, 25),
        "stamp_text": "2026-11-25 11:49:25",
        "opend_listening": True,
        "opend_pids": [103847, 103857],
        "supervisor_running": False,
        "binary_ready": True,
        "interpreter_ready": True,
        "pane_prompt": "Please enter account",
        "sticky": "",
        "qot_logined": None,
        "qot_reason": "constructor_timeout",
        "fails": 0,
        "last_attempt_at": None,
        "previous_alert": None,
        "python": "/workspace/futu/.venv/bin/python",
        "lock_held": False,
    }
    base.update(kwargs)
    return base


class Plan(unittest.TestCase):
    def test_reboot_starts_one_pty_and_does_not_use_the_old_launcher(self):
        decided = once.plan(world(
            opend_listening=False, opend_pids=[], supervisor_running=False, pane_prompt="",
        ))
        self.assertEqual(decided["action"], "start_opend_pty")
        self.assertFalse(decided["pkill"])
        self.assertFalse(decided["start_opend_sh"])
        text = " ".join(decided["exec"])
        self.assertIn("tmux", decided["exec"][0])
        self.assertIn("new-session", decided["exec"])
        self.assertIn("-s", decided["exec"])
        self.assertNotIn("start_opend.sh", text)
        self.assertNotIn("pkill", text)
        self.assertNotIn("FUTU_LOGIN", text)
        self.assertIn("sleep 0.4; exec ./FutuOpenD", text)

    def test_process_without_a_port_is_not_killed(self):
        decided = once.plan(world(opend_listening=False, opend_pids=[103847]))
        self.assertEqual(decided["action"], "alert_opend_stuck")
        self.assertEqual(decided["exec"], [])
        self.assertFalse(decided["pkill"])

    def test_missing_binary_does_not_start_a_session(self):
        decided = once.plan(world(opend_listening=False, opend_pids=[], binary_ready=False))
        self.assertEqual(decided["action"], "alert_opend_binary_missing")
        self.assertEqual(decided["exec"], [])

    def test_account_prompt_and_not_logged_in_runs_one_console_login(self):
        effects = once.Effects()
        decided, _event = once.execute(world(), effects)
        self.assertEqual(decided["action"], "login_once")
        self.assertEqual(len(effects.spawned), 1)
        text = " ".join(effects.spawned[0])
        self.assertIn("opend_console_login.py", text)
        self.assertNotIn("opend_login.py", text)
        self.assertNotIn("FUTU_LOGIN", text)
        self.assertNotIn("publish", text)

    def test_login_success_starts_the_daemon_once(self):
        effects = once.Effects()
        effects.spawn = lambda argv: effects.spawned.append(list(argv)) or 0
        decided, _event = once.execute(world(), effects)
        self.assertEqual(decided["action"], "login_once")
        self.assertEqual(len(effects.spawned), 2)
        self.assertIn("daemon.sh", " ".join(effects.spawned[1]))
        self.assertEqual(effects.state["sticky"], "")
        self.assertEqual(effects.state["fails"], 0)

    def test_auth_and_otp_stick_and_do_not_login_again(self):
        for code, sticky in ((2, "auth_challenge"), (3, "auth_failed")):
            remembered = once.apply_login_result(world(), code)
            self.assertEqual(remembered["sticky"], sticky)
            decided = once.plan(remembered)
            self.assertEqual(decided["exec"], [])
            self.assertTrue(decided["action"].startswith("alert_"))

    def test_three_protocol_misses_stop(self):
        current = world()
        for _ in range(3):
            current = once.apply_login_result(current, 4)
        self.assertEqual(current["sticky"], "login_stopped")
        self.assertEqual(once.plan(current)["exec"], [])

    def test_backoff_skips_a_second_login(self):
        decided = once.plan(world(fails=1, last_attempt_at=at(14, 39, 50)))
        self.assertEqual(decided["action"], "noop_backoff")
        self.assertEqual(decided["exec"], [])

    def test_qot_true_starts_supervisor_without_login(self):
        decided = once.plan(world(qot_logined=True, qot_reason="qot_logined", pane_prompt=""))
        self.assertEqual(decided["action"], "start_supervisor_once")
        self.assertIn("daemon.sh", " ".join(decided["exec"]))
        self.assertNotIn("opend_console_login.py", " ".join(decided["exec"]))

    def test_qot_true_and_supervisor_running_does_not_start_another(self):
        decided = once.plan(world(
            qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
            stamp=at(15, 19, 16),
        ))
        self.assertEqual(decided["action"], "noop_supervisor_running")
        self.assertEqual(decided["exec"], [])
        self.assertEqual(decided["freshness"]["state"], "fresh")

    def test_lunch_is_not_trading_stale(self):
        decided = once.plan(world(
            now=at(12, 20), qot_logined=True, supervisor_running=True, stamp=at(11, 49, 25),
        ))
        self.assertEqual(decided["freshness"]["state"], "expected")
        self.assertEqual(decided["exec"], [])

    def test_bad_output_does_not_login(self):
        decided = once.plan(world(qot_reason="bad_output", qot_logined=None))
        self.assertEqual(decided["action"], "alert_qot_unconfirmed")
        self.assertEqual(decided["exec"], [])

    def test_missing_sdk_does_not_login_or_start_the_daemon(self):
        decided = once.plan(world(interpreter_ready=False, qot_logined=None, qot_reason=""))
        self.assertEqual(decided["action"], "alert_interpreter")
        self.assertEqual(decided["exec"], [])

    def test_banner_only_pane_does_not_login(self):
        decided = once.plan(world(pane_prompt=">>>", qot_reason="constructor_timeout"))
        self.assertEqual(decided["action"], "alert_account_prompt_missing")
        self.assertEqual(decided["exec"], [])

    def test_duplicate_alert_is_not_written_twice(self):
        first = once.Effects()
        decided, event = once.execute(world(sticky="auth_failed"), first)
        self.assertEqual(len(first.events), 1)
        second = once.Effects()
        again = world(sticky="auth_failed", previous_alert=event)
        _decided, event2 = once.execute(again, second)
        self.assertTrue(event2["duplicate"])
        self.assertEqual(second.events, [])
        self.assertEqual(decided["action"], "alert_auth_failed")

    def test_without_run_does_not_observe(self):
        def observe(_runtime):
            raise AssertionError("observed")

        code = once.main([], stdout=io.StringIO(), observe=observe, effects=once.Effects())
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
