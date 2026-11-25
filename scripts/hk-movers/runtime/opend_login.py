#!/usr/bin/env python3
"""One telnet login against an OpenD that is already listening.

A fresh OpenD 10.11.7108 prints the version line and then
``Please enter account``. One ``account\\r\\n`` is one line; the next prompt
is ``Please enter password``. A version banner with no account prompt is not
a send. This program never sends ``help``, never pkills, and never starts a
second OpenD.

After ``login successful``, a quote check runs in a child process with a hard
timeout. On this host ``OpenQuoteContext`` hung for 15s and 20s before any
login, so a hang is ``qot_logined=unknown``, not an auth failure and not a
reason to log in again. The supervisor is allowed only when that check
returns ``qot_logined`` true. Credentials are read from the process
environment and are never written to the transcript, the outcome file, or
stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import login_readiness as lr  # noqa: E402

BANNER_WAIT = 12.0
STEP_WAIT = 8.0
QOT_TIMEOUT = 20.0
DEFAULT_PYTHON = "/workspace/futu/.venv/bin/python"

IMPORT_SRC = r"""
import json
try:
    import futu
except Exception:
    print(json.dumps({"ok": False, "reason": "import_failed"}))
    raise SystemExit(1)
path = (getattr(futu, "__file__", "") or "").replace("\\", "/")
if "site-packages" not in path:
    print(json.dumps({"ok": False, "reason": "shadowed"}))
    raise SystemExit(2)
print(json.dumps({"ok": True, "version": str(getattr(futu, "__version__", ""))}))
"""

QOT_SRC = r"""
import json, sys
host, port = sys.argv[1], int(sys.argv[2])
from futu import OpenQuoteContext
ctx = OpenQuoteContext(host=host, port=port)
try:
    ret, data = ctx.get_global_state()
finally:
    ctx.close()
logged = None
if isinstance(data, dict) and "qot_logined" in data:
    logged = bool(data["qot_logined"])
code = ret if isinstance(ret, int) else -1
print(json.dumps({"ret": code, "qot_logined": logged}))
"""


class SocketTransport:
    def __init__(self, sock):
        self.sock = sock

    def recv(self, timeout):
        self.sock.settimeout(timeout if timeout > 0 else 0.01)
        try:
            return self.sock.recv(8192)
        except socket.timeout:
            raise TimeoutError()

    def send(self, data):
        self.sock.sendall(data)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def connect_tcp(host, port, timeout=5):
    sock = socket.create_connection((host, port), timeout)
    return SocketTransport(sock)


def redact(text, account, password):
    out = text or ""
    secrets = [(password, "<redacted:password>"), (account, "<redacted:account>")]
    secrets.sort(key=lambda item: len(item[0] or ""), reverse=True)
    for secret, token in secrets:
        if secret:
            out = out.replace(secret, token)
    return out


def _credential(env, name):
    value = env.get(name, "")
    if not value:
        raise SystemExit(6)
    if "\n" in value or "\r" in value:
        raise SystemExit(6)
    return value


def _ready(text):
    kind = lr.classify_banner(text)
    if kind in (lr.STARTUP_NOT_READY, lr.VERSION_BANNER):
        return False
    return bool(text)


def _advance_if_stuck(clock, start, timeout):
    if clock() == start:
        advance = getattr(clock, "advance", None)
        if advance is not None:
            advance(timeout if timeout else 0.01)


def _read(transport, clock, wait_s, transcript, account, password):
    end = clock() + wait_s
    parts = []
    while clock() < end:
        timeout = max(0.01, min(0.5, end - clock()))
        start = clock()
        try:
            data = transport.recv(timeout)
        except TimeoutError:
            _advance_if_stuck(clock, start, timeout)
            continue
        if not data:
            break
        piece = data.decode("utf-8", "replace")
        parts.append(piece)
        transcript.append("recv " + redact(piece, account, password))
        if _ready("".join(parts)):
            drain_end = clock() + 0.3
            while clock() < drain_end:
                left = max(0.01, drain_end - clock())
                start = clock()
                try:
                    extra = transport.recv(left)
                except TimeoutError:
                    _advance_if_stuck(clock, start, left)
                    break
                if not extra:
                    break
                piece = extra.decode("utf-8", "replace")
                parts.append(piece)
                transcript.append("recv " + redact(piece, account, password))
            break
    return "".join(parts)


def _send_secret(transport, value, label, transcript):
    transport.send((value + "\r\n").encode())
    transcript.append("send <redacted:%s>" % label)


def _decide(text, account_sent, password_sent, remember_sent):
    """Choose the next telnet line.

    Official interactive order is account, then password, then whether to
    remember (Futu API Doc v10.12 command-line OpenD). A fresh 10.11.7108
    prints ``Please enter account`` before it accepts a line. One
    ``payload + \\r\\n`` is that line: the same binary answers it with
    ``Please enter password``, and a second ``\\r\\n`` repeats that prompt
    instead of jumping to the remember question. A version banner alone
    therefore sends nothing. Y is sent only after the password line. The
    14:45 telnet read showed the remember question before any
    ``Please enter password``; answering Y there is not repeated.
    """
    kind = lr.classify_banner(text)
    if not (text or "").strip() or kind == lr.STARTUP_NOT_READY:
        return "timeout", "protocol_timeout"
    if kind == lr.AUTH_CHALLENGE:
        return "stop", lr.AUTH_CHALLENGE
    if kind == lr.OK:
        return "stop", lr.OK
    if kind == lr.AUTH_FAILED:
        if not password_sent:
            return "stop", lr.PASSWORD_NOT_SENT
        return "stop", lr.AUTH_FAILED
    if kind == lr.VERSION_BANNER:
        return "stop", "account_prompt_missing"
    if kind == lr.AWAITING_ACCOUNT:
        if account_sent:
            return "stop", "protocol_unexpected"
        return "send_account", kind
    if kind == lr.AWAITING_PASSWORD:
        if not account_sent:
            return "stop", lr.ACCOUNT_CONSUMED
        if password_sent:
            return "stop", "protocol_unexpected"
        return "send_password", kind
    if kind == lr.AWAITING_REMEMBER:
        if not password_sent:
            return "stop", lr.REMEMBER_BEFORE_PASSWORD
        if remember_sent or not account_sent:
            return "stop", "protocol_unexpected"
        return "send_remember", kind
    return "stop", "protocol_unexpected"


def run_login(transport, account, password, *, clock, banner_wait=BANNER_WAIT, step_wait=STEP_WAIT):
    """One connection, at most one account line, one password line, and one Y."""
    transcript = []
    account_sent = password_sent = remember_sent = False
    kind = "protocol_timeout"
    try:
        for step in range(4):
            wait = banner_wait if step == 0 else step_wait
            text = _read(transport, clock, wait, transcript, account, password)
            op, kind = _decide(text, account_sent, password_sent, remember_sent)
            if op == "send_account":
                _send_secret(transport, account, "account", transcript)
                account_sent = True
                continue
            if op == "send_password":
                _send_secret(transport, password, "password", transcript)
                password_sent = True
                continue
            if op == "send_remember":
                transport.send(b"Y\r\n")
                transcript.append("send Y")
                remember_sent = True
                continue
            break
    finally:
        transport.close()
    return {
        "kind": kind,
        "login_successful": kind == lr.OK,
        "account_sent": account_sent,
        "password_sent": password_sent,
        "remember_sent": remember_sent,
        "retry": False,
        "transcript": transcript,
    }


def supervisor_allowed(login_kind, qot_logined):
    """Supervisor starts only after the SDK reports qot_logined.

    Telnet ``login successful`` is recorded, and it is not treated as quote
    login while the API constructor has not returned. A timeout leaves
    qot_logined unknown and does not request another login.
    """
    if qot_logined is True and login_kind == lr.OK:
        return True, "qot_logined"
    if login_kind != lr.OK:
        return False, login_kind
    if qot_logined is False:
        return False, "qot_not_logined"
    return False, "qot_unconfirmed"


def _run_child(argv, cwd, timeout, src_stdin):
    try:
        proc = subprocess.run(
            argv,
            input=src_stdin,
            text=True,
            cwd=cwd,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"code": None, "stdout": "", "stderr": "", "timed_out": True}
    except OSError:
        return {"code": None, "stdout": "", "stderr": "", "timed_out": False}
    return {
        "code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "timed_out": False,
    }


def probe_import(python, runner=None, timeout=10):
    run = runner or (lambda argv, cwd, timeout: _run_child(argv, cwd, timeout, IMPORT_SRC))
    done = run([python, "-"], "/tmp", timeout)
    if done.get("timed_out"):
        return {"ready": False, "reason": "timeout", "version": ""}
    try:
        payload = json.loads(done.get("stdout") or "{}")
    except json.JSONDecodeError:
        return {"ready": False, "reason": "bad_output", "version": ""}
    return {
        "ready": bool(payload.get("ok")),
        "reason": payload.get("reason") or ("ok" if payload.get("ok") else "import_failed"),
        "version": str(payload.get("version") or ""),
    }


def probe_qot(python, host, port, timeout=QOT_TIMEOUT, runner=None):
    run = runner or (lambda argv, cwd, timeout: _run_child(argv, cwd, timeout, QOT_SRC))
    done = run([python, "-", host, str(port)], "/tmp", timeout)
    if done.get("timed_out"):
        return {"qot_logined": None, "reason": "constructor_timeout"}
    try:
        payload = json.loads(done.get("stdout") or "{}")
    except json.JSONDecodeError:
        return {"qot_logined": None, "reason": "bad_output"}
    logged = payload.get("qot_logined")
    if logged is True:
        return {"qot_logined": True, "reason": "qot_logined"}
    if logged is False:
        return {"qot_logined": False, "reason": "qot_not_logined"}
    return {"qot_logined": None, "reason": "unexpected_shape"}


def report_lines(result):
    logged = result.get("qot_logined")
    lines = [
        "kind=%s" % result["kind"],
        "login_successful=%s" % str(bool(result["login_successful"])).lower(),
        "qot_logined=%s" % ("unknown" if logged is None else str(bool(logged)).lower()),
        "qot_reason=%s" % result.get("qot_reason", ""),
        "interpreter=%s" % result.get("interpreter", ""),
        "start_supervisor=%s" % str(bool(result["start_supervisor"])).lower(),
        "retry=false",
    ]
    return "\n".join(lines) + "\n"


def _write_private(path, text):
    if not path:
        return
    target = Path(path)
    target.write_text(text)
    try:
        os.chmod(target, 0o600)
    except OSError:
        pass


def main(argv=None, env=None, connect=None, clock=None, import_runner=None, qot_runner=None, stdout=None):
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description="Log in to an already-running OpenD. Does not restart it.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--telnet-port", type=int, default=22222)
    parser.add_argument("--api-port", type=int, default=11111)
    parser.add_argument("--python", default=env.get("HK_MOVERS_PYTHON") or DEFAULT_PYTHON)
    parser.add_argument("--transcript", default="")
    parser.add_argument("--outcome", default="")
    parser.add_argument("--banner-wait", type=float, default=BANNER_WAIT)
    parser.add_argument("--step-wait", type=float, default=STEP_WAIT)
    parser.add_argument("--qot-timeout", type=float, default=QOT_TIMEOUT)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args(argv)
    out = stdout or sys.stdout
    account = _credential(env, "FUTU_LOGIN_ACCOUNT")
    password = _credential(env, "FUTU_LOGIN_PWD")

    if args.check_only:
        login = {
            "kind": "check_only",
            "login_successful": False,
            "account_sent": False,
            "password_sent": False,
            "remember_sent": False,
            "retry": False,
            "transcript": ["check-only"],
        }
    else:
        try:
            opener = connect or (lambda host, port: connect_tcp(host, port))
            transport = opener(args.host, args.telnet_port)
        except OSError:
            text = "kind=telnet_down\nlogin_successful=false\nqot_logined=unknown\nstart_supervisor=false\nretry=false\n"
            out.write(text)
            _write_private(args.outcome, "telnet_down\n")
            return 5
        timer = clock or __import__("time").monotonic
        login = run_login(
            transport, account, password, clock=timer,
            banner_wait=args.banner_wait, step_wait=args.step_wait,
        )

    imported = probe_import(args.python, runner=import_runner)
    qot = {"qot_logined": None, "reason": "not_run"}
    if imported["ready"] and (login["login_successful"] or args.check_only):
        qot = probe_qot(args.python, args.host, args.api_port, timeout=args.qot_timeout, runner=qot_runner)
    elif login["login_successful"] or args.check_only:
        qot = {"qot_logined": None, "reason": "interpreter_" + imported["reason"]}
    if login["login_successful"] or args.check_only:
        allowed, why = supervisor_allowed(lr.OK if (login["login_successful"] or qot["qot_logined"] is True) else login["kind"], qot["qot_logined"])
        if args.check_only and qot["qot_logined"] is True:
            allowed, why = True, "qot_logined"
        elif args.check_only:
            allowed, why = False, qot["reason"]
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
    rendered = report_lines(result)
    if account in rendered or password in rendered:
        out.write("kind=redaction_failure\nretry=false\n")
        return 6
    out.write(rendered)
    _write_private(args.outcome, login["kind"] + "\n")
    _write_private(args.transcript, "\n".join(login["transcript"]) + "\n")
    if any(secret and secret in "\n".join(login["transcript"]) for secret in (account, password)):
        return 6
    if allowed:
        return 0
    if login["kind"] == lr.AUTH_CHALLENGE:
        return 2
    if login["kind"] == lr.AUTH_FAILED:
        return 3
    if login["login_successful"] or args.check_only:
        return 8
    if login["kind"] == lr.TELNET_DOWN:
        return 5
    return 4


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as exc:
        if exc.code == 6:
            sys.stderr.write("FUTU_LOGIN_ACCOUNT and FUTU_LOGIN_PWD must be set in this process and must be single-line.\n")
        raise
