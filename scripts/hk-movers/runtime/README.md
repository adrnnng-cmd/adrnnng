# Movers collector runtime (box-only scripts)

These files run on the machine that has the local OpenD (`127.0.0.1:11111`), next to `hk_movers_sync.py`. They used
to exist only on that box. The Python collector, rosters, history cache, news lookup, KV key (`hk-movers:latest.json`),
both public APIs and the 5 minute cadence are not changed by anything in this directory.

| File | Replaces | Role |
|---|---|---|
| `daemon.sh` | `daemon.sh` | Same entry point (`bash daemon.sh`, pid kept through `exec`); starts `supervisor.py`. |
| `supervisor.py` | the bash loop | Schedule, wall-clock and suspend-aware supervision of one collect, backoff, process sweep. |
| `run_sync.sh` | `run_sync.sh` | One collect + publish: flock, collect with one retry, publish gate, curl PUT to KV, atomic local replace. |
| `publish_gate.py` | new | Refuses a stale, overdue or older-than-live document before KV and before the local replace. |
| `install.sh`, `rollback.sh` | new | Backup, atomic install and restore, under `.sync.lock`. Neither restarts anything. |

## What went wrong on 2026-11-23

`daemon.sh` polled every 15 s on the wall clock, but ran each collect as `timeout 180 run_sync.sh`. The loop was blocked
inside `timeout` for as long as the collect lived, and the deadline did not run while the host was frozen. The 14:02:44
collect lived until 14:59:58 (`exit=124`). The 15:00:13 collect was frozen again and was not killed after the second
resume; it finished 15:20:12 and was published as fresh with the stamp `updated_at_hkt` 15:00:13, because the collector
stamps the start of a collect. (That the second collect survived a 20 minute wall-clock gap is also what a deadline that
does not follow the wall clock predicts; it was not reproduced on the box, which this repository cannot pause.)

## How the new runtime supervises

* The collect runs in its own session. The supervisor keeps ticking (1 s) while it runs; nothing blocks the loop.
* An attempt ends when **any** of these holds: the wall clock says 180 s have passed, the monotonic clock says so, or
  the wall clock moved more than 20 s ahead of the monotonic clock between two ticks (host freeze/resume or a clock
  step). It does not matter which of the clocks a freeze stops: if only the wall clock follows the resume, the jump
  test fires; if both follow it, the wall deadline fires; if neither does, nothing runs and nothing can.
* The process group gets TERM, then KILL after 15 s (measured on both clocks). Everything left in the group **or the
  session** (zombies excluded, read from `/proc`) is killed after every attempt, so an orphan cannot keep the
  `.sync.lock` flock. A collector that calls `setsid` itself escapes this; the shipped collector does not.
* A freeze is not a failure. It is followed, after 5 s, by a fresh collect (not by the end of the old one). A failed or
  overdue attempt backs off 30 s, 60 s, 120 s, 120 s ... instead of retrying on every poll; success resets it. The old
  loop also re-ran at once after a long attempt (`now - last_attempt >= interval`), e.g. 15:20:13 then 15:20:28; the
  rule is now only "latest.json is at least 300 s old".
* "Not overlapping": the supervisor probes `.sync.lock` before it starts and does not start while it is held (logged
  once); `run_sync.sh` keeps its own `flock -n`; `.daemon.lock` stops a second supervisor.
* A run is OK only if `run_sync.sh` exited 0 **and** `latest.json` was replaced; exit 0 from a busy lock is logged as
  `no-publish`.
* Log lines keep the old shapes (`syncing (file_age=Ns)...`, `sync OK`, `sync WARN exit=N`) with the reason added.

## Nothing stale is published

The supervisor exports `HK_MOVERS_ATTEMPT_START_EPOCH`, `HK_MOVERS_ATTEMPT_DEADLINE_EPOCH` and
`HK_MOVERS_PUBLISH_BY_EPOCH` (deadline minus 25 s, so an upload never straddles the kill). After the collect and before
the KV upload, `publish_gate.py` rejects (exit 3, `sync WARN exit=3` in the log) when the document is not a Movers
document, is stamped more than 210 s ago (`HK_MOVERS_MAX_DOC_AGE`) or from before the attempt, is later than the publish
deadline, or is older than the live `latest.json`. The stamp is **not** rewritten to the finish time: the document is
rejected, the last good snapshot stays, and a fresh collect follows.

Two deliberate differences from the old `run_sync.sh`:

1. The local `latest.json` is replaced **after** a successful KV upload (it was before). A failed upload therefore
   looks stale to the supervisor and is retried within the backoff, instead of waiting out the 5 minutes.
2. `curl` gets `--connect-timeout 10 --max-time 20`. Everything else of the curl contract (PUT, the key, the URL, the
   headers, `--data-binary @file`, reading the token from `/workspace/digest/.cf_token` at run time) is unchanged. The
   token is on curl's command line as before.

The KV account and namespace ids are not in this repository: `install.sh` copies them from the live `run_sync.sh`
(or from `HK_MOVERS_KV_ACCOUNT_ID` / `HK_MOVERS_KV_NAMESPACE_ID`) into `runtime.env` (mode 600) next to the scripts.

## Install (the parent executor)

```bash
cd <this directory>            # or wherever the files were copied
bash install.sh --dry-run      # checks syntax, shows the hashes, writes nothing
bash install.sh                # exit 75 if a collect holds .sync.lock: wait and rerun
```

`install.sh` takes `.sync.lock`, copies the files it replaces to `$DIR/rollout-runtime-<UTC time>/` (with `SHA256SUMS`
and an `ABSENT` list), and renames the new files into place. A running bash daemon keeps its old inode, so nothing
changes until it is replaced. OpenD is never touched. Then replace only the daemon:

```bash
DIR=/workspace/futu/hk-movers
kill "$(cat $DIR/daemon.pid)"                       # TERM; the old bash daemon is idle between collects (only a `sleep 15` child)
# wait until `.sync.lock` has no holder, then
setsid nohup bash $DIR/daemon.sh >> $DIR/daemon.log 2>&1 < /dev/null &
tail -n 5 $DIR/daemon.log                           # "supervisor started pid=..."
```

If a collect is in flight when the old daemon is stopped, let it finish first (`pgrep -f run_sync.sh`). The restart guard
holds: a `latest.json` younger than 300 s is not collected again.

## Rollback

```bash
bash rollback.sh --dir /workspace/futu/hk-movers /workspace/futu/hk-movers/rollout-runtime-<stamp>
kill "$(cat /workspace/futu/hk-movers/daemon.pid)"   # the supervisor stops its collect and removes daemon.pid
setsid nohup bash /workspace/futu/hk-movers/daemon.sh >> /workspace/futu/hk-movers/daemon.log 2>&1 < /dev/null &
```

`rollback.sh` also takes `.sync.lock`, restores the saved files byte for byte and removes the ones that did not exist
before (`supervisor.py`, `publish_gate.py`, `runtime.env`). The old daemon's behaviour returns with the old files.

## Limits

* Nothing is collected while the host is paused. After the resume the supervisor ends the in-flight collect and starts a
  fresh one on its next ticks (about 5 s later; OpenD may need a few seconds to reconnect, and then the ordinary backoff
  applies). The public snapshot is as old as the pause until that collect publishes.
* An external runner is not possible: OpenD is only reachable on `127.0.0.1` of this box.
* The daemon does not survive a reboot (no systemd/cron on the box).
* A document older than 210 s at publish time is rejected even when it is the only one: with OpenD down the public
  snapshot simply stays old, and the page flags it as 快照過時 in an active session.
* History K-line quota (`100/100`) is not touched; a failed attempt can still spend quota, which is why retries back off.
* A freeze that happens in the milliseconds between the gate and the KV upload is not detected.

## Tests

`python3 -m unittest scripts/tests/test_hk_movers_runtime.py` (about 16 s): fake wall/monotonic clocks, real process
trees (blocked collector, TERM ignored, orphan holding the lock, child leaving its process group), resume jump, 180 s
expiry, lock contention, backoff, publish gate, `run_sync.sh` with a stub curl, install and rollback in a temp
directory, and the real supervisor process with a real SIGTERM. They never contact OpenD, KV or the network.
