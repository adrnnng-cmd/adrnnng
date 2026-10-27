# adrnnng.com

Adrian Ng's trading and investing site. It is plain static files with **no build step**: the repo
root is the site root, and whatever is committed is what Cloudflare Pages (project `adrnnng`)
serves. Data that needs refreshing is fetched by scheduled GitHub Actions and committed as
static JSON/CSV.

| Path | What | Published by |
| --- | --- | --- |
| `/` | Landing page (`index.html`, `assets/js/home.js`) | this repo |
| `/backtest/` | Backtest tool | this repo; prices refreshed by `backtest-prices.yml` |
| `/politician-tracker/` | Politician Tracker | this repo; page rebuilt by `politician-tracker.yml` |
| `/news/` | Morning Report | **News Analyst agent** (direct Wrangler upload, ~08:15 HKT). Not in this repo. |

## Layout

```
index.html                     landing page
robots.txt                     crawlers allowed; /api/ disallowed; sitemap pointer
llms.txt                       section guide for AI crawlers
sitemap.xml                    sitemap index (regenerated for the upload)
_headers                       cache rules; X-Robots-Tag noindex on /api/* and browser JSON
assets/
  tools.json                   TOOL REGISTRY: drives the header nav, footer and landing cards
  css/theme.css                design system (tokens + components) shared by every tool
  css/home.css, js/home.js     landing page only
  js/site.js                   shared header/nav/footer, rendered from tools.json
  img/, vendor/                favicon; TradingView Lightweight Charts (Apache-2.0)
<tool>/                        one folder per tool, served at /<tool>/
  index.html                   page (includes theme.css + site.js)
  app.js, style.css            tool code and styles
  data/                        the tool's static data, if any
backtest/
  engine/                      bars, indicators, execution loop, metrics (pure ES modules)
  strategies/                  strategy plug-ins + registry
  providers/                   price-data plug-ins + registry
  data/prices/                 daily CSVs + manifest.json (written by the scheduled fetch)
  tests/                       node --test unit tests; tests/reference = independent Python cross-check
politician-tracker/            built page + data.json + img/ (committed by its workflow)
.github/<tool>/                data builders run by Actions (Python stdlib, no pip installs)
.github/workflows/             scheduled refreshes, publish ping, site check
scripts/                       check-site, sitemap, IndexNow ping, new-tool scaffolder, assemble-deploy
_headers                       Cloudflare Pages cache headers
```

Conventions: a tool's URL is its folder name; its data lives inside its folder; anything that
builds that data lives in `.github/<tool>/` and is run by `.github/workflows/<tool>*.yml`, which
only ever stages the tool's own folder. Pages use the shared chrome unless they have a
deliberate house style (the Politician Tracker keeps its newspaper look but reads its nav links
from `tools.json`).

## Run locally

```bash
npm run serve        # http://127.0.0.1:8788  (any static server works; no install needed)
npm test             # engine unit tests, price-fetcher tests, politician-tracker photo tests
npm run verify:backtest   # engine vs an independent Python implementation on real SPY data
npm run check        # registry, page wiring, local links/imports, reserved paths, price manifest
```

The landing ships a static cover in `index.html` (kicker, H1, dek, stories, and a link to the
edition) so a no-JS fetch still shows the morning report. `assets/js/home.js` still replaces
that cover from `/news/` or `/assets/news-preview.json` when JavaScript runs. The page also
asks for `/news/latest.json` when it loads, for the lead photo. That file is published with the
Morning Report and is not part of this repo. To preview the lead photo, copy the sample over
that path and do not commit it (`npm run check` fails while `news/` exists):

```bash
mkdir -p news && cp scripts/preview/latest.json news/latest.json
```

Remove `news/` before `npm run check`. A missing file, or `"image_url": null`, leaves the SPY chart cover.
The page displays `image_url` only. Production publishes that as a WebP under `/news/img/YYYYMMDD/`.
Extra keys, including `image_url_original`, are ignored. The sample's `image_url` is a Commons
photo so the preview loads without a `news/` tree.

Node ≥ 20 and Python ≥ 3.10. There are no dependencies to install. CI (`site-check.yml`) runs the
same three commands on every PR and push.

## Add a new tool

```bash
npm run new-tool -- options-flow "Options Flow" --zh "期權資金流" --category Flow \
  --summary "Unusual options activity on the Watchlist."
```

This creates `options-flow/{index.html,app.js,style.css}` from `scripts/templates/tool/` and adds
an entry to `assets/tools.json`. The header nav, footer and landing page pick it up from the
registry, so there is nothing else to wire. Then:

1. Build the tool in `options-flow/app.js`. Use the components in `assets/css/theme.css`
   (`panel`, `field`, `select`, `input`, `seg`, `check`, `table`, `badge`, `btn`, `notice`) and
   tokens (`var(--surface)`, `var(--accent)`, `var(--up)`, `var(--down)`, `var(--font-mono)`).
2. If it needs fresh data, add a builder in `.github/options-flow/` and a workflow modelled on
   `backtest-prices.yml` that writes into `options-flow/data/`, stages only that folder, and calls
   `notify-host.yml`.
3. Edit its registry entry: `status` (`beta` → `new` → `live`), `summary`, `highlights`,
   `icon` (`backtest`, `capitol`, `news`, `scanner`, `greeks`, `tool`), `accent`, `nav`.
4. `npm run check`, commit, push.

Registry fields: `id` (kebab-case, = folder), `title`, `zh`, `href` (`/id/`, or `null` for a
"soon" card), `status` (`live | new | beta | soon`), `category`, `summary`, `highlights[]`, `icon`,
`accent`, `nav` (show in header), `owner` (`repo` or `news-analyst`), `chrome` (`shared` = must
include `theme.css` + `site.js`, checked by `npm run check`; `own` = page has its own design).

## Backtest

`/backtest/` runs entirely in the browser. The code is split so that strategies, composition,
and data sources stay separate:

```
providers/*       →  bars. Daily equities, or HSI futures when the public packs are published
composition/*     →  HTF confirm, entry, exit, session → one target[]
strategies/*      →  signal plug-ins (direction only; they do not call each other)
engine/backtest.js → fills at next open, costs or index points, equity, trades
engine/metrics.js → CAGR, Sharpe, Sortino, max drawdown, win rate, profit factor, …
charts.js / app.js → the one /backtest/ page
```

`/hsi-lab/` redirects to `/backtest/` with the Fast Response recipe selected. There is not a second UI.

HSI futures 1-minute and 5-minute ATR SuperTrend does not run the minute tape in the browser.
The page looks up a stored daily score and draws that. Pages Functions in `functions/backtest/data/hsi/`
read the objects from the existing `HSI_BARS` KV binding. The year packs and the result bundles stay
out of git. A missing result says it is not computed yet. A missing daily file says the bars are not
on the site yet.

| Name | Where it is set | What it points at |
| --- | --- | --- |
| `HSI_BARS` | Pages project binding, namespace `f6577e29d4b249dea5a81b4f00443082` | KV keys `v1/1m/…` and `v1/results/…` |
| `HSI_BARS_URL` | Worker or pack environment | Public base URL for that prefix |
| `HSI_BARS_BASE` | `window.__HSI_BARS_BASE` or `<meta name="hsi-bars-base">` | Same base, read in the browser |
| bar paths | `/backtest/data/hsi/` | `v1/1m/manifest.json`, `v1/1m/YYYY.bin`, optional `v1/1d/HSImain.csv` |
| result paths | `/backtest/data/hsi/` | `v1/results/{1\|5}m-{10\|11\|12\|13\|14}/all.json.gz` |

`_routes.json` sends only `/backtest/data/hsi/*` through a Function. The rest of the site stays static.
Minute objects are `v1/1m/YYYY.bin` (magic `HSI1`). Every equity and index on the page has daily bars
in the site files. HSI futures daily, weekly, and monthly use `v1/1d/HSImain.csv` when that file is
published. 1-minute and 5-minute stay disabled for every other ticker, and choosing them locks the
security to HSI futures. The page never names a data vendor.

### Stored HSI SuperTrend results

The page requests one key and slices it. Fast Response is entry 5-minute, ATR 10, exit 5-minute,
clock 09:30, re-enter:

- Key and public path: `v1/results/5m-10/all.json.gz`
- Combo inside the bundle: `5:10:clock:09:30:reenter`

Key shape: `v1/results/{entryTf}m-{entryAtr}/all.json.gz` with `entryTf` of `1` or `5` and
`entryAtr` of 10, 11, 12, 13, or 14. The body is gzip (magic `1f 8b`) of an HSID v1 daily bundle,
the same bytes `encodeBundle()` in `backtest/providers/hsi-results.js` writes. The name ends in
`.json.gz`; the payload is not JSON. A year file `v1/results/{entryTf}m-{entryAtr}/{year}.json.gz`
is served if it is uploaded. The page reads the `all` bundle.

Combo shape: `{exitTf}:{exitAtr}:{entryRule}:{clock}:{exitRule}`.

- `exitTf` is `1` or `5`. `exitAtr` is 10–14, and equals `entryAtr` when the timeframes match.
- `entryRule` is `flip`, `clock`, or `firstFlip`. `clock` is `-` for `flip`, otherwise `09:15` or `09:30`.
- `exitRule` is `flat`, `reenter`, or `reverse`.

Factor 2.5, EMA smoothing 2, the 09:15–16:30 Hong Kong session, flatten at the session close, and
no separate daily confirm are fixed. They are not in the key. `year=all`, a single year, custom
dates, and the round-trip point cost are applied when the page reads. Custom dates and the
Range presets slice that same `all` bundle. A combo outside that grid shows “not computed yet”
and does not run the tape. The chart is one candle per session day, in the same up, down, and
equity colors as the other backtests.

The SuperTrend line and Buy/Sell labels are not in that score. They are one extra object per combo,
`v1/results/{entryTf}m-{entryAtr}/ov/{exitTf}-{exitAtr}-{entryRule}-{clock}-{exitRule}.json.gz`.
`clock` is `na` for a flip, otherwise `0915` or `0930`. Fast Response is
`v1/results/5m-10/ov/5-10-clock-0930-reenter.json.gz`. The body is gzip of the bytes
`encodeOverlay()` in `backtest/providers/hsi-overlay.js` writes. Sample the session line and price
at direction changes and at least every 15 minutes. Keep at most 60,000 line points and 8,000
markers. A missing overlay leaves the score on the chart. The page does not rebuild it from the
minute tape. The price-chart SuperTrend checkbox shows or hides the line and the labels.

Phase 1 HSI score is index points for one unit (price movement). Basis-point commission is not applied.
The optional cost field subtracts a flat number of points per closed trade. Until that field is edited it is 6 points on a 5-minute exit and 8 points on a 1-minute exit.

### Execution model and metric definitions

- A strategy returns `target[i] ∈ {1, 0, -1, null}`: the position wanted after bar *i* closes
  (`null` = keep). The engine fills it at bar *i+1*'s **open**. No look-ahead (tested for every
  strategy by running it on truncated histories).
- Each entry invests 100% of equity in fractional units. Commission and slippage are in basis
  points per side. Shorts only when "Allow short selling" is on; otherwise `-1` means flat.
- Optional stop loss / take profit / max bars are checked on the close and exit next open; the
  same side is not re-entered until the strategy's target changes.
- Indicators warm up on history before the start date. Buy & hold buys the first bar's close
  with the same costs. A position open on the last bar is marked to market and excluded from
  trade statistics.
- **CAGR** = (end/start)^(1/years) − 1 with years = days/365.25. **Sharpe** = mean(r − rf) /
  stdev(r) × √N, **Sortino** = mean(r − rf) / √mean(min(0, r − rf)²) × √N, where r are bar
  returns of the equity curve and N = bars per year measured from the data (≈252 stocks, ≈365
  crypto, 52 weekly, 12 monthly). **Max drawdown** = min(equity / running peak − 1). **Calmar** =
  CAGR / |max DD|. **Win rate** = closed trades with P&L > 0 after costs / closed trades.
  **Profit factor** = gross profit / gross loss. Also: volatility, longest drawdown, exposure,
  average/best/worst trade, average bars held, beta and correlation to buy & hold.

### Strategies included

Daily equities keep TD Sequential. ATR SuperTrend is the same kind of plug-in: it emits a direction
and leaves clocks, confirm, and session flatten to `composition/`. Both are choices in the Strategy
select. The composition row (entry, exit, clock, after the flip, confirm, session, year or custom
From–To, plus Entry ATR / Exit ATR when the study has an ATR length) is on the page for every
strategy. A slot that does not change that run is disabled, with the reason on the control and in
the row hint. TD Sequential on daily, weekly, and monthly bars uses By year and From–To. Clock,
exit, confirm, flatten, and point cost apply to HSI futures 1-minute and 5-minute ATR SuperTrend,
which reads the stored matrix and does not run the minute tape. The first selectable recipe is
SuperTrend Fast Response (ATR 10, factor 2.5, smoothing 2, 5-minute clock at 09:30, re-enter, flatten
at the day-session close). A second recipe adds a daily SuperTrend confirm as a separate signal.
That confirm is not in the stored results.

| id | Rule |
| --- | --- |
| `td-sequential` | DeMark TD Sequential. Setup: 9 consecutive closes below (above) the close 4 bars earlier, started by a price flip; optional perfection filter. Countdown: 13 closes ≤ low (≥ high) 2 bars earlier, bar 13 must reach the close of countdown bar 8 (else deferred "+"), cancelled by an opposite setup or a close through TDST; optional recycling. Trade on Setup 9, Countdown 13, or either; the opposite signal exits (or reverses). |

### Add a strategy

Create `backtest/strategies/my-strategy.js`:

```js
import { sma } from '../engine/indicators.js';

export default {
  id: 'my-strategy',                       // stable: used in share links
  name: 'Close above SMA', short: 'SMA', summary: 'Long while the close is above its N-bar SMA.',
  tags: ['Trend'],
  params: [{ key: 'period', label: 'Period', type: 'number', default: 100, min: 2, max: 400, step: 1 }],
  run(bars, p) {
    const avg = sma(bars.map((b) => b.close), p.period);
    return {
      // Only use bars[0..i] to decide target[i].
      target: bars.map((b, i) => (avg[i] == null ? null : b.close > avg[i] ? 1 : 0)),
      overlays: [{ name: `SMA ${p.period}`, color: '#38bdf8', values: avg }],   // optional
      // markers: [{ index, position: 'above'|'below', text, color, kind }]     // optional
      // panes:   [{ name, series: [{ name, values, color, type: 'line'|'histogram' }], levels: [] }]
    };
  },
};
```

Register it in `backtest/strategies/index.js` (`STRATEGIES`). The form is generated from
`params` (`number`, `select` with `options`, `boolean`). `npm test` automatically runs the
contract and no-look-ahead tests on every registered strategy; add a hand-worked case of your
own in `backtest/tests/`.

### Add a price-data source

A provider (see `backtest/providers/index.js`) is an object with `id`, `name`, `kind`
(`catalog` with `listSymbols()`, or `file`), and `load()` returning
`{ symbol, name, currency, bars: [{ time: 'YYYY-MM-DD', open, high, low, close, volume, dividend }], hasDividends, source: { name, url, note, asOf }, sample }`.
Bars must be daily, ascending and split-adjusted. Set `sample: true` for anything that is not real
market data; the page then shows a SAMPLE badge and banner. Register it in `PROVIDERS`.

Included: `site` (the committed daily CSVs) and `csv` (a CSV the visitor picks, read
locally). A browser-side API provider (e.g. one that needs an API key and sends CORS headers) can
be added the same way. The scheduled fetch's chart endpoint sends no CORS headers, which is why
the site serves prices as static files. HSI futures are a separate loader (`providers/hsi-futures.js`),
selected by the `HSImain` symbol rather than by the source dropdown.

To add tickers to the site data, edit `.github/backtest/prices/universe.json` and run the
"Backtest prices refresh" workflow (or `PYTHONPATH=.github/backtest python3 -m prices fetch --out .`).

### Price data

`backtest-prices.yml` runs at 06:30 HKT Tue–Sat (after the US close) and writes
`backtest/data/prices/<SYMBOL>.csv` (`date,open,high,low,close,volume,dividend,split`, from 1990
or listing), `manifest.json` and `recent.json` (last 160 bars of a few symbols for the landing
page). A symbol that fails keeps its previous file and is flagged `stale` (shown on the page).
Each refresh appends a few lines per file, so git history grows slowly.

The fetcher checks its dividend back-adjustment against the adjusted close reported with the
download (`adj_check` in the manifest). It matches to 1e-6 for 45 of 47 symbols; for 0005.HK and
9988.HK that adjusted close skips some of the dividends the download reports, and this site
applies all of them.

### Verification

- `backtest/tests/*.test.mjs`: RSI against the published Wilder/StockCharts example; hand-worked
  TD Setup / Countdown / deferral / TDST cancellation cases; fills, costs, shorts, reversals and risk
  exits with exact expected equity; metrics against values computed in Python; compounding of trade
  returns equals the equity change.
- `backtest/tests/reference/reference_check.py`: an independent stdlib-Python implementation of
  the data adjustment, TD Sequential, execution and metrics, compared trade by trade with
  the engine on real SPY data for four configurations (daily/weekly, long-only/long-short, costs,
  stop loss), plus a printed walk-through of the first TD trade for checking by hand.

## Deploying, and how the News Analyst upload fits in

Nothing in this repo deploys to Cloudflare. Pushes to `main` trigger `notify-host.yml`, which
pings the host; the News Analyst uploads `/news/` with Wrangler around 08:15 HKT. A Pages direct
upload replaces the entire deployment, so every upload must contain both this repo's files and
`news/`:

```bash
git -C adrnnng pull origin main
adrnnng/scripts/assemble-deploy.sh /tmp/site --news ./news-output   # writes sitemap.xml
npx wrangler pages deploy /tmp/site --project-name adrnnng --branch main
node adrnnng/scripts/ping-indexnow.mjs --site /tmp/site || true      # after the upload is live
```

`assemble-deploy.sh` copies the tracked site files (minus `.github/`, `scripts/`, tests, docs),
then the News Analyst's folder into `news/`. It then rewrites `assets/news-preview.json` and
the static home cover from the newest `news/YYYYMMDD/index.html` (href, kicker, dek, stories,
markets, and `serp_hook`), and patches `news/index.html` with the archive meta description, a
`<title>` aligned to the og:title (港股美股), and a static Buttondown card. It does not rewrite
daily edition titles. Those already come from News Analyst: `serp_hook` in
`digest/data/YYYY-MM-DD.json` (also `YYYYMMDD.json`), copied into the day-page
`<title>` as `{serp_hook}｜{M}月{D}日港股美股盤前早報 — ADRRR`, with a dated fallback and no
empty hook prefix when the field is missing. Pass that digest directory with
`ADRRR_DIGEST_DIR` or place it at `../digest/data` next to this repo; otherwise the hook
written into `news-preview.json` is taken from `news/latest.json`, a JSON sidecar, a
`<meta name="serp_hook">` tag, or the edition `<title>`. An empty string is kept when the
field is present but blank.

It then stamps public HTML with Organization and WebSite JSON-LD (`og:locale=zh_HK`, `twitter:site=@adrnnng`, breadcrumbs on sections and editions). Day pages keep their News Analyst titles and headlines. If a day page already has `NewsArticle` JSON-LD, the stamp adds `publisher.logo` (the apple-touch icon) and copies `datePublished` into `article:published_time` when that timestamp is already on the page. It does not add `SearchAction` or `FAQPage`. There is no site search.

`/news/feed.xml` is written from the edition files in that upload: one item per `/news/YYYYMMDD/`, using that page's title and description. `pubDate` is set only when the page already has a timestamp. `dc:date` is the edition date in the path.

The script then writes `/sitemap.xml` from the merged tree. `/` and `/news/` `lastmod` values are at least the preview edition date, so a morning publish moves those entries even when the file mtime is still the previous UTC day. Other URLs keep their own file mtime.
That index lists every HTML page present (`/`, `/backtest/`, `/politician-tracker/`, static
member pages), plus `sitemap-news.xml` for `/news/YYYYMMDD/` editions. `/hsi-lab/` redirects
to `/backtest/` and is not a separate HTML page, so it is listed only if an `index.html` is
actually in the upload.
Editions from today or yesterday in Hong Kong also go in `news-sitemap.xml` (Google News,
`<news:language>zh-Hant</news:language>`), and
the index includes that fragment only when one exists. `news/` is reserved: it is registered in
`tools.json` with `owner: "news-analyst"`, and `npm run check` fails if the repo ever contains
it. A hand upload of the repo checkout plus `news/` still works if you run
`node scripts/home-preview.mjs --site <dir>` and
`node scripts/build-sitemap.mjs --site <dir>` on that folder before Wrangler. The committed
sitemap has no daily editions, because `news/` is not in the repo. The committed
`assets/news-preview.json` is only the fallback copy; every assemble overwrites the upload.

The landing reads `news/latest.json` after load and uses `date`, `headline`, `summary`,
`image_url`, `image_credit`, `source_name`, `source_url`, and `report_url`. `image_url` is the
photo on the page; the daily file points it at a WebP under `/news/img/YYYYMMDD/`. Other keys,
including `image_url_original`, are ignored. The News Analyst publishes that file with the daily
report. The only copy in this repo is `scripts/preview/latest.json`, and `assemble-deploy.sh`
does not upload `scripts/`.

This repo owns the site root outside `news/`: `index.html`, `404.html`, `robots.txt`, `llms.txt`,
the IndexNow key file, `_headers`, `_redirects`, `assets/`, `backtest/` (without `backtest/tests/`),
and `politician-tracker/`. `publish.sh` still writes a `Disallow: /` robots.txt only when the repo
has none, so the committed file wins. It must not append `X-Robots-Tag: noindex` on `/*`;
`_headers` detaches that header on public HTML and sets it for `/api/` plus
`/politician-tracker/data.json`, `/news/latest.json`, and `/assets/tools.json`.
Those JSON rules stay below the `/news/*` and `/politician-tracker/*` detaches:
Cloudflare applies `_headers` in file order, and a later `!` would remove the
noindex. After `wrangler pages deploy`, ping IndexNow with
`node scripts/ping-indexnow.mjs --site <deploy_dir>`.
`404.html` must be in every upload. Without it, Pages treats the site as a single-page app and serves `index.html`
with status 200 for unknown paths, including `/backtest/tests/`. `_redirects` only aliases
`/backtesting` to `/backtest/` and `www` to the apex. `/favicon.ico` is the same file as
`assets/brand/favicon.ico`, so browsers that request the root icon get the real one. The News
Analyst merges the `/latest` redirect rules at upload time and does not write a root `index.html`.

Sitemap files are static XML written at assemble time. This repo has no Pages Function that
could return 500 for them. Titles are XML-escaped, and characters XML 1.0 forbids are stripped,
so a news title cannot make the document malformed. A direct fetch of `/sitemap.xml` returns 200.

## Disclaimer

Research and education only. Not investment advice. Backtests are hypothetical, use historical
data that may contain errors, and do not predict future results.
