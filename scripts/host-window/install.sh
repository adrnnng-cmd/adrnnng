#!/usr/bin/env bash
# Install the patched host scripts under a digest root. Refuses the live
# /workspace/digest path unless ADRRR_INSTALL_CONFIRM=1. Takes the publish lock.
set -euo pipefail
ROOT=${1:?host root}
PKG=$(cd "$(dirname "$0")" && pwd)
case "$ROOT" in
  /workspace/digest|/workspace/digest/*)
    if [ "${ADRRR_INSTALL_CONFIRM:-}" != "1" ]; then
      echo "refusing $ROOT without ADRRR_INSTALL_CONFIRM=1" >&2
      exit 1
    fi
    ;;
esac
mkdir -p "$ROOT"
exec 9>"$ROOT/.publish.lock"
if ! flock -w "${ADRRR_LOCK_WAIT:-1200}" 9; then
  echo "ERROR: publish lock busy" >&2
  exit 1
fi
exec python3 "$PKG/publish_window.py" install --host "$ROOT" --package "$PKG" --locked
