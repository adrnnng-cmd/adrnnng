"""One-shot gate for Movers recovery. It does not start OpenD, collect, or publish.

The installed supervisor does not survive a reboot, and start_opend.sh pkills a
live gateway and then waits for an account prompt OpenD 10.11.7108 does not
print. This module decides what a person or an external timer may do next.
It never returns a pkill, never returns start_opend.sh, and never retries a
login that already failed, challenged, or left qot_logined unknown.

``updated_at_hkt`` is the collector start stamp. It is not a quote time.
``quote_as_of`` stays unknown. Lunch and closed sessions are not trading-stale.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

HKT = timezone(timedelta(hours=8))
COLLECT_MAX_AGE = 300
DAEMON = "/workspace/futu/hk-movers/daemon.sh"

# Weekday collect windows from the installed supervisor: 09:20-12:06 and 12:55-16:16.
def in_collect_window(moment):
    moment = moment.astimezone(HKT)
    if moment.weekday() >= 5:
        return False
    minutes = moment.hour * 60 + moment.minute
    return 9 * 60 + 20 <= minutes <= 12 * 60 + 6 or 12 * 60 + 55 <= minutes <= 16 * 60 + 16


def market_session(moment):
    moment = moment.astimezone(HKT)
    if moment.weekday() >= 5:
        return "closed"
    minutes = moment.hour * 60 + moment.minute
    if 9 * 60 <= minutes < 9 * 60 + 30:
        return "pre_open"
    if 9 * 60 + 30 <= minutes < 12 * 60:
        return "morning"
    if 12 * 60 <= minutes < 13 * 60:
        return "lunch"
    if 13 * 60 <= minutes < 16 * 60:
        return "afternoon"
    if 16 * 60 <= minutes < 16 * 60 + 10:
        return "closing_auction"
    return "closed"


def freshness(now, stamp):
    """How to read a collector stamp. Does not rewrite it."""
    session = market_session(now)
    window = in_collect_window(now)
    if stamp is None:
        state = "missing"
        age = None
    else:
        age = (now - stamp).total_seconds()
        if session in ("lunch", "closed", "pre_open", "closing_auction"):
            state = "expected"
        elif window and age > COLLECT_MAX_AGE:
            state = "stale_trading"
        elif window:
            state = "fresh"
        else:
            state = "expected"
    return {
        "state": state,
        "session": session,
        "collect_window": window,
        "age_s": age,
        "collected_at": stamp.astimezone(HKT).strftime("%Y-%m-%d %H:%M:%S") if stamp else None,
        "quote_as_of": "unknown",
    }


def backoff_delay(fails, base=30, cap=120):
    if fails <= 0:
        return 0
    return min(cap, base * (2 ** (fails - 1)))


def _stop(action, reason, fresh, *, retry=False, commands=None):
    return {
        "action": action,
        "reason": reason,
        "retry": retry,
        "commands": commands or [],
        "pkill": False,
        "start_opend_sh": False,
        "freshness": fresh,
        "quote_as_of": "unknown",
    }


def decide(obs):
    """Return the single next action for one recovery pass.

    ``obs`` keys: recover_lock_held, opend_listening, supervisor_running,
    login_kind (None if the helper has not run), qot_logined (True/False/None),
    interpreter_ready, now, stamp, fails, last_attempt_at.
    """
    now = obs["now"]
    fresh = freshness(now, obs.get("stamp"))
    if obs.get("recover_lock_held"):
        return _stop("noop_duplicate", "recover_lock_held", fresh)
    if not obs.get("opend_listening"):
        return _stop("alert_opend_down", "opend_not_listening", fresh)
    kind = obs.get("login_kind")
    if kind in ("auth_challenge",):
        return _stop("alert_auth_challenge", kind, fresh)
    if kind in ("auth_failed",):
        return _stop("alert_auth_failed", kind, fresh)
    if kind in (
        "account_consumed", "protocol_timeout", "protocol_unexpected", "telnet_down",
        "account_prompt_missing", "remember_before_password", "password_not_sent",
    ):
        return _stop("alert_login_protocol", kind, fresh)
    delay = backoff_delay(obs.get("fails") or 0)
    last = obs.get("last_attempt_at")
    if delay and last is not None and (now - last).total_seconds() < delay:
        return _stop("noop_backoff", "backoff", fresh)
    qot = obs.get("qot_logined")
    if kind is None and qot is not True:
        # A PTY OpenD prints the account prompt on the console. Telnet stays the
        # version banner, so the one login is the console helper.
        return _stop("run_login_once", "login_not_verified", fresh, commands=["opend_console_login.py"])
    if not obs.get("interpreter_ready"):
        return _stop("alert_interpreter", "interpreter_not_ready", fresh)
    if qot is None:
        return _stop("alert_qot_unconfirmed", "constructor_timeout", fresh)
    if qot is not True:
        return _stop("alert_qot_not_logined", "qot_logined_false", fresh)
    if obs.get("supervisor_running"):
        action = "noop_supervisor_running"
        if fresh["state"] == "stale_trading":
            action = "alert_stale_while_supervisor_running"
        return _stop(action, "supervisor_already_running", fresh)
    commands = ["setsid", "nohup", "bash", DAEMON]
    decided = _stop("start_supervisor_once", "qot_logined", fresh, commands=commands)
    decided["collect_due"] = fresh["state"] in ("stale_trading", "missing") and fresh["collect_window"]
    return decided


def alert_fingerprint(decision, stamp_text):
    fresh = decision["freshness"]
    return "|".join([
        decision["action"],
        decision["reason"],
        fresh["state"],
        fresh["session"],
        stamp_text or "",
    ])


def next_alert(previous, decision, now, stamp_text):
    fingerprint = alert_fingerprint(decision, stamp_text)
    if previous and previous.get("fingerprint") == fingerprint:
        return {
            "fingerprint": fingerprint,
            "at": previous.get("at"),
            "repeat": previous.get("repeat", 1) + 1,
            "duplicate": True,
            "action": decision["action"],
        }
    return {
        "fingerprint": fingerprint,
        "at": now.astimezone(HKT).strftime("%Y-%m-%d %H:%M:%S"),
        "repeat": 1,
        "duplicate": False,
        "action": decision["action"],
    }
