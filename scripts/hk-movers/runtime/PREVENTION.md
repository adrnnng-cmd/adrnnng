# Recovery pass for approval

`recover_once.py` is the one pass a 5-minute caller would run. It is not
installed. This tree does not create the caller. Nothing here publishes,
kills OpenD, or runs `start_opend.sh`.

The public afternoon snapshot from the console login is already on the
site: `updated_at_hkt` 2026-11-25 15:19:16, sha256
`2ae6142610720a44dddfc8c2d81bfd7065b81803c194e223655ebe45dd71e90f`,
278880 bytes, `market_session` afternoon. The supervisor that produced it
is the existing `daemon.sh`. This pass only starts that daemon when
`qot_logined` is true. `publish_gate` inside the existing sync still
rejects a stale file. `updated_at_hkt` stays the collector start time.

## What one pass does

1. Take `.recover.lock`. A second pass exits as a duplicate.
2. If ports 11111 and 22222 are closed and no `FutuOpenD` process exists,
   start one tmux session `opend` with `recover-tmux.conf` (`history-limit 0`,
   no pipe-pane) and `sleep 0.4; exec ./FutuOpenD` using the existing flags.
   No account or password is in that command.
3. If a process exists and a port does not, write an alert and stop. Do not
   kill it.
4. If `/workspace/futu/.venv/bin/python` is absent, do not log in and do not
   start the daemon. Append `alert_missing_deps` with reason `venv_missing`
   and pin `futu-api==10.12.7208` from `requirements-futu.txt`. This still
   happens on the same pass that starts OpenD. The pass does not run
   `python -m venv` and does not run pip. The venv is not restored.
5. If the quote check is true and `daemon.pid` is alive, do nothing. Lunch
   and a closed session are not trading-stale. `quote_as_of` is unknown.
   `updated_at_hkt` is the collector start, not an exchange as-of time.
6. If the quote check is true and the daemon is down, start
   `setsid nohup bash daemon.sh` once. This pass does not collect.
7. Login runs only when the SDK interpreter exists, both environment
   variables are already set, the pane's current line is `Please enter account`,
   and the quote check is not logged in. The helper process is
   `/usr/bin/python3`. `--python` is the SDK interpreter, passed only as an
   argument. Exit 2 and exit 3 stick. Three other failures stick as
   `login_stopped`. A missing variable sticks as `authmaterialmissing`.
   Exit 0 then starts the daemon. A `bad_output` quote check does not log in.
8. Alerts append to `recover-events.log` only when the fingerprint changes.
   Each line says `quote_as_of=unknown` and `collected_at=collector_start`.

## External routine

Adrian creates this after approval. This tree does not create it. A host
crontab can disappear when the box is replaced, so the wake lives outside
the box: one saved GrokBot routine, weekdays, every 5 minutes.

The routine does four things and nothing else:

1. Read the public snapshot at `/movers/data/latest` and
   `/hk-movers/data/latest`. Compare `updated_at_hkt` with the previous
   observation. That field is the collector start. It is not an exchange
   as-of time. `quote_as_of` is unknown and the routine must not invent one.
2. When the box answers, read `recover-events.log` and `recover-state.json`.
   Notify only when the event fingerprint changes, when the public
   `updated_at_hkt` changes, or when a previously stale or missing collector
   stamp is replaced by a newer one. A repeat of the same fingerprint is
   not a notification.
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

## Quote record

`probe_qot` accepts one `HKMOVERS_QOT_BEGIN` / `HKMOVERS_QOT_END` record.
Connect and disconnect logs around it are ignored. A JSON object outside
the markers is not a login. A non-zero `ret` is not a login. A timeout
discards any late record and does not start another login by itself.
