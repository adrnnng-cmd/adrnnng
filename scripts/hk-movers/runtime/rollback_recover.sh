#!/bin/sh
# Dry-run by default. Removes only the recovery files this install copied.
# Does not stop OpenD, tmux, or the supervisor, and does not publish.
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
for name in $FILES; do
  echo "remove $DEST/$name"
done
if [ "$APPLY" -ne 1 ]; then
  echo "dry-run: pass --apply only to remove those files"
  exit 0
fi
for name in $FILES; do
  rm -f "$DEST/$name"
done
echo "removed recovery files"
echo "OpenD, tmux, and the supervisor were left running"
