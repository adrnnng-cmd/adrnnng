import test from 'node:test';
import assert from 'node:assert/strict';
import td, { tdSequential } from '../strategies/td-sequential.js';
import { barsFromCloses } from './helpers.mjs';

// 10 rising closes (10..19), then a steady decline of 1 per bar from 15.
const rise = Array.from({ length: 10 }, (_, i) => 10 + i);
const fall = Array.from({ length: 25 }, (_, i) => 15 - i * 1);
const closes = [...rise, ...fall];
const bars = barsFromCloses(closes, 0.25);

const indices = (arr) => arr.flatMap((v, i) => (v ? [i] : []));

test('buy setup: price flip then nine closes below the close four bars earlier', () => {
  const r = tdSequential(bars);
  // Bar 10 (close 15 < close 16 four bars back, prior bar 19 > 15) is the flip and setup bar 1.
  assert.equal(r.buySetup[9], 0);
  assert.equal(r.buySetup[10], 1);
  assert.equal(r.buySetup[18], 9);
  assert.deepEqual(indices(r.buySetupDone), [18]);
  assert.equal(r.buyPerfect[18], true);
  // Counting continues past 9 without signalling a new setup.
  assert.equal(r.buySetup[19], 10);
  // The opening rise has no bullish price flip (it starts rising from bar 0), so no sell setup.
  assert.deepEqual(indices(r.sellSetupDone), []);
});

test('TDST resistance is the highest high of the setup bars', () => {
  const r = tdSequential(bars);
  const setupHighs = bars.slice(10, 19).map((b) => b.high);
  assert.equal(r.tdstResistance[18], Math.max(...setupHighs));
});

test('countdown starts on setup bar 9 and completes 13 with the bar-8 qualifier', () => {
  const r = tdSequential(bars);
  assert.equal(r.buyCountdown[18], 1);
  assert.equal(r.buyCountdown[25], 8);
  assert.deepEqual(indices(r.buy13), [30]);
  assert.equal(r.buyCountdown[30], 13);
  assert.equal(r.buyCountdown[31], 0, 'countdown ends after 13');
});

test('without the flip requirement a setup can start on the first qualifying bar', () => {
  const flat = barsFromCloses([5, 5, 5, 5, 5, 4, 3, 2, 1, 0.5, 0.4, 0.3, 0.2, 0.1], 0.01);
  assert.equal(tdSequential(flat).buySetup[5], 0, 'needs a flip by default');
  assert.equal(tdSequential(flat, { requireFlip: false }).buySetup[5], 1);
});

test('countdown is cancelled by a close above TDST resistance', () => {
  // Same setup, then after countdown bar 3 rip above the setup high.
  const c = [...rise, ...fall.slice(0, 11), 30, 31, 32, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
  const r = tdSequential(barsFromCloses(c, 0.25));
  assert.equal(r.buyCountdown[20], 3);
  assert.deepEqual(indices(r.buy13), []);
  assert.equal(tdSequential(barsFromCloses(c, 0.25), { cancelOnTdst: false }).buy13.some(Boolean), true);
});

test('bar 13 is deferred while its low is above the close of countdown bar 8', () => {
  // Countdown 1..8 on the decline (bar 8 closes at 0), bounce, then grind lower so counts
  // 9..12 and the first 13 candidates happen above 0. Worked by hand: counts 9-12 on bars
  // 31-34, deferred on 35-38 (lows 2.75, 1.95, 1.25, 0.25), 13 on bar 39 (low -0.75).
  const c = [...rise, ...fall.slice(0, 16), 3.5, 5, 7, 7.4, 6, 5.5, 5, 4.5, 3.8, 3, 2.2, 1.5, 0.5, -0.5, -1.5];
  const b = barsFromCloses(c, 0.25);
  const r = tdSequential(b);
  assert.equal(r.buyCountdown[25], 8);
  assert.equal(b[25].close, 0);
  assert.deepEqual([31, 32, 33, 34].map((i) => r.buyCountdown[i]), [9, 10, 11, 12]);
  assert.deepEqual(indices(r.buyDeferred), [35, 36, 37, 38]);
  assert.deepEqual(indices(r.buy13), [39]);
  assert.deepEqual(indices(r.sellSetupDone), []);
});

test('strategy wrapper: buy 9 → long, sell 9 → exit/short', () => {
  const down = barsFromCloses([...rise, ...fall.slice(0, 12), ...Array.from({ length: 14 }, (_, i) => 5 + i * 1.5)], 0.25);
  const out = td.run(down, { entry: 'setup9', perfectOnly: false, lookback: 4, setupLength: 9, countdownLength: 13, cancelOnTdst: true, recycle: false });
  const longs = indices(out.target.map((t) => t === 1));
  const shorts = indices(out.target.map((t) => t === -1));
  assert.deepEqual(longs, [18]);
  assert.equal(shorts.length, 1);
  assert.ok(shorts[0] > 18);
  assert.ok(out.markers.some((m) => m.text === '9' && m.index === 18 && m.position === 'below'));
});
