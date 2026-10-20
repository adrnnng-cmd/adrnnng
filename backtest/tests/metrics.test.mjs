import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, drawdownSeries, periodReturns } from '../engine/metrics.js';
import { close } from './helpers.mjs';

// Expected values computed independently with Python's statistics module.
const times = ['2020-01-01', '2021-01-01', '2022-01-01', '2023-01-01'];
const equity = [100, 110, 99, 120];

test('return, risk and ratio metrics', () => {
  const m = computeMetrics({ times, equity });
  assert.ok(close(m.years, 3.0006844626967832));
  assert.ok(close(m.periodsPerYear, 0.9997718978102189));
  assert.ok(close(m.totalReturn, 0.2));
  assert.ok(close(m.cagr, 0.06264383802219697));
  assert.ok(close(m.volatility, 0.15809100966936715));
  assert.ok(close(m.sharpe, 0.4471534619030714));
  assert.ok(close(m.sortino, 1.2245427048567061));
  assert.ok(close(m.maxDrawdown, -0.1));
  assert.ok(close(m.calmar, 0.6264383802219697));
  assert.equal(m.longestDrawdownDays, 730);
});

test('risk-free rate is de-annualised per period', () => {
  const m = computeMetrics({ times, equity, riskFreeRate: 0.05 });
  const rf = Math.pow(1.05, 1 / m.periodsPerYear) - 1;
  const r = [0.1, -0.1, 120 / 99 - 1];
  const mean = r.reduce((a, b) => a + b) / 3;
  const sd = Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / 2);
  assert.ok(close(m.sharpe, ((mean - rf) / sd) * Math.sqrt(m.periodsPerYear)));
});

test('trade statistics use closed trades only', () => {
  const trades = [
    { pnl: 100, returnPct: 10, bars: 5 },
    { pnl: -50, returnPct: -5, bars: 3 },
    { pnl: 30, returnPct: 3, bars: 2 },
    { pnl: -20, returnPct: -2, bars: 6 },
    { pnl: 999, returnPct: 99, bars: 1, open: true },
  ];
  const m = computeMetrics({ times, equity, trades, positions: [0, 1, 1, 0] });
  assert.equal(m.trades, 4);
  assert.equal(m.winRate, 0.5);
  assert.ok(close(m.profitFactor, 130 / 70));
  assert.equal(m.avgTradePct, 1.5);
  assert.equal(m.avgWinPct, 6.5);
  assert.equal(m.avgLossPct, -3.5);
  assert.equal(m.bestTradePct, 10);
  assert.equal(m.worstTradePct, -5);
  assert.equal(m.avgBarsHeld, 4);
  assert.equal(m.exposure, 0.5);
});

test('profit factor edge cases', () => {
  assert.equal(computeMetrics({ times, equity, trades: [{ pnl: 5, returnPct: 1, bars: 1 }] }).profitFactor, Infinity);
  assert.ok(Number.isNaN(computeMetrics({ times, equity, trades: [] }).profitFactor));
});

test('beta and correlation against a benchmark', () => {
  const bench = [100, 105, 99.75, 109.725]; // returns 5%, -5%, 10%
  const m = computeMetrics({ times, equity: [100, 110, 99, 118.8], benchmark: bench }); // exactly 2x
  assert.ok(close(m.beta, 2));
  assert.ok(close(m.correlation, 1));
});

test('drawdown series and monthly/yearly returns', () => {
  assert.deepEqual(drawdownSeries([100, 120, 90, 120, 130]).map((x) => +x.toFixed(4)), [0, 0, -0.25, 0, 0]);
  const t = ['2023-12-28', '2023-12-29', '2024-01-02', '2024-01-31', '2024-02-01'];
  const e = [100, 110, 121, 99, 110];
  const p = periodReturns(t, e);
  assert.deepEqual(p.months.map((x) => [x.year, x.month, +x.ret.toFixed(6)]), [
    [2023, 11, 0.1],
    [2024, 0, +(99 / 110 - 1).toFixed(6)],
    [2024, 1, +(110 / 99 - 1).toFixed(6)],
  ]);
  assert.deepEqual(p.years.map((x) => [x.year, +x.ret.toFixed(6)]), [
    [2023, 0.1],
    [2024, 0],
  ]);
});
