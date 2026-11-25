# OpenD login helper (already-running process)

A fresh OpenD 10.11.7108 on telnet prints two lines, then waits:

```
Futu OpenD version info: 10.11.7108(20260916134500), Type "help" for more information.
Please enter account
```

`Type "help"` is not a command. The account is one `account\r\n`. The next
prompt on that fresh process is `Please enter password`. A second `\r\n`
repeats the password prompt. A bare `\n` does not submit the account. The
helper sends one `payload + \r\n` and does not send telnet IAC bytes.

A version banner with no `Please enter account` is not a send. The helper
waits, then stops with `account_prompt_missing` and writes no credential.
The 14:45 live read was banner, then an account line, then the remember
question, with no `Please enter password`. A fresh copy of this same build
does not do that. Do not point this helper at that process.

Do not run `start_opend.sh` while parent 75819 / child 75823 are alive. It pkills OpenD.
`needs_relogin` from that script is the launcher's own empty-prompt branch, not an auth result.

To use the normal order, the current OpenD has to be stopped first. That needs
permission to stop those two pids and exclusive use of ports 11111 and 22222.
Then start one `./FutuOpenD` with the existing flags in a terminal, and answer
only the prompt on screen: account at `Please enter account`, password at
`Please enter password`, `Y` only at the remember question. Stop if a
verify-code command appears. A read-only telnet (connect, write zero bytes)
can show whether the current process is still sitting on a prompt. If that
prompt is `Please enter password`, a password is already pending for whatever
line was sent earlier (`help` at 14:32). Do not type the real password there.

## One login

The process environment must already contain `FUTU_LOGIN_ACCOUNT` and `FUTU_LOGIN_PWD`.
The helper reads them and does not print them. Run from a directory that contains
this file and `login_readiness.py`:

```bash
python3 opend_login.py \
  --host 127.0.0.1 --telnet-port 22222 --api-port 11111 \
  --python /workspace/futu/.venv/bin/python \
  --transcript /workspace/futu/login-transcript.txt \
  --outcome /workspace/futu/last_login_outcome.txt \
  --qot-timeout 20
```

The transcript and outcome file are mode 600. Account and password are replaced
with `<redacted:account>` and `<redacted:password>`.

What it does, once:

1. Connect. Read up to 12s. Send the account only when the buffer contains `Please enter account`. A version banner alone sends nothing (`account_prompt_missing`, exit 4).
2. If the first text is already `Please enter password`, send nothing and stop (`account_consumed`).
3. On `Please enter password`, send the password.
4. Send `Y` only after the password line, and only when the next text is the remember question. If that question arrives before `Please enter password`, send nothing else and stop (`remember_before_password`). The word password inside the remember question is not the password prompt.
5. On a phone or picture verification command, send nothing further and exit 2.
6. On `login successful`, run `OpenQuoteContext` in a child with cwd `/tmp` and a 20s kill. The constructor is what hung for 15s and 20s before login, so a timeout is `qot_logined=unknown` (exit 8), not a bad password, and it does not log in again.
7. Exit 0 only when `qot_logined` is true. Then start the supervisor once:

```bash
setsid nohup bash /workspace/futu/hk-movers/daemon.sh >> /workspace/futu/hk-movers/daemon.log 2>&1 < /dev/null &
```

Do not start it on exit 2, 3, 4, or 8. After a later SDK-only recheck:

```bash
python3 opend_login.py --check-only --python /workspace/futu/.venv/bin/python --qot-timeout 20
```

`--check-only` does not open telnet.

## Interpreter

`/workspace/futu/.venv` was recreated at 14:35 HKT with `futu-api==10.12.7208`
(the version named in `scripts/hk_movers_sync.py` and the README). Import from
`/tmp` resolves to site-packages. Import from `/workspace` or `/workspace/futu`
can bind the project directory instead of the SDK. `run_sync.sh` uses
`HK_MOVERS_PYTHON` or `/workspace/futu/.venv/bin/python`.

The venv is a rebuild product. The durable pin is `requirements-futu.txt`.
`requirements-futu-freeze-20261125.txt` is the freeze observed that afternoon,
not a lock from the old environment. Recreate with:

```bash
python3 -m venv /workspace/futu/.venv
/workspace/futu/.venv/bin/python -m pip install --index-url https://pypi.org/simple -r requirements-futu.txt
cd /tmp && /workspace/futu/.venv/bin/python -c 'import futu; assert "site-packages" in futu.__file__'
```

## Gate

`recover.py` is the decision for a later external timer. It does not execute
commands. It will not ask for `start_opend.sh` or a pkill. A second pass while
the supervisor is running does not start another daemon; the installed
supervisor is what publishes the next snapshot after 300s. Two afternoon
snapshots are that loop, after exit 0 from this helper. This tree cannot
produce those public documents.
