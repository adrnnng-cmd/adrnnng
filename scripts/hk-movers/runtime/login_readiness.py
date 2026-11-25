"""Classify an OpenD launcher result without contacting OpenD.

Official behaviour this encodes (Futu API Doc v10.12):

- Command Line OpenD, from 10.10, starts in interactive login and prompts
  for account, password, and whether to remember the password
  (https://openapi.futunn.com/futu-api-doc/en/opend/opend-cmd.html).
  The non-interactive follow-up is
  ``FutuOpenD -login_account=<account> -login_by_remember=1``.
- Telnet is the operation-command channel (help, relogin,
  input_phone_verify_code, input_pic_verify_code). It starts with OpenD,
  before login finishes
  (https://openapi.futunn.com/futu-api-doc/en/opend/opend-operate.html).
  A listening telnet port is not a login result.

``start_opend.sh`` writes ``needs_relogin`` both when telnet never shows
``Please enter account`` and when a real login reply lacks ``login
successful``. Those are different. The 30 Oct prompt-order handling
(remember before password) runs only after the account prompt was seen,
so a no-prompt exit never reaches it.
"""

from __future__ import annotations

OK = "ok"
AWAITING_ACCOUNT = "awaiting_account"
AWAITING_PASSWORD = "awaiting_password"
AWAITING_REMEMBER = "awaiting_remember"
VERSION_BANNER = "version_banner"
ACCOUNT_CONSUMED = "account_consumed"
REMEMBER_BEFORE_PASSWORD = "remember_before_password"
PASSWORD_NOT_SENT = "password_not_sent"
AUTH_CHALLENGE = "auth_challenge"
AUTH_FAILED = "auth_failed"
STARTUP_NOT_READY = "startup_not_ready"
TELNET_DOWN = "telnet_down"

# None of these relaunch start_opend.sh. A password is sent only by
# opend_login.py after that same connection has sent the account.
STOP_DO_NOT_RELAUNCH = "stop_do_not_relaunch"
STOP_OPERATOR_VERIFICATION = "stop_operator_verification"
STOP_DO_NOT_RETRY = "stop_do_not_retry"
SEND_ACCOUNT_ON_TELNET = "send_account_on_telnet"
DO_NOT_SEND_PASSWORD = "do_not_send_password"
SEND_REMEMBER_Y = "send_remember_y"
START_SUPERVISOR_ONCE = "start_supervisor_once"
BOUNDED_WAIT_EXHAUSTED = "bounded_wait_exhausted"


def _low(text: str) -> str:
    return (text or "").lower()


def classify_banner(text: str) -> str:
    """Classify one captured console or telnet buffer. Sends nothing."""
    blob = _low(text)
    if not blob.strip():
        return STARTUP_NOT_READY
    if any(
        needle in blob
        for needle in (
            "input_phone_verify_code",
            "req_phone_verify_code",
            "input_pic_verify_code",
            "req_pic_verify_code",
            "phone verification",
            "graphic verification",
            "验证码",
        )
    ):
        return AUTH_CHALLENGE
    if "login successful" in blob or "登录成功" in blob:
        return OK
    if "no account prompt" in blob:
        return STARTUP_NOT_READY
    # Failure text before prompt text. A remembered-password miss contains 密码
    # and must not be read as "please enter password". A transcript that already
    # contains "login successful" was returned above.
    if any(
        needle in blob
        for needle in (
            "login failed",
            "登录失败",
            "password error",
            "wrong password",
            "密码错误",
            "找不到记住密码",
        )
    ):
        return AUTH_FAILED
    if "please enter password" in blob or "请输入密码" in blob or "请输入您的密码" in blob:
        return AWAITING_PASSWORD
    if "please enter account" in blob or "请输入账号" in blob or "请输入帐户" in blob:
        return AWAITING_ACCOUNT
    if "remember" in blob:
        return AWAITING_REMEMBER
    # OpenD 10.11.7108 sends this instead of "Please enter account".
    # The line also says Type "help"; that word is not a command to send.
    if "opend version info" in blob or "futu opend version" in blob:
        return VERSION_BANNER
    return STARTUP_NOT_READY


def classify_launcher_result(outcome: str, message: str = "", banner: str = "") -> dict:
    """Map the launcher's outcome file plus its own stdout line.

    ``needs_relogin`` with ``Login failed (no account prompt)`` is
    ``startup_not_ready``. No credential was submitted, so it is not
    ``auth_failed`` and must not be retried by running the launcher again.
    """
    outcome_l = _low(outcome).strip()
    message_l = _low(message)
    banner_class = classify_banner(banner) if banner else ""

    if banner_class == AUTH_CHALLENGE:
        kind = AUTH_CHALLENGE
    elif banner_class == VERSION_BANNER:
        kind = VERSION_BANNER
    elif banner_class == AWAITING_PASSWORD and ("no account prompt" in message_l or outcome_l == "needs_relogin"):
        kind = ACCOUNT_CONSUMED
    elif "telnet not up" in message_l:
        kind = TELNET_DOWN
    elif "no account prompt" in message_l:
        kind = STARTUP_NOT_READY
    elif banner_class == OK or outcome_l == "ok":
        kind = OK
    elif banner_class in (AWAITING_ACCOUNT, AWAITING_PASSWORD, AWAITING_REMEMBER):
        kind = banner_class
    elif outcome_l == "needs_relogin" and "login failed" in message_l and "no account prompt" not in message_l:
        kind = AUTH_FAILED
    elif banner_class == AUTH_FAILED:
        kind = AUTH_FAILED
    elif outcome_l == "needs_relogin":
        # Outcome file alone, with no prompt and no OpenD failure text.
        kind = STARTUP_NOT_READY
    elif banner_class:
        kind = banner_class
    else:
        kind = STARTUP_NOT_READY

    return {
        "kind": kind,
        "action": _action(kind),
        "retry": False,
        "false_needs_relogin": outcome_l == "needs_relogin" and kind in (
            STARTUP_NOT_READY, VERSION_BANNER, ACCOUNT_CONSUMED,
        ),
    }


def _action(kind: str) -> str:
    return {
        OK: START_SUPERVISOR_ONCE,
        AWAITING_ACCOUNT: SEND_ACCOUNT_ON_TELNET,
        VERSION_BANNER: SEND_ACCOUNT_ON_TELNET,
        AWAITING_PASSWORD: DO_NOT_SEND_PASSWORD,
        ACCOUNT_CONSUMED: DO_NOT_SEND_PASSWORD,
        AWAITING_REMEMBER: DO_NOT_SEND_PASSWORD,
        REMEMBER_BEFORE_PASSWORD: DO_NOT_SEND_PASSWORD,
        PASSWORD_NOT_SENT: DO_NOT_SEND_PASSWORD,
        AUTH_CHALLENGE: STOP_OPERATOR_VERIFICATION,
        AUTH_FAILED: STOP_DO_NOT_RETRY,
        STARTUP_NOT_READY: STOP_DO_NOT_RELAUNCH,
        TELNET_DOWN: BOUNDED_WAIT_EXHAUSTED,
    }[kind]


def readiness_from_chunks(chunks: list[tuple[float, str]], *, wait_s: float) -> dict:
    """One bounded read. ``chunks`` are ``(t_seconds, text)`` from t=0.

    Returns as soon as the buffer classifies as something other than
    ``startup_not_ready``. If ``wait_s`` elapses on empty or unrecognized
    text, the result stays ``startup_not_ready`` and ``retry`` is false.
    There is no second wait.
    """
    if wait_s < 0:
        raise ValueError("wait_s must be >= 0")
    buf = ""
    for t, piece in chunks:
        if t > wait_s:
            break
        buf += piece
        kind = classify_banner(buf)
        if kind != STARTUP_NOT_READY:
            return {"kind": kind, "action": _action(kind), "retry": False, "waited_s": t, "exhausted": False}
    return {
        "kind": STARTUP_NOT_READY,
        "action": STOP_DO_NOT_RELAUNCH,
        "retry": False,
        "waited_s": wait_s,
        "exhausted": True,
    }
