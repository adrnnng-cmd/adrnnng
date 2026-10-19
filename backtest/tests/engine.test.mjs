import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from '../engine/backtest.js';
import { dates, scripted, close } from './helpers.mjs';

const mk = (rows) => {
  const t = dates(rows.length);
  return rows.map(([o, c], i) => ({ time: t[i], open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: 0 }));
};
const free = { commissionBps: 0, slippageBps: 0 };

test('decision on bar i close fills at bar i+1 open (no look-ahead), no costs', () => {
  const bars = mk([[10, 10], [11, 12], [12, 13], [14, 15], [15, 14]]);
  const r = runBacktest(bars, scripted([1, null, 0, null, null]), {}, free);
  const q = 10000 / 11;
  assert.deepEqual(r.positions, [0, 1, 1, 0, 0]);
  [10000, q * 12, q * 13, q * 14, q * 14].forEach((v, i) => assert.ok(close(r.equity[i], v), `equity[${i}]`));
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entryPrice, 11);
  assert.equal(t.exitPrice, 14);
  assert.equal(t.entryTime, bars[1].time);
  assert.equal(t.exitTime, bars[3].time);
  assert.equal(t.bars, 2);
  assert.ok(close(t.pnl, 3 * q));
  assert.ok(close(t.returnPct, (3 / 11) * 100));
  assert.equal(r.metrics.trades, 1);
  assert.equal(r.metrics.winRate, 1);
});

test('commission and slippage are charged on both sides', () => {
  const bars = mk([[10, 10], [11, 12], [12, 13], [14, 15], [15, 14]]);
  const r = runBacktest(bars, scripted([1, null, 0, null, null]), {}, { commissionBps: 10, slippageBps: 10 });
  const entryFill = 11 * 1.001;
  const exitFill = 14 * 0.999;
  const qty = 10000 / 1.001 / entryFill;
  const final = qty * exitFill * 0.999;
  assert.ok(close(r.equity.at(-1), final));
  assert.ok(close(r.trades[0].pnl, final - 10000));
  assert.ok(close(r.trades[0].entryPrice, entryFill));
  assert.ok(close(r.trades[0].exitPrice, exitFill));
});

test('shorts only when allowed; open trade at the end is reported separately', () => {
  const bars = mk([[10, 10], [10, 9], [9, 8], [8, 7]]);
  const strat = scripted([-1, null, null, null]);
  const flat = runBacktest(bars, strat, {}, free);
  assert.deepEqual(flat.equity, [10000, 10000, 10000, 10000]);
  assert.equal(flat.trades.length, 0);

  const s = runBacktest(bars, strat, {}, { ...free, allowShort: true });
  [10000, 11000, 12000, 13000].forEach((v, i) => assert.ok(close(s.equity[i], v)));
  assert.equal(s.trades.length, 0);
  assert.equal(s.openTrade.side, 'short');
  assert.ok(close(s.openTrade.pnl, 3000));
  assert.ok(Number.isNaN(s.metrics.winRate));
});

test('reversal long → short happens at a single open', () => {
  const bars = mk([[10, 10], [10, 11], [11, 12], [12, 11], [11, 10]]);
  const r = runBacktest(bars, scripted([1, null, -1, null, null]), {}, { ...free, allowShort: true });
  assert.deepEqual(r.positions, [0, 1, 1, -1, -1]);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].exitPrice, 12);
  assert.equal(r.openTrade.entryPrice, 12);
  assert.ok(close(r.equity.at(-1), 12000 + 12000 * (2 / 12)));
});

test('stop loss exits next open and blocks re-entry until the target changes', () => {
  const bars = mk([[100, 100], [100, 95], [95, 89], [90, 91], [91, 92], [92, 93], [93, 94]]);
  const always = runBacktest(bars, scripted([1, 1, 1, 1, 1, 1, 1]), {}, { ...free, stopLossPct: 10 });
  assert.equal(always.trades.length, 1);
  assert.equal(always.trades[0].reason, 'stop loss');
  assert.equal(always.trades[0].exitPrice, 90);
  assert.equal(always.openTrade, null);

  const reset = runBacktest(bars, scripted([1, 1, 1, 0, 1, 1, 1]), {}, { ...free, stopLossPct: 10 });
  assert.equal(reset.trades.length, 1);
  assert.equal(reset.openTrade.entryPrice, 92, 're-entered after target went 0 → 1');
});

test('take profit and max bars held', () => {
  const bars = mk([[10, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15]]);
  const tp = runBacktest(bars, scripted([1, null, null, null, null, null]), {}, { ...free, takeProfitPct: 15 });
  assert.equal(tp.trades[0].reason, 'take profit');
  assert.equal(tp.trades[0].exitPrice, 12, '12/10 = +20% at bar 2 close → exit bar 3 open');
  const mh = runBacktest(bars, scripted([1, null, null, null, null, null]), {}, { ...free, maxHoldBars: 2 });
  assert.equal(mh.trades[0].reason, 'max bars');
  assert.equal(mh.trades[0].bars, 2);
});

test('compounded trade returns equal the equity change when flat at the end (with costs)', () => {
  const n = 300;
  const t = dates(n);
  const bars = t.map((time, i) => {
    const c = 100 + 20 * Math.sin(i / 9) + i * 0.05;
    const o = 100 + 20 * Math.sin((i - 0.5) / 9) + i * 0.05;
    return { time, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, volume: 0 };
  });
  const target = bars.map((_, i) => (i > n - 5 ? 0 : [1, null, null, -1, null, 0, null, 1][i % 8]));
  const r = runBacktest(bars, scripted(target), {}, { commissionBps: 7, slippageBps: 3, allowShort: true });
  assert.equal(r.openTrade, null);
  const product = r.trades.reduce((p, x) => p * (1 + x.returnPct / 100), 1);
  assert.ok(close(product, r.equity.at(-1) / 10000, 1e-9));
});

test('buy & hold buys at the first bar close of the range', () => {
  const bars = mk([[10, 10], [10, 20], [20, 25], [25, 50]]);
  const r = runBacktest(bars, scripted([]), {}, { ...free, start: 1 });
  assert.deepEqual(r.times, bars.slice(1).map((b) => b.time));
  assert.deepEqual(r.benchmark, [10000, 12500, 25000]);
  assert.ok(close(r.benchmarkMetrics.totalReturn, 1.5));
  assert.equal(r.benchmarkDrawdown.every((d) => d === 0), true);
});

test('signals before the start date never open positions earlier than the range', () => {
  const bars = mk([[10, 10], [10, 11], [11, 12], [12, 13]]);
  const r = runBacktest(bars, scripted([1, null, null, null]), {}, { ...free, start: 2 });
  assert.deepEqual(r.positions, [0, 0]);
});
