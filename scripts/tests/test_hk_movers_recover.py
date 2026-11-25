import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "hk-movers" / "runtime"))

import recover  # noqa: E402

HKT = timezone(timedelta(hours=8))


def at(hour, minute, second=0, day=25):
    return datetime(2026, 11, day, hour, minute, second, tzinfo=HKT)


def obs(**kwargs):
    base = {
        "recover_lock_held": False,
        "opend_listening": True,
        "supervisor_running": False,
        "login_kind": None,
        "qot_logined": None,
        "interpreter_ready": True,
        "now": at(14, 40),
        "stamp": at(11, 49, 25),
        "fails": 0,
        "last_attempt_at": None,
    }
    base.update(kwargs)
    return base


class Recovery(unittest.TestCase):
    def test_reboot_with_opend_down_does_not_pkill_or_launch_the_old_script(self):
        decided = recover.decide(obs(opend_listening=False, supervisor_running=False))
        self.assertEqual(decided["action"], "alert_opend_down")
        self.assertEqual(decided["commands"], [])
        self.assertFalse(decided["pkill"])
        self.assertFalse(decided["start_opend_sh"])
        self.assertFalse(decided["retry"])

    def test_duplicate_watchdog_is_a_noop(self):
        decided = recover.decide(obs(recover_lock_held=True, qot_logined=True, login_kind="ok"))
        self.assertEqual(decided["action"], "noop_duplicate")
        self.assertEqual(decided["commands"], [])

    def test_healthy_supervisor_does_not_start_another(self):
        decided = recover.decide(obs(
            supervisor_running=True, login_kind="ok", qot_logined=True, stamp=at(14, 39),
        ))
        self.assertEqual(decided["action"], "noop_supervisor_running")
        self.assertEqual(decided["freshness"]["state"], "fresh")
        self.assertEqual(decided["commands"], [])

    def test_unverified_login_uses_the_console_helper(self):
        decided = recover.decide(obs(login_kind=None, qot_logined=None))
        self.assertEqual(decided["action"], "run_login_once")
        self.assertEqual(decided["commands"], ["opend_console_login.py"])
        self.assertNotIn("opend_login.py", decided["commands"])

    def test_auth_failure_and_challenge_do_not_retry_or_start_supervisor(self):
        for kind, action in (("auth_failed", "alert_auth_failed"), ("auth_challenge", "alert_auth_challenge")):
            decided = recover.decide(obs(login_kind=kind, qot_logined=None))
            self.assertEqual(decided["action"], action)
            self.assertEqual(decided["commands"], [])
            self.assertFalse(decided["retry"])

    def test_missing_interpreter_blocks_supervisor_after_login(self):
        decided = recover.decide(obs(login_kind="ok", qot_logined=True, interpreter_ready=False))
        self.assertEqual(decided["action"], "alert_interpreter")
        self.assertNotIn("daemon.sh", " ".join(decided["commands"]))

    def test_qot_unknown_after_telnet_success_does_not_start_or_relogin(self):
        decided = recover.decide(obs(login_kind="ok", qot_logined=None, interpreter_ready=True))
        self.assertEqual(decided["action"], "alert_qot_unconfirmed")
        self.assertEqual(decided["reason"], "constructor_timeout")
        self.assertEqual(decided["commands"], [])
        self.assertFalse(decided["retry"])

    def test_stale_afternoon_snapshot_starts_supervisor_once_when_qot_is_true(self):
        decided = recover.decide(obs(login_kind="ok", qot_logined=True))
        self.assertEqual(decided["freshness"]["state"], "stale_trading")
        self.assertEqual(decided["freshness"]["collected_at"], "2026-11-25 11:49:25")
        self.assertEqual(decided["quote_as_of"], "unknown")
        self.assertEqual(decided["action"], "start_supervisor_once")
        self.assertTrue(decided["collect_due"])
        self.assertIn("/workspace/futu/hk-movers/daemon.sh", decided["commands"])
        self.assertNotIn("start_opend.sh", decided["commands"])

    def test_two_afternoon_cycles_do_not_start_a_second_supervisor(self):
        first = recover.decide(obs(login_kind="ok", qot_logined=True, now=at(14, 40), stamp=at(11, 49, 25)))
        self.assertEqual(first["action"], "start_supervisor_once")
        running = recover.decide(obs(
            login_kind="ok", qot_logined=True, supervisor_running=True,
            now=at(14, 46), stamp=at(14, 46),
        ))
        self.assertEqual(running["freshness"]["state"], "fresh")
        self.assertEqual(running["commands"], [])
        later = recover.decide(obs(
            login_kind="ok", qot_logined=True, supervisor_running=True,
            now=at(14, 52), stamp=at(14, 46),
        ))
        self.assertEqual(later["freshness"]["state"], "stale_trading")
        self.assertEqual(later["action"], "alert_stale_while_supervisor_running")
        self.assertEqual(later["commands"], [])

    def test_lunch_and_closed_are_not_trading_failures(self):
        lunch = recover.decide(obs(now=at(12, 30), stamp=at(11, 49, 25), login_kind="ok", qot_logined=True, supervisor_running=True))
        self.assertEqual(lunch["freshness"]["state"], "expected")
        self.assertEqual(lunch["freshness"]["session"], "lunch")
        weekend = recover.freshness(at(10, 0, day=28), at(11, 49, 25))
        self.assertEqual(weekend["session"], "closed")
        self.assertEqual(weekend["state"], "expected")

    def test_backoff_blocks_a_second_login_attempt(self):
        decided = recover.decide(obs(fails=1, last_attempt_at=at(14, 39, 50), now=at(14, 40)))
        self.assertEqual(decided["action"], "noop_backoff")
        self.assertFalse(decided["retry"])

    def test_alert_fingerprint_collapses_repeats(self):
        decided = recover.decide(obs(opend_listening=False))
        first = recover.next_alert(None, decided, at(14, 40), "2026-11-25 11:49:25")
        second = recover.next_alert(first, decided, at(14, 45), "2026-11-25 11:49:25")
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(second["repeat"], 2)
        self.assertNotIn("password", second["fingerprint"])
        self.assertNotIn("11:49:25", first["fingerprint"])
        advanced = recover.next_alert(first, decided, at(14, 50), "2026-11-25 15:26:11")
        self.assertTrue(advanced["duplicate"])
        self.assertNotIn("15:26:11", advanced["fingerprint"])


if __name__ == "__main__":
    unittest.main()
