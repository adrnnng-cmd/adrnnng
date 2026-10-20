import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, defaultParams, normaliseParams, getStrategy } from '../strategies/index.js';
import { runBacktest } from '../engine/backtest.js';
import { barsFromCloses } from './helpers.mjs';

// Deterministic pseudo-random walk so every strategy gets trades. Test fixture only.
function walk(n, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [100];
  for (let i = 1; i < n; i++) out.push(Math.max(1, out[i - 1] * (1 + (rnd() - 0.5) * 0.04 + Math.sin(i / 40) * 0.004)));
  return out;
}
const bars = barsFromCloses(walk(900), 0.8);

for (const s of STRATEGIES) {
  test(`${s.id}: declares a usable contract`, () => {
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.ok(s.name && s.summary);
    const p = defaultParams(s);
    const out = s.run(bars, p);
    assert.equal(out.target.length, bars.length);
    assert.ok(out.target.every((t) => t === null || t === 1 || t === 0 || t === -1));
    for (const o of out.overlays || []) assert.equal(o.values.length, bars.length);
    for (const pane of out.panes || []) for (const ser of pane.series) assert.equal(ser.values.length, bars.length);
    const r = runBacktest(bars, s, p, { allowShort: true });
    assert.ok(r.trades.length > 0, 'produces trades on a random walk');
  });

  test(`${s.id}: target[i] depends only on bars[0..i] (no look-ahead)`, () => {
    const p = defaultParams(s);
    const full = s.run(bars, p).target;
    for (const k of [250, 501, 777]) {
      const part = s.run(bars.slice(0, k), p).target;
      assert.deepEqual(part, full.slice(0, k), `prefix ${k}`);
    }
  });
}

test('normaliseParams clamps numbers, coerces booleans and rejects unknown options', () => {
  const s = getStrategy('td-sequential');
  const p = normaliseParams(s, { lookback: '99', perfectOnly: 'true', entry: 'nope' });
  assert.equal(p.lookback, 10);
  assert.equal(p.perfectOnly, true);
  assert.equal(p.entry, 'setup9');
  assert.equal(getStrategy('missing').id, 'td-sequential');
});
