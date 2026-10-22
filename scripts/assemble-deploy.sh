#!/usr/bin/env bash
# Assemble the exact folder to upload to Cloudflare Pages (project "adrnnng").
#
#   scripts/assemble-deploy.sh <out_dir> [--news <news_dir>]
#
# Copies the site's tracked files into <out_dir>, leaving out repo-only files
# (.github/, scripts/, tests, docs, package.json), then copies <news_dir> into <out_dir>/news/.
# Fails if the repo itself contains news/ (that path belongs to the News Analyst).
# Writes sitemap.xml from the merged tree (pages, /news/YYYYMMDD/ editions, and any new section).
#
# Then:  npx wrangler pages deploy <out_dir> --project-name adrnnng --branch main
# A Pages direct upload replaces the whole deployment, so always upload the merged folder,
# never news/ alone and never the repo without news/.
set -euo pipefail

usage() { echo "usage: $0 <out_dir> [--news <news_dir>]" >&2; exit 2; }
[ $# -ge 1 ] || usage
out=$1; shift
news=""
while [ $# -gt 0 ]; do
  case "$1" in
    --news) news=${2:-}; [ -n "$news" ] || usage; shift 2 ;;
    *) usage ;;
  esac
done

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if git ls-files --error-unmatch news >/dev/null 2>&1 || [ -n "$(git ls-files news)" ]; then
  echo "error: the repo contains news/, which is reserved for the News Analyst upload" >&2
  exit 1
fi

mkdir -p "$out"
out=$(cd "$out" && pwd)
case "$out" in "$root"|"$root"/*) echo "error: out_dir must be outside the repo" >&2; exit 1 ;; esac
find "$out" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

git ls-files -z \
  | grep -zvE '^(\.github/|scripts/|backtest/tests/|\.gitignore$|package\.json$|.*\.md$)' \
  | tar --null -cf - -T - | tar -xf - -C "$out"

if [ -n "$news" ]; then
  [ -d "$news" ] || { echo "error: $news is not a directory" >&2; exit 1; }
  mkdir -p "$out/news"
  cp -a "$news"/. "$out/news/"
fi

if [ ! -f "$out/404.html" ]; then
  echo "error: 404.html is missing from the upload; Pages would serve index.html with status 200" >&2
  exit 1
fi

# Sitemap index from the files actually being uploaded, including news/YYYYMMDD/
# editions and any new section such as hsi-lab/. Overwrites a sitemap copied
# from git so the upload is not stuck on the repo's news-less copy.
node "$root/scripts/build-sitemap.mjs" --site "$out"
echo "indexnow: after wrangler pages deploy, run: node \"$root/scripts/ping-indexnow.mjs\" --site \"$out\""

files=$(find "$out" -type f | wc -l | tr -d ' ')
size=$(du -sh "$out" | cut -f1)
echo "assembled $out: $files files, $size${news:+ (news/ from $news)}"
[ -f "$out/news/index.html" ] || echo "note: $out/news/index.html is missing; /news/ will 404 if you upload this folder" >&2
