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
4. If the quote check is true and `daemon.pid` is alive, do nothing. Lunch
   and a closed session are not trading-stale.
5. If the quote check is true and the daemon is down, start
   `setsid nohup bash daemon.sh` once. This pass does not collect.
6. If the pane's current line is `Please enter account` and the quote check
   is not logged in, run `opend_console_login.py` once. Exit 2 and exit 3
   stick. Three other failures stick as `login_stopped`. Exit 0 then starts
   the daemon. A `bad_output` quote check does not log in.
7. Alerts append to `recover-events.log` only when the fingerprint changes.

## Proposed caller

Adrian approves this. The agent cannot create it.

```cron
*/5 * * * 1-5 HISTFILE= /usr/bin/flock -n /workspace/futu/hk-movers/.recover.lock /workspace/futu/.venv/bin/python /workspace/futu/hk-movers/recover_once.py --run --dir /workspace/futu/hk-movers --python /workspace/futu/.venv/bin/python
```

The crontab line has no secret. The caller must already have
`FUTU_LOGIN_ACCOUNT` and `FUTU_LOGIN_PWD` in its environment, from a mode-600
file the operator owns. That file is not in this repository and this pass
does not read a new path.

## Approvals still required

- Create the 5-minute caller above. Weekdays only, flock, no secrets in the command.
- Put the two login variables in that caller's environment without printing them.
- Allow one tmux session and one `FutuOpenD` only when no OpenD process exists and both ports are closed.
- Do not grant a standing permission to kill a process, to run `start_opend.sh`, or to log in again after `auth_failed`, `auth_challenge`, or `login_stopped`. Clearing `recover-state.json` is a person.
- Run `install_recover.sh --apply /workspace/futu/hk-movers` only after those are accepted. The default is a dry-run. Rollback is `rollback_recover.sh --apply` and it does not stop the gateway or the daemon.

## Quote record

`probe_qot` accepts one `HKMOVERS_QOT_BEGIN` / `HKMOVERS_QOT_END` record.
Connect and disconnect logs around it are ignored. A JSON object outside
the markers is not a login. A non-zero `ret` is not a login. A timeout
discards any late record and does not start another login by itself.
