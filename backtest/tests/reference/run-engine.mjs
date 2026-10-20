// node backtest/tests/reference/run-engine.mjs SPY > out.json
// Runs the site's engine on a committed price file with the cases in cases.json and prints JSON,
// for reference_check.py to compare against its independent implementation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv, adjustForDividends, resample, indexAtOrAfter, indexAtOrBefore } from '../../engine/bars.js';
import { runBacktest } from '../../engine/backtest.js';
import { getStrategy, normaliseParams } from '../../strategies/index.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const symbol = process.argv[2] || 'SPY';
const manifest = JSON.parse(readFileSync(here('../../data/prices/manifest.json'), 'utf8'));
const entry = manifest.symbols.find((s) => s.symbol === symbol);
const raw = parseCsv(readFileSync(here(`../../data/prices/${entry.file}`), 'utf8'));
const cases = JSON.parse(readFileSync(here('./cases.json'), 'utf8'));

const out = [];
for (const c of cases) {
  const bars = resample(adjustForDividends(raw), c.timeframe);
  const strategy = getStrategy(c.strategy);
  const params = normaliseParams(strategy, c.params);
  const r = runBacktest(bars, strategy, params, {
    ...c.options,
    start: indexAtOrAfter(bars, c.from),
    end: indexAtOrBefore(bars, c.to),
  });
  out.push({
    name: c.name,
    first: r.times[0],
    last: r.times.at(-1),
    bars: r.times.length,
    finalEquity: r.equity.at(-1),
    metrics: r.metrics,
    benchmarkMetrics: r.benchmarkMetrics,
    trades: r.trades.map((t) => ({ side: t.side, entryTime: t.entryTime, entryPrice: t.entryPrice, exitTime: t.exitTime, exitPrice: t.exitPrice, pnl: t.pnl, returnPct: t.returnPct, reason: t.reason })),
    openTrade: r.openTrade && { side: r.openTrade.side, entryTime: r.openTrade.entryTime, entryPrice: r.openTrade.entryPrice },
  });
}
process.stdout.write(JSON.stringify({ symbol, cases: out }, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 1));
