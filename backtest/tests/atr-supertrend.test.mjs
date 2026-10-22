import test from 'node:test';
import assert from 'node:assert/strict';
import atrSupertrendStrategy, { atrSupertrend } from '../strategies/atr-supertrend.js';
import { defaultParams } from '../strategies/index.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Hand series. True range with these highs and lows is 2, 3, 4, 3, 5, 3, 3.
// ATR length 3, factor 1, EMA smoothing 2. Fractions are the Pine recurrence.
const bars = [
  { open: 10, high: 11, low: 9, close: 10 },
  { open: 10, high: 12, low: 9, close: 11 },
  { open: 11, high: 14, low: 10, close: 13 },
  { open: 13, high: 14, low: 11, close: 12 },
  { open: 12, high: 13, low: 8, close: 9 },
  { open: 9, high: 10, low: 7, close: 8 },
  { open: 8, high: 9, low: 6, close: 7 },
].map((b, i) => ({ ...b, volume: 1, time: `2024-01-02T09:${String(15 + i).padStart(2, '0')}:00` }));

test('ATR SuperTrend ratchets, then flips when the smoothed close crosses', () => {
  const st = atrSupertrend(bars, { atrLength: 3, factor: 1, smoothing: 2 });
  assert.deepEqual(st.trend.slice(0, 2), [null, null]);
  assert.deepEqual(st.trend.slice(2), [1, 1, 1, -1, -1]);
  assert.deepEqual(st.flip, [0, 0, 0, 0, 0, -1, 0]);
  assert.ok(near(st.smoothed[0], 10));
  assert.ok(near(st.smoothed[1], 32 / 3));
  assert.ok(near(st.smoothed[2], 110 / 9));
  assert.ok(near(st.atr[2], 3));
  assert.ok(near(st.atr[4], 11 / 3));
  assert.ok(near(st.atr[5], 31 / 9));
  // Seeded uptrend. The line does not fall while the trend holds.
  assert.ok(near(st.line[2], 83 / 9));
  assert.ok(near(st.line[3], 83 / 9));
  assert.ok(near(st.line[4], 83 / 9));
  // Bear flip resets the line to smoothed + atr, then the downtrend ratchets down.
  assert.ok(near(st.line[5], 2945 / 243));
  assert.ok(near(st.line[6], 7913 / 729));
  assert.ok(st.line[6] < st.line[5]);
});

test('the seeded bar is bullish and is not a flip', () => {
  const st = atrSupertrend(bars, { atrLength: 3, factor: 1, smoothing: 2 });
  const first = st.trend.findIndex((t) => t != null);
  assert.equal(st.trend[first], 1);
  assert.equal(st.flip[first], 0);
  assert.equal(st.atrLength, 3);
  assert.equal(st.factor, 1);
  assert.equal(st.smoothing, 2);
});

test('trend at i depends only on bars[0..i]', () => {
  const full = atrSupertrend(bars, { atrLength: 3, factor: 1, smoothing: 2 });
  for (const k of [3, 5, 6]) {
    const part = atrSupertrend(bars.slice(0, k), { atrLength: 3, factor: 1, smoothing: 2 });
    assert.deepEqual(part.trend, full.trend.slice(0, k));
    assert.deepEqual(part.line, full.line.slice(0, k));
    assert.deepEqual(part.flip, full.flip.slice(0, k));
  }
});

test('the plugin defaults are the locked Phase 1 factor and smoothing', () => {
  const p = defaultParams(atrSupertrendStrategy);
  assert.equal(p.atrLength, 10);
  assert.equal(p.factor, 2.5);
  assert.equal(p.smoothing, 2);
  const out = atrSupertrendStrategy.run(bars, p);
  assert.equal(out.target.length, bars.length);
  assert.ok(out.target.every((t) => t === null || t === 1 || t === -1));
  assert.equal(out.overlays[0].values.length, bars.length);
});
