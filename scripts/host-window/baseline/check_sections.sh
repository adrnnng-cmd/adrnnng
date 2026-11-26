#!/usr/bin/env bash
# Redeploy adrnnng.com only when the sections repo HEAD changed. No report rebuild, no email.
# Usage (every 30 min): bash /workspace/digest/check_sections.sh
set -uo pipefail
D=/workspace/digest; export GIT_TERMINAL_PROMPT=0
URL=$(python3 -c "import json;print(json.load(open('$D/sections_repo.json')).get('url',''))")
BR=$(python3 -c "import json;print(json.load(open('$D/sections_repo.json')).get('branch','main'))")
[ -z "$URL" ] && { echo "no sections repo configured"; exit 0; }
OUT=$(timeout 60 git ls-remote "$URL" "refs/heads/$BR" 2>&1) || { echo "WARN: ls-remote failed: $OUT"; exit 0; }
REMOTE=$(echo "$OUT" | awk '{print $1}'); REMOTE=${REMOTE:-EMPTY}
LAST=$(cat $D/.sections_deployed 2>/dev/null || echo NONE)
[ "$REMOTE" = "$LAST" ] && { echo "unchanged ($REMOTE)"; exit 0; }
LATEST=$(ls -d $D/site/????-??-?? 2>/dev/null | sort | tail -1)
[ -z "$LATEST" ] && { echo "no report folder"; exit 0; }
echo "sections changed: $LAST -> $REMOTE; redeploying with $(basename $LATEST)"
# Website-only path: force no newsletter. Inline 1 wins over inherited 0/unset;
# receipt in buttondown_send.py is not a substitute. Morning ./publish.sh is unchanged.
NETLIFY_MIRROR=0 BUTTONDOWN_SKIP=1 bash $D/publish.sh "$LATEST"
