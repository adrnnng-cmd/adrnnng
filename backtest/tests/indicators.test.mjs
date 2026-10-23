import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, pineEma, rma, trueRange, atr, rsi, macd, bollinger, donchian } from '../engine/indicators.js';

const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

test('sma', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

const near = (a, b) => Math.abs(a - b) < 1e-12;

test('pineEma seeds with the first value', () => {
  const e = pineEma([10, 11, 13], 2);
  assert.equal(e[0], 10);
  assert.ok(near(e[1], 32 / 3));
  assert.ok(near(e[2], 110 / 9));
  assert.equal(pineEma([1, null, 3], 2)[1], null);
  assert.ok(near(pineEma([1, null, 3], 2)[2], (2 / 3) * 3 + (1 / 3) * 1));
});

test('rma seeds with an SMA then uses the Wilder recurrence', () => {
  const out = rma([2, 3, 4, 3, 5, 3, 3], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 3);
  assert.equal(out[3], 3);
  assert.ok(near(out[4], 11 / 3));
  assert.ok(near(out[5], 31 / 9));
  assert.ok(near(out[6], 89 / 27));
  const skipped = rma([2, null, 3, 4], 3);
  assert.equal(skipped[1], null);
  assert.equal(skipped[3], 3);
});

test('true range uses high-low on the first bar and the previous close after that', () => {
  const bars = [
    { high: 11, low: 9, close: 10 },
    { high: 12, low: 9, close: 11 },
  ];
  assert.deepEqual(trueRange(bars), [2, 3]);
  assert.equal(atr(bars, 2)[1], 2.5);
});

test('ema is seeded with the SMA', () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(e.slice(0, 3), [null, null, 2]);
  assert.equal(e[3], 4 * 0.5 + 2 * 0.5);
  assert.equal(e[4], 5 * 0.5 + 3 * 0.5);
});

test('rsi matches the published Wilder example (StockCharts RSI tutorial)', () => {
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314];
  const expected = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3, 33.08, 37.77];
  const r = rsi(closes, 14);
  assert.equal(r[13], null);
  assert.deepEqual(r.slice(14).map((v) => round(v)), expected);
});

test('macd line is the EMA difference and histogram is line minus signal', () => {
  const v = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.2);
  const m = macd(v, 12, 26, 9);
  const f = ema(v, 12);
  const s = ema(v, 26);
  assert.equal(m.line[24], null);
  assert.equal(m.line[30], f[30] - s[30]);
  assert.equal(m.signal[25 + 7], null);
  assert.ok(m.signal[25 + 8] != null);
  assert.equal(m.hist[50], m.line[50] - m.signal[50]);
});

test('bollinger uses population standard deviation', () => {
  const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  assert.equal(b.mid[7], 5);
  assert.equal(b.upper[7], 9);
  assert.equal(b.lower[7], 1);
});

test('donchian channel excludes the current bar', () => {
  const d = donchian([1, 5, 3, 9, 2], [0, 4, 2, 8, 1], 2);
  assert.deepEqual(d.upper, [null, null, 5, 5, 9]);
  assert.deepEqual(d.lower, [null, null, 0, 2, 2]);
});
