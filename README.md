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

### Strategy included

For now the page ships with TD Sequential only; other rules plug in through the interface in the next section.

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

This repo owns the site root outside `news/`: `index.html`, `_headers`, `_redirects`, `assets/`,
`backtest/` (without `backtest/tests/`), and `politician-tracker/`. `_redirects` only aliases
`/backtesting` to `/backtest/`. The News Analyst merges the `/latest` redirect rules at upload
time and does not write a root `index.html`.

## Disclaimer

Research and education only. Not investment advice. Backtests are hypothetical, use historical
data that may contain errors, and do not predict future results.
