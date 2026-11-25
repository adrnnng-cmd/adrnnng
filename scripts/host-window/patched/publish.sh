#!/usr/bin/env bash
# Usage: publish.sh <dated_folder e.g. /workspace/digest/site/2026-10-07>
#        DRY_RUN=1 publish.sh <dated_folder>   # build deploy/ only, no upload
# Live URL: https://news-chart.com/news/YYYYMMDD/
# Ownership (2026-10-20, approved by Adrian): repo adrnnng-cmd/adrnnng (main) owns everything except news/
# (/, section folders, shared assets, _redirects except /latest). We own news/ and /latest.
# Every morning run assembles ONE full tree -> single wrangler deploy.
# A prearm hold fail-closes every caller. An armed pin uploads the pinned tree once.
set -euo pipefail
# Unset ADRRR_HOST_ROOT is the live digest. The lock wait default stays 1200s.
D=${ADRRR_HOST_ROOT:-/workspace/digest}
exec 9>"$D/.publish.lock"; flock -w "${ADRRR_LOCK_WAIT:-1200}" 9 || { echo "ERROR: publish lock busy"; exit 1; }
DEPLOY=$D/deploy
SRC=${1:?dated folder required}; DATE=$(basename "$SRC")
COMPACT=$(python3 -c "print('$DATE'.replace('-',''))")
DRY_RUN=${DRY_RUN:-0}
ROUTE=$(python3 "$D/tools/publish_window.py" route --host "$D" --entry "${ADRRR_WINDOW_ENTRY:-0}") || exit $?
if [ "$ROUTE" = "noop" ]; then
  echo "WINDOW: pinned source and artifact already match the verified deployment; no-op"
  exit 0
fi
if [ "$ROUTE" = "held" ]; then
  echo "FAIL-CLOSED: hold is in force; refusing assemble, refresh, upload, and mail"
  exit 3
fi
if [ "$ROUTE" = "restore" ]; then
  echo "WINDOW: completing one rollback of the previous public bytes; not uploading the new tree"
  python3 "$D/tools/publish_window.py" restore --host "$D"
  echo "FAIL-CLOSED: hold remains; marker not written"
  exit 3
fi
if [ "${ADRRR_PUBLISH_MODE:-}" = "frozen" ] && [ "$ROUTE" = "daily" ]; then
  echo "FAIL-CLOSED: ADRRR_PUBLISH_MODE=frozen is not a morning run and there is no armed window"
  exit 3
fi
if [ "$ROUTE" = "window" ]; then
  echo "WINDOW: uploading pinned artifacts (no assemble, no refresh, no mail)"
  echo "buttondown: skip (window transaction; BUTTONDOWN_SKIP=${BUTTONDOWN_SKIP:-0})"
  CF=$D/cloudflare_config.json
  export CLOUDFLARE_ACCOUNT_ID=$(python3 -c "import json;print(json.load(open('$CF'))['account_id'])")
  CF_PROJECT=$(python3 -c "import json;print(json.load(open('$CF'))['project'])")
  if [ -s "$D/.cf_token" ]; then export CLOUDFLARE_API_TOKEN=$(cat "$D/.cf_token")
  else export CLOUDFLARE_API_TOKEN=$(python3 -c "import os,re;t=os.environ.get('CLOUDFLARE_API_TOKEN','');m=re.search(r'Bearer\s+([A-Za-z0-9_-]+)',t);print(m.group(1) if m else t.strip())"); fi
  export WRANGLER_SEND_METRICS=false
  STAGE=$(mktemp -d -p "$D/tools/cfwrangler")
  if ! python3 "$D/tools/publish_window.py" stage --host "$D" --dest "$STAGE"; then
    rm -rf "$STAGE"
    exit 3
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY_RUN=1: pinned artifacts staged, not uploading"
    rm -rf "$STAGE"
    exit 0
  fi
  if ! python3 "$D/tools/publish_window.py" begin-upload --host "$D"; then
    rm -rf "$STAGE"
    exit 3
  fi
  set +e
  CF_OUT=$( cd "$D/tools/cfwrangler" && ./node_modules/.bin/wrangler pages deploy . --project-name "$CF_PROJECT" --branch main --commit-dirty=true --cwd "$STAGE" 2>&1 )
  CF_RC=$?
  set -e
  CF_LOG=$(mktemp)
  printf '%s\n' "$CF_OUT" > "$CF_LOG"
  echo "$CF_OUT" | grep -Ei 'success|complete|error|✘|Functions bundle|Compiled Worker|skipping' || true
  set +e
  python3 "$D/tools/publish_window.py" finalize --host "$D" --stage "$STAGE" --log "$CF_LOG" --wrangler-rc "$CF_RC"
  FIN=$?
  set -e
  rm -rf "$STAGE"
  rm -f "$CF_LOG"
  if [ "$FIN" != 0 ]; then
    echo "FAIL-CLOSED: window deployment not verified; marker not written"
    exit "$FIN"
  fi
  echo "WINDOW: deployed and read back"
  exit 0
fi
if [ "$ROUTE" != "daily" ]; then
  echo "FAIL-CLOSED: unknown publish route $ROUTE"
  exit 3
fi
SRC_ROOT=$D
BUILD=$D/deploy.next
CFG=$D/netlify_config.json
SITE=$(python3 -c "import json;print(json.load(open('$CFG'))['site_id'])")
PREFIX=$(python3 -c "import json;c=json.load(open('$CFG'));print(c.get('path_prefix') or c.get('secret') or 'news')")
BASE=$(python3 -c "import json;print(json.load(open('$CFG'))['base_url'])")

# Fail-closed reader-facing wrap URL evidence (Adrian, 2026-11-24).
# Unverified / 403 / timeout / date-filled slugs must not be published.
if [ -f "$SRC_ROOT/data/${DATE}.json" ]; then
  python3 "$D/tools/validate_wrap_urls.py" --root "$SRC_ROOT" "$DATE" || {
    echo "ERROR: wrap URL evidence gate failed — refusing to assemble/deploy"
    exit 1
  }
fi

# --- (1) Pull fresh main of the site repo.
# Fail-closed if the checkout is not the current remote desired revision.
# A failed fetch/clone may continue ONLY when HEAD already equals that desired SHA
# (standalone last-known-correct tree). The previous "warn and use last copy"
# fallback is not used, because a stale checkout can reassemble old brand files.
# ---
SEC_CFG=$D/sections_repo.json; SEC_DIR=$D/sections-src
SEC_URL=$(python3 -c "import json;print(json.load(open('$SEC_CFG')).get('url',''))" 2>/dev/null || true)
SEC_BR=$(python3 -c "import json;print(json.load(open('$SEC_CFG')).get('branch','main'))" 2>/dev/null || echo main)
export GIT_TERMINAL_PROMPT=0
if [ -n "$SEC_URL" ]; then
  DESIRED_SHA=$(timeout 60 git ls-remote "$SEC_URL" "refs/heads/$SEC_BR" 2>/dev/null | awk '{print $1}' || true)
  if ! printf '%s' "${DESIRED_SHA:-}" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "FAIL-CLOSED: cannot read current $SEC_BR of the sections repo; refusing to assemble/deploy with an unverified checkout."
    exit 2
  fi
  FETCH_OK=0
  if [ -d "$SEC_DIR/.git" ]; then
    if ( cd "$SEC_DIR" && timeout 60 git fetch -q --depth 1 origin "$SEC_BR" && git reset -q --hard FETCH_HEAD && git clean -qfdx ); then
      FETCH_OK=1
    else
      echo "WARN: repo fetch/reset failed; will continue only if checkout already matches $DESIRED_SHA"
    fi
  else
    if rm -rf "$SEC_DIR" && timeout 90 git clone -q --depth 1 -b "$SEC_BR" "$SEC_URL" "$SEC_DIR"; then
      FETCH_OK=1
    else
      echo "WARN: repo clone failed"
      rm -rf "$SEC_DIR"
    fi
  fi
  REPO_SHA=$( [ -d "$SEC_DIR/.git" ] && git -C "$SEC_DIR" rev-parse HEAD 2>/dev/null || echo EMPTY )
  echo "repo: $SEC_BR @ $REPO_SHA (desired $DESIRED_SHA)"
  if [ "$REPO_SHA" != "$DESIRED_SHA" ]; then
    echo "FAIL-CLOSED: sections-src is $REPO_SHA, not current $SEC_BR $DESIRED_SHA. Refusing to assemble/deploy with a stale or missing repo."
    exit 2
  fi
  if [ "$FETCH_OK" != "1" ]; then
    echo "NOTE: fetch/clone failed, but checkout already matches desired $DESIRED_SHA; continuing with existing tree."
  fi
else
  REPO_SHA=$( [ -d "$SEC_DIR/.git" ] && git -C "$SEC_DIR" rev-parse HEAD 2>/dev/null || echo EMPTY )
  echo "repo: $SEC_BR @ $REPO_SHA"
fi
# Prefer Engineer's assemble-deploy for home sync semantics, but keep our assembler
# (owns /latest + dashed news redirects, _headers merge, stubs). Always run the same
# post-steps assemble-deploy.sh runs: home-preview.mjs then build-sitemap.mjs.
if [ -f "$SEC_DIR/scripts/assemble-deploy.sh" ]; then
  echo "NOTE: repo assemble-deploy.sh present — publish.sh keeps its own assembler; runs home-preview + seo-meta + news-feed + build-sitemap after news/ (PR #11/#12)"
fi

# --- Fresh build tree (never mutate the last-deployed tree in place) ---
rm -rf "$BUILD"; mkdir -p "$BUILD/$PREFIX"

# --- (5) news/ — built as before ---
python3 - <<PY
from pathlib import Path
import json, shutil, re, sys
sys.path.insert(0, "$D")
from build_site import archive_html
prefix="$PREFIX"; build=Path("$BUILD"); site=Path("$SRC_ROOT/site")
dashed=[]
for d in sorted(site.iterdir()):
    if d.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d.name):
        dashed.append(d.name); shutil.copytree(d, build/prefix/d.name.replace("-",""))
arch = archive_html(sorted(dashed, reverse=True))
for d in dashed: arch = arch.replace(f'href="{d}/"', f'href="{d.replace("-","")}/"')
(build/prefix/"index.html").write_text(arch)
print("news days:", [d.replace("-","") for d in sorted(dashed, reverse=True)])
PY
mkdir -p "$BUILD/$PREFIX/img"; [ -d "$SRC_ROOT/cache/img" ] && cp -r "$SRC_ROOT/cache/img/." "$BUILD/$PREFIX/img/" || true
find "$BUILD/$PREFIX/img" -type d -name orig -prune -exec rm -rf {} + 2>/dev/null || true   # uncropped originals stay local (smartcrop)
python3 $D/tools/latest_json.py "$DATE" "$BUILD/$PREFIX/latest.json" >/dev/null || echo "WARN: latest.json failed (news still deploys)"

# --- (2)(3)(4) Repo paths + root files + merged _redirects/_headers ---
python3 - "$BUILD" "$SEC_DIR" "$SEC_CFG" "$PREFIX" "$COMPACT" "$CFG" <<'PY'
import sys, json, shutil, re
from pathlib import Path
build, src, seccfg, prefix, compact, cfgp = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
cfg = json.load(open(cfgp)); old = cfg.get("old_secret") or ""
try: secs = json.load(open(seccfg)).get("sections", [])
except Exception: secs = []
# repo meta, not site content: never deployed
SKIP = {prefix, "scripts", "README.md", "node_modules", "package.json", "package-lock.json", "_redirects", "_headers", ".github", ".gitignore"}
# nested repo paths never deployed (tests etc.)
SKIP_SUB = ["backtest/tests"]
origin = {}
if src.is_dir():
    for p in sorted(src.iterdir()):
        if p.name.startswith(".") or p.name in SKIP: continue
        dest = build / p.name
        (shutil.copytree if p.is_dir() else shutil.copy2)(p, dest); origin[p.name] = "repo"
for sub in SKIP_SUB:
    if (build/sub).exists(): shutil.rmtree(build/sub); origin[sub] = "EXCLUDED (repo-only)"

# root landing: repo wins; ours only as fallback
if "index.html" not in origin:
    links = "".join(f'<a class="card" href="/{p}/"><b>{t}</b></a>' for p, t in [(prefix,"晨報 Morning Report")]+[(s, s.replace("-"," ").title()) for s in secs])
    (build/"index.html").write_text(f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>News Chart</title><style>body{{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111}}
.card{{display:block;border:1px solid #ddd;border-radius:10px;padding:16px;margin:12px 0;text-decoration:none;color:#111}}</style></head>
<body><h1>News Chart</h1>{links}<p style="color:#888;font-size:13px">Latest report: <a href="/{prefix}/{compact}/">{compact}</a></p></body></html>
"""); origin["index.html"] = "fallback (publish.sh)"
if "robots.txt" not in origin:
    (build/"robots.txt").write_text("User-agent: *\nDisallow: /\n"); origin["robots.txt"] = "fallback (publish.sh)"
# 'Coming soon' stubs only for configured sections the repo lacks
stubs = []
for s in secs:
    if s in origin: continue
    d = build/s; d.mkdir(parents=True); title = s.replace("-"," ").title(); stubs.append(s)
    (d/"index.html").write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>{title} · News Chart</title>
<style>body{{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:720px;margin:60px auto;padding:0 16px;color:#111}}</style></head>
<body><p><a href="/">News Chart</a></p><h1>{title}</h1><p>Coming soon · 即將推出</p><p><a href="/{prefix}/">← Morning Report</a></p></body></html>
"""); origin[s] = "stub (publish.sh)"

# _redirects: repo file (minus any /latest and /news rules) + ours; dedupe, order kept
def is_ours(l):
    t = l.split()
    return bool(t) and (t[0] in ("/latest", "/latest/") or t[0].startswith(f"/{prefix}") or (old and t[0].startswith(f"/{old}")))
repo_r = (src/"_redirects").read_text().splitlines() if (src/"_redirects").is_file() else []
ours = [f"/latest /{prefix}/{compact}/ 302", f"/latest/ /{prefix}/{compact}/ 302"]
for d in sorted(p.name for p in (build/prefix).iterdir() if re.fullmatch(r"\d{8}", p.name)):
    dash = f"{d[:4]}-{d[4:6]}-{d[6:]}"
    ours += [f"/{prefix}/{dash} /{prefix}/{d}/ 301", f"/{prefix}/{dash}/ /{prefix}/{d}/ 301"]
    if old: ours += [f"/{old}/{dash} /{prefix}/{d}/ 301", f"/{old}/{dash}/ /{prefix}/{d}/ 301"]
if old: ours += [f"/{old} /{prefix}/ 301", f"/{old}/ /{prefix}/ 301"]
merged, seen = [], set()
# ours first so /latest wins (first match) over any repo catch-all
for l in ["# --- news + /latest (publish.sh) ---"] + ours + ["# --- repo adrnnng-cmd/adrnnng ---"] + [l for l in repo_r if not is_ours(l)]:
    k = " ".join(l.split())
    if k and not k.startswith("#") and k in seen: continue
    seen.add(k); merged.append(l)
(build/"_redirects").write_text("\n".join(merged).rstrip()+"\n")
origin["_redirects"] = "merged (ours /latest+/news, repo rest)" if repo_r else "publish.sh (repo has none)"
# _headers (SEO PR #8, 2026-10-22; PR #13 2026-10-27): repo file verbatim (detaches X-Robots-Tag on public HTML; JSON noindex at bottom).
# + our news cache blocks appended. CF last path-block for /news/latest.json wins, so ours_h must keep X-Robots-Tag noindex.
# NO site-wide /* noindex ever (Cloudflare comma-joins X-Robots-Tag).
ours_h = (f"/{prefix}/latest.json\n  Content-Type: application/json; charset=utf-8\n  Cache-Control: public, max-age=300, must-revalidate\n  Access-Control-Allow-Origin: *\n  ! X-Robots-Tag\n  X-Robots-Tag: noindex, nofollow\n"
     f"/{prefix}/img/*\n  Cache-Control: public, max-age=604800, immutable\n")
api_h = "/api\n  X-Robots-Tag: noindex, nofollow\n/api/*\n  X-Robots-Tag: noindex, nofollow\n"
if (src/"_headers").is_file():
    repo_h = (src/"_headers").read_text().rstrip()+"\n"
    if not re.search(r"(?m)^/api/\*\s*$", repo_h): repo_h += api_h
    h = "# --- repo adrnnng-cmd/adrnnng ---\n" + repo_h + "\n# --- news (publish.sh) ---\n" + ours_h
    origin["_headers"] = "repo + ours appended (no /* noindex)"
else: h = api_h + ours_h; origin["_headers"] = "publish.sh fallback (/api noindex only)"
(build/"_headers").write_text(h)
json.dump(origin, open(build.parent/".deploy_origin.json","w"), indent=1, ensure_ascii=False)
for k in sorted(origin): print(f"  {k:24s} <- {origin[k]}")
print("stubs:", stubs or "none")
PY

# --- Post-steps matching scripts/assemble-deploy.sh --news (PR #11 + #12).
# Does NOT rewrite day-page <title> / serp_hook / NewsArticle headline.
# ADRRR_DIGEST_DIR supplies serp_hook from data/<DATE>.json when present.
export ADRRR_DIGEST_DIR="${ADRRR_DIGEST_DIR:-$D/data}"
post_step() {
  local warn="$1"; shift
  if "$@"; then return 0; fi
  echo "WARN: $warn"
}
post_missing() {
  echo "WARN: $1"
}
if [ -f "$SEC_DIR/scripts/home-preview.mjs" ]; then
  post_step "home-preview failed (committed cover kept)" \
    bash -c 'cd "$1" && node scripts/home-preview.mjs --site "$2" --digest "$3"' bash "$SEC_DIR" "$BUILD" "$ADRRR_DIGEST_DIR"
else
  post_missing "home-preview.mjs missing — home cover may lag the edition"
fi

# Organization + WebSite JSON-LD, og:locale, twitter:site, breadcrumbs,
# publisher.logo, article:published_time (PR #12). Titles left untouched.
if [ -f "$SEC_DIR/scripts/seo-meta.mjs" ]; then
  post_step "seo-meta failed (JSON-LD / og:locale may be incomplete)" \
    bash -c 'cd "$1" && node scripts/seo-meta.mjs --site "$2"' bash "$SEC_DIR" "$BUILD"
else
  post_missing "seo-meta.mjs missing — SEO P2 stamps skipped"
fi

# /news/feed.xml from edition HTML in this upload (PR #12). Repo-only uploads 404.
if [ -f "$SEC_DIR/scripts/news-feed.mjs" ]; then
  post_step "news-feed failed (/news/feed.xml may be missing)" \
    bash -c 'cd "$1" && node scripts/news-feed.mjs --site "$2"' bash "$SEC_DIR" "$BUILD"
else
  post_missing "news-feed.mjs missing — /news/feed.xml will 404"
fi

# --- Sitemap (PR #8): regenerate from full tree incl. news/ ---
if [ -f "$SEC_DIR/scripts/build-sitemap.mjs" ]; then
  post_step "build-sitemap failed (repo sitemap kept)" \
    bash -c 'cd "$1" && node scripts/build-sitemap.mjs --site "$2"' bash "$SEC_DIR" "$BUILD"
fi

# --- (6) Completeness gate: never upload a partial site ---
for f in index.html _redirects "$PREFIX/index.html" "$PREFIX/$COMPACT/index.html"; do
  [ -s "$BUILD/$f" ] || { echo "ERROR: build incomplete, missing $f — nothing uploaded"; exit 1; }
done
# PR #12: feed.xml only exists after news-inclusive assemble — never ship without it
if [ -f "$SEC_DIR/scripts/news-feed.mjs" ]; then
  [ -s "$BUILD/$PREFIX/feed.xml" ] || { echo "ERROR: build incomplete, missing $PREFIX/feed.xml — nothing uploaded"; exit 1; }
fi
[ -s "$BUILD/favicon.ico" ] || echo "WARN: favicon.ico missing at deploy root"
rm -rf "$DEPLOY.prev"; [ -d "$DEPLOY" ] && mv "$DEPLOY" "$DEPLOY.prev"; mv "$BUILD" "$DEPLOY"
echo "assembled: $DEPLOY ($(find "$DEPLOY" -type f | wc -l) files)"
if [ "$DRY_RUN" = "1" ]; then echo "DRY_RUN=1: not uploading"; echo "DAY: $BASE/$PREFIX/$COMPACT/"; exit 0; fi

# --- Deploy: Cloudflare Pages, single upload of the full tree ---
CF=$D/cloudflare_config.json
export CLOUDFLARE_ACCOUNT_ID=$(python3 -c "import json;print(json.load(open('$CF'))['account_id'])")
CF_PROJECT=$(python3 -c "import json;print(json.load(open('$CF'))['project'])")
if [ -s "$D/.cf_token" ]; then export CLOUDFLARE_API_TOKEN=$(cat "$D/.cf_token")
else export CLOUDFLARE_API_TOKEN=$(python3 -c "import os,re;t=os.environ.get('CLOUDFLARE_API_TOKEN','');m=re.search(r'Bearer\s+([A-Za-z0-9_-]+)',t);print(m.group(1) if m else t.strip())"); fi
export WRANGLER_SEND_METRICS=false
# mktemp under cfwrangler so wrangler find-up hits writable node_modules
# (a /tmp stage walks up to root /node_modules → EACCES mkdir .cache/wrangler)
STAGE=$(mktemp -d -p "$D/tools/cfwrangler"); cp -r "$DEPLOY"/. "$STAGE"/
# Wrangler resolves functions/ from cwd (not the upload dir). Must --cwd "$STAGE"
# or Pages Functions never compile (static 404.html for /backtest/data/hsi/…).
set +e
CF_OUT=$( cd "$D/tools/cfwrangler" && ./node_modules/.bin/wrangler pages deploy . --project-name "$CF_PROJECT" --branch main --commit-dirty=true --cwd "$STAGE" 2>&1 )
CF_RC=$?
set -e
echo "$CF_OUT" | grep -Ei 'success|complete|error|✘|Functions bundle|Compiled Worker|skipping' || true
FUNC_OK=1
if [ -d "$STAGE/functions" ] && ! echo "$CF_OUT" | grep -q 'Uploading Functions bundle'; then
  echo "ERROR: functions/ present but Wrangler did not upload Functions bundle (cwd bug?)"
  FUNC_OK=0
fi
if [ "$CF_RC" = "0" ] && [ "$FUNC_OK" = "1" ] && echo "$CF_OUT" | grep -q 'Deployment complete'; then
  echo "$REPO_SHA" > $D/.sections_deployed
  if [ -s "$D/.publish_window_pin" ] || [ -s "$D/.publish_window_hold" ]; then
    python3 "$D/tools/publish_window.py" consume-daily --host "$D"
  fi
  # IndexNow (PR #8 body), best-effort: never fails the publish
  STATE=$D/state; mkdir -p "$STATE"
  if [ -f "$SEC_DIR/scripts/ping-indexnow.mjs" ]; then
    ( cd "$SEC_DIR" && node scripts/ping-indexnow.mjs --site "$DEPLOY" $( [ -s "$STATE/indexnow-urls.txt" ] && echo --previous "$STATE/indexnow-urls.txt" ) ) 2>&1 | sed 's/^/indexnow: /' || echo "WARN: IndexNow ping failed"
    ( cd "$SEC_DIR" && node scripts/ping-indexnow.mjs --site "$DEPLOY" --print-urls > "$STATE/indexnow-urls.txt.new" ) && mv "$STATE/indexnow-urls.txt.new" "$STATE/indexnow-urls.txt" || echo "WARN: IndexNow url list not saved"
  fi
  # Buttondown newsletter (after successful CF deploy + IndexNow). Token never echoed.
  # Fires when BUTTONDOWN_SEND=1, or when .buttondown_token exists and DATE is a weekday.
  # Missing token → skip quietly. Failure → WARN only (never fail the publish).
  BD_TOKEN_FILE="$D/.buttondown_token"
  BD_DO=0
  if [ "${BUTTONDOWN_SKIP:-0}" = "1" ]; then
    echo "buttondown: skip (BUTTONDOWN_SKIP=1)"; BD_DO=0
  elif [ "${BUTTONDOWN_SEND:-0}" = "1" ]; then BD_DO=1
  elif [ -s "$BD_TOKEN_FILE" ]; then
    python3 -c "import datetime,sys; d=datetime.date.fromisoformat(sys.argv[1]); sys.exit(0 if d.weekday()<5 else 1)" "$DATE" && BD_DO=1 || BD_DO=0
  fi
  if [ "$BD_DO" = "1" ]; then
    if [ ! -s "$BD_TOKEN_FILE" ] && [ -z "${BUTTONDOWN_API_KEY:-}" ]; then
      echo "buttondown: skip (no token)"
    else
      python3 "$D/tools/buttondown_send.py" "$DATE" || echo "WARN: Buttondown send failed"
    fi
  fi
else
  echo "FAIL-CLOSED: deploy not verified (wrangler=$CF_RC functions=$FUNC_OK); marker not written"
  rm -rf "$STAGE"
  exit 1
fi
rm -rf "$STAGE"

# --- Netlify mirror: DISABLED since 2026-10-16. Opt-in only: NETLIFY_MIRROR=1. ---
if [ "${NETLIFY_MIRROR:-0}" = "1" ]; then
  NSTAGE=$(mktemp -d); cp -r "$DEPLOY"/. "$NSTAGE"/
  sed -i -E 's/ (30[12])$/ \1!/' "$NSTAGE/_redirects"
  ( cd "$NSTAGE" && npx -y netlify-cli deploy --prod --dir "$NSTAGE" --site "$SITE" 2>&1 | grep -Ei 'live|error|✖' ) || true
  rm -rf "$NSTAGE"
fi
echo "DAY: $BASE/$PREFIX/$COMPACT/"
