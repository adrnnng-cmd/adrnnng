import io
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "hk-movers" / "runtime"))

import opend_console_login as oc  # noqa: E402

ACCOUNT = "acct-not-a-real-login"
PASSWORD = "pw-not-a-real-secret"
HOST_PANE = """Futu OpenD version info: 10.11.7108(20260916134500)
Start Time: 2026-11-25 15:05:05
Futu OpenD is running
Configuration file loaded successfully
Server started
Telnet Listening Address: 127.0.0.1:22222
API Listening Address: 127.0.0.1:11111
API RSA Enabled: No
Please enter account
>>>
"""


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, dt):
        self.t += dt


class Panes:
    def __init__(self, frames):
        self.frames = list(frames)
        self.pasted = []
        self.cleared = 0

    def capture(self):
        if len(self.frames) > 1:
            return self.frames.pop(0)
        return self.frames[0]

    def paste(self, line):
        self.pasted.append(line)

    def clear(self):
        self.cleared += 1


def _run(frames, step_wait=2):
    panes = Panes(frames)
    clock = Clock()
    result = oc.run_console(
        ACCOUNT, PASSWORD,
        capture=panes.capture, paste=panes.paste, clear_history=panes.clear,
        clock=clock, sleep=clock.sleep, step_wait=step_wait,
    )
    return panes, result


def _text(result):
    return "\n".join(result["transcript"])


class ConsoleProtocol(unittest.TestCase):
    def test_host_pane_sends_one_cr_per_line_and_masks_nothing_into_the_transcript(self):
        password_pane = HOST_PANE + ">>>" + ACCOUNT + "\nPlease enter password\n>>>\n"
        remember = password_pane + (
            "Please choose whether to remember the password "
            "(Y to remember, N not to remember)\n>>>\n"
        )
        success = remember + "Login successful\n"
        panes, result = _run([HOST_PANE, password_pane, remember, success])
        self.assertEqual(result["kind"], "ok")
        self.assertEqual(panes.pasted, [ACCOUNT + "\r", PASSWORD + "\r", "Y\r"])
        for line in panes.pasted:
            self.assertNotIn("\n", line)
            self.assertEqual(line.count("\r"), 1)
            self.assertTrue(line.endswith("\r"))
        blob = _text(result)
        self.assertNotIn(ACCOUNT, blob)
        self.assertNotIn(PASSWORD, blob)
        self.assertIn("send <redacted:account>", blob)
        self.assertIn("send <redacted:password>", blob)
        self.assertIn("send Y", blob)
        self.assertEqual(panes.cleared, 1)

    def test_login_failed_does_not_answer_the_next_account_prompt(self):
        password_pane = "Please enter password\n>>>\n"
        remember = (
            "Please choose whether to remember the password "
            "(Y to remember, N not to remember)\n>>>\n"
        )
        failed = (
            "Login failed,The account and password you've entered don't match. "
            "9 chances remained.\nPlease enter account\n>>>\n"
        )
        panes, result = _run([HOST_PANE, password_pane, remember, failed])
        self.assertEqual(result["kind"], "auth_failed")
        self.assertEqual(panes.pasted, [ACCOUNT + "\r", PASSWORD + "\r", "Y\r"])
        self.assertFalse(result["retry"])

    def test_banner_without_account_prompt_sends_nothing(self):
        panes, result = _run(["Futu OpenD version info: 10.11.7108\n>>>\n"])
        self.assertEqual(result["kind"], "account_prompt_missing")
        self.assertEqual(panes.pasted, [])

    def test_remember_before_password_sends_nothing(self):
        question = (
            "Please choose whether to remember the password "
            "(Y to remember, N not to remember)\n>>>\n"
        )
        panes, result = _run([question])
        self.assertEqual(result["kind"], "remember_before_password")
        self.assertEqual(panes.pasted, [])

    def test_password_prompt_before_our_account_sends_nothing(self):
        panes, result = _run(["Please enter password\n>>>\n"])
        self.assertEqual(result["kind"], "account_consumed")
        self.assertEqual(panes.pasted, [])

    def test_challenge_sends_no_code(self):
        panes, result = _run([HOST_PANE, "Input_phone_verify_code -code=\n"])
        self.assertEqual(result["kind"], "auth_challenge")
        self.assertEqual(panes.pasted, [ACCOUNT + "\r"])

    def test_challenge_after_remember_sends_no_code(self):
        panes, result = _run([
            HOST_PANE,
            "Please enter password\n>>>\n",
            "Please choose whether to remember the password (Y to remember, N not to remember)\n>>>\n",
            "Input_phone_verify_code -code=\n",
        ])
        self.assertEqual(result["kind"], "auth_challenge")
        self.assertEqual(panes.pasted, [ACCOUNT + "\r", PASSWORD + "\r", "Y\r"])
        self.assertNotIn("code=", "".join(panes.pasted))


class Cli(unittest.TestCase):
    def test_success_exits_0_only_when_qot_is_true_and_argv_has_no_secret(self):
        panes = Panes([
            HOST_PANE,
            "Please enter password\n>>>\n",
            "Please choose whether to remember the password (Y to remember, N not to remember)\n>>>\n",
            "Login successful\n",
        ])
        seen = {}

        def qot_runner(argv, cwd, timeout):
            seen["cwd"] = cwd
            seen["argv"] = argv
            return {"code": 0, "stdout": '{"ret": 0, "qot_logined": true}', "timed_out": False}

        buf = io.StringIO()
        code = oc.main(
            ["--qot-timeout", "20", "--transcript", "", "--outcome", ""],
            env={"FUTU_LOGIN_ACCOUNT": ACCOUNT, "FUTU_LOGIN_PWD": PASSWORD, "HK_MOVERS_PYTHON": "/tmp/no-such-venv/bin/python"},
            capture=panes.capture,
            paste=panes.paste,
            clear_history=panes.clear,
            clock=Clock(),
            sleep=lambda dt: None,
            import_runner=lambda argv, cwd, timeout: {"code": 0, "stdout": '{"ok": true, "version": "10.12.7208"}', "timed_out": False},
            qot_runner=qot_runner,
            stdout=buf,
        )
        self.assertEqual(code, 0)
        self.assertEqual(seen["cwd"], "/tmp")
        self.assertNotIn(ACCOUNT, " ".join(seen["argv"]))
        self.assertNotIn(PASSWORD, " ".join(seen["argv"]))
        self.assertIn("start_supervisor=true", buf.getvalue())
        self.assertNotIn(ACCOUNT, buf.getvalue())
        self.assertNotIn(PASSWORD, buf.getvalue())


if __name__ == "__main__":
    unittest.main()
