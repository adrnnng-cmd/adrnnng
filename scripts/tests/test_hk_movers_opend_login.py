import io
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "hk-movers" / "runtime"))

import opend_login as ol  # noqa: E402

BANNER = b'Futu OpenD version info: 10.11.7108(20260916134500), Type "help" for more information.\n'
ACCOUNT = "acct-not-a-real-login"
PASSWORD = "pw-not-a-real-secret"


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class Script:
    def __init__(self, items):
        self.clock = Clock()
        self.items = list(items)
        self.sent = []
        self.closed = False

    def recv(self, timeout):
        if not self.items:
            self.clock.advance(timeout)
            raise TimeoutError()
        item = self.items.pop(0)
        if item is None:
            self.clock.advance(timeout)
            raise TimeoutError()
        self.clock.advance(0.01)
        return item

    def send(self, data):
        self.sent.append(data)

    def close(self):
        self.closed = True


def _run(items):
    script = Script(items)
    result = ol.run_login(script, ACCOUNT, PASSWORD, clock=script.clock)
    return script, result


def _text(result):
    return "\n".join(result["transcript"])


class Transcripts(unittest.TestCase):
    def test_banner_then_password_then_success_redacts_and_never_sends_help(self):
        self.assertEqual(len(BANNER), 87)
        script, result = _run([
            BANNER, None,
            b"Please enter password\n", None,
            b"Login successful\n", None,
        ])
        self.assertEqual(result["kind"], "ok")
        self.assertTrue(result["login_successful"])
        self.assertFalse(result["retry"])
        self.assertEqual(script.sent, [
            (ACCOUNT + "\r\n").encode(),
            (PASSWORD + "\r\n").encode(),
        ])
        self.assertNotIn(b"help\r\n", script.sent)
        blob = _text(result)
        self.assertNotIn(ACCOUNT, blob)
        self.assertNotIn(PASSWORD, blob)
        self.assertIn("<redacted:account>", blob)
        self.assertIn("<redacted:password>", blob)
        self.assertTrue(script.closed)

    def test_split_banner_is_still_one_account_line(self):
        script, result = _run([
            BANNER[:40], BANNER[40:], None,
            b"Please enter password\n", None,
            b"Login successful\n", None,
        ])
        self.assertEqual(result["kind"], "ok")
        self.assertEqual(script.sent[0], (ACCOUNT + "\r\n").encode())

    def test_password_before_account_sends_nothing(self):
        # Probe B: first input was consumed as the account. A connection that
        # is already asking for a password must not be given one.
        script, result = _run([b"Please enter password\n", None])
        self.assertEqual(result["kind"], "account_consumed")
        self.assertEqual(script.sent, [])
        self.assertFalse(result["password_sent"])
        self.assertFalse(result["retry"])

    def test_challenge_before_password_does_not_send_the_password(self):
        script, result = _run([
            BANNER, None,
            b"Input_phone_verify_code -code=\n", None,
        ])
        self.assertEqual(result["kind"], "auth_challenge")
        self.assertEqual(script.sent, [(ACCOUNT + "\r\n").encode()])
        self.assertFalse(result["password_sent"])
        self.assertFalse(result["retry"])

    def test_challenge_after_password_sends_no_code(self):
        script, result = _run([
            BANNER, None,
            b"Please enter password\n", None,
            b"req_pic_verify_code\n", None,
        ])
        self.assertEqual(result["kind"], "auth_challenge")
        self.assertEqual(len(script.sent), 2)
        self.assertNotIn(b"123456\r\n", script.sent)
        self.assertFalse(result["retry"])

    def test_login_failed_is_not_retried_and_echoed_secret_is_redacted(self):
        script, result = _run([
            BANNER, None,
            b"Please enter password\n", None,
            ("Login failed " + PASSWORD + "\n").encode(), None,
        ])
        self.assertEqual(result["kind"], "auth_failed")
        self.assertFalse(result["retry"])
        self.assertNotIn(PASSWORD, _text(result))
        self.assertNotIn(ACCOUNT, _text(result))

    def test_remember_after_password_sends_one_y(self):
        script, result = _run([
            BANNER, None,
            b"Please enter password\n", None,
            b"Remember the password? (Y/N)\n", None,
            b"Login successful\n", None,
        ])
        self.assertEqual(result["kind"], "ok")
        self.assertEqual(script.sent[-1], b"Y\r\n")
        self.assertEqual(script.sent.count(b"Y\r\n"), 1)

    def test_remember_before_password_then_success(self):
        script, result = _run([
            BANNER, None,
            b"Remember the password? (Y/N)\n", None,
            b"Please enter password\n", None,
            b"Login successful\n", None,
        ])
        self.assertEqual(result["kind"], "ok")
        self.assertEqual(script.sent[1], b"Y\r\n")
        self.assertEqual(script.sent[2], (PASSWORD + "\r\n").encode())

    def test_banner_with_no_follow_up_does_not_retry(self):
        script, result = _run([BANNER, None, None])
        self.assertEqual(result["kind"], "protocol_timeout")
        self.assertEqual(script.sent, [(ACCOUNT + "\r\n").encode()])
        self.assertFalse(result["retry"])


class Gate(unittest.TestCase):
    def test_qot_true_allows_supervisor(self):
        allowed, why = ol.supervisor_allowed("ok", True)
        self.assertTrue(allowed)
        self.assertEqual(why, "qot_logined")

    def test_constructor_timeout_does_not_allow_supervisor_or_another_login(self):
        allowed, why = ol.supervisor_allowed("ok", None)
        self.assertFalse(allowed)
        self.assertEqual(why, "qot_unconfirmed")

    def test_qot_false_is_not_an_implied_retry(self):
        allowed, why = ol.supervisor_allowed("ok", False)
        self.assertFalse(allowed)
        self.assertEqual(why, "qot_not_logined")


class Cli(unittest.TestCase):
    def _env(self):
        return {"FUTU_LOGIN_ACCOUNT": ACCOUNT, "FUTU_LOGIN_PWD": PASSWORD, "HK_MOVERS_PYTHON": "/tmp/no-such-venv/bin/python"}

    def test_success_path_exits_0_only_when_qot_is_true(self):
        script = Script([BANNER, None, b"Please enter password\n", None, b"Login successful\n", None])
        calls = {"qot": 0}

        def qot_runner(argv, cwd, timeout):
            calls["qot"] += 1
            self.assertEqual(cwd, "/tmp")
            self.assertEqual(timeout, 20)
            self.assertNotIn(ACCOUNT, " ".join(argv))
            self.assertNotIn(PASSWORD, " ".join(argv))
            return {"code": 0, "stdout": '{"ret": 0, "qot_logined": true}', "timed_out": False}

        buf = io.StringIO()
        code = ol.main(
            ["--qot-timeout", "20", "--transcript", "", "--outcome", ""],
            env=self._env(),
            connect=lambda host, port: script,
            import_runner=lambda argv, cwd, timeout: {"code": 0, "stdout": '{"ok": true, "version": "10.12.7208"}', "timed_out": False},
            qot_runner=qot_runner,
            stdout=buf,
        )
        self.assertEqual(code, 0)
        self.assertEqual(calls["qot"], 1)
        text = buf.getvalue()
        self.assertIn("start_supervisor=true", text)
        self.assertIn("qot_logined=true", text)
        self.assertNotIn(ACCOUNT, text)
        self.assertNotIn(PASSWORD, text)
        self.assertNotIn(ACCOUNT, _text({"transcript": []}))

    def test_constructor_timeout_exits_8_and_does_not_login_again(self):
        script = Script([BANNER, None, b"Please enter password\n", None, b"Login successful\n", None])
        connects = {"n": 0}

        def connect(host, port):
            connects["n"] += 1
            return script

        buf = io.StringIO()
        code = ol.main(
            ["--qot-timeout", "20"],
            env=self._env(),
            connect=connect,
            import_runner=lambda argv, cwd, timeout: {"code": 0, "stdout": '{"ok": true, "version": "10.12.7208"}', "timed_out": False},
            qot_runner=lambda argv, cwd, timeout: {"code": None, "stdout": "", "timed_out": True},
            stdout=buf,
        )
        self.assertEqual(code, 8)
        self.assertEqual(connects["n"], 1)
        self.assertIn("qot_logined=unknown", buf.getvalue())
        self.assertIn("qot_reason=constructor_timeout", buf.getvalue())
        self.assertIn("start_supervisor=false", buf.getvalue())
        self.assertNotIn(PASSWORD, buf.getvalue())

    def test_challenge_does_not_call_qot(self):
        script = Script([BANNER, None, b"Input_phone_verify_code -code=\n", None])
        called = {"qot": 0}

        def qot_runner(argv, cwd, timeout):
            called["qot"] += 1
            return {"code": 0, "stdout": '{"qot_logined": true}', "timed_out": False}

        buf = io.StringIO()
        code = ol.main(
            [],
            env=self._env(),
            connect=lambda host, port: script,
            import_runner=lambda argv, cwd, timeout: {"code": 0, "stdout": '{"ok": true, "version": "10.12.7208"}', "timed_out": False},
            qot_runner=qot_runner,
            stdout=buf,
        )
        self.assertEqual(code, 2)
        self.assertEqual(called["qot"], 0)
        self.assertIn("kind=auth_challenge", buf.getvalue())

    def test_missing_env_exits_6_without_connecting(self):
        def connect(host, port):
            raise AssertionError("connected")

        with self.assertRaises(SystemExit) as caught:
            ol.main([], env={}, connect=connect, stdout=io.StringIO())
        self.assertEqual(caught.exception.code, 6)

    def test_check_only_does_not_connect_and_reports_a_hang(self):
        def connect(host, port):
            raise AssertionError("connected")

        buf = io.StringIO()
        code = ol.main(
            ["--check-only", "--qot-timeout", "20"],
            env=self._env(),
            connect=connect,
            import_runner=lambda argv, cwd, timeout: {"code": 0, "stdout": '{"ok": true, "version": "10.12.7208"}', "timed_out": False},
            qot_runner=lambda argv, cwd, timeout: {"timed_out": True, "stdout": ""},
            stdout=buf,
        )
        self.assertEqual(code, 8)
        self.assertIn("login_successful=false", buf.getvalue())
        self.assertIn("start_supervisor=false", buf.getvalue())
        self.assertNotIn(ACCOUNT, buf.getvalue())


if __name__ == "__main__":
    unittest.main()
