#!/usr/bin/python3
"""One recovery pass. It does not publish and it does not kill OpenD.

A reboot leaves OpenD and the supervisor absent. This pass starts one
FutuOpenD in a tmux PTY when no OpenD process exists and both ports are
closed, runs the console login once when the pane asks for the account and
the quote check says not logged in, and starts the existing daemon once
when ``qot_logined`` is true. ``start_opend.sh`` is never used.

Auth failure and a verify-code prompt stick until a person clears the state
file. A quote-check timeout before login is not a login. Credentials are
the process environment. They are not arguments.

The process that runs this file is system Python. The SDK lives in
``.venv`` and was absent after the box replace, so a caller that starts
with that interpreter never reaches this file and cannot write an alert.
This pass does not create the venv. It names the pin ``futu-api==10.12.7208``
in a ``missing_deps`` event. ``updated_at_hkt`` is the collector start, and
``quote_as_of`` stays unknown.

``--run`` is required. Nothing in this repository starts the outside caller.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
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
PIN = "futu-api==10.12.7208"
SYSTEM_PYTHON = "/usr/bin/python3"
LOGIN_BLOCK = ("auth_failed", "auth_challenge", "login_stopped", "authmaterialmissing")


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


def login_command(runtime_dir, sdk_python, helper_python=SYSTEM_PYTHON):
    return [
        helper_python, str(Path(runtime_dir) / "opend_console_login.py"),
        "--session", "opend",
        "--api-port", "11111",
        "--python", sdk_python,
        "--transcript", str(Path(runtime_dir) / "login-transcript.txt"),
        "--outcome", str(Path(runtime_dir) / "last_login_outcome.txt"),
        "--qot-timeout", "20",
    ]


def auth_material_from_env(env):
    """True only when both variables are already in this process. No file is read."""
    account = env.get("FUTU_LOGIN_ACCOUNT") or ""
    password = env.get("FUTU_LOGIN_PWD") or ""
    if not account or not password:
        return False
    if any(char in account or char in password for char in ("\n", "\r")):
        return False
    return True


def read_pin(text):
    """The one direct pin. Other lines are comments or not this package."""
    for line in (text or "").splitlines():
        item = line.strip()
        if item.startswith("futu-api=="):
            return item
    return ""


def bootstrap_command(system_python, venv_dir, requirements):
    """How a person would recreate the SDK. This pass does not run it."""
    venv_python = str(Path(venv_dir) / "bin" / "python")
    return [
        [system_python, "-m", "venv", venv_dir],
        [venv_python, "-m", "pip", "install", "--index-url", "https://pypi.org/simple", "-r", requirements],
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
        "collected_at_role": "collector_start",
        "exec": [],
        "pin": world.get("pin") or "",
    }

    def stop(action, reason, exec_cmd=None):
        decided = dict(base)
        decided["action"] = action
        decided["reason"] = reason
        decided["exec"] = list(exec_cmd or [])
        return decided

    if world.get("lock_held"):
        return stop("noop_duplicate", "recover_lock_held")
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
        return stop("alert_missing_deps", "venv_missing")
    if sticky in LOGIN_BLOCK:
        return stop("alert_" + sticky, sticky)
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
        login_command(
            world["runtime_dir"],
            world.get("python") or "python3",
            world.get("helper_python") or SYSTEM_PYTHON,
        ),
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


def _annotate(event, world, reason):
    event["reason"] = reason
    event["quote_as_of"] = "unknown"
    event["collected_at_role"] = "collector_start"
    event["pin"] = world.get("pin") or ""
    return event


def format_event_line(event):
    pin = event.get("pin") or ""
    pin_bit = (" pin=" + pin) if pin else ""
    return "%s %s %s quote_as_of=unknown collected_at=collector_start%s\n" % (
        event.get("at") or "", event.get("action") or "", event.get("reason") or "", pin_bit,
    )


def state_payload(state):
    last = state.get("last_attempt_at")
    if hasattr(last, "strftime"):
        last = last.astimezone(recover.HKT).strftime("%Y-%m-%d %H:%M:%S")
    return {
        "fails": state.get("fails") or 0,
        "sticky": state.get("sticky") or "",
        "alert": state.get("alert"),
        "deps_alert": state.get("deps_alert"),
        "last_attempt_at": last or "",
    }


def execute(world, effects):
    """Run the one planned action. A login that returns 0 may start the daemon.

    A missing SDK still starts OpenD, and it also writes ``missing_deps``.
    Login is not attempted without the SDK or without both environment
    variables. This function does not create a venv and does not read a
    credential file.
    """
    decision = plan(world)
    remembered = world
    if decision["action"] == "login_once" and not world.get("auth_material", True):
        decision = dict(decision)
        decision["action"] = "alert_authmaterialmissing"
        decision["reason"] = "authmaterialmissing"
        decision["exec"] = []
        remembered = dict(world)
        remembered["sticky"] = "authmaterialmissing"
    code = None
    if decision["exec"]:
        code = effects.spawn(decision["exec"])
    if decision["action"] == "login_once":
        remembered = apply_login_result(world, code if isinstance(code, int) else 4)
        if code == 0 and not world.get("supervisor_running"):
            effects.spawn(supervisor_command())
    event = _annotate(emit_event(
        world.get("previous_alert"), decision, world["now"],
        world.get("stamp_text") or "",
    ), world, decision["reason"])
    if not event["duplicate"] and decision["action"].startswith("alert_"):
        effects.write_event(event)
    deps_saved = None
    if not world.get("interpreter_ready") and decision["action"] != "alert_missing_deps":
        deps = _annotate(emit_event(
            world.get("previous_deps_alert"), {
                "action": "alert_missing_deps",
                "reason": "venv_missing",
                "freshness": decision["freshness"],
            }, world["now"], world.get("stamp_text") or "",
        ), world, "venv_missing")
        deps_saved = deps
        if not deps["duplicate"]:
            effects.write_event(deps)
    elif not world.get("interpreter_ready"):
        deps_saved = event
    effects.write_state(state_payload({
        "fails": remembered.get("fails") or 0,
        "sticky": remembered.get("sticky") or "",
        "alert": event,
        "deps_alert": deps_saved,
        "last_attempt_at": remembered.get("last_attempt_at"),
    }))
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
        "helper_python": parts.get("helper_python") or SYSTEM_PYTHON,
        "pin": parts.get("pin") or "",
        "auth_material": parts.get("auth_material", True),
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
        "helper_python": SYSTEM_PYTHON,
        "pin": read_pin(Path(__file__).with_name("requirements-futu.txt").read_text()) if Path(__file__).with_name("requirements-futu.txt").is_file() else "",
        "auth_material": auth_material_from_env(os.environ),
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
        line = format_event_line(event)
        path = self.runtime_dir / "recover-events.log"
        with path.open("a") as handle:
            handle.write(line)
        try:
            os_chmod(path)
        except OSError:
            pass

    def write_state(self, state):
        self.state = dict(state)
        payload = state_payload(state)
        path = self.runtime_dir / "recover-state.json"
        path.write_text(json.dumps(payload) + "\n")
        try:
            os_chmod(path)
        except OSError:
            pass


def os_chmod(path):
    import os
    os.chmod(path, 0o600)


def _parse_hkt(text):
    if not text:
        return None
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=recover.HKT)


def load_world(path, runtime_dir):
    """Load a fixture observation. Does not open ports or read credentials."""
    raw = json.loads(Path(path).read_text())
    raw["now"] = _parse_hkt(raw.get("now"))
    raw["stamp"] = _parse_hkt(raw.get("stamp"))
    raw["last_attempt_at"] = _parse_hkt(raw.get("last_attempt_at"))
    raw["runtime_dir"] = runtime_dir
    world = assemble(raw)
    world["pane_prompt"] = raw.get("pane_prompt") or ""
    world["sticky"] = raw.get("sticky") or ""
    world["auth_material"] = raw.get("auth_material", True)
    world["interpreter_ready"] = raw.get("interpreter_ready", True)
    world["pin"] = raw.get("pin") or PIN
    saved = _state(runtime_dir)
    if saved.get("sticky"):
        world["sticky"] = saved["sticky"]
    if saved.get("alert"):
        world["previous_alert"] = saved["alert"]
    if saved.get("deps_alert"):
        world["previous_deps_alert"] = saved["deps_alert"]
    if saved.get("fails"):
        world["fails"] = saved["fails"]
    if saved.get("last_attempt_at"):
        world["last_attempt_at"] = _parse_hkt(saved["last_attempt_at"])
    return world


class FileEffects(Effects):
    """Record the action and write the event log. Does not start processes."""

    def __init__(self, runtime_dir):
        super().__init__()
        self.runtime_dir = Path(runtime_dir)

    def spawn(self, argv):
        self.spawned.append(list(argv))
        path = self.runtime_dir / "spawned.json"
        path.write_text(json.dumps(self.spawned) + "\n")
        return 0

    def write_event(self, event):
        super().write_event(event)
        path = self.runtime_dir / "recover-events.log"
        with path.open("a") as handle:
            handle.write(format_event_line(event))

    def write_state(self, state):
        super().write_state(state)
        path = self.runtime_dir / "recover-state.json"
        path.write_text(json.dumps(state_payload(state)) + "\n")


def main(argv=None, stdout=None, observe=None, effects=None):
    out = stdout or sys.stdout
    parser = argparse.ArgumentParser(description="One Movers recovery pass. Does not publish.")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--dir", default="/workspace/futu/hk-movers")
    parser.add_argument("--python", default="/workspace/futu/.venv/bin/python")
    parser.add_argument("--world", default="")
    args = parser.parse_args(argv)
    if not args.run:
        out.write("recover_once: not started. The 5-minute routine is not approved.\n")
        return 2
    if args.world:
        world = load_world(args.world, args.dir)
        effects = effects or FileEffects(args.dir)
        decision, event = execute(world, effects)
        out.write(
            "action=%s\nreason=%s\nduplicate=%s\nquote_as_of=%s\nfreshness=%s\ncollected_at_role=%s\n" % (
                decision["action"], decision["reason"], str(bool(event["duplicate"])).lower(),
                decision["quote_as_of"], decision["freshness"]["state"],
                decision["collected_at_role"],
            )
        )
        return 0
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
