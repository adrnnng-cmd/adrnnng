#!/usr/bin/env bash
# Restore the files saved by install.sh.  rollback.sh [--dir DIR] BACKUP_DIR
# Files that did not exist before the install are removed. Does not restart anything.
set -euo pipefail
DIR=${HK_MOVERS_DIR:-/workspace/futu/hk-movers}
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    *) BACKUP=$1; shift ;;
  esac
done
[ -n "${BACKUP:-}" ] && [ -f "$BACKUP/ABSENT" ] || { echo "usage: rollback.sh [--dir DIR] BACKUP_DIR" >&2; exit 2; }

exec 9>"$DIR/.sync.lock"
flock -n 9 || { echo "a collect holds $DIR/.sync.lock; try again when it has finished" >&2; exit 75; }

for f in publish_gate.py run_sync.sh supervisor.py daemon.sh runtime.env; do
  if grep -qx "$f" "$BACKUP/ABSENT"; then
    rm -f "$DIR/$f"
  else
    cp -p "$BACKUP/$f" "$DIR/.stage.$f.$$"
    mv -f "$DIR/.stage.$f.$$" "$DIR/$f"
  fi
done
echo "restored from $BACKUP"
