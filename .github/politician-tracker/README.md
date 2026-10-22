# Politician Tracker · 政治人物持股動向

A static section of the Morning Report site, published at **https://adrnnng.com/politician-tracker/**.
It lists new STOCK Act disclosures from a VIP list of members of Congress, plus any member's trade in a
ticker on Adrian's Watchlist. Each row shows the politician, ticker/company, Buy/Sell/Exchange, size band,
trade date, filing date, **lag days** (filing − trade) and a link to the official filing.

The builder is plain Python 3.10+ standard library: no `pip install`, no API keys, no paid services.
It writes `index.html` (fully rendered, works without JS), `data.json`, and official portraits
under `img/<bioguide>.jpg` for every member in the trades, into `<site root>/politician-tracker/`.
Portraits already on disk are left alone. No build step runs on the host; the built files are committed.

## Run locally

```bash
python3 -m tracker build --out public        # ~45s, fetches all sources
./scripts/serve.sh                            # http://127.0.0.1:47319/politician-tracker/
python3 -m unittest discover -s tests         # offline tests
```

`build` exits 1 when no data source returned rows. The page still renders the previously stored rows
with a "stale" notice, so a flaky source never blanks the page.

## Data sources (free-first)

| Source | Used for |
| --- | --- |
| [QuantEngines API](https://quantengines.com/api/v1/docs) `/trades/` | Preferred source. Queried every build; it currently returns 0 trades, so the fallbacks below supply the data. |
| [Senate eFD](https://efdsearch.senate.gov) (official) | Every Senate PTR filed in the window, parsed from the filing pages. Rows link to the filing. |
| [House Clerk](https://disclosures-clerk.house.gov) FD index (official) | Maps House rows to the official PTR PDF (`ptr-pdfs/<year>/<DocID>.pdf`). |
| [Quiver Quantitative](https://www.quiverquant.com/congresstrading/) public pages | House transactions: the all-members recent feed (~3 weeks) for Watchlist overlap, plus each VIP's profile page for history. |
| [@unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators) | Party, state/district, and "former member" detection. |
| [unitedstates.io](https://theunitedstates.io/images/congress/225x275/) portraits, then [Bioguide](https://bioguide.congress.gov/) | Official photo for every bioguide in the trades, saved as `img/<bioguide>.jpg`. Bioguide is the fallback. Files already present are skipped. |

Rows from different sources are merged. Where the same trade appears twice, the earliest filing and the
most official source win, and genuine repeat trades inside one filing are kept. Amended filings keep the
original filing date when it is known, and are labelled "amended". History builds up across runs because
each build merges the previous `data.json`. Rows are kept for `retention_days` (120).

## Configuration: `tracker/config.json`

- `vip`: the VIP list (bioguide ID, display name, chamber, party, state, and a one-line rationale).
  Revisit quarterly against the Quiver / Capitol Markets leaderboards. Leave high-volume "spray" traders
  (e.g. Ro Khanna, Gilbert Cisneros) off.
- `watchlist.us` / `watchlist.hk`: Adrian's Watchlist. `watchlist.aliases` maps other listings of the
  same company (GOOG→GOOGL, BABA→9988.HK, TCEHY→0700.HK, LVMHF→LVMUY).
- `site`: base URL, output path, archive link, timezone, retention, and `noindex`
  (`false`: the page is indexable; set it to `true` only to opt the tracker back out).

## Publishing (GitHub → Cloudflare Pages)

The site is served by Cloudflare Pages from **github.com/adrnnng-cmd/adrnnng** (`main`). Publishing is just a
push: the `notify-host` workflow POSTs `{"repo":"adrnnng","sha":"<sha>"}` to `GROKBOT_WEBHOOK_URL`
(with `GROKBOT_WEBHOOK_KEY` as the `Authorization` header) and the host redeploys within minutes.

Layout in the site repo:

```
politician-tracker/index.html, data.json      built page, served at /politician-tracker/
.github/politician-tracker/tracker/            this builder (used by the scheduled refresh)
.github/workflows/notify-host.yml              publish ping on every push to main
.github/workflows/politician-tracker.yml       07:05 HKT Mon–Sat: rebuild, commit politician-tracker/, ping
```

The refresh workflow only ever stages `politician-tracker/`; `news/` (built separately) is never touched.
Pushes made with `GITHUB_TOKEN` don't trigger `on: push`, so the refresh calls `notify-host` itself.
Run it by hand from the Actions tab ("Politician Tracker refresh" → Run workflow).

To export code changes from this repo into a site checkout:

```bash
git clone https://github.com/adrnnng-cmd/adrnnng.git ../adrnnng
./scripts/export-site.sh ../adrnnng      # copies builder + workflows, rebuilds the page
cd ../adrnnng && git add politician-tracker .github .gitignore && git commit -m "..." && git push
```

## Layout

```
tracker/
  __main__.py        CLI: python3 -m tracker build --out <deploy root>
  config.json        VIP list, Watchlist, site settings
  pipeline.py        collect → enrich (VIP / Watchlist / links) → dedupe → write
  render.py          HTML + CSS + filter JS (Morning Report design tokens)
  sources/           quantengines, senate_efd, house_clerk, quiver
scripts/serve.sh     local preview server (port 47319)
scripts/export-site.sh  copy builder/workflows into the site repo and rebuild
site-repo/           workflow files and .gitignore for the site repo
tests/               offline unit tests
```

Out of scope for v1 (Phase 2): corporate Form 4 executive insider tracker, predictive scoring, paid Quiver API.
