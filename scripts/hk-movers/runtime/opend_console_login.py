#!/usr/bin/env python3
"""One console login for an OpenD that already shows its prompt in tmux.

OpenD 10.11.7108 with stdin on a PTY prints ``Please enter account`` on that
console. Telnet on the same process stays the 87-byte version banner, so the
telnet helper is the wrong transport. A write to the pane's ``/dev/pts`` node
paints the screen and is not keyboard input. This program pastes one line
through tmux: ``load-buffer`` reads the line from this process's stdin, then
``paste-buffer -d`` deletes that buffer. The line is never a tmux argument.

The line ending is one CR. The pane tty has ICRNL, and a CR LF pair is two
breaks. The password is masked with asterisks by OpenD. The account is echoed.
Captures stay in memory. The transcript records the prompt line and
``<redacted:...>`` only. Scrollback is cleared at the end. One account, one
password, one ``Y``. A verify-code prompt, a login failure, or an unexpected
line sends nothing further.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import login_readiness as lr  # noqa: E402
import opend_login as telnet_login  # noqa: E402

STEP_WAIT = 8.0
ACCOUNT_LINE = "please enter account"
PASSWORD_LINE = "please enter password"
REMEMBER_LINE = "please choose whether to remember the password"


def _credential(env, name):
    value = env.get(name, "")
    if not value or "\n" in value or "\r" in value:
        raise SystemExit(6)
    return value


def last_prompt(text):
    """The input line OpenD is waiting on. ``>>>`` is the cursor, not a prompt."""
    lines = [line.strip() for line in (text or "").splitlines()]
    while lines and not lines[-1]:
        lines.pop()
    if lines and lines[-1] and set(lines[-1]) <= {">"}:
        lines.pop()
    while lines and not lines[-1]:
        lines.pop()
    return lines[-1] if lines else ""


def _terminal(text):
    blob = (text or "").lower()
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
        return lr.AUTH_CHALLENGE
    if "login successful" in blob or "登录成功" in blob:
        return lr.OK
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
        return lr.AUTH_FAILED
    return ""


def _active(text):
    line = last_prompt(text).lower()
    if line.startswith(ACCOUNT_LINE) or line.startswith("请输入账号") or line.startswith("请输入帐户"):
        return "account"
    if line.startswith(PASSWORD_LINE) or line.startswith("请输入密码") or line.startswith("请输入您的密码"):
        return "password"
    if line.startswith(REMEMBER_LINE):
        return "remember"
    return ""


def _decide(text, account_sent, password_sent, remember_sent):
    terminal = _terminal(text)
    if terminal == lr.AUTH_CHALLENGE:
        return "stop", lr.AUTH_CHALLENGE
    if terminal == lr.OK:
        return "stop", lr.OK
    if terminal == lr.AUTH_FAILED:
        if not password_sent:
            return "stop", lr.PASSWORD_NOT_SENT
        return "stop", lr.AUTH_FAILED
    active = _active(text)
    if active == "account":
        if account_sent:
            return "stop", "protocol_unexpected"
        return "send_account", lr.AWAITING_ACCOUNT
    if active == "password":
        if not account_sent:
            return "stop", lr.ACCOUNT_CONSUMED
        if password_sent:
            return "stop", "protocol_unexpected"
        return "send_password", lr.AWAITING_PASSWORD
    if active == "remember":
        if not password_sent:
            return "stop", lr.REMEMBER_BEFORE_PASSWORD
        if remember_sent or not account_sent:
            return "stop", "protocol_unexpected"
        return "send_remember", lr.AWAITING_REMEMBER
    if not account_sent:
        return "stop", "account_prompt_missing"
    return "stop", "protocol_timeout"


def _wait(capture, clock, sleep, timeout, previous=""):
    """Poll until a new prompt or a terminal line. The same prompt is not a new step."""
    end = clock() + timeout
    text = ""
    while True:
        text = capture()
        if _terminal(text):
            return text
        if _active(text) and last_prompt(text) != previous:
            return text
        if clock() >= end:
            return text
        sleep(0.2)


def run_console(account, password, *, capture, paste, clear_history, clock, sleep, step_wait=STEP_WAIT):
    """One sequence. ``paste`` receives the line including its single trailing CR."""
    transcript = []
    account_sent = password_sent = remember_sent = False
    kind = "account_prompt_missing"
    previous = ""
    try:
        for _step in range(4):
            text = _wait(capture, clock, sleep, step_wait, previous)
            prompt = last_prompt(text)
            terminal = _terminal(text)
            if terminal:
                transcript.append("stop " + terminal)
            else:
                safe_prompt = telnet_login.redact(prompt, account, password)
                if safe_prompt and safe_prompt != previous:
                    transcript.append("prompt " + safe_prompt)
            op, kind = _decide(text, account_sent, password_sent, remember_sent)
            if op == "send_account":
                paste(account + "\r")
                transcript.append("send <redacted:account>")
                account_sent = True
                previous = prompt
                continue
            if op == "send_password":
                paste(password + "\r")
                transcript.append("send <redacted:password>")
                password_sent = True
                previous = prompt
                continue
            if op == "send_remember":
                paste("Y\r")
                transcript.append("send Y")
                remember_sent = True
                previous = prompt
                continue
            break
    finally:
        clear_history()
    blob = "\n".join(transcript)
    if (account and account in blob) or (password and password in blob):
        raise SystemExit(6)
    return {
        "kind": kind,
        "login_successful": kind == lr.OK,
        "account_sent": account_sent,
        "password_sent": password_sent,
        "remember_sent": remember_sent,
        "retry": False,
        "transcript": transcript,
    }


def _tmux_base(tmux_bin, socket_name):
    cmd = [tmux_bin]
    if socket_name:
        cmd.extend(["-L", socket_name])
    return cmd


def _clean_env(env):
    return {key: value for key, value in env.items() if key not in ("FUTU_LOGIN_ACCOUNT", "FUTU_LOGIN_PWD")}


def make_tmux(tmux_bin, socket_name, target, env):
    base = _tmux_base(tmux_bin, socket_name)
    clean = _clean_env(env)

    def capture():
        done = subprocess.run(
            base + ["capture-pane", "-p", "-t", target],
            check=False, capture_output=True, env=clean,
        )
        if done.returncode != 0:
            return ""
        return done.stdout.decode("utf-8", "replace")

    def paste(line):
        if not line.endswith("\r") or "\n" in line or line.count("\r") != 1:
            raise SystemExit(6)
        name = "oc" + os.urandom(4).hex()
        loaded = subprocess.run(
            base + ["load-buffer", "-b", name, "-"],
            input=line.encode(), check=False, capture_output=True, env=clean,
        )
        try:
            if loaded.returncode != 0:
                raise SystemExit(4)
            pasted = subprocess.run(
                base + ["paste-buffer", "-d", "-b", name, "-t", target],
                check=False, capture_output=True, env=clean,
            )
            if pasted.returncode != 0:
                raise SystemExit(4)
        finally:
            subprocess.run(base + ["delete-buffer", "-b", name], check=False, capture_output=True, env=clean)

    def clear_history():
        subprocess.run(base + ["clear-history", "-t", target], check=False, capture_output=True, env=clean)

    return capture, paste, clear_history


def main(argv=None, env=None, capture=None, paste=None, clear_history=None, clock=None, sleep=None, import_runner=None, qot_runner=None, stdout=None):
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description="Log in on an existing OpenD tmux console. Does not restart it.")
    parser.add_argument("--session", default="opend")
    parser.add_argument("--target", default="")
    parser.add_argument("--tmux", default="tmux")
    parser.add_argument("--socket", default="")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--api-port", type=int, default=11111)
    parser.add_argument("--python", default=env.get("HK_MOVERS_PYTHON") or telnet_login.DEFAULT_PYTHON)
    parser.add_argument("--transcript", default="")
    parser.add_argument("--outcome", default="")
    parser.add_argument("--step-wait", type=float, default=STEP_WAIT)
    parser.add_argument("--qot-timeout", type=float, default=telnet_login.QOT_TIMEOUT)
    args = parser.parse_args(argv)
    out = stdout or sys.stdout
    account = _credential(env, "FUTU_LOGIN_ACCOUNT")
    password = _credential(env, "FUTU_LOGIN_PWD")
    target = args.target or args.session
    if capture is None:
        capture, paste, clear_history = make_tmux(args.tmux, args.socket, target, env)
    timer = clock or __import__("time").monotonic
    pause = sleep or __import__("time").sleep
    login = run_console(
        account, password,
        capture=capture, paste=paste, clear_history=clear_history or (lambda: None),
        clock=timer, sleep=pause, step_wait=args.step_wait,
    )
    imported = telnet_login.probe_import(args.python, runner=import_runner)
    qot = {"qot_logined": None, "reason": "not_run"}
    if imported["ready"] and login["login_successful"]:
        qot = telnet_login.probe_qot(args.python, args.host, args.api_port, timeout=args.qot_timeout, runner=qot_runner)
    elif login["login_successful"]:
        qot = {"qot_logined": None, "reason": "interpreter_" + imported["reason"]}
    if login["login_successful"]:
        allowed, why = telnet_login.supervisor_allowed(lr.OK, qot["qot_logined"])
    else:
        allowed, why = False, login["kind"]
    result = {
        **login,
        "qot_logined": qot["qot_logined"],
        "qot_reason": qot["reason"],
        "interpreter": imported["version"] if imported["ready"] else imported["reason"],
        "start_supervisor": allowed,
        "supervisor_reason": why,
    }
    rendered = telnet_login.report_lines(result)
    if account in rendered or password in rendered:
        out.write("kind=redaction_failure\nretry=false\n")
        return 6
    out.write(rendered)
    telnet_login._write_private(args.outcome, login["kind"] + "\n")
    telnet_login._write_private(args.transcript, "\n".join(login["transcript"]) + "\n")
    if any(secret and secret in "\n".join(login["transcript"]) for secret in (account, password)):
        return 6
    if allowed:
        return 0
    if login["kind"] == lr.AUTH_CHALLENGE:
        return 2
    if login["kind"] == lr.AUTH_FAILED:
        return 3
    if login["login_successful"]:
        return 8
    return 4


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as exc:
        if exc.code == 6:
            sys.stderr.write("FUTU_LOGIN_ACCOUNT and FUTU_LOGIN_PWD must be set in this process and must be single-line.\n")
        raise
