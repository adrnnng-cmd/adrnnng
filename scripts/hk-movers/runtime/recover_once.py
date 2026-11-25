#!/usr/bin/env python3
"""One recovery pass. It does not publish and it does not kill OpenD.

A reboot leaves OpenD and the supervisor absent. This pass starts one
FutuOpenD in a tmux PTY when no OpenD process exists and both ports are
closed, runs the console login once when the pane asks for the account and
the quote check says not logged in, and starts the existing daemon once
when ``qot_logined`` is true. ``start_opend.sh`` is never used.

Auth failure and a verify-code prompt stick until a person clears the state
file. A quote-check timeout before login is not a login. Credentials are
the process environment. They are not arguments.

``--run`` is required. Nothing in this repository starts the 5-minute caller.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import socket
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import opend_console_login as console_login  # noqa: E402
import opend_login  # noqa: E402
import recover  # noqa: E402

OPEND_DIR = "/workspace/futu/opend/current"
DAEMON = "/workspace/futu/hk-movers/daemon.sh"
CONF_NAME = "recover-tmux.conf"
ACCOUNT_PROMPT = "Please enter account"


def opend_pty_command(runtime_dir, opend_dir=OPEND_DIR):
    conf = str(Path(runtime_dir) / CONF_NAME)
    inner = (
        "sleep 0.4; exec ./FutuOpenD -lang=en -api_ip=127.0.0.1 "
        "-api_port=11111 -telnet_ip=127.0.0.1 -telnet_port=22222"
    )
    return [
        "tmux", "-f", conf, "new-session", "-d", "-s", "opend",
        "-c", opend_dir, inner,
    ]


def login_command(runtime_dir, python):
    return [
        python, str(Path(runtime_dir) / "opend_console_login.py"),
        "--session", "opend",
        "--api-port", "11111",
        "--python", python,
        "--transcript", str(Path(runtime_dir) / "login-transcript.txt"),
        "--outcome", str(Path(runtime_dir) / "last_login_outcome.txt"),
        "--qot-timeout", "20",
    ]


def supervisor_command():
    return ["setsid", "nohup", "bash", DAEMON]


def plan(world):
    """Choose at most one process action. ``world`` is already observed."""
    now = world["now"]
    fresh = recover.freshness(now, world.get("stamp"))
    sticky = world.get("sticky") or ""
    qot = world.get("qot_logined")
    base = {
        "retry": False,
        "pkill": False,
        "start_opend_sh": False,
        "freshness": fresh,
        "quote_as_of": "unknown",
        "exec": [],
    }

    def stop(action, reason, exec_cmd=None):
        decided = dict(base)
        decided["action"] = action
        decided["reason"] = reason
        decided["exec"] = list(exec_cmd or [])
        return decided

    if world.get("lock_held"):
        return stop("noop_duplicate", "recover_lock_held")
    if sticky in ("auth_failed", "auth_challenge", "login_stopped"):
        return stop("alert_" + sticky, sticky)
    listening = bool(world.get("opend_listening"))
    pids = list(world.get("opend_pids") or [])
    if not listening and pids:
        return stop("alert_opend_stuck", "process_without_port")
    if not listening and not world.get("binary_ready"):
        return stop("alert_opend_binary_missing", "binary_missing")
    if not listening:
        return stop("start_opend_pty", "opend_absent", opend_pty_command(world["runtime_dir"]))
    if qot is True and world.get("supervisor_running"):
        if fresh["state"] == "stale_trading":
            return stop("alert_stale_while_supervisor_running", "supervisor_already_running")
        return stop("noop_supervisor_running", "qot_logined")
    if qot is True:
        return stop("start_supervisor_once", "qot_logined", supervisor_command())
    if not world.get("interpreter_ready"):
        return stop("alert_interpreter", "interpreter_not_ready")
    if sticky == "qot_unconfirmed":
        return stop("alert_qot_unconfirmed", world.get("qot_reason") or "qot_unconfirmed")
    if world.get("qot_reason") == "bad_output":
        return stop("alert_qot_unconfirmed", "bad_output")
    delay = recover.backoff_delay(world.get("fails") or 0)
    last = world.get("last_attempt_at")
    if delay and last is not None and (now - last).total_seconds() < delay:
        return stop("noop_backoff", "backoff")
    prompt = (world.get("pane_prompt") or "").strip()
    if prompt != ACCOUNT_PROMPT:
        return stop("alert_account_prompt_missing", "account_prompt_missing")
    if qot is None and world.get("qot_reason") not in ("qot_not_logined", "constructor_timeout", None, ""):
        return stop("alert_qot_unconfirmed", world.get("qot_reason") or "qot_unconfirmed")
    return stop(
        "login_once", "account_prompt",
        login_command(world["runtime_dir"], world.get("python") or "python3"),
    )


def apply_login_result(world, code):
    """What the next observation should remember after one console login."""
    nxt = dict(world)
    nxt["fails"] = (world.get("fails") or 0) + 1
    nxt["last_attempt_at"] = world["now"]
    if code == 0:
        nxt["fails"] = 0
        nxt["sticky"] = ""
        nxt["qot_logined"] = True
        nxt["qot_reason"] = "qot_logined"
    elif code == 2:
        nxt["sticky"] = "auth_challenge"
    elif code == 3:
        nxt["sticky"] = "auth_failed"
    elif code == 8:
        nxt["sticky"] = "qot_unconfirmed"
        nxt["qot_logined"] = None
        nxt["qot_reason"] = "qot_unconfirmed"
    elif nxt["fails"] >= 3:
        nxt["sticky"] = "login_stopped"
    return nxt


def emit_event(previous, decision, now, stamp_text):
    return recover.next_alert(previous, decision, now, stamp_text)


def execute(world, effects):
    """Run the one planned action. A login that returns 0 may start the daemon."""
    decision = plan(world)
    code = None
    if decision["exec"]:
        code = effects.spawn(decision["exec"])
    remembered = world
    if decision["action"] == "login_once":
        remembered = apply_login_result(world, code if isinstance(code, int) else 4)
        if code == 0 and not world.get("supervisor_running"):
            effects.spawn(supervisor_command())
    event = emit_event(
        world.get("previous_alert"), decision, world["now"],
        world.get("stamp_text") or "",
    )
    if not event["duplicate"] and decision["action"].startswith("alert_"):
        effects.write_event(event)
    effects.write_state({
        "fails": remembered.get("fails") or 0,
        "sticky": remembered.get("sticky") or "",
        "alert": event,
        "last_attempt_at": remembered.get("last_attempt_at"),
    })
    return decision, event


class Effects:
    def __init__(self):
        self.spawned = []
        self.events = []
        self.state = None

    def spawn(self, argv):
        self.spawned.append(list(argv))

    def write_event(self, event):
        self.events.append(dict(event))

    def write_state(self, state):
        self.state = dict(state)


def assemble(parts):
    """Build one observation from already collected facts. Touches nothing."""
    return {
        "runtime_dir": parts["runtime_dir"],
        "now": parts["now"],
        "stamp": parts.get("stamp"),
        "stamp_text": parts.get("stamp_text") or "",
        "opend_listening": bool(parts.get("api_open")) and bool(parts.get("telnet_open")),
        "opend_pids": list(parts.get("pids") or []),
        "supervisor_running": bool(parts.get("supervisor_running")),
        "binary_ready": bool(parts.get("binary_ready")),
        "interpreter_ready": bool(parts.get("interpreter_ready")),
        "pane_prompt": parts.get("pane_prompt") or "",
        "sticky": parts.get("sticky") or "",
        "qot_logined": parts.get("qot_logined"),
        "qot_reason": parts.get("qot_reason") or "",
        "fails": parts.get("fails") or 0,
        "last_attempt_at": parts.get("last_attempt_at"),
        "previous_alert": parts.get("previous_alert"),
        "python": parts.get("python") or "python3",
        "lock_held": bool(parts.get("lock_held")),
    }


def _pids():
    found = []
    proc = Path("/proc")
    if not proc.exists():
        return found
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().replace(b"\0", b" ")
        except OSError:
            continue
        if b"FutuOpenD" in command and not command.startswith(b"tmux"):
            found.append(int(entry.name))
    return found


def _port_open(port):
    try:
        sock = socket.create_connection(("127.0.0.1", port), 0.3)
    except OSError:
        return False
    sock.close()
    return True


def _pane_prompt():
    done = subprocess.run(
        ["tmux", "capture-pane", "-p", "-t", "opend"],
        check=False, capture_output=True, text=True,
    )
    if done.returncode != 0:
        return ""
    return console_login.last_prompt(done.stdout)


def _stamp(runtime_dir):
    path = Path(runtime_dir) / "latest.json"
    if not path.exists():
        return None, ""
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None, ""
    text = str(payload.get("updated_at_hkt") or "")
    if not text:
        return None, ""
    try:
        stamp = datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=recover.HKT)
    except ValueError:
        return None, text
    return stamp, text


def _state(runtime_dir):
    path = Path(runtime_dir) / "recover-state.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def collect_host(runtime_dir, python):
    """Read ports, processes, the pane, and one quote check. Starts nothing."""
    state = _state(runtime_dir)
    outcome = ""
    outcome_path = Path(runtime_dir) / "last_login_outcome.txt"
    if outcome_path.exists():
        try:
            outcome = outcome_path.read_text().strip()
        except OSError:
            outcome = ""
    sticky = state.get("sticky") or ""
    if outcome in ("auth_failed", "auth_challenge"):
        sticky = outcome
    api_open = _port_open(11111)
    telnet_open = _port_open(22222)
    interpreter = opend_login.probe_import(python) if Path(python).exists() else {
        "ready": False, "reason": "missing", "version": "",
    }
    qot = {"qot_logined": None, "reason": ""}
    if api_open and telnet_open and interpreter["ready"]:
        qot = opend_login.probe_qot(python, "127.0.0.1", 11111, timeout=20)
    last = None
    if state.get("last_attempt_at"):
        try:
            last = datetime.strptime(state["last_attempt_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=recover.HKT)
        except ValueError:
            last = None
    stamp, stamp_text = _stamp(runtime_dir)
    return assemble({
        "runtime_dir": runtime_dir,
        "now": datetime.now(recover.HKT),
        "stamp": stamp,
        "stamp_text": stamp_text,
        "api_open": api_open,
        "telnet_open": telnet_open,
        "pids": _pids(),
        "supervisor_running": _supervisor_running(),
        "binary_ready": (Path(OPEND_DIR) / "FutuOpenD").is_file(),
        "interpreter_ready": interpreter["ready"],
        "pane_prompt": _pane_prompt() if telnet_open else "",
        "sticky": sticky,
        "qot_logined": qot.get("qot_logined"),
        "qot_reason": qot.get("reason") or "",
        "fails": state.get("fails") or 0,
        "last_attempt_at": last,
        "previous_alert": state.get("alert"),
        "python": python,
        "lock_held": False,
    })


def _supervisor_running():
    pid_path = Path("/workspace/futu/hk-movers/daemon.pid")
    if not pid_path.exists():
        return False
    try:
        pid = int(pid_path.read_text().strip())
    except (OSError, ValueError):
        return False
    return Path("/proc/%s" % pid).exists()


class HostEffects:
    """Perform the one argv. The daemon is detached. Nothing is published here."""

    def __init__(self, runtime_dir):
        self.runtime_dir = Path(runtime_dir)
        self.spawned = []
        self.events = []
        self.state = None

    def spawn(self, argv):
        self.spawned.append(list(argv))
        if argv[:1] == ["setsid"]:
            subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            return 0
        done = subprocess.run(argv, check=False)
        return done.returncode

    def write_event(self, event):
        self.events.append(dict(event))
        line = "%s %s %s\n" % (event.get("at") or "", event["action"], event.get("reason", ""))
        path = self.runtime_dir / "recover-events.log"
        with path.open("a") as handle:
            handle.write(line)
        try:
            os_chmod(path)
        except OSError:
            pass

    def write_state(self, state):
        self.state = dict(state)
        last = state.get("last_attempt_at")
        if hasattr(last, "strftime"):
            last_text = last.astimezone(recover.HKT).strftime("%Y-%m-%d %H:%M:%S")
        else:
            last_text = last or ""
        payload = {
            "fails": state.get("fails") or 0,
            "sticky": state.get("sticky") or "",
            "alert": state.get("alert"),
            "last_attempt_at": last_text,
        }
        path = self.runtime_dir / "recover-state.json"
        path.write_text(json.dumps(payload) + "\n")
        try:
            os_chmod(path)
        except OSError:
            pass


def os_chmod(path):
    import os
    os.chmod(path, 0o600)


def main(argv=None, stdout=None, observe=None, effects=None):
    out = stdout or sys.stdout
    parser = argparse.ArgumentParser(description="One Movers recovery pass. Does not publish.")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--dir", default="/workspace/futu/hk-movers")
    parser.add_argument("--python", default="/workspace/futu/.venv/bin/python")
    args = parser.parse_args(argv)
    if not args.run:
        out.write("recover_once: not started. The 5-minute routine is not approved.\n")
        return 2
    lock_handle = None
    if observe is None:
        lock_path = Path(args.dir) / ".recover.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_handle = lock_path.open("a")
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            world = assemble({
                "runtime_dir": args.dir, "now": datetime.now(recover.HKT),
                "lock_held": True, "api_open": False, "telnet_open": False,
            })
            decision, event = execute(world, effects or Effects())
            out.write("action=%s\nreason=%s\nduplicate=%s\n" % (
                decision["action"], decision["reason"], str(bool(event["duplicate"])).lower(),
            ))
            return 0
        world = collect_host(args.dir, args.python)
        effects = effects or HostEffects(args.dir)
    else:
        world = observe(args.dir)
        effects = effects or Effects()
    try:
        decision, event = execute(world, effects)
    finally:
        if lock_handle is not None:
            lock_handle.close()
    out.write("action=%s\nreason=%s\nduplicate=%s\n" % (
        decision["action"], decision["reason"], str(bool(event["duplicate"])).lower(),
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
