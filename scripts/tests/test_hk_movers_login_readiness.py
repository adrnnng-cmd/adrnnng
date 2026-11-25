import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "hk-movers" / "runtime"))

import login_readiness as lr  # noqa: E402


class Banner(unittest.TestCase):
    def test_empty_buffer_is_not_an_auth_result(self):
        self.assertEqual(lr.classify_banner(""), lr.STARTUP_NOT_READY)
        self.assertEqual(lr.classify_banner("\x00\xff\xfb\x01"), lr.STARTUP_NOT_READY)

    def test_account_prompt_is_stdin_stage(self):
        got = lr.classify_banner("Please enter account: ")
        self.assertEqual(got, lr.AWAITING_ACCOUNT)

    def test_password_prompt_is_telnet_stage(self):
        self.assertEqual(lr.classify_banner("Please enter password: "), lr.AWAITING_PASSWORD)

    def test_remember_question_is_not_the_password_prompt(self):
        question = "Please choose whether to remember the password (Y to remember, N not to remember)"
        self.assertEqual(lr.classify_banner(question), lr.AWAITING_REMEMBER)
        self.assertNotEqual(lr.classify_banner(question), lr.AWAITING_PASSWORD)
        self.assertEqual(lr.classify_banner("Please enter password"), lr.AWAITING_PASSWORD)
        self.assertEqual(
            lr.classify_banner(question + "\nPlease enter password"),
            lr.AWAITING_PASSWORD,
        )

    def test_login_successful(self):
        self.assertEqual(lr.classify_banner("Login successful"), lr.OK)

    def test_verify_code_is_a_real_challenge_and_not_a_retry(self):
        for text in (
            "please input_phone_verify_code -code=",
            "req_pic_verify_code",
            "graphic verification required",
        ):
            self.assertEqual(lr.classify_banner(text), lr.AUTH_CHALLENGE, text)

    def test_launcher_no_prompt_sentence_is_not_auth_failed(self):
        self.assertEqual(
            lr.classify_banner("Login failed (no account prompt)"),
            lr.STARTUP_NOT_READY,
        )

    def test_opend_login_failed_text_is_auth_failed(self):
        self.assertEqual(lr.classify_banner("登录失败，找不到记住密码信息"), lr.AUTH_FAILED)
        self.assertEqual(lr.classify_banner("Login failed: wrong password"), lr.AUTH_FAILED)


class LauncherOutcome(unittest.TestCase):
    def test_no_account_prompt_is_false_needs_relogin(self):
        got = lr.classify_launcher_result(
            "needs_relogin\n",
            "Login failed (no account prompt)",
            banner="",
        )
        self.assertEqual(got["kind"], lr.STARTUP_NOT_READY)
        self.assertTrue(got["false_needs_relogin"])
        self.assertFalse(got["retry"])
        self.assertEqual(got["action"], lr.STOP_DO_NOT_RELAUNCH)

    def test_same_outcome_file_after_a_real_login_reply_is_auth_failed(self):
        got = lr.classify_launcher_result("needs_relogin", "Login failed", banner="Login failed")
        self.assertEqual(got["kind"], lr.AUTH_FAILED)
        self.assertFalse(got["false_needs_relogin"])
        self.assertEqual(got["action"], lr.STOP_DO_NOT_RETRY)
        self.assertFalse(got["retry"])

    def test_outcome_file_alone_does_not_become_auth_failed(self):
        got = lr.classify_launcher_result("needs_relogin", "")
        self.assertEqual(got["kind"], lr.STARTUP_NOT_READY)
        self.assertTrue(got["false_needs_relogin"])

    def test_telnet_down_is_not_retried_by_this_classifier(self):
        got = lr.classify_launcher_result("needs_relogin", "telnet not up")
        self.assertEqual(got["kind"], lr.TELNET_DOWN)
        self.assertEqual(got["action"], lr.BOUNDED_WAIT_EXHAUSTED)
        self.assertFalse(got["retry"])

    def test_challenge_stops_for_the_operator(self):
        got = lr.classify_launcher_result(
            "needs_relogin",
            "Login failed",
            banner="Input_phone_verify_code -code=",
        )
        self.assertEqual(got["kind"], lr.AUTH_CHALLENGE)
        self.assertEqual(got["action"], lr.STOP_OPERATOR_VERIFICATION)
        self.assertFalse(got["retry"])

    def test_ok_allows_one_supervisor_start(self):
        got = lr.classify_launcher_result("ok", "Login successful", banner="Login successful")
        self.assertEqual(got["kind"], lr.OK)
        self.assertEqual(got["action"], lr.START_SUPERVISOR_ONCE)
        self.assertFalse(got["retry"])


class BoundedRead(unittest.TestCase):
    def test_prompt_inside_the_wait_returns_once(self):
        got = lr.readiness_from_chunks([(0.2, "noise"), (1.0, "Please enter account")], wait_s=12)
        self.assertEqual(got["kind"], lr.AWAITING_ACCOUNT)
        self.assertEqual(got["waited_s"], 1.0)
        self.assertFalse(got["exhausted"])
        self.assertFalse(got["retry"])

    def test_empty_until_deadline_is_not_needs_relogin_retry(self):
        # 14:28 shape: telnet accepted, 12s, no account prompt.
        got = lr.readiness_from_chunks([(0.1, ""), (11.9, "\xff\xfd\x01")], wait_s=12)
        self.assertEqual(got["kind"], lr.STARTUP_NOT_READY)
        self.assertTrue(got["exhausted"])
        self.assertFalse(got["retry"])
        self.assertEqual(got["action"], lr.STOP_DO_NOT_RELAUNCH)

    def test_chunks_after_the_deadline_are_ignored(self):
        got = lr.readiness_from_chunks([(12.1, "Please enter account")], wait_s=12)
        self.assertEqual(got["kind"], lr.STARTUP_NOT_READY)
        self.assertTrue(got["exhausted"])

    def test_version_banner_alone_does_not_send_the_account(self):
        banner = 'Futu OpenD version info: 10.11.7108(20260916134500), Type "help" for more information.\n'
        self.assertEqual(len(banner.encode()), 87)
        got = lr.readiness_from_chunks([(0.2, banner)], wait_s=12)
        self.assertEqual(got["kind"], lr.VERSION_BANNER)
        self.assertEqual(got["action"], lr.WAIT_FOR_ACCOUNT_PROMPT)
        self.assertFalse(got["exhausted"])
        self.assertFalse(got["retry"])
        prompted = lr.readiness_from_chunks([(0.2, banner + "Please enter account\n")], wait_s=12)
        self.assertEqual(prompted["kind"], lr.AWAITING_ACCOUNT)
        self.assertEqual(prompted["action"], lr.SEND_ACCOUNT_ON_TELNET)
        classified = lr.classify_launcher_result(
            "needs_relogin", "Login failed (no account prompt)", banner=banner,
        )
        self.assertEqual(classified["kind"], lr.VERSION_BANNER)
        self.assertTrue(classified["false_needs_relogin"])
        self.assertFalse(classified["retry"])

    def test_password_prompt_without_our_account_does_not_send_a_password(self):
        got = lr.readiness_from_chunks([(0.4, "Please enter password")], wait_s=12)
        self.assertEqual(got["kind"], lr.AWAITING_PASSWORD)
        self.assertEqual(got["action"], lr.DO_NOT_SEND_PASSWORD)


if __name__ == "__main__":
    unittest.main()
