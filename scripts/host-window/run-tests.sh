#!/usr/bin/env bash
# Run the window suite in this checkout. The host root is always a temp
# directory chosen by the tests. This script does not install, arm, or publish
# /workspace/digest. strace must show no open of that path and no connect
# outside the loopback interface.
set -euo pipefail
cd "$(dirname "$0")/../.."
unset ADRRR_HOST_ROOT || true
unset ADRRR_PAGES_ROLLBACK_LIVE || true
if ! command -v strace >/dev/null 2>&1; then
  echo "strace is required; the suite must not claim isolation without it" >&2
  exit 2
fi
LOG=$(mktemp)
set +e
strace -f -e trace=openat,open,connect -o "$LOG" \
  python3 -m unittest scripts.tests.test_publish_window -v
RC=$?
set -e
if grep -F '/workspace/digest' "$LOG"; then
  echo "production digest path appeared in the window-test trace" >&2
  exit 4
fi
if grep -E 'sin_addr=inet_addr\("' "$LOG" | grep -v 'inet_addr("127\.'; then
  echo "window tests connected outside 127.0.0.0/8" >&2
  exit 5
fi
if grep -E 'sin6_addr=' "$LOG" | grep -v 'sin6_addr=::1'; then
  echo "window tests connected outside IPv6 loopback" >&2
  exit 5
fi
exit "$RC"
