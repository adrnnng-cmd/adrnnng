#!/usr/bin/env bash
# Install the runtime files next to the live collector, atomically and with a backup. Does not restart anything.
#   install.sh [--dir DIR] [--dry-run]
# Files are staged on the same filesystem and renamed into place under the .sync.lock flock (exit 75 if a collect
# holds it). A running bash daemon keeps reading its old inode, so replacing daemon.sh is safe. Restarting
# daemon.sh is a separate step (README.md).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIR=${HK_MOVERS_DIR:-/workspace/futu/hk-movers}
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
FILES=(publish_gate.py run_sync.sh supervisor.py daemon.sh)
SCRIPTS=(run_sync.sh daemon.sh install.sh rollback.sh)

for f in "${SCRIPTS[@]}"; do bash -n "$HERE/$f"; done
for f in supervisor.py publish_gate.py; do
  python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' "$HERE/$f"
done
[ -d "$DIR" ] || { echo "no such directory: $DIR" >&2; exit 2; }
[ -f "$DIR/hk_movers_sync.py" ] || { echo "$DIR/hk_movers_sync.py not found; refusing to install" >&2; exit 2; }

# KV ids stay out of git: take them from the run_sync.sh that is live now, or from the environment.
ENVFILE="$DIR/runtime.env"
NEW_ENV=""
if [ ! -f "$ENVFILE" ]; then
  acct=${HK_MOVERS_KV_ACCOUNT_ID:-}
  ns=${HK_MOVERS_KV_NAMESPACE_ID:-}
  if [ -f "$DIR/run_sync.sh" ]; then
    [ -n "$acct" ] || acct=$(sed -n 's/^ACCT=\([0-9a-f]\{32\}\).*/\1/p' "$DIR/run_sync.sh" | head -n 1)
    [ -n "$ns" ] || ns=$(sed -n 's/^NS=\([0-9a-f]\{32\}\).*/\1/p' "$DIR/run_sync.sh" | head -n 1)
  fi
  if [ -z "$acct" ] || [ -z "$ns" ]; then
    echo "cannot find the KV account/namespace ids; set HK_MOVERS_KV_ACCOUNT_ID and HK_MOVERS_KV_NAMESPACE_ID" >&2
    exit 2
  fi
  NEW_ENV="HK_MOVERS_KV_ACCOUNT_ID=$acct
HK_MOVERS_KV_NAMESPACE_ID=$ns"
fi

echo "install into $DIR"
for f in "${FILES[@]}"; do printf '  %s  %s\n' "$(sha256sum "$HERE/$f" | cut -d' ' -f1)" "$f"; done
if [ "$DRY" = 1 ]; then echo "dry run: nothing written"; exit 0; fi

exec 9>"$DIR/.sync.lock"
flock -n 9 || { echo "a collect holds $DIR/.sync.lock; try again when it has finished" >&2; exit 75; }

BACKUP="$DIR/rollout-runtime-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$BACKUP"
: > "$BACKUP/ABSENT"
for f in "${FILES[@]}" runtime.env; do
  if [ -e "$DIR/$f" ]; then cp -p "$DIR/$f" "$BACKUP/$f"; else echo "$f" >> "$BACKUP/ABSENT"; fi
done
(cd "$BACKUP" && sha256sum $(ls | grep -v -e '^ABSENT$' -e '^SHA256SUMS$') > SHA256SUMS 2>/dev/null || true)

if [ -n "$NEW_ENV" ]; then
  umask 077
  printf '%s\n' "$NEW_ENV" > "$DIR/.runtime.env.$$"
  mv -f "$DIR/.runtime.env.$$" "$ENVFILE"
  umask 022
fi
for f in "${FILES[@]}"; do
  cp "$HERE/$f" "$DIR/.stage.$f.$$"
  chmod 755 "$DIR/.stage.$f.$$"
done
for f in "${FILES[@]}"; do mv -f "$DIR/.stage.$f.$$" "$DIR/$f"; done
echo "installed. backup: $BACKUP"
echo "rollback: bash $HERE/rollback.sh --dir $DIR $BACKUP"
