#!/usr/bin/env bash
# Restore the newest install backup (or --stamp) under the publish lock.
# Refuses /workspace/digest unless ADRRR_INSTALL_CONFIRM=1. Refuses to roll
# back over bytes that match neither the backup nor the patched install.
set -euo pipefail
ROOT=${1:?host root}
STAMP=${2:-}
PKG=$(cd "$(dirname "$0")" && pwd)
case "$ROOT" in
  /workspace/digest|/workspace/digest/*)
    if [ "${ADRRR_INSTALL_CONFIRM:-}" != "1" ]; then
      echo "refusing $ROOT without ADRRR_INSTALL_CONFIRM=1" >&2
      exit 1
    fi
    ;;
esac
exec 9>"$ROOT/.publish.lock"
if ! flock -w "${ADRRR_LOCK_WAIT:-1200}" 9; then
  echo "ERROR: publish lock busy" >&2
  exit 1
fi
exec python3 "$PKG/publish_window.py" rollback --host "$ROOT" ${STAMP:+--stamp "$STAMP"} --locked
