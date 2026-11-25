import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

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
    def test_a_busy_port_without_an_owned_process_does_not_start(self):
        cases = (
            (True, False, [], "api_busy"),
            (False, True, [], "telnet_busy"),
            (True, True, [], "ports_busy_unowned"),
        )
        for api_open, telnet_open, pids, reason in cases:
            decided = once.plan(world(
                api_open=api_open, telnet_open=telnet_open, opend_pids=pids,
                opend_listening=api_open and telnet_open, pane_prompt="",
            ))
            self.assertEqual(decided["action"], "alert_port_busy", reason)
            self.assertEqual(decided["reason"], reason)
            self.assertEqual(decided["exec"], [])
        owned = once.plan(world(
            api_open=False, telnet_open=False, opend_listening=False, opend_pids=[103847], pane_prompt="",
        ))
        self.assertEqual(owned["action"], "alert_opend_stuck")
        self.assertEqual(owned["exec"], [])
        start = once.plan(world(
            api_open=False, telnet_open=False, opend_listening=False, opend_pids=[], pane_prompt="",
        ))
        self.assertEqual(start["action"], "start_opend_pty")
        self.assertTrue(start["exec"])
        self.assertNotIn("FUTU_LOGIN", " ".join(start["exec"]))

    def test_healthy_stamp_advance_is_not_a_new_fingerprint(self):
        first = once.plan(world(
            qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
            stamp=at(15, 19, 16), stamp_text="2026-11-25 15:19:16", now=at(15, 24),
        ))
        second = once.plan(world(
            qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
            stamp=at(15, 26, 11), stamp_text="2026-11-25 15:26:11", now=at(15, 31),
        ))
        self.assertEqual(first["action"], "noop_supervisor_running")
        left = once.recover.alert_fingerprint(first, "2026-11-25 15:19:16")
        right = once.recover.alert_fingerprint(second, "2026-11-25 15:26:11")
        self.assertEqual(left, right)
        self.assertNotIn("15:19:16", left)
        self.assertNotIn("15:26:11", right)

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
        current = world(interpreter_ready=False, qot_logined=None, qot_reason="", pin=once.PIN)
        decided = once.plan(current)
        self.assertEqual(decided["action"], "alert_missing_deps")
        self.assertEqual(decided["reason"], "venv_missing")
        self.assertEqual(decided["pin"], once.PIN)
        self.assertEqual(decided["exec"], [])
        effects = once.Effects()
        once.execute(current, effects)
        self.assertEqual(effects.spawned, [])
        self.assertIn(once.PIN, effects.events[0]["pin"])
        self.assertEqual(effects.events[0]["quote_as_of"], "unknown")
        self.assertEqual(effects.events[0]["collected_at_role"], "collector_start")

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


SCRIPT = ROOT / "scripts" / "hk-movers" / "runtime" / "recover_once.py"
PREVENTION = ROOT / "scripts" / "hk-movers" / "runtime" / "PREVENTION.md"


def run_script(tmp, body):
    path = Path(tmp) / "world.json"
    path.write_text(json.dumps(body))
    env = {"PATH": os.environ.get("PATH", ""), "HOME": tmp}
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "--run", "--dir", tmp, "--world", str(path)],
        capture_output=True, text=True, env=env, check=False,
    )
    return done


class Executable(unittest.TestCase):
    def observation(self, **kwargs):
        body = {
            "now": "2026-11-25 14:40:00",
            "stamp": "2026-11-25 11:49:25",
            "stamp_text": "2026-11-25 11:49:25",
            "api_open": True,
            "telnet_open": True,
            "pids": [103847, 103857],
            "supervisor_running": False,
            "binary_ready": True,
            "interpreter_ready": True,
            "pane_prompt": "Please enter account",
            "sticky": "",
            "qot_logined": None,
            "qot_reason": "constructor_timeout",
            "auth_material": True,
            "pin": once.PIN,
            "python": "/workspace/futu/.venv/bin/python",
        }
        body.update(kwargs)
        return body

    def test_system_python_starts_and_alerts_when_the_venv_is_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            decoy = Path(tmp) / "secrets.env"
            decoy.write_text("FUTU_LOGIN_PWD=do-not-read\n")
            before = decoy.read_text()
            done = run_script(tmp, self.observation(
                api_open=False, telnet_open=False, pids=[], interpreter_ready=False, pane_prompt="",
            ))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("action=start_opend_pty", done.stdout)
            self.assertIn("quote_as_of=unknown", done.stdout)
            log = (Path(tmp) / "recover-events.log").read_text()
            self.assertIn("alert_missing_deps venv_missing", log)
            self.assertIn("pin=" + once.PIN, log)
            self.assertIn("collected_at=collector_start", log)
            spawned = json.loads((Path(tmp) / "spawned.json").read_text())
            self.assertIn("tmux", spawned[0][0])
            self.assertNotIn("pip", json.dumps(spawned))
            self.assertNotIn(".venv", json.dumps(spawned))
            self.assertFalse((Path(tmp) / ".venv").exists())
            self.assertEqual(decoy.read_text(), before)
            again = run_script(tmp, self.observation(
                api_open=False, telnet_open=False, pids=[], interpreter_ready=False, pane_prompt="",
            ))
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertEqual(log, (Path(tmp) / "recover-events.log").read_text())

    def test_console_boot_login_then_daemon_uses_system_python(self):
        with tempfile.TemporaryDirectory() as tmp:
            done = run_script(tmp, self.observation())
            self.assertEqual(done.returncode, 0, done.stderr)
            spawned = json.loads((Path(tmp) / "spawned.json").read_text())
            self.assertEqual(spawned[0][0], "/usr/bin/python3")
            self.assertIn("opend_console_login.py", spawned[0][1])
            self.assertIn("/workspace/futu/.venv/bin/python", spawned[0][6:])
            self.assertIn("daemon.sh", " ".join(spawned[1]))
            self.assertNotIn("FUTU_LOGIN", json.dumps(spawned))
            self.assertNotIn("start_opend.sh", json.dumps(spawned))

    def test_missing_auth_material_sticks_without_a_second_guess(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = self.observation(auth_material=False)
            first = run_script(tmp, body)
            self.assertIn("action=alert_authmaterialmissing", first.stdout)
            self.assertFalse((Path(tmp) / "spawned.json").exists())
            state = json.loads((Path(tmp) / "recover-state.json").read_text())
            self.assertEqual(state["sticky"], "authmaterialmissing")
            second = run_script(tmp, body)
            self.assertIn("duplicate=true", second.stdout)
            lines = (Path(tmp) / "recover-events.log").read_text().splitlines()
            self.assertEqual(1, len(lines))
            self.assertIn("alert_authmaterialmissing", lines[0])
            self.assertFalse((Path(tmp) / "spawned.json").exists())

    def test_auth_failure_is_not_attempted_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            done = run_script(tmp, self.observation(sticky="auth_failed", qot_logined=False, qot_reason="qot_not_logined"))
            self.assertIn("action=alert_auth_failed", done.stdout)
            self.assertFalse((Path(tmp) / "spawned.json").exists())

    def test_dead_process_duplicate_and_healthy_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            dead = run_script(tmp, self.observation(api_open=False, telnet_open=False, pids=[103847]))
            self.assertIn("action=alert_opend_stuck", dead.stdout)
            self.assertFalse((Path(tmp) / "spawned.json").exists())
        with tempfile.TemporaryDirectory() as tmp:
            locked = run_script(tmp, self.observation(lock_held=True))
            self.assertIn("action=noop_duplicate", locked.stdout)
            self.assertFalse((Path(tmp) / "spawned.json").exists())
        with tempfile.TemporaryDirectory() as tmp:
            healthy = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
                stamp="2026-11-25 15:19:16",
            ))
            self.assertIn("action=noop_supervisor_running", healthy.stdout)
            self.assertIn("quote_as_of=unknown", healthy.stdout)
            self.assertFalse((Path(tmp) / "spawned.json").exists())

    def test_lunch_is_expected_and_afternoon_stale_is_deduped(self):
        with tempfile.TemporaryDirectory() as tmp:
            lunch = run_script(tmp, self.observation(
                now="2026-11-25 12:20:00", qot_logined=True, qot_reason="qot_logined",
                supervisor_running=True,
            ))
            self.assertIn("action=noop_supervisor_running", lunch.stdout)
            self.assertIn("freshness=expected", lunch.stdout)
        with tempfile.TemporaryDirectory() as tmp:
            stale = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
            ))
            self.assertIn("action=alert_stale_while_supervisor_running", stale.stdout)
            self.assertIn("freshness=stale_trading", stale.stdout)
            again = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
            ))
            self.assertIn("duplicate=true", again.stdout)
            self.assertEqual(1, (Path(tmp) / "recover-events.log").read_text().count("alert_stale"))

    def test_qot_true_records_one_daemon_start(self):
        with tempfile.TemporaryDirectory() as tmp:
            done = run_script(tmp, self.observation(qot_logined=True, qot_reason="qot_logined", pane_prompt=""))
            spawned = json.loads((Path(tmp) / "spawned.json").read_text())
            self.assertEqual(spawned, [["setsid", "nohup", "bash", "/workspace/futu/hk-movers/daemon.sh"]])
            self.assertIn("action=start_supervisor_once", done.stdout)

    def test_ports_and_healthy_stamps_do_not_spawn_or_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            for api_open, telnet_open in ((True, False), (False, True), (True, True)):
                done = run_script(tmp, self.observation(
                    api_open=api_open, telnet_open=telnet_open, pids=[], pane_prompt="",
                ))
                self.assertIn("action=alert_port_busy", done.stdout, done.stdout)
                self.assertNotIn("start_opend_pty", done.stdout)
            self.assertFalse((Path(tmp) / "spawned.json").exists())
            owned = run_script(tmp, self.observation(
                api_open=False, telnet_open=False, pids=[103847], pane_prompt="",
            ))
            self.assertIn("action=alert_opend_stuck", owned.stdout)
            start = run_script(tmp, self.observation(
                api_open=False, telnet_open=False, pids=[], pane_prompt="", binary_ready=True,
                interpreter_ready=True,
            ))
            self.assertIn("action=start_opend_pty", start.stdout)
            spawned = json.loads((Path(tmp) / "spawned.json").read_text())
            self.assertEqual(spawned[0][0], "tmux")
        env = {
            "PATH": "/usr/bin",
            "FUTU_LOGIN_ACCOUNT": "not-used",
            "FUTU_LOGIN_PWD": "not-used",
        }
        opened = once.spawn_env(["tmux", "new-session"], env)
        self.assertNotIn("FUTU_LOGIN_ACCOUNT", opened)
        self.assertNotIn("FUTU_LOGIN_PWD", opened)
        helper = once.spawn_env(["/usr/bin/python3", "opend_console_login.py"], env)
        self.assertEqual(helper["FUTU_LOGIN_ACCOUNT"], "not-used")
        self.assertTrue(str(once.daemon_log_path("/workspace/futu/hk-movers")).endswith("daemon.log"))
        self.assertNotIn("null", once.daemon_log_path("/workspace/futu/hk-movers").name)

    def test_healthy_advance_is_silent_and_recovery_is_one_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
                now="2026-11-25 15:24:00", stamp="2026-11-25 15:19:16",
                stamp_text="2026-11-25 15:19:16",
            ))
            self.assertIn("action=noop_supervisor_running", first.stdout)
            self.assertIn("freshness=fresh", first.stdout)
            self.assertFalse((Path(tmp) / "recover-events.log").exists())
            second = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
                now="2026-11-25 15:31:00", stamp="2026-11-25 15:26:11",
                stamp_text="2026-11-25 15:26:11",
            ))
            self.assertIn("action=noop_supervisor_running", second.stdout)
            self.assertFalse((Path(tmp) / "recover-events.log").exists())
            state = json.loads((Path(tmp) / "recover-state.json").read_text())
            self.assertNotIn("15:26:11", state["alert"]["fingerprint"])
            self.assertNotIn("15:19:16", state["alert"]["fingerprint"])
        with tempfile.TemporaryDirectory() as tmp:
            stale = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
                now="2026-11-25 14:40:00", stamp="2026-11-25 11:49:25",
                stamp_text="2026-11-25 11:49:25",
            ))
            self.assertIn("action=alert_stale_while_supervisor_running", stale.stdout)
            still = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
                now="2026-11-25 14:45:00", stamp="2026-11-25 11:50:00",
                stamp_text="2026-11-25 11:50:00",
            ))
            self.assertIn("duplicate=true", still.stdout)
            recovered = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
                now="2026-11-25 15:31:00", stamp="2026-11-25 15:26:11",
                stamp_text="2026-11-25 15:26:11",
            ))
            self.assertIn("action=noop_supervisor_running", recovered.stdout)
            log = (Path(tmp) / "recover-events.log").read_text()
            self.assertEqual(1, log.count("alert_recovered"))
            self.assertIn("stale_to_fresh", log)
            self.assertIn("notify=1", log)
            later = run_script(tmp, self.observation(
                qot_logined=True, qot_reason="qot_logined", supervisor_running=True,
                now="2026-11-25 15:40:00", stamp="2026-11-25 15:36:06",
                stamp_text="2026-11-25 15:36:06",
            ))
            self.assertIn("action=noop_supervisor_running", later.stdout)
            self.assertEqual(log, (Path(tmp) / "recover-events.log").read_text())
            self.assertFalse((Path(tmp) / "spawned.json").exists())

    def test_caller_contract_is_system_python(self):
        self.assertTrue(SCRIPT.read_text().startswith("#!/usr/bin/python3\n"))
        text = PREVENTION.read_text()
        self.assertIn("/usr/bin/python3 /workspace/futu/hk-movers/recover_once.py", text)
        self.assertNotIn(".venv/bin/python /workspace/futu/hk-movers/recover_once.py", text)
        command = once.bootstrap_command(
            "/usr/bin/python3", "/workspace/futu/.venv", "/workspace/futu/hk-movers/requirements-futu.txt",
        )
        self.assertEqual(command[0][0], "/usr/bin/python3")
        self.assertIn("futu-api", Path(ROOT / "scripts/hk-movers/runtime/requirements-futu.txt").read_text())
        self.assertEqual(once.read_pin("\n# comment\nfutu-api==10.12.7208\n"), once.PIN)


if __name__ == "__main__":
    unittest.main()
