# OpenD login

The running gateway is already in tmux session `opend`. Its console shows
`Please enter account`. Telnet on that process stays the version banner.
Do not send the account on telnet. Do not restart the process. Do not run
`start_opend.sh`.

`opend_console_login.py` reads `tmux capture-pane` and pastes one line only
when the current console line is the matching prompt. `load-buffer` takes the
line on stdin. `paste-buffer -d` deletes the buffer. The line is not a tmux
argument, not `send-keys`, and not a file. The line ending is one CR. A CR LF
pair is two breaks on this tty. OpenD echoes the account and masks the
password with asterisks. The transcript stores the prompt and
`<redacted:...>` only. Scrollback is cleared at the end. One account, one
password, one `Y`. A verify-code line, a login failure, or any other line
stops the sequence.

The process environment must already contain `FUTU_LOGIN_ACCOUNT` and
`FUTU_LOGIN_PWD`. Nothing in this command is a secret:

```bash
HISTFILE= python3 opend_console_login.py \
  --session opend \
  --api-port 11111 \
  --python /workspace/futu/.venv/bin/python \
  --transcript /workspace/futu/login-transcript.txt \
  --outcome /workspace/futu/last_login_outcome.txt \
  --qot-timeout 20
```

Exit 0 only when telnet is not involved and `qot_logined` is true. The quote
check is a child process with cwd `/tmp`. Exit 2 is a verify-code prompt.
Exit 3 is a login failure after the password line. Exit 4 means the account
prompt was not the current console line, so nothing was pasted.

## Why telnet is the wrong transport here

A PTY-backed 10.11.7108 prints `Please enter account` on the console and
answers a later telnet connect with only:

```
Futu OpenD version info: 10.11.7108(20260916134500), Type "help" for more information.
```

Writing the account to `/dev/pts/N` displays it and does not submit it. tmux
holds the PTY master. `paste-buffer` is the input path.

A no-TTY start is different and is not this process. With stdin `/dev/null`
and stdout a file, the console file does not grow a prompt, and telnet shows
`Please enter account` only when the client is already connected within about
two seconds of listen. A client that connects later sees the banner alone.
`opend_login.py` is that no-TTY telnet helper. Do not point it at session `opend`.

## No-TTY telnet helper

`opend_login.py` talks only to telnet. It sends the account only after
`Please enter account` is in the telnet read, then the password only after
`Please enter password`, then `Y` only after that. One `payload + \r\n` is one
telnet line. A version banner alone is `account_prompt_missing`.

## No-TTY command

Do not run this against session `opend`. It opens telnet. Use it only for a
process whose stdin is not a PTY and whose telnet read contains
`Please enter account`. The environment must already contain
`FUTU_LOGIN_ACCOUNT` and `FUTU_LOGIN_PWD`:

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
commands. The login command it names is `opend_console_login.py`. It will not
ask for `start_opend.sh` or a pkill. A second pass while
the supervisor is running does not start another daemon; the installed
supervisor is what publishes the next snapshot after 300s. Two afternoon
snapshots are that loop, after exit 0 from this helper. This tree cannot
produce those public documents.
