#!/usr/bin/env python3
"""Wall-clock aware supervisor for the Movers collector on the box that runs OpenD.

It replaces the bash polling loop of daemon.sh. The scheduling rules are the same (weekdays 09:20-12:06 and
12:55-16:16 Hong Kong time, a new snapshot once latest.json is 300 s old, a 15 s poll). What changes is how a
collect is supervised: GNU `timeout` counts a deadline that does not advance while the host is frozen, so one
freeze kept the loop inside a 180 s `timeout` for nearly an hour.

Here the collect runs in its own session (process group) and the supervisor keeps ticking while it runs. An attempt
is over when ANY of these is true: the wall clock says it ran for the timeout, the monotonic clock says so, or the
two clocks disagree by more than `--jump` seconds between two ticks (the host was frozen and resumed, or the clock
was stepped). The whole process group is then sent TERM, and KILL after a grace period (both measured on both
clocks), and every process left in the group or session is swept. The next attempt is a fresh collect.

Standard library only. Linux only for the process sweep (it reads /proc); the rest is portable.
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HKT = timezone(timedelta(hours=8))
DEFAULT_DIR = "/workspace/futu/hk-movers"
NEVER = 999999


class SystemClock:
    def wall(self):
        return time.time()

    def mono(self):
        return time.monotonic()

    def sleep(self, seconds):
        time.sleep(seconds)


class Config:
    def __init__(self, directory=DEFAULT_DIR, run_sync=None, interval=300, poll=15, tick=1.0, timeout=180,
                 term_grace=15, jump=20, publish_reserve=25, backoff_base=30, backoff_max=120, settle=5,
                 log_lines=400, always_run=False):
        self.dir = Path(directory)
        self.run_sync = Path(run_sync) if run_sync else self.dir / "run_sync.sh"
        self.interval = interval
        self.poll = poll
        self.tick = tick
        self.timeout = timeout
        self.term_grace = term_grace
        self.jump = jump
        self.publish_reserve = publish_reserve
        self.backoff_base = backoff_base
        self.backoff_max = backoff_max
        self.settle = settle
        self.log_lines = log_lines
        self.always_run = always_run

    @property
    def latest(self):
        return self.dir / "latest.json"

    @property
    def log(self):
        return self.dir / "daemon.log"

    @property
    def sync_lock(self):
        return self.dir / ".sync.lock"

    @property
    def daemon_lock(self):
        return self.dir / ".daemon.lock"

    @property
    def pidfile(self):
        return self.dir / "daemon.pid"


def in_window(moment):
    """Same schedule as the old should_run(): Mon-Fri, 09:20-12:06 and 12:55-16:16 Hong Kong time."""
    moment = moment.astimezone(HKT)
    if moment.weekday() >= 5:
        return False
    minutes = moment.hour * 60 + moment.minute
    return 9 * 60 + 20 <= minutes <= 12 * 60 + 6 or 12 * 60 + 55 <= minutes <= 16 * 60 + 16


def backoff_delay(cfg, fails):
    if fails <= 0:
        return 0
    return min(cfg.backoff_max, cfg.backoff_base * (2 ** (fails - 1)))


def _proc_fields(pid):
    """(state, pgrp, session) of a process from /proc, or None when it is gone or /proc is unavailable."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as fh:
            raw = fh.read().decode("ascii", "replace")
    except OSError:
        return None
    tail = raw[raw.rfind(")") + 2:].split()
    try:
        return tail[0], int(tail[2]), int(tail[3])
    except (IndexError, ValueError):
        return None


def group_members(pgid):
    """Live (non-zombie) pids whose process group or session is `pgid`."""
    found = []
    try:
        names = os.listdir("/proc")
    except OSError:
        return found
    for name in names:
        if not name.isdigit():
            continue
        fields = _proc_fields(int(name))
        if fields and fields[0] != "Z" and (fields[1] == pgid or fields[2] == pgid):
            found.append(int(name))
    return found


def lock_holders(path):
    """Pids holding `path` open (any fd). Diagnostic only."""
    try:
        target = os.stat(path)
    except OSError:
        return []
    holders = []
    for name in os.listdir("/proc") if os.path.isdir("/proc") else []:
        if not name.isdigit() or int(name) == os.getpid():
            continue
        fd_dir = "/proc/%s/fd" % name
        try:
            for fd in os.listdir(fd_dir):
                try:
                    st = os.stat(os.path.join(fd_dir, fd))
                except OSError:
                    continue
                if (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino):
                    holders.append(int(name))
                    break
        except OSError:
            continue
    return holders


def lock_busy(path):
    """True when another process holds the flock on `path` (the lock run_sync.sh takes)."""
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in (errno.EAGAIN, errno.EACCES):
            return True
        raise
    finally:
        os.close(fd)
    return False


class Outcome:
    def __init__(self, kind, exit_code=0, reason="", elapsed=0.0):
        self.kind = kind
        self.exit_code = exit_code
        self.reason = reason
        self.elapsed = elapsed

    def __repr__(self):
        return "Outcome(%s, exit=%s, reason=%s, elapsed=%.0f)" % (self.kind, self.exit_code, self.reason, self.elapsed)


class Supervisor:
    def __init__(self, cfg, clock=None, env=None):
        self.cfg = cfg
        self.clock = clock or SystemClock()
        self.env = dict(os.environ if env is None else env)
        self.fails = 0
        self.next_allowed = 0.0
        self._stop = False
        self._last_wall = self.clock.wall()
        self._last_mono = self.clock.mono()
        self._busy_logged = False
        self.outcomes = []

    def stop(self, *_args):
        self._stop = True

    def stopped(self):
        return self._stop

    def log(self, message):
        stamp = datetime.fromtimestamp(self.clock.wall(), HKT).strftime("%Y-%m-%d %H:%M:%S HKT")
        with open(str(self.cfg.log), "a", encoding="utf-8") as fh:
            fh.write("[%s] %s\n" % (stamp, message))

    def trim_log(self):
        try:
            lines = self.cfg.log.read_text(encoding="utf-8", errors="replace").splitlines(True)
            if len(lines) <= self.cfg.log_lines:
                return
            tmp = self.cfg.log.with_name(self.cfg.log.name + ".tmp")
            tmp.write_text("".join(lines[-self.cfg.log_lines:]), encoding="utf-8")
            os.replace(str(tmp), str(self.cfg.log))
        except OSError:
            pass

    def observe(self):
        """Seconds the wall clock moved beyond the monotonic clock since the last call (a freeze or a clock step)."""
        wall, mono = self.clock.wall(), self.clock.mono()
        gap = (wall - self._last_wall) - (mono - self._last_mono)
        self._last_wall, self._last_mono = wall, mono
        return gap

    def file_age(self, now):
        try:
            mtime = self.cfg.latest.stat().st_mtime
        except OSError:
            return NEVER
        age = now - mtime
        # A file dated in the future (clock stepped back) must not block collection until the clock catches up.
        if age < -60:
            return self.cfg.interval
        return max(0, age)

    def due(self, now):
        if not self.cfg.always_run and not in_window(datetime.fromtimestamp(now, HKT)):
            return False, None
        age = self.file_age(now)
        if age < self.cfg.interval or now < self.next_allowed:
            return False, age
        return True, age

    def cycle(self):
        jump = self.observe()
        if jump >= self.cfg.jump:
            self.log("clock jumped %ds ahead of the monotonic clock (host pause/resume or clock step)" % jump)
        now = self.clock.wall()
        due, age = self.due(now)
        if not due:
            return None
        if lock_busy(self.cfg.sync_lock):
            if not self._busy_logged:
                holders = lock_holders(self.cfg.sync_lock)
                self.log("sync lock is held (pids %s); not starting another collect" % (holders or "unknown"))
                self._busy_logged = True
            return Outcome("busy")
        self._busy_logged = False
        outcome = self.attempt(age)
        self.outcomes.append(outcome)
        self.after(outcome)
        return outcome

    def after(self, outcome):
        now = self.clock.wall()
        if outcome.kind == "ok":
            self.fails = 0
            self.next_allowed = 0.0
        elif outcome.kind in ("suspend", "shutdown"):
            self.next_allowed = now + self.cfg.settle
        else:
            self.fails += 1
            delay = backoff_delay(self.cfg, self.fails)
            self.next_allowed = now + delay
            self.log("retry in %ds (consecutive failures: %d)" % (delay, self.fails))
        self.remove_stale_tmp()
        self.trim_log()

    def remove_stale_tmp(self):
        if lock_busy(self.cfg.sync_lock):
            return
        for path in self.cfg.dir.glob("latest.json.tmp*"):
            try:
                path.unlink()
            except OSError:
                pass

    def attempt_env(self, start):
        env = dict(self.env)
        deadline = start + self.cfg.timeout
        env["HK_MOVERS_ATTEMPT_START_EPOCH"] = "%d" % start
        env["HK_MOVERS_ATTEMPT_DEADLINE_EPOCH"] = "%d" % deadline
        env["HK_MOVERS_PUBLISH_BY_EPOCH"] = "%d" % (deadline - self.cfg.publish_reserve)
        env["HK_MOVERS_DIR"] = str(self.cfg.dir)
        return env

    def attempt(self, age):
        cfg = self.cfg
        wall0, mono0 = self.clock.wall(), self.clock.mono()
        before = self.latest_signature()
        self.log("syncing (file_age=%ds)..." % age)
        reason = ""
        jumped = False
        with open(str(cfg.log), "ab") as logfh:
            proc = subprocess.Popen([str(cfg.run_sync)], stdin=subprocess.DEVNULL, stdout=logfh,
                                    stderr=subprocess.STDOUT, env=self.attempt_env(wall0), cwd=str(cfg.dir),
                                    start_new_session=True)
            pgid = proc.pid
            self.observe()
            exit_code = None
            while True:
                self.clock.sleep(cfg.tick)
                exit_code = proc.poll()
                gap = self.observe()
                wall, mono = self.clock.wall(), self.clock.mono()
                if gap >= cfg.jump:
                    jumped = True
                if exit_code is not None:
                    break
                if self.stopped():
                    reason = "shutdown"
                elif jumped:
                    reason = "clock-jump"
                elif wall - wall0 >= cfg.timeout:
                    reason = "wall-deadline"
                elif mono - mono0 >= cfg.timeout:
                    reason = "monotonic-deadline"
                if reason:
                    self.terminate(proc, pgid)
                    exit_code = 124
                    break
            self.sweep(pgid)
        elapsed = max(self.clock.wall() - wall0, self.clock.mono() - mono0)
        if reason == "shutdown":
            self.log("sync stopped: supervisor shutting down")
            return Outcome("shutdown", exit_code, reason, elapsed)
        if reason:
            kind = "suspend" if reason == "clock-jump" else "deadline"
            self.log("sync WARN exit=%d reason=%s elapsed=%ds" % (exit_code, reason, elapsed))
            return Outcome(kind, exit_code, reason, elapsed)
        if exit_code == 0:
            if self.latest_signature() != before:
                self.log("sync OK (elapsed=%ds)" % elapsed)
                return Outcome("ok", 0, "", elapsed)
            self.log("sync WARN exit=0 reason=no-publish (latest.json was not replaced) elapsed=%ds" % elapsed)
            return Outcome("noop", 0, "no-publish", elapsed)
        if jumped:
            self.log("sync WARN exit=%d reason=clock-jump elapsed=%ds" % (exit_code, elapsed))
            return Outcome("suspend", exit_code, "clock-jump", elapsed)
        self.log("sync WARN exit=%d elapsed=%ds" % (exit_code, elapsed))
        return Outcome("failed", exit_code, "", elapsed)

    def latest_signature(self):
        """Identity of latest.json: run_sync.sh replaces it by rename, so a new file means a publish. Comparing it
        instead of its mtime keeps working when the wall clock is stepped back during the attempt."""
        try:
            st = self.cfg.latest.stat()
        except OSError:
            return None
        return (st.st_ino, st.st_mtime_ns, st.st_size)

    def signal_group(self, pgid, sig):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        if sig == signal.SIGKILL:
            for pid in group_members(pgid):
                try:
                    os.kill(pid, sig)
                except OSError:
                    pass

    def terminate(self, proc, pgid):
        self.signal_group(pgid, signal.SIGTERM)
        wall0, mono0 = self.clock.wall(), self.clock.mono()
        grace = self.cfg.term_grace
        while proc.poll() is None or group_members(pgid):
            if self.clock.wall() - wall0 >= grace or self.clock.mono() - mono0 >= grace:
                break
            self.clock.sleep(min(self.cfg.tick, 0.5))
        self.signal_group(pgid, signal.SIGKILL)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.log("collect leader %d did not exit after KILL" % pgid)

    def sweep(self, pgid):
        """Kill whatever the finished attempt left in its group or session, so no orphan keeps the sync lock."""
        for _ in range(20):
            members = group_members(pgid)
            if not members:
                return
            self.log("killing %d leftover process(es) of the collect: %s" % (len(members), members))
            self.signal_group(pgid, signal.SIGKILL)
            time.sleep(0.05)
        self.log("WARN: processes %s survived KILL" % group_members(pgid))

    def run(self, max_cycles=None):
        cycles = 0
        while not self.stopped():
            self.cycle()
            cycles += 1
            if max_cycles is not None and cycles >= max_cycles:
                break
            if self.stopped():
                break
            self.clock.sleep(self.cfg.poll)


def write_pidfile(path, pid):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("%d\n" % pid)
    os.replace(str(tmp), str(path))


def parse_args(argv=None):
    env = os.environ
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dir", default=env.get("HK_MOVERS_DIR", DEFAULT_DIR))
    p.add_argument("--run-sync", default=None)
    p.add_argument("--interval", type=int, default=int(env.get("HK_MOVERS_INTERVAL", "300")))
    p.add_argument("--poll", type=float, default=float(env.get("HK_MOVERS_POLL", "15")))
    p.add_argument("--tick", type=float, default=1.0)
    p.add_argument("--timeout", type=int, default=int(env.get("HK_MOVERS_SYNC_TIMEOUT", "180")))
    p.add_argument("--term-grace", type=int, default=15)
    p.add_argument("--backoff-base", type=int, default=30, help="first retry delay (s) after a failed collect; doubles up to 120")
    p.add_argument("--jump", type=int, default=20, help="clock disagreement (s) that counts as a freeze")
    p.add_argument("--always-run", action="store_true", help="ignore the trading-hours window (tests and diagnostics only)")
    p.add_argument("--once", action="store_true", help="run one scheduler cycle and exit (diagnostics)")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    cfg = Config(args.dir, args.run_sync, args.interval, args.poll, args.tick, args.timeout, args.term_grace, args.jump, backoff_base=args.backoff_base, always_run=args.always_run)
    sup = Supervisor(cfg)
    lock_fd = os.open(str(cfg.daemon_lock), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sup.log("another supervisor already holds %s; exiting" % cfg.daemon_lock.name)
        return 0
    write_pidfile(cfg.pidfile, os.getpid())
    signal.signal(signal.SIGTERM, sup.stop)
    signal.signal(signal.SIGINT, sup.stop)
    sup.log("supervisor started pid=%d interval=%ds poll=%ss timeout=%ds" % (os.getpid(), cfg.interval, args.poll, cfg.timeout))
    try:
        sup.run(max_cycles=1 if args.once else None)
    finally:
        try:
            if cfg.pidfile.read_text().strip() == str(os.getpid()):
                cfg.pidfile.unlink()
        except OSError:
            pass
        sup.log("supervisor stopped pid=%d" % os.getpid())
    return 0


if __name__ == "__main__":
    sys.exit(main())
