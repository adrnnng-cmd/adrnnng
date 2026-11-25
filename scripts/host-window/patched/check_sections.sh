#!/usr/bin/env bash
# Redeploy adrnnng.com only when the sections repo HEAD changed. No report rebuild, no email.
# Usage (every 30 min): bash /workspace/digest/check_sections.sh
set -uo pipefail
D=${ADRRR_HOST_ROOT:-/workspace/digest}; export GIT_TERMINAL_PROMPT=0
URL=$(python3 -c "import json;print(json.load(open('$D/sections_repo.json')).get('url',''))")
BR=$(python3 -c "import json;print(json.load(open('$D/sections_repo.json')).get('branch','main'))")
PIN=$D/.publish_window_pin
HOLD=$D/.publish_window_hold
WINDOW=0
if [ -s "$PIN" ] || [ -s "$HOLD" ]; then WINDOW=1; fi
if [ -z "$URL" ]; then
  if [ "$WINDOW" = "1" ]; then echo "FAIL-CLOSED: no sections repo during window"; exit 3; fi
  echo "no sections repo configured"; exit 0
fi
OUT=$(timeout 60 git ls-remote "$URL" "refs/heads/$BR" 2>&1) || {
  if [ "$WINDOW" = "1" ]; then echo "FAIL-CLOSED: ls-remote failed during window: $OUT"; exit 3; fi
  echo "WARN: ls-remote failed: $OUT"; exit 0
}
REMOTE=$(echo "$OUT" | awk '{print $1}'); REMOTE=${REMOTE:-EMPTY}
if [ "$WINDOW" = "1" ]; then
  # The on-disk pin chooses the frozen transaction. A leaked frozen env does not.
  # This entry never falls through to the morning assembler.
  ROUTE=$(python3 "$D/tools/publish_window.py" route --host "$D" --entry 1) || exit $?
  if [ "$ROUTE" = "noop" ]; then echo "unchanged ($REMOTE; script+artifact identity)"; exit 0; fi
  if [ "$ROUTE" != "window" ]; then echo "FAIL-CLOSED: window entry route $ROUTE"; exit 3; fi
  LATEST=$(ls -d $D/site/????-??-?? 2>/dev/null | sort | tail -1)
  [ -z "$LATEST" ] && LATEST="$D/site/1970-01-01"
  echo "window: publishing pinned artifacts for $REMOTE"
  env -u ADRRR_PUBLISH_MODE -u ADRRR_FROZEN_ROOT \
    NETLIFY_MIRROR=0 BUTTONDOWN_SKIP=1 ADRRR_WINDOW_ENTRY=1 ADRRR_HOST_ROOT="$D" \
    bash $D/publish.sh "$LATEST"
  exit $?
fi
if [ -f "$D/.sections_deployed" ] && grep -q '^identity ' "$D/.sections_deployed"; then
  echo "FAIL-CLOSED: marker records a window deployment but the pin is gone; refusing normal publish"
  exit 3
fi
LAST=$(head -n 1 "$D/.sections_deployed" 2>/dev/null || echo NONE)
LAST=${LAST:-NONE}
[ "$REMOTE" = "$LAST" ] && { echo "unchanged ($REMOTE)"; exit 0; }
LATEST=$(ls -d $D/site/????-??-?? 2>/dev/null | sort | tail -1)
[ -z "$LATEST" ] && { echo "no report folder"; exit 0; }
echo "sections changed: $LAST -> $REMOTE; redeploying with $(basename $LATEST)"
# Website-only path: force no newsletter. Inline 1 wins over inherited 0/unset.
# Morning ./publish.sh is unchanged. A leaked frozen env is stripped here too.
env -u ADRRR_PUBLISH_MODE -u ADRRR_FROZEN_ROOT \
  NETLIFY_MIRROR=0 BUTTONDOWN_SKIP=1 \
  ADRRR_HOST_ROOT="$D" \
  bash $D/publish.sh "$LATEST"
