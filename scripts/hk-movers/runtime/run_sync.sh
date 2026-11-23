#!/usr/bin/env bash
# One collect + publish. Started by supervisor.py (or by hand). Same contract as the run_sync.sh it replaces:
# flock on .sync.lock (a second instance exits 0), collect with a single retry, curl PUT to the KV key, local
# latest.json replaced atomically. New: the document goes through publish_gate.py first, so a stale or overdue
# collect (for example one that spanned a host freeze) is never published, and the local file is replaced only
# after the KV upload succeeded, so a failed upload is retried by the supervisor instead of looking fresh.
set -euo pipefail

DIR=${HK_MOVERS_DIR:-/workspace/futu/hk-movers}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# runtime.env (chmod 600, written by install.sh) holds HK_MOVERS_KV_ACCOUNT_ID and HK_MOVERS_KV_NAMESPACE_ID.
if [ -f "$DIR/runtime.env" ]; then
  # shellcheck disable=SC1091
  . "$DIR/runtime.env"
fi
ACCT=${HK_MOVERS_KV_ACCOUNT_ID:?HK_MOVERS_KV_ACCOUNT_ID is not set (see runtime.env)}
NS=${HK_MOVERS_KV_NAMESPACE_ID:?HK_MOVERS_KV_NAMESPACE_ID is not set (see runtime.env)}
KEY="hk-movers:latest.json"
PY=${HK_MOVERS_PYTHON:-/workspace/futu/.venv/bin/python}
COLLECTOR=${HK_MOVERS_COLLECTOR:-$DIR/hk_movers_sync.py}
GATE=${HK_MOVERS_GATE:-$HERE/publish_gate.py}
GATE_PYTHON=${HK_MOVERS_GATE_PYTHON:-python3}
CURL=${HK_MOVERS_CURL:-curl}
TOKEN_FILE=${HK_MOVERS_TOKEN_FILE:-/workspace/digest/.cf_token}
OUT="$DIR/latest.json"
TMP="$DIR/latest.json.tmp.$$"

trap 'rm -f "$TMP"' EXIT
trap 'exit 143' TERM INT

exec 8>"$DIR/.sync.lock"
flock -n 8 || exit 0

collect() {
  "$PY" "$COLLECTOR" --out "$TMP" --history-cache "$DIR/history.json"
}

# Retry once if OpenD has a brief transient reconnect, unless the attempt has no time left for a second collect.
if ! collect; then
  if [ -n "${HK_MOVERS_PUBLISH_BY_EPOCH:-}" ] && [ "$(date +%s)" -ge $((HK_MOVERS_PUBLISH_BY_EPOCH - 40)) ]; then
    echo "collect failed and the attempt has no time left for a retry" >&2
    exit 1
  fi
  sleep 4
  collect
fi

"$GATE_PYTHON" "$GATE" "$TMP" --current "$OUT"

TOKEN=$(tr -d '\r\n ' < "$TOKEN_FILE")  # the token is read at run time only; its value is never written anywhere
ENC_KEY=$("$GATE_PYTHON" -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$KEY")
URL="https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$NS/values/$ENC_KEY"
RESP=$("$CURL" -fsS --connect-timeout 10 --max-time 20 -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json; charset=utf-8" --data-binary "@$TMP" "$URL")
echo "$RESP" | "$GATE_PYTHON" -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print("kv upload failed:", d, file=sys.stderr) or 1))'

mv "$TMP" "$OUT"
