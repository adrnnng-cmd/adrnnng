#!/bin/sh
# Dry-run by default. Copies the recovery files only when --apply is passed.
# Does not install a timer, does not start OpenD, and does not publish.
set -eu
APPLY=0
DEST=/workspace/futu/hk-movers
if [ "${1:-}" = "--apply" ]; then
  APPLY=1
  shift
fi
if [ "${1:-}" != "" ]; then
  DEST=$1
fi
SRC=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
FILES="
opend_console_login.py
opend_login.py
login_readiness.py
recover.py
recover_once.py
recover-tmux.conf
requirements-futu.txt
PREVENTION.md
OPEND_LOGIN.md
"
echo "dest $DEST"
echo "caller /usr/bin/python3"
echo "wake external GrokBot routine; this script does not install cron"
for name in $FILES; do
  echo "file $name"
done
if [ "$APPLY" -ne 1 ]; then
  echo "dry-run: pass --apply only after the 5-minute routine is approved"
  exit 0
fi
mkdir -p "$DEST"
for name in $FILES; do
  cp "$SRC/$name" "$DEST/$name"
  chmod 644 "$DEST/$name"
done
chmod 755 "$DEST/recover_once.py" "$DEST/opend_console_login.py" "$DEST/opend_login.py"
echo "applied $DEST"
echo "no timer was installed"
