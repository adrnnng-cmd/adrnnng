# Recovery pass for approval

`recover_once.py` is the one pass a 5-minute caller would run. It is not
installed. This tree does not create the caller. Nothing here publishes,
kills OpenD, or runs `start_opend.sh`.

Two afternoon collector starts are already confirmed: 2026-11-25 15:19:16,
then 2026-11-25 15:26:11 (sha256 prefix `8918f1a7`). The 15:19:16 file is
not the current public snapshot. A later public read of both latest URLs,
which this pass did not collect, returned `updated_at_hkt` 2026-11-25
15:36:06, sha256
`5eb1e5c3bfa49b4f2c30a6ea3095d4a23df33d337037978671d9bd6806422c18`,
281996 bytes, `market_session` afternoon. That stamp is the collector
start. `quote_as_of` is unknown. This pass starts `daemon.sh` only when
`qot_logined` is true, and appends that process to the existing
`daemon.log`. `publish_gate` still rejects a stale file.

## What one pass does

1. Take `.recover.lock`. A second pass exits as a duplicate.
2. Start one tmux session `opend` only when both 11111 and 22222 are closed
   and no owned `FutuOpenD` process exists. The session uses
   `recover-tmux.conf` (`history-limit 0`, no pipe-pane) and
   `sleep 0.4; exec ./FutuOpenD` with the existing flags. The tmux process
   does not inherit `FUTU_LOGIN_ACCOUNT` or `FUTU_LOGIN_PWD`. No account or
   password is in the command.
3. If either port is open and no owned `FutuOpenD` exists, write
   `alert_port_busy` and do not start a session. If an owned process exists
   and a port does not, write `alert_opend_stuck` and do not kill it.
4. If `/workspace/futu/.venv/bin/python` is absent, do not log in and do not
   start the daemon. Append `alert_missing_deps` with reason `venv_missing`
   and pin `futu-api==10.12.7208` from `requirements-futu.txt`. This still
   happens on the same pass that starts OpenD. The pass does not run
   `python -m venv` and does not run pip. The venv is not restored.
5. If the quote check is true and `daemon.pid` is alive, do nothing. Lunch
   and a closed session are not trading-stale. `quote_as_of` is unknown.
   `updated_at_hkt` is the collector start, not an exchange as-of time.
6. If the quote check is true and the daemon is down, start
   `setsid nohup bash daemon.sh` once. Its stdout and stderr append to the
   existing `daemon.log`. This pass does not collect.
7. Login runs only when the SDK interpreter exists, both environment
   variables are already set, the pane's current line is `Please enter account`,
   and the quote check is not logged in. The helper process is
   `/usr/bin/python3`. `--python` is the SDK interpreter, passed only as an
   argument. Exit 2 and exit 3 stick. Three other failures stick as
   `login_stopped`. A missing variable sticks as `authmaterialmissing`.
   Exit 0 then starts the daemon. A `bad_output` quote check does not log in.
8. A failure, a sticky stop, or `alert_recovered` is appended to
   `recover-events.log` when its fingerprint is new. The fingerprint is
   action, reason, freshness state, and session. It does not include
   `updated_at_hkt`. A healthy stamp that advances does not append and does
   not notify. `alert_recovered` is written only for stale or missing
   becoming fresh, or a newer collector stamp that is no longer stale or
   missing. Each line says `quote_as_of=unknown`,
   `collected_at=collector_start`, and `notify=1` only for those events.

## External routine

Adrian creates this after approval. This tree does not create it. A host
crontab can disappear when the box is replaced, so the wake lives outside
the box: one saved GrokBot routine, weekdays, every 5 minutes.

The routine does four things and nothing else:

1. Read the public snapshot at `/movers/data/latest` and
   `/hk-movers/data/latest` only to know the collector start. That field is
   not an exchange as-of time. `quote_as_of` is unknown. Do not notify
   because `updated_at_hkt` advanced. A newer healthy stamp is not a page.
2. When the box answers, read `recover-events.log`. Notify only when a new
   line has `notify=1`: a new failure, a sticky stop
   (`auth_failed`, `auth_challenge`, `login_stopped`, `authmaterialmissing`),
   or `alert_recovered`. Do not notify because the fingerprint in
   `recover-state.json` changed by itself, and do not notify on a repeated
   fingerprint. `alert_recovered` is the stale or missing to fresh or newer
   transition. The pass writes it once. A later healthy cycle writes nothing.
3. Invoke the pass only when `sticky` is empty or is not one of
   `auth_failed`, `auth_challenge`, `login_stopped`, `authmaterialmissing`.
   The command is exactly:

```
/usr/bin/flock -n /workspace/futu/hk-movers/.recover.lock /usr/bin/python3 /workspace/futu/hk-movers/recover_once.py --run --dir /workspace/futu/hk-movers --python /workspace/futu/.venv/bin/python
```

   `/usr/bin/python3` is the process. The `.venv` path is only the `--python`
   argument. If that file is missing, this command still starts and writes
   `alert_missing_deps`. It does not install the package.
4. After `auth_failed`, `auth_challenge`, `login_stopped`, or
   `authmaterialmissing`, notify once on the transition and do not invoke
   the command again. The script also refuses the login. A person clears
   `recover-state.json`.

The command contains no secret. The routine uses the environment it already
has. This pass reads `FUTU_LOGIN_ACCOUNT` and `FUTU_LOGIN_PWD` from that
environment only. It does not read or write a credential file. If either
variable is missing, it writes one `authmaterialmissing` event and does not
guess again.

## Approvals still required

- Create the external 5-minute GrokBot routine above. Weekdays only, flock, no secrets in the command. Do not rely on host cron as the only wake.
- Leave the two login variables in the existing environment. Do not add a credential file.
- Allow one tmux session and one `FutuOpenD` only when no OpenD process exists and both ports are closed.
- Do not grant a standing permission to kill a process, to run `start_opend.sh`, to create the venv, or to log in again after `auth_failed`, `auth_challenge`, `login_stopped`, or `authmaterialmissing`.
- Run `install_recover.sh --apply /workspace/futu/hk-movers` only after those are accepted. The default is a dry-run. Rollback is `rollback_recover.sh --apply` and it does not stop the gateway or the daemon.
- `recover-state.json` does not survive a replace that wipes the workspace. This pass does not claim the box comes back by itself. Missing SDK stays an alert. Missing login variables stay one sticky `authmaterialmissing` event.

## Quote record

`probe_qot` accepts one `HKMOVERS_QOT_BEGIN` / `HKMOVERS_QOT_END` record.
Connect and disconnect logs around it are ignored. A JSON object outside
the markers is not a login. A non-zero `ret` is not a login. A timeout
discards any late record and does not start another login by itself.
