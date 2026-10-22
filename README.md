# adrnnng.com

Adrian Ng's trading and investing site. It is plain static files with **no build step**: the repo
root is the site root, and whatever is committed is what Cloudflare Pages (project `adrnnng`)
serves. Data that needs refreshing is fetched by scheduled GitHub Actions and committed as
static JSON/CSV.

| Path | What | Published by |
| --- | --- | --- |
| `/` | Landing page (`index.html`, `assets/js/home.js`) | this repo |
| `/backtest/` | Backtest tool | this repo; prices refreshed by `backtest-prices.yml` |
| `/hsi-lab/` | HSI futures strategy lab | this repo. Precomputed scores stay in Workers KV; a Pages Function returns points only |
| `/politician-tracker/` | Politician Tracker | this repo; page rebuilt by `politician-tracker.yml` |
| `/news/` | Morning Report | **News Analyst agent** (direct Wrangler upload, ~08:15 HKT). Not in this repo. |

## Layout

```
index.html                     landing page
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
  runners/                     Node-only studies (HSI ATR SuperTrend phase 1). Not a page.
  data/prices/                 daily CSVs + manifest.json (written by the scheduled fetch)
  tests/                       node --test unit tests; tests/reference = independent Python cross-check
politician-tracker/            built page + data.json + img/ (committed by its workflow)
hsi-lab/                       public lab page, engine, and request handler
functions/api/hsi-lab/         Cloudflare Pages Function (GET the registry, POST a run)
scripts/pack-hsi-r2.mjs        private packer: cleaned parquet/CSV → year bins
scripts/hsi-lab-precompute.mjs private grid: tape → gzipped result bundles for KV
.github/<tool>/                data builders run by Actions (Python stdlib, no pip installs)
.github/workflows/             scheduled refreshes, publish ping, site check
scripts/                       check-site, new-tool scaffolder + template, assemble-deploy
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
npm test             # engine unit tests (node --test) + price fetcher tests (Python)
npm run verify:backtest   # engine vs an independent Python implementation on real SPY data
npm run check        # registry, page wiring, local links/imports, reserved paths, price manifest
```

The landing asks for `/news/latest.json` when the page loads. That file is published with the
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

`/backtest/` runs entirely in the browser on the static price files. The code is split so that
strategies and data sources are plug-ins:

```
providers/*  →  bars (daily, split-adjusted, dividends on ex-dates)
engine/bars.js  →  dividend adjustment (optional) → weekly/monthly resampling
strategies/*  →  target position per bar
engine/backtest.js  →  fills at next open, costs, risk exits, equity, trades, buy & hold
engine/metrics.js  →  CAGR, Sharpe, Sortino, max drawdown, win rate, profit factor, …
charts.js / app.js  →  UI
```

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

### Strategies

| id | Rule |
| --- | --- |
| `td-sequential` | DeMark TD Sequential. Setup: 9 consecutive closes below (above) the close 4 bars earlier, started by a price flip; optional perfection filter. Countdown: 13 closes ≤ low (≥ high) 2 bars earlier, bar 13 must reach the close of countdown bar 8 (else deferred "+"), cancelled by an opposite setup or a close through TDST; optional recycling. Trade on Setup 9, Countdown 13, or either; the opposite signal exits (or reverses). |
| `atr-supertrend` | ATR SuperTrend [QuantAlgo](https://www.tradingview.com/script/5ZlvGLXX-ATR-Supertrend-QuantAlgo/). EMA-smoothed close versus a ratcheting ATR band. Bull trend is long, bear trend is short (needs Allow short selling on this page). Defaults: ATR length 10, factor 2.5, smoothing 2. |

### HSI ATR SuperTrend, phase 1

A separate Node runner studies that signal on a private continuous HSI 1-minute file. It does not use the page's percent-of-equity engine. Phase 1 is price movement only: one notional unit of the index, P&L in index points and in percent of the run's first close. No contract size, commission, or slippage. `phase2CostHook` in `backtest/runners/phase1.js` is where Phase 2 (Mini HSI, HKD 10/point, HKD 40 round-turn) will subtract costs; it is left disabled, so net points equal gross points.

Day session only. The first regular bar at or after 09:15 HKT is the open (the 08:45–09:15 auction and the 12:30–13:00 pre-open are dropped). The position is held through lunch and flattened at the last day-session bar's close (16:29 open on a full 1-minute day). Bull flip → long, bear flip → short, and a later flip reverses. Entry arms:

| arm | First entry |
| --- | --- |
| `control` | any flip on the day-session bars |
| `A-S` | at 09:15 (or the first bar after it), take the current trend, no flip required |
| `A-F` | first flip at or after 09:15 |
| `B-S` / `B-F` | the same at 09:30 |

After that entry, flips are followed until the end-of-day flatten. With the session filter in place, `control` and `A-F` are the same study: nothing before 09:15 reaches the simulator. A flip fills at the next bar's open. A state arm fills at the clock bar's open, using only the prior bar's trend.

The matrix is 1m and 5m (5m resampled from the day-session 1m bars) × ATR length 10, 11, 12, 13, 14 × those five arms = 50 runs. Factor 2.5 and EMA smoothing 2. Each run records total points, percent return, win rate, trades, average points per trade, max drawdown in points and percent, Sharpe on daily returns (sample stdev, rf = 0, √252), a long/short split, and the equity curve. `summary.csv` / `summary.json` rank the 50 runs by points.

The real HSI file is private and is not in this repo. Do not commit it. Point the runner at a local CSV or parquet (`time_key`, `open`, `high`, `low`, `close`, `volume`; `time_key` is the bar open in Asia/Hong_Kong). Parquet needs pyarrow, polars, or duckdb already installed; this repo does not install them. CSV needs nothing.

```bash
node backtest/runners/hsi-supertrend-phase1.js --data /path/to/HSImain_1m.parquet
```

`HSI_BARS_PATH` is the same path when `--data` is omitted. Output defaults to `backtest/output/hsi-supertrend-phase1/` (gitignored): `summary.csv`, `summary.json`, and `runs/<id>.json`. The reader is not a browser provider and the site does not serve the bars.

### HSI Strategy Lab

`/hsi-lab/` is the public page for that study. There is no login. The free plan allows about 10ms of CPU and 128MB per request, so the page does not run the backtest. Adrian picks a cell in a precomputed grid and the server looks up the score: trades, trades per day, win rate, profit factor, average points, average hold, max drawdown, gross and net points, an equity curve of at most 250 cumulative points, and breakdowns by year and by entry hour. The response has no prices, no entry or exit levels, and no per-trade timestamps.

The grid is entry timeframe 1m or 5m, entry ATR 10 through 14, exit timeframe 1m or 5m, and exit ATR 10 through 14. When the timeframes match, both sides share one ATR. Then five entry rules (any flip, the 09:15 state, the 09:30 state, the first flip after 09:15, the first flip after 09:30) and three exits (flat, re-enter the same way, reverse). Factor is 2.5, smoothing is 2, and the window is the day session 09:15–16:30. That is 900 studies. The date control is By year (one calendar year, or all years) or Custom dates, any start and end from 2020-01-02 through today.

Each study stores one row per session day: gross points, trade count, wins, gross win points, gross loss points, hold minutes, and the session’s lowest mark in points from that session’s start. The worker adds the days inside the window. Net points are gross minus the round-trip cost times the trade count. Win rate and profit factor stay on gross points. Max drawdown is the peak-to-trough of that end-of-day curve, so the figure on the page is daily, not every minute. Costs default to 8 points when the exit is 1-minute and 6 when it is 5-minute. Entry hour is shown for a whole stored year or for every stored year. A custom window still gets the year table.

The archive is 10 gzip bundles, one per entry timeframe and ATR, plus a manifest: 11 KV keys. A synthetic bundle of 1,776 weekday sessions and 90 studies is 3.7 MB raw and about 840 KB gzipped, so the ten bundles are about 8.2 MB. Each value stays under the 25 MB limit. Real session counts are lower once holidays are dropped. By year and custom dates both read that one key.

The page calls `POST /api/hsi-lab`. `GET /api/hsi-lab` returns the grid and does not touch KV. There is no `/api/bars`. `functions/api/hsi-lab/_middleware.js` is the only auth hook: `authorize()` in `hsi-lab/server/auth.js` currently allows every request, and a later login replaces that function. The endpoint allows 30 lookups a minute per IP on each isolate. A missing `HSI_BARS` binding returns 503. Parsed bundles stay in isolate memory for 10 minutes, at most eight at a time.

A flip is known at the signal bar's close and fills at the next 1-minute open, on the same date. A 5-minute flip fills at the first 1-minute open of the next 5-minute bucket. Clock entries use the last completed bar's trend. The position flattens at the last bar of the day session.

Bars are not in git and never go to KV for the page. The engineer precomputes on a private machine. `--data` reads the cleaned parquet or CSV (`time_key`, `open`, `high`, `low`, `close`, `volume`, Hong Kong time). `--bins` reads packed year files from `scripts/pack-hsi-r2.mjs`. Parquet needs pyarrow, polars, or duckdb. The script uses worker threads, refuses to write inside this repository, and does not print prices.

```bash
node scripts/hsi-lab-precompute.mjs \
  --data /secure/HK_HSImain_1m.parquet \
  --out /secure/hsi-results

# Nightly refresh. --years checks the year, then rewrites the same ten
# daily bundles. The full tape is still read. There is no per-year file.
node scripts/hsi-lab-precompute.mjs \
  --data /secure/HK_HSImain_1m.parquet \
  --out /secure/hsi-results \
  --years 2026
```

Each bundle is `v1/results/<entryTf>m-<entryAtr>/all.json.gz`. `v1/results/manifest.json` lists the 10 keys, the total byte count, and no prices. Upload them to the Workers KV namespace `hsi-bars` (id `f6577e29d4b249dea5a81b4f00443082`).

```bash
# Pages project adrnnng → Settings → Bindings → Add → KV namespace.
# Variable name: HSI_BARS. Namespace: hsi-bars. Do not add a wrangler.toml.
npx wrangler kv key put --namespace-id f6577e29d4b249dea5a81b4f00443082 \
  v1/results/5m-14/all.json.gz \
  --path /secure/hsi-results/v1/results/5m-14/all.json.gz --remote

npx wrangler kv key put --namespace-id f6577e29d4b249dea5a81b4f00443082 \
  v1/results/manifest.json \
  --path /secure/hsi-results/v1/results/manifest.json --remote
```

Repeat the put for every `v1/results/<tf>m-<atr>/all.json.gz`, or upload the same key and file from the KV dashboard. A full grid is 10 bundles plus the manifest, 11 writes, inside the free plan's 1,000 writes a day. The worker reads one bundle with `env.HSI_BARS.get(key, 'arrayBuffer')`. Without the binding, Run returns 503 and no bars.

The same bytes can be stored in an R2 bucket bound as `HSI_BARS`. The adapter still accepts `get(key).arrayBuffer()`. KV is the binding to configure. `assemble-deploy.sh` already ships `functions/` and `hsi-lab/`.

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

Included: `site` (the committed Yahoo Finance CSVs) and `csv` (a CSV the visitor picks, read
locally). A browser-side API provider (e.g. one that needs an API key and sends CORS headers) can
be added the same way; Yahoo's own endpoint sends no CORS headers, which is why the site serves
prices as static files.

To add tickers to the site data, edit `.github/backtest/prices/universe.json` and run the
"Backtest prices refresh" workflow (or `PYTHONPATH=.github/backtest python3 -m prices fetch --out .`).

### Price data

`backtest-prices.yml` runs at 06:30 HKT Tue–Sat (after the US close) and writes
`backtest/data/prices/<SYMBOL>.csv` (`date,open,high,low,close,volume,dividend,split`, from 1990
or listing), `manifest.json` and `recent.json` (last 160 bars of a few symbols for the landing
page). A symbol that fails keeps its previous file and is flagged `stale` (shown on the page).
Each refresh appends a few lines per file, so git history grows slowly.

The fetcher checks its dividend back-adjustment against Yahoo's own adjusted close
(`adj_check` in the manifest). It matches to 1e-6 for 45 of 47 symbols; for 0005.HK and 9988.HK
Yahoo's adjusted close skips some of the dividends it reports, and this site applies all of them.

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
git -C adrnnng pull origin main                       # latest site, no build needed
adrnnng/scripts/assemble-deploy.sh /tmp/site --news ./news-output
npx wrangler pages deploy /tmp/site --project-name adrnnng --branch main
```

`assemble-deploy.sh` copies the tracked site files (minus `.github/`, `scripts/`, tests, docs),
then the News Analyst's folder into `news/`. `news/` is reserved: it is registered in
`tools.json` with `owner: "news-analyst"`, and `npm run check` fails if the repo ever contains
it. Uploading the raw repo checkout plus `news/` (the current flow) also keeps working, since
there is still no build step.

The landing reads `news/latest.json` after load and uses `date`, `headline`, `summary`,
`image_url`, `image_credit`, `source_name`, `source_url`, and `report_url`. `image_url` is the
photo on the page; the daily file points it at a WebP under `/news/img/YYYYMMDD/`. Other keys,
including `image_url_original`, are ignored. The News Analyst publishes that file with the daily
report. The only copy in this repo is `scripts/preview/latest.json`, and `assemble-deploy.sh`
does not upload `scripts/`.

This repo owns the site root outside `news/`: `index.html`, `404.html`, `_headers`, `_redirects`,
`assets/`, `backtest/` (without `backtest/tests/`), `hsi-lab/`, `functions/`, and `politician-tracker/`. `404.html` must be
in every upload. Without it, Pages treats the site as a single-page app and serves `index.html`
with status 200 for unknown paths, including `/backtest/tests/`. `_redirects` only aliases
`/backtesting` to `/backtest/`. The News Analyst merges the `/latest` redirect rules at upload
time and does not write a root `index.html`.

## Disclaimer

Research and education only. Not investment advice. Backtests are hypothetical, use historical
data that may contain errors, and do not predict future results.
