import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atrSupertrend } from '../strategies/atr-supertrend.js';
import { barDate, barMinutes, resampleMinutes } from '../engine/intraday.js';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeYear, encodeYear, objectKey } from '../../hsi-lab/engine/archive.js';
import { decodeDaily, encodeBundle, readDay } from '../../hsi-lab/engine/daily.js';
import { bundleKey, bundleKeys, gridJobs, indexToDate, validateLookup } from '../../hsi-lab/engine/grid.js';
import { computeEntryGroup, prepareDayBars, requestedRanges } from '../../hsi-lab/engine/precompute.js';
import { scoreStored } from '../../hsi-lab/engine/results.js';
import { resetLookupCache } from '../../hsi-lab/server/lookup.js';
import { buildSignals } from '../../hsi-lab/engine/signals.js';
import { simulateHsi } from '../../hsi-lab/engine/simulate.js';
import { runLab, toPublicResult } from '../../hsi-lab/engine/run.js';
import { DEFAULTS, validateInput } from '../../hsi-lab/engine/validate.js';
import { applyAuth } from '../../hsi-lab/server/auth.js';
import { handle, originAllowed } from '../../hsi-lab/server/handle.js';
import { ARCHIVE_CACHE_MS, loadBars, resetArchiveCache } from '../../hsi-lab/server/load-bars.js';
import { createLimiter } from '../../hsi-lab/server/rate-limit.js';
import { assertOutDir } from '../../scripts/pack-hsi-r2.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const F = 2.5;
const S = 2;
const BANNED = new Set(['open', 'high', 'low', 'close', 'volume', 'price', 'entryprice', 'exitprice', 'time', 'time_key', 'bars', 'bid', 'ask', 'ohlc']);

function stamp(date, mins) {
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:00`;
}

function sessionMinutes() {
  const mins = [];
  for (let m = 9 * 60 + 15; m < 12 * 60; m++) mins.push(m);
  for (let m = 13 * 60; m < 16 * 60 + 30; m++) mins.push(m);
  return mins;
}

function zigzagSeries(dates, { step = 40, period = 16, base = 18000 } = {}) {
  const bars = [];
  let i = 0;
  for (const date of dates) {
    for (const m of sessionMinutes()) {
      const phase = i % period;
      const leg = Math.floor(i / period);
      const up = phase < period / 2;
      const along = up ? phase : period - phase;
      const close = base + leg * 3 + along * step;
      const open = close - (up ? 6 : -6);
      const high = Math.max(open, close) + 1;
      const low = Math.min(open, close) - 1;
      bars.push({ time: stamp(date, m), open, high, low, close, volume: 100 + (i % 5) });
      i += 1;
    }
  }
  return bars;
}

function bar(date, mins, open, close) {
  return {
    time: stamp(date, mins),
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
  };
}

function scripted(n, flips = [], states = []) {
  const flip = new Array(n).fill(0);
  const state = new Array(n).fill(0);
  const sigMin = new Array(n).fill(-1);
  for (const [i, v, min] of flips) {
    flip[i] = v;
    sigMin[i] = min;
  }
  for (const [i, v] of states) state[i] = v;
  return { flip, state, sigMin };
}

function study(over = {}) {
  return validateInput({
    strategy: 'atr-supertrend',
    atrLength: 10,
    exitAtrLength: 10,
    factor: F,
    smoothing: S,
    entryTimeframe: 1,
    exitTimeframe: 1,
    entryRule: 'flip',
    exitRule: 'flat',
    windowStart: '09:15',
    windowEnd: '16:30',
    costs: false,
    ...over,
  });
}

// Independent transcription of the private exit-variants.mjs signal and fill loop.
function oracleSig1(b1, atr) {
  const n = b1.length;
  const date = b1.map((b) => barDate(b.time));
  const mins = b1.map((b) => barMinutes(b.time));
  const lastOfDay = new Array(n).fill(false);
  for (let j = 0; j < n; j++) if (j === n - 1 || date[j + 1] !== date[j]) lastOfDay[j] = true;
  const trend = atrSupertrend(b1, { atrLength: atr, factor: F, smoothing: S }).trend;
  const flip = new Int8Array(n);
  const state = new Int8Array(n);
  const sigMin = new Int16Array(n).fill(-1);
  for (let j = 1; j < n; j++) {
    state[j] = trend[j - 1] ?? 0;
    const t = trend[j - 1];
    const p = j > 1 ? trend[j - 2] : null;
    if (date[j] === date[j - 1] && !lastOfDay[j - 1] && t != null && p != null && t !== p) {
      flip[j] = t;
      sigMin[j] = mins[j - 1];
    }
  }
  return { flip, state, sigMin };
}

function oracleSig5(b1, atr) {
  const n = b1.length;
  const date = b1.map((b) => barDate(b.time));
  const mins = b1.map((b) => barMinutes(b.time));
  const b5 = resampleMinutes(b1, 5);
  const k5 = new Array(n);
  let k = -1;
  for (let j = 0; j < n; j++) {
    const key = `${date[j]}#${Math.floor(mins[j] / 5)}`;
    if (j === 0 || key !== `${date[j - 1]}#${Math.floor(mins[j - 1] / 5)}`) k += 1;
    k5[j] = k;
  }
  if (k + 1 !== b5.length) throw new Error('bucket mismatch');
  const b5date = b5.map((b) => barDate(b.time));
  const b5min = b5.map((b) => barMinutes(b.time));
  const b5last = b5.map((_, i) => i === b5.length - 1 || b5date[i + 1] !== b5date[i]);
  const trend = atrSupertrend(b5, { atrLength: atr, factor: F, smoothing: S }).trend;
  const flip = new Int8Array(n);
  const state = new Int8Array(n);
  const sigMin = new Int16Array(n).fill(-1);
  for (let j = 1; j < n; j++) {
    const kk = k5[j];
    if (kk === 0) continue;
    state[j] = trend[kk - 1] ?? 0;
    if (k5[j - 1] === kk - 1 && b5date[kk - 1] === date[j] && !b5last[kk - 1]) {
      const t = trend[kk - 1];
      const p = kk > 1 ? trend[kk - 2] : null;
      if (t != null && p != null && t !== p) {
        flip[j] = t;
        sigMin[j] = b5min[kk - 1];
      }
    }
  }
  return { flip, state, sigMin };
}

function oracleSim(b1, E, X, mode, clock) {
  const n = b1.length;
  const date = b1.map((b) => barDate(b.time));
  const mins = b1.map((b) => barMinutes(b.time));
  const lastOfDay = new Array(n).fill(false);
  for (let j = 0; j < n; j++) if (j === n - 1 || date[j + 1] !== date[j]) lastOfDay[j] = true;
  let pos = 0;
  let ep = 0;
  let ej = 0;
  let orig = 0;
  let done = false;
  let clockTaken = false;
  let real = 0;
  let peak = 0;
  let dd = 0;
  const tr = [];
  const days = new Set();
  const close = (j, px, r) => {
    const p = pos * (px - ep);
    real += p;
    tr.push({ p, hold: (j - ej) + (r === 'eod' ? 1 : 0) });
    pos = 0;
  };
  for (let j = 0; j < n; j++) {
    if (j === 0 || date[j] !== date[j - 1]) {
      done = false;
      clockTaken = false;
      orig = 0;
      days.add(date[j]);
    }
    const o = b1[j].open;
    if (pos !== 0 && j > ej && X.flip[j] === -pos) {
      close(j, o, 'x');
      if (mode !== 'clockRe' && mode !== 'flipAny') done = true;
    }
    if (pos === 0 && !done && !lastOfDay[j]) {
      if ((mode === 'clock' || mode === 'clockRe') && !clockTaken && mins[j] >= clock) {
        clockTaken = true;
        const s = E.state[j];
        if (s) {
          pos = s;
          ep = o;
          ej = j;
          orig = s;
        } else done = true;
      } else if (mode === 'clockRe' && orig && E.flip[j] === orig) {
        pos = orig;
        ep = o;
        ej = j;
      } else if (mode === 'firstFlip' && E.flip[j] && E.sigMin[j] >= clock) {
        pos = E.flip[j];
        ep = o;
        ej = j;
      } else if (mode === 'flipAny' && E.flip[j]) {
        pos = E.flip[j];
        ep = o;
        ej = j;
      }
    }
    if (lastOfDay[j] && pos !== 0) close(j, b1[j].close, 'eod');
    const eq = real + (pos ? pos * (b1[j].close - ep) : 0);
    if (eq > peak) peak = eq;
    if (eq - peak < dd) dd = eq - peak;
  }
  return {
    days: days.size,
    dd,
    net: real,
    points: tr.map((t) => t.p),
    holds: tr.map((t) => t.hold),
  };
}

function specFor(mode, clockMin, entryTf, exitTf, atrE, atrX) {
  const entryRule = mode === 'flipAny' ? 'flip' : mode === 'firstFlip' ? 'firstFlip' : 'clock';
  const exitRule = mode === 'clockRe' ? 'reenter' : mode === 'flipAny' ? 'reverse' : 'flat';
  const input = {
    strategy: 'atr-supertrend',
    atrLength: atrE,
    exitAtrLength: atrX,
    factor: F,
    smoothing: S,
    entryTimeframe: entryTf,
    exitTimeframe: exitTf,
    entryRule,
    exitRule,
    windowStart: '09:15',
    windowEnd: '16:30',
    costs: false,
  };
  if (entryRule !== 'flip') {
    const hh = String(Math.floor(clockMin / 60)).padStart(2, '0');
    const mm = String(clockMin % 60).padStart(2, '0');
    input.clock = `${hh}:${mm}`;
  }
  return validateInput(input);
}

test('server engine matches exit-variants.mjs on a synthetic session', () => {
  const bars = zigzagSeries(['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07']);
  const cases = [
    [1, 11, 1, 11, 'clock', 9 * 60 + 15],
    [1, 11, 1, 11, 'clock', 9 * 60 + 30],
    [1, 11, 1, 11, 'clockRe', 9 * 60 + 30],
    [1, 11, 1, 11, 'firstFlip', 9 * 60 + 15],
    [1, 11, 1, 11, 'firstFlip', 9 * 60 + 30],
    [5, 14, 5, 14, 'clock', 9 * 60 + 30],
    [5, 14, 5, 14, 'clockRe', 9 * 60 + 30],
    [5, 14, 5, 14, 'firstFlip', 9 * 60 + 15],
    [5, 14, 1, 12, 'flipAny', 0],
    [5, 14, 1, 13, 'clock', 9 * 60 + 30],
  ];
  let trades = 0;
  for (const [entryTf, atrE, exitTf, atrX, mode, clock] of cases) {
    const oracleE = entryTf === 1 ? oracleSig1(bars, atrE) : oracleSig5(bars, atrE);
    const oracleX = entryTf === exitTf && atrE === atrX ? oracleE : (exitTf === 1 ? oracleSig1(bars, atrX) : oracleSig5(bars, atrX));
    const paramsE = { atrLength: atrE, factor: F, smoothing: S };
    const paramsX = { atrLength: atrX, factor: F, smoothing: S };
    const engineE = buildSignals(bars, entryTf, paramsE);
    const engineX = entryTf === exitTf && atrE === atrX ? engineE : buildSignals(bars, exitTf, paramsX);
    assert.deepEqual(engineE.flip, [...oracleE.flip], `${mode} entry flips`);
    assert.deepEqual(engineE.state, [...oracleE.state], `${mode} entry state`);
    assert.deepEqual(engineE.sigMin, [...oracleE.sigMin], `${mode} entry sigMin`);
    assert.deepEqual(engineX.flip, [...oracleX.flip], `${mode} exit flips`);
    const oracle = oracleSim(bars, oracleE, oracleX, mode, clock);
    const raw = simulateHsi(bars, engineE, engineX, specFor(mode, clock, entryTf, exitTf, atrE, atrX));
    assert.deepEqual(raw.trades.map((t) => t.points), oracle.points, `${mode} ${entryTf}/${exitTf} points`);
    assert.deepEqual(raw.trades.map((t) => t.holdMinutes), oracle.holds, `${mode} ${entryTf}/${exitTf} hold`);
    assert.equal(raw.grossPoints, oracle.net);
    assert.equal(raw.maxDrawdownPoints, oracle.dd);
    assert.equal(raw.sessionDays, oracle.days);
    trades += raw.trades.length;
    for (let j = 0; j < bars.length; j++) {
      if (!engineE.flip[j]) continue;
      if (entryTf === 5) assert.equal(barMinutes(bars[j].time) % 5, 0, '5m fill is the first open of the bucket');
      assert.equal(barDate(bars[j].time), barDate(bars[j - 1].time));
    }
  }
  assert.ok(trades > 0, 'synthetic series produced no trades');
});

test('window flatten, clock, first flip, and reverse follow the fill rules', () => {
  const date = '2024-06-03';
  const bars = [
    bar(date, 9 * 60 + 30, 100, 101),
    bar(date, 9 * 60 + 31, 110, 112),
    bar(date, 9 * 60 + 32, 120, 130),
    bar(date, 9 * 60 + 33, 140, 150),
    bar(date, 9 * 60 + 34, 160, 170),
  ];
  const n = bars.length;
  const entry = scripted(n, [[1, 1, 9 * 60 + 30]], [[1, 1]]);
  const noExit = scripted(n);
  const window = study({ windowStart: '09:30', windowEnd: '09:33', entryRule: 'flip', clock: '09:30' });
  const held = simulateHsi(bars, entry, noExit, window);
  // Enter at the 09:31 open (110). The window's last bar is 09:32, flattened at its close (130).
  assert.deepEqual(held.trades.map((t) => t.points), [20]);
  assert.deepEqual(held.trades.map((t) => t.holdMinutes), [2]);
  assert.equal(held.equity.at(-1).points, 20);

  const clockBars = [bar(date, 9 * 60 + 30, 200, 210), bar(date, 9 * 60 + 31, 220, 230)];
  const clock = simulateHsi(
    clockBars,
    scripted(2, [], [[0, 1], [1, 1]]),
    scripted(2),
    study({ entryRule: 'clock', clock: '09:30', windowStart: '09:30', windowEnd: '09:32' }),
  );
  // State at 09:30 is long. Flatten at 09:31 close because that is the last bar inside 09:32.
  assert.equal(clock.trades.length, 1);
  assert.equal(clock.trades[0].points, 230 - 200);
  assert.equal(clock.trades[0].holdMinutes, 2);
  assert.equal(clock.trades[0].entryHour, 9);

  const flipBars = [
    bar(date, 9 * 60 + 30, 100, 100),
    bar(date, 9 * 60 + 31, 110, 110),
    bar(date, 9 * 60 + 32, 120, 120),
    bar(date, 9 * 60 + 33, 130, 130),
  ];
  const first = simulateHsi(
    flipBars,
    scripted(4, [[1, 1, 9 * 60 + 29], [2, 1, 9 * 60 + 31]]),
    scripted(4),
    study({ entryRule: 'firstFlip', clock: '09:30', windowStart: '09:15', windowEnd: '16:30' }),
  );
  // The 09:31 fill is too early: its signal bar is 09:29. The 09:32 fill qualifies.
  assert.equal(first.trades.length, 1);
  assert.equal(first.trades[0].points, 130 - 120);

  const revBars = [
    bar(date, 9 * 60 + 15, 100, 100),
    bar(date, 9 * 60 + 16, 110, 110),
    bar(date, 9 * 60 + 17, 120, 120),
    bar(date, 9 * 60 + 18, 130, 125),
    bar(date, 9 * 60 + 19, 140, 145),
    bar(date, 9 * 60 + 20, 142, 144),
    bar(date, 9 * 60 + 21, 146, 150),
  ];
  const flips = scripted(7, [[1, 1, 9 * 60 + 15], [3, -1, 9 * 60 + 17], [4, 1, 9 * 60 + 18]]);
  const flat = simulateHsi(revBars, flips, flips, study({ entryRule: 'flip', exitRule: 'flat' }));
  const same = simulateHsi(revBars, flips, flips, study({ entryRule: 'flip', exitRule: 'reenter' }));
  const rev = simulateHsi(revBars, flips, flips, study({ entryRule: 'flip', exitRule: 'reverse' }));
  assert.deepEqual(flat.trades.map((t) => t.points), [20]);
  assert.deepEqual(same.trades.map((t) => t.points), [20, 10]);
  // Long 110→130, short 130→140, long 140→150 at the session close.
  assert.deepEqual(rev.trades.map((t) => t.points), [20, -10, 10]);
  assert.deepEqual(rev.trades.map((t) => t.holdMinutes), [2, 1, 3]);

  const split = simulateHsi(
    revBars,
    scripted(7, [[1, 1, 9 * 60 + 15]]),
    scripted(7, [[3, -1, 9 * 60 + 17]]),
    study({ entryRule: 'flip', exitRule: 'reverse' }),
  );
  // The exit timeframe flipped, the entry timeframe did not, so the trade flattens and does not reverse on that bar.
  assert.deepEqual(split.trades.map((t) => t.points), [20]);
});

test('public result is points only, with the 1m and 5m cost defaults', () => {
  const bars = [
    bar('2024-06-03', 9 * 60 + 15, 54321.25, 54321.25),
    bar('2024-06-03', 9 * 60 + 16, 54331.25, 54341.25),
    bar('2024-06-03', 9 * 60 + 17, 54351.25, 54361.25),
  ];
  bars[1].volume = 424242;
  const entry = scripted(3, [[1, 1, 9 * 60 + 15]]);
  const spec = study({ costs: true, exitTimeframe: 1, entryTimeframe: 1 });
  assert.equal(spec.costPoints, 8);
  const raw = simulateHsi(bars, entry, scripted(3), spec);
  const pub = toPublicResult(raw, spec);
  const text = JSON.stringify(pub);
  assert.equal(text.includes('54321'), false);
  assert.equal(text.includes('424242'), false);
  assert.equal(text.includes('T09'), false);
  walk(pub);
  assert.equal(pub.metrics.trades, 1);
  assert.equal(pub.metrics.grossPoints, Number(raw.grossPoints.toFixed(2)));
  assert.equal(pub.metrics.netPoints, Number((raw.grossPoints - 8).toFixed(2)));
  assert.equal(study({ costs: true, exitTimeframe: 5, entryTimeframe: 5, entryRule: 'clock', clock: '09:30' }).costPoints, 6);
  assert.equal(study({ costs: false, costPoints: 8 }).costPoints, 0);

  const day2 = [
    ...bars,
    bar('2024-06-04', 9 * 60 + 15, 100, 100),
    bar('2024-06-04', 9 * 60 + 16, 110, 120),
    bar('2024-06-04', 9 * 60 + 17, 130, 140),
  ];
  const ranged = simulateHsi(
    day2,
    scripted(6, [[1, 1, 9 * 60 + 15], [4, 1, 9 * 60 + 15]]),
    scripted(6),
    study({ from: '2024-06-04', to: '2024-06-04' }),
  );
  assert.equal(ranged.trades.length, 1);
  assert.deepEqual(ranged.equity.map((p) => p.date), ['2024-06-04']);

  const auction = { time: '2024-06-03T09:14:00', open: 54321.25, high: 54321.25, low: 54321.25, close: 54321.25, volume: 424242 };
  const input = {
    strategy: 'atr-supertrend',
    atrLength: 5,
    factor: 1,
    smoothing: 1,
    entryTimeframe: 1,
    exitTimeframe: 1,
    entryRule: 'flip',
    exitRule: 'reverse',
    windowStart: '09:15',
    windowEnd: '16:30',
    costs: false,
  };
  const session = zigzagSeries(['2024-06-03'], { step: 50, period: 12, base: 20000 });
  const clean = runLab(session, input);
  const dirty = runLab([auction, ...session], input);
  assert.ok(clean.raw.trades.length > 0);
  assert.deepEqual(dirty.result, clean.result);
  const scored = JSON.stringify(clean.result);
  assert.equal(scored.includes('54321'), false);
  assert.equal(scored.includes('424242'), false);
});

test('archive round-trips a year and rejects a bad object', () => {
  const bars = [
    { time: '2024-02-28T09:15:00', open: 1.5, high: 2, low: 1, close: 1.25, volume: 10 },
    { time: '2024-02-29T16:29:00', open: 3, high: 3.5, low: 2.5, close: 3.25, volume: 4294967296 },
  ];
  const decoded = decodeYear(encodeYear(bars, 2024));
  assert.equal(decoded[0].time, bars[0].time);
  assert.equal(decoded[0].open, 1.5);
  assert.equal(decoded[1].time, '2024-02-29T16:29:00');
  assert.equal(decoded[1].close, 3.25);
  assert.equal(decoded[1].volume, 4294967295);
  assert.throws(() => decodeYear(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
  assert.throws(() => encodeYear(bars, 2023));
});

function bytesOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function kvStore(parts, { paginate = false } = {}) {
  const objects = new Map(Object.entries(parts).map(([year, bars]) => [objectKey(Number(year)), encodeYear(bars, Number(year))]));
  const gets = [];
  const lists = [];
  return {
    gets,
    lists,
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
    async get(key, type) {
      gets.push([key, type]);
      const bytes = objects.get(key);
      if (!bytes || type !== 'arrayBuffer') return null;
      return bytesOf(bytes);
    },
    async list({ cursor } = {}) {
      lists.push(cursor ?? null);
      const names = [...objects.keys()].sort();
      if (!paginate) return { keys: names.map((name) => ({ name })), list_complete: true };
      if (!cursor) return { keys: [{ name: names[0] }, { name: 'v1/1m/manifest.json' }], list_complete: false, cursor: 'next' };
      return { keys: names.slice(1).map((name) => ({ name })), list_complete: true };
    },
  };
}

function r2Store(parts) {
  const objects = new Map(Object.entries(parts).map(([year, bars]) => [objectKey(Number(year)), encodeYear(bars, Number(year))]));
  const gets = [];
  return {
    gets,
    async head() {
      return null;
    },
    async get(key, options) {
      gets.push(options);
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { async arrayBuffer() { return bytesOf(bytes); } };
    },
    async list() {
      return { objects: [...objects.keys()].sort().map((key) => ({ key })), truncated: false };
    },
  };
}

function bucket(parts, { paginate = false } = {}) {
  const objects = new Map(Object.entries(parts).map(([year, bars]) => [objectKey(Number(year)), encodeYear(bars, Number(year))]));
  const gets = [];
  return {
    gets,
    async get(key) {
      gets.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    },
    async list({ cursor } = {}) {
      const keys = [...objects.keys()].sort();
      if (!paginate) return { objects: keys.map((key) => ({ key })), truncated: false };
      if (!cursor) return { objects: [{ key: keys[0] }, { key: 'v1/1m/manifest.json' }], truncated: true, cursor: 'next' };
      return { objects: keys.slice(1).map((key) => ({ key })), truncated: false };
    },
  };
}

function post(body, origin = 'https://adrnnng.com') {
  return new Request('https://adrnnng.com/api/hsi-lab', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function resultKv(files) {
  const objects = new Map(Object.entries(files).map(([key, bundle]) => {
    const raw = bundle instanceof Uint8Array ? bundle : encodeBundle(bundle);
    return [key, gzipSync(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength))];
  }));
  const gets = [];
  return {
    gets,
    async get(key, type) {
      gets.push([key, type]);
      const bytes = objects.get(key);
      if (!bytes || type !== 'arrayBuffer') return null;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async list() {
      return { keys: [...objects.keys()].map((name) => ({ name })), list_complete: true };
    },
  };
}

test('the endpoint returns scores, rate-limits, and never echoes bars', async () => {
  resetLookupCache();
  const planted = 54321.25;
  const clock = new Date('2026-10-22T00:00:00Z');
  const bars = zigzagSeries(['2024-03-04'], { base: planted });
  const group = computeEntryGroup(prepareDayBars(bars), {
    entryTimeframe: 5,
    atrLength: 14,
    now: clock,
  });
  const key = bundleKey(5, 14, 'all');
  const store = resultKv({ [key]: group.bundle });
  const limiter = createLimiter({ limit: 5 });
  const res = await handle(post({
    entryTimeframe: 5,
    atrLength: 14,
    exitTimeframe: 5,
    exitAtrLength: 14,
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    range: '2024',
    costs: true,
    costPoints: 6,
  }), { HSI_BARS: store }, { limiter, clock });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal(text.includes(String(planted)), false);
  assert.equal(text.includes('T09'), false);
  const body = JSON.parse(text);
  walk(body);
  assert.equal(typeof body.metrics.trades, 'number');
  assert.equal(Array.isArray(body.trades), false);
  assert.equal(body.metrics.netPoints, Number((body.metrics.grossPoints - 6 * body.metrics.trades).toFixed(2)));
  assert.equal(body.params.resolution, 'daily');
  assert.ok(body.equity.length <= 250);
  assert.ok(body.equity.every((p) => p.date.startsWith('2024')));
  const custom = await handle(post({
    entryTimeframe: 5,
    atrLength: 14,
    exitTimeframe: 5,
    exitAtrLength: 14,
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    from: '2024-03-04',
    to: '2024-03-04',
    costs: true,
    costPoints: 6,
  }), { HSI_BARS: store }, { limiter, clock });
  const customBody = await custom.json();
  assert.equal(custom.status, 200);
  assert.equal(customBody.params.range, 'custom');
  assert.equal(customBody.byEntryHour.length, 0);
  assert.equal(customBody.metrics.sessionDays, body.metrics.sessionDays);
  assert.equal(JSON.stringify(customBody).includes(String(planted)), false);
  assert.deepEqual(store.gets.map((call) => call[0]), [key]);
  assert.equal(store.gets.some((call) => String(call[0]).includes('.bin')), false);

  const leaked = await handle(post({ bars: [{ close: planted }], strategy: 'atr-supertrend' }), { HSI_BARS: store }, { limiter });
  const leakedText = await leaked.text();
  assert.equal(leaked.status, 400);
  assert.equal(leakedText.includes(String(planted)), false);

  const blocked = bucket({ 2024: [bar('2024-01-02', 9 * 60 + 15, planted, planted)] });
  blocked.get = async () => { throw new Error('should not read'); };
  const foreign = await handle(post({}, 'https://evil.example'), { HSI_BARS: blocked }, { limiter: createLimiter() });
  assert.equal(foreign.status, 403);

  const local = await handle(post('{}', 'http://127.0.0.1:8788'), {}, { limiter: createLimiter() });
  assert.equal(local.status, 503);

  resetLookupCache();
  const empty = {
    async get() { return null; },
    async list() { return { keys: [], list_complete: true }; },
  };
  const vacant = await handle(post({}), { HSI_BARS: empty }, { limiter: createLimiter(), clock });
  assert.equal(vacant.status, 404);
  assert.match(await vacant.text(), /not in the archive/i);

  resetArchiveCache();
  const corrupt = {
    async get() { return { async arrayBuffer() { return new Uint8Array([9, 9, 9, 9]).buffer; } }; },
    async list() { return { objects: [{ key: 'v1/1m/2024.bin' }], truncated: false }; },
  };
  const bad = await handle(post({}), { HSI_BARS: corrupt }, { limiter: createLimiter() });
  const badText = await bad.text();
  assert.equal(bad.status, 500);
  assert.equal(badText.includes('54321'), false);
  assert.match(badText, /could not be read/i);

  const tight = createLimiter({ limit: 2 });
  const env = {};
  assert.equal((await handle(post('{}'), env, { limiter: tight })).status, 503);
  assert.equal((await handle(post('{}'), env, { limiter: tight })).status, 503);
  const limited = await handle(post('{}'), env, { limiter: tight });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));

  const huge = await handle(post('{"strategy":"atr-supertrend"' + ' '.repeat(5000) + '}'), {}, { limiter: createLimiter() });
  assert.equal(huge.status, 413);
  const typed = new Request('https://adrnnng.com/api/hsi-lab', { method: 'POST', headers: { origin: 'https://adrnnng.com' }, body: '{}' });
  assert.equal((await handle(typed, {}, { limiter: createLimiter() })).status, 415);
  assert.equal((await handle(new Request('https://adrnnng.com/api/hsi-lab', { method: 'PUT' }), {})).status, 405);

  const described = await handle(new Request('https://adrnnng.com/api/hsi-lab'));
  const registry = await described.json();
  assert.equal(registry.strategies[0].id, 'atr-supertrend');
  assert.equal(registry.defaults.atrLength, 14);
  assert.equal(registry.defaults.range, 'all');
  assert.ok(registry.grid.atrLengths.includes(10));
  assert.ok(registry.grid.ranges.includes('all'));
  assert.ok(registry.grid.ranges.includes('2020'));
  assert.equal(registry.grid.dateStart, '2020-01-02');
  assert.equal(registry.grid.resolution, 'daily');
  walk(registry);
});

test('KV is the default read and a decoded year is not fetched again', async () => {
  resetArchiveCache();
  const day = zigzagSeries(['2024-03-04'], { base: 18000 });
  const timed = kvStore({ 2024: day });
  const spec = validateInput({ from: '2024-03-04', to: '2024-03-04' });
  const t0 = 1_700_000_000_000;
  await loadBars(timed, spec, t0);
  const warm = timed.gets.length;
  await loadBars(timed, spec, t0 + ARCHIVE_CACHE_MS - 1);
  assert.equal(timed.gets.length, warm);
  await loadBars(timed, spec, t0 + ARCHIVE_CACHE_MS);
  assert.ok(timed.gets.length > warm);

  resetArchiveCache();
  const r2 = r2Store({ 2024: day });
  const bars = await loadBars(r2, spec, t0);
  assert.equal(bars.length, day.length);
  assert.ok(r2.gets.length > 0);
  assert.ok(r2.gets.every((options) => options === undefined));
});

test('auth is one hook and the route does not publish bars', async () => {
  assert.equal(originAllowed('https://adrnnng.com'), true);
  assert.equal(originAllowed('https://preview.adrnnng.pages.dev'), true);
  assert.equal(originAllowed('https://evil.example'), false);
  let next = 0;
  const allowed = await applyAuth({ next: () => { next += 1; return new Response('ok'); } });
  assert.equal(next, 1);
  assert.equal(await allowed.text(), 'ok');
  const denied = await applyAuth(
    { next: () => { throw new Error('should not run'); } },
    async () => new Response('no', { status: 401 }),
  );
  assert.equal(denied.status, 401);

  const { onRequest } = await import('../../functions/api/hsi-lab/_middleware.js');
  let passed = false;
  const through = await onRequest({ next: () => { passed = true; return new Response('next'); } });
  assert.equal(passed, true);
  assert.equal(await through.text(), 'next');

  const { onRequest: route } = await import('../../functions/api/hsi-lab/index.js');
  const missing = await route({ request: post('{}'), env: {} });
  assert.equal(missing.status, 503);

  const names = walkFiles(join(root, 'functions')).map((p) => p.slice(root.length));
  assert.equal(names.some((p) => /bars/i.test(p)), false);
  const app = readFileSync(join(root, 'hsi-lab/app.js'), 'utf8');
  assert.match(app, /\/api\/hsi-lab/);
  assert.doesNotMatch(app, /\/api\/bars|loadLocalBars|HSI_BARS/);
  const html = readFileSync(join(root, 'hsi-lab/index.html'), 'utf8');
  assert.match(html, /id="atr-length"[\s\S]*value="14" selected/);
  assert.match(html, /Factor <b>2\.5<\/b>/);
  assert.match(html, /value="reenter" selected/);
  assert.match(html, /id="range"/);
  assert.match(html, /id="range-mode"/);
  assert.match(html, /data-mode="custom"/);
  assert.match(html, /id="from"[^>]*type="date"/);
  assert.match(html, /min="2020-01-02"/);
  assert.match(html, /No risk-free rate/);
  assert.match(app, /No risk-free rate/);
  assert.match(app, /daily resolution/);
  assert.match(html, /data-site-header/);
  assert.match(html, /\/assets\/js\/site\.js/);
});

test('pack script writes year objects outside the repo and prints no prices', () => {
  assert.throws(() => assertOutDir(join(root, 'hsi-r2')), /Refusing/);
  const dir = mkdtempSync(join(tmpdir(), 'hsi-pack-'));
  const csv = join(dir, 'in.csv');
  const price = '54321.25';
  writeFileSync(csv, [
    'time_key,open,high,low,close,volume',
    `2024-03-04 09:14:00,${price},54322,54320,54321.5,5`,
    '2024-03-04 09:15:00,18000,18010,17990,18008,15',
    '2024-03-04 09:16:00,18008,18012,18000,18001,9',
    '2025-01-02 09:15:00,19000,19001,18999,19000.5,3',
  ].join('\n'));
  const out = join(dir, 'r2');
  const packed = spawnSync('node', ['scripts/pack-hsi-r2.mjs', '--data', csv, '--out', out], { encoding: 'utf8', cwd: root });
  assert.equal(packed.status, 0, packed.stderr);
  assert.equal(packed.stdout.includes(price), false);
  assert.equal(packed.stdout.includes('18000'), false);
  const manifest = JSON.parse(readFileSync(join(out, 'v1/1m/manifest.json'), 'utf8'));
  assert.equal(JSON.stringify(manifest).includes(price), false);
  assert.deepEqual(manifest.objects.map((o) => o.key), ['v1/1m/2024.bin', 'v1/1m/2025.bin']);
  const year = decodeYear(readFileSync(join(out, 'v1/1m/2024.bin')));
  assert.equal(year[0].open, 54321.25);
  assert.equal(year[1].time, '2024-03-04T09:15:00');
  const refused = spawnSync('node', ['scripts/pack-hsi-r2.mjs', '--data', csv, '--out', join(root, 'hsi-lab')], { encoding: 'utf8', cwd: root });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing/);
  assert.equal(existsSync(join(root, 'hsi-lab/v1')), false);
});

test('input bounds reject a timeframe, a clock outside the window, and a wide range', () => {
  assert.throws(() => study({ entryTimeframe: 15 }), /1m or 5m/);
  assert.throws(() => study({ atrLength: 1 }), /ATR length/);
  assert.throws(() => study({ factor: 40 }), /Factor/);
  assert.throws(() => study({ windowStart: '08:00', windowEnd: '09:00' }), /day session/);
  assert.throws(() => study({ entryRule: 'clock', clock: '09:00' }), /Clock/);
  assert.throws(() => study({ entryRule: 'clock', clock: '15:00', windowStart: '09:30', windowEnd: '11:00' }), /inside the trading window/);
  assert.throws(() => study({ from: '2000-01-01', to: '2024-01-01' }), /10 years/);
  assert.throws(() => study({ from: '2024-01-02' }), /both dates/);
  assert.equal(validateInput({}).strategy, 'atr-supertrend');
  assert.equal(validateInput({}).exitRule, 'reenter');
  const clock = new Date('2026-10-22T00:00:00Z');
  assert.throws(() => validateLookup({ atrLength: 8 }, clock), /ATR length/);
  assert.throws(() => validateLookup({ factor: 2.5 }, clock), /Unknown field/);
  assert.throws(() => validateLookup({ entryTimeframe: 5, exitTimeframe: 5, atrLength: 14, exitAtrLength: 10 }, clock), /one ATR/);
  assert.throws(() => validateLookup({ range: '2019' }, clock), /Range/);
  assert.equal(validateLookup({ range: '2024' }, clock).key, 'v1/results/5m-14/all.json.gz');
  assert.equal(validateLookup({ range: '2024' }, clock).from, '2024-01-01');
  assert.equal(validateLookup({ range: '2024' }, clock).to, '2024-12-31');
  assert.equal(validateLookup({ range: '2020' }, clock).from, '2020-01-02');
  assert.equal(validateLookup({ range: '2026' }, clock).to, '2026-10-22');
  assert.equal(validateLookup({}, clock).from, '2020-01-02');
  assert.equal(validateLookup({ from: '2024-03-01', to: '2024-03-31' }, clock).range, 'custom');
  assert.throws(() => validateLookup({ from: '2020-01-01', to: '2020-02-01' }, clock), /2020-01-02/);
  assert.throws(() => validateLookup({ from: '2026-10-23', to: '2026-10-23' }, clock), /2020-01-02/);
  assert.throws(() => validateLookup({ from: '2024-05-02', to: '2024-05-01' }, clock), /start date/);
  assert.throws(() => validateLookup({ range: '2024', from: '2024-01-02', to: '2024-02-01' }, clock), /not both/);
  assert.throws(() => validateLookup({ to: '2024-02-01' }, clock), /start and an end/);
  assert.equal(gridJobs().length, 900);
  assert.ok(gridJobs().filter((job) => job.entryTimeframe === job.exitTimeframe).every((job) => job.atrLength === job.exitAtrLength));
  const years = requestedRanges([], clock);
  assert.deepEqual(years, ['2020', '2021', '2022', '2023', '2024', '2025', '2026', 'all']);
  assert.equal(bundleKeys().length, 10);
  assert.ok(bundleKeys().length <= 150);
  assert.deepEqual(requestedRanges(['2026'], clock), ['2026', 'all']);
});

test('a precomputed year matches a direct run and costs are applied on lookup', () => {
  const clock = new Date('2026-10-22T00:00:00Z');
  const bars = zigzagSeries(['2023-12-28', '2024-03-04', '2024-03-05'], { base: 18000 });
  const day = prepareDayBars(bars);
  const group = computeEntryGroup(day, { entryTimeframe: 5, atrLength: 14, now: clock });
  const decoded = decodeDaily(encodeBundle(group.bundle));
  const combo = '5:14:clock:09:30:reenter';
  const direct = runLab(bars, {
    atrLength: 14,
    exitAtrLength: 14,
    factor: 2.5,
    smoothing: 2,
    entryTimeframe: 5,
    exitTimeframe: 5,
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    from: '2024-03-04',
    to: '2024-12-31',
    windowStart: '09:15',
    windowEnd: '16:30',
    costs: true,
    costPoints: 6,
  });
  const looked = validateLookup({
    entryTimeframe: 5,
    atrLength: 14,
    exitTimeframe: 5,
    exitAtrLength: 14,
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    range: '2024',
    costs: true,
    costPoints: 6,
  }, clock);
  const pub = scoreStored(decoded, looked);
  assert.equal(pub.metrics.trades, direct.result.metrics.trades);
  assert.equal(pub.metrics.grossPoints, direct.result.metrics.grossPoints);
  assert.equal(pub.metrics.sessionDays, direct.result.metrics.sessionDays);
  assert.equal(pub.metrics.netPoints, direct.result.metrics.netPoints);
  assert.equal(pub.metrics.winRate, direct.result.metrics.winRate);
  assert.equal(pub.metrics.avgHoldMinutes, direct.result.metrics.avgHoldMinutes);
  assert.equal(pub.params.resolution, 'daily');
  assert.ok(pub.equity.length <= 250);
  assert.ok(pub.equity.every((point) => point.date.startsWith('2024')));
  assert.equal(JSON.stringify(pub).includes('18000'), false);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (let i = 0; i < decoded.days.length; i++) {
    if (!indexToDate(decoded.days[i]).startsWith('2024')) continue;
    const row = readDay(decoded, combo, i);
    cum += row.g;
    if (cum > peak) peak = cum;
    if (cum - peak < dd) dd = cum - peak;
    assert.equal(typeof row.mn, 'number');
  }
  const gross = scoreStored(decoded, { ...looked, costs: false, costPoints: 0 });
  assert.equal(gross.metrics.maxDrawdownPoints, Number(dd.toFixed(2)));
  assert.ok(gross.byEntryHour.length > 0);
  const both = scoreStored(decoded, validateLookup({
    entryTimeframe: 5,
    atrLength: 14,
    exitTimeframe: 5,
    exitAtrLength: 14,
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    from: '2024-03-04',
    to: '2024-03-05',
    costs: true,
    costPoints: 6,
  }, clock));
  assert.equal(both.metrics.trades, pub.metrics.trades);
  assert.equal(both.metrics.netPoints, pub.metrics.netPoints);
  assert.equal(both.byEntryHour.length, 0);
  const one = scoreStored(decoded, validateLookup({
    entryTimeframe: 5,
    atrLength: 14,
    exitTimeframe: 5,
    exitAtrLength: 14,
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    from: '2024-03-05',
    to: '2024-03-05',
    costs: false,
  }, clock));
  assert.equal(one.metrics.sessionDays, 1);
  assert.ok(one.metrics.trades <= pub.metrics.trades);
  const stored = readDay(decoded, combo, 0);
  const again = readDay(decodeDaily(encodeBundle(group.bundle)), combo, 0);
  assert.equal(again.g, stored.g);
  assert.equal(again.mn, stored.mn);
  assert.equal(again.t, stored.t);
  const nets = [];
  for (let i = 0; i < decoded.days.length; i++) {
    if (!indexToDate(decoded.days[i]).startsWith('2024')) continue;
    const row = readDay(decoded, combo, i);
    nets.push(row.g - 6 * row.t);
  }
  assert.equal(pub.metrics.sharpe, sampleSharpe(nets));
});

function sampleSharpe(nets) {
  if (nets.length < 2) return null;
  const mean = nets.reduce((sum, value) => sum + value, 0) / nets.length;
  const variance = nets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (nets.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return Number(((mean / sd) * Math.sqrt(252)).toFixed(4));
}

function dailyBundle(days, gross, trades) {
  const row = {
    g: gross,
    t: trades,
    w: gross.map((points, i) => (points > 0 ? trades[i] : 0)),
    gw: gross.map((points) => (points > 0 ? points : 0)),
    gl: gross.map((points) => (points < 0 ? -points : 0)),
    h: trades.map((count) => count * 10),
    mn: gross.map((points) => Math.min(0, points)),
    hours: { all: [], years: {} },
  };
  return {
    entryTimeframe: 5,
    atrLength: 14,
    days,
    rows: { '5:14:clock:09:30:reenter': row },
  };
}

test('sharpe counts flat sessions and is net of the chosen cost', () => {
  const clock = new Date('2026-10-22T00:00:00Z');
  const days = ['2024-03-04', '2024-03-05', '2024-03-06'];
  const decoded = decodeDaily(encodeBundle(dailyBundle(days, [10, 0, -4], [1, 0, 1])));
  const spec = {
    entryTimeframe: 5,
    atrLength: 14,
    exitTimeframe: 5,
    exitAtrLength: 14,
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    from: '2024-03-04',
    to: '2024-03-06',
    costs: true,
    costPoints: 6,
  };
  const pub = scoreStored(decoded, validateLookup(spec, clock));
  assert.equal(pub.metrics.sessionDays, 3);
  assert.equal(pub.metrics.trades, 2);
  assert.equal(pub.metrics.sharpe, sampleSharpe([4, 0, -10]));
  assert.notEqual(pub.metrics.sharpe, sampleSharpe([4, -10]));
  const one = scoreStored(decoded, validateLookup({ ...spec, from: '2024-03-05', to: '2024-03-05' }, clock));
  assert.equal(one.metrics.sessionDays, 1);
  assert.equal(one.metrics.sharpe, null);
  const flat = decodeDaily(encodeBundle(dailyBundle(days.slice(0, 2), [0, 0], [0, 0])));
  const flatScore = scoreStored(flat, validateLookup({ ...spec, to: '2024-03-05', costs: false }, clock));
  assert.equal(flatScore.metrics.sharpe, null);
  assert.equal(JSON.stringify(pub).includes('18000'), false);
});

function weekdayDates(from, to) {
  const days = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end) {
    const date = new Date(t);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(date.toISOString().slice(0, 10));
    t += 86400000;
  }
  return days;
}

function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    return x;
  };
}

test('one lookup stays fast on a realistic bundle', async () => {
  resetLookupCache();
  const days = weekdayDates('2020-01-02', '2026-10-22');
  assert.ok(days.length > 1500, `sessions ${days.length}`);
  const rnd = lcg(7);
  const rows = {};
  for (let c = 0; c < 90; c++) {
    const g = new Array(days.length);
    const t = new Array(days.length);
    const w = new Array(days.length);
    const gw = new Array(days.length);
    const gl = new Array(days.length);
    const h = new Array(days.length);
    const mn = new Array(days.length);
    let trades = 0;
    let wins = 0;
    let gross = 0;
    for (let i = 0; i < days.length; i++) {
      const roll = rnd();
      const tradesToday = roll % 7 === 0 ? 0 : 1 + (roll % 3);
      const points = tradesToday ? (roll % 800) - 400 : 0;
      g[i] = points;
      t[i] = tradesToday;
      w[i] = points > 0 ? Math.min(tradesToday, 1) : 0;
      gw[i] = points > 0 ? points : 0;
      gl[i] = points < 0 ? -points : 0;
      h[i] = tradesToday * 20;
      mn[i] = Math.min(0, points);
      trades += tradesToday;
      if (points > 0) wins += 1;
      gross += points;
    }
    rows[`x:${c}:flip:-:flat`] = {
      g, t, w, gw, gl, h, mn,
      hours: { all: [[9, trades, wins, gross]], years: { 2024: [[9, 40, 20, 100]] } },
    };
  }
  rows['5:14:clock:09:30:reenter'] = rows['x:0:flip:-:flat'];
  const encoded = encodeBundle({ entryTimeframe: 5, atrLength: 14, days, rows });
  const gz = gzipSync(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength));
  assert.ok(gz.length < 25 * 1024 * 1024, `one bundle is ${gz.length} bytes`);
  assert.equal(bundleKeys().length, 10);
  const store = resultKv({ 'v1/results/5m-14/all.json.gz': encoded });
  const clock = new Date('2026-10-22T00:00:00Z');
  const started = performance.now();
  const res = await handle(post({}), { HSI_BARS: store }, { limiter: createLimiter(), clock });
  const elapsed = performance.now() - started;
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(elapsed < 80, `lookup took ${elapsed.toFixed(1)}ms`);
  const body = JSON.parse(text);
  walk(body);
  assert.equal(body.metrics.netPoints, Number((body.metrics.grossPoints - body.params.costPoints * body.metrics.trades).toFixed(2)));
  assert.ok(body.equity.length <= 250);
  assert.ok(body.equity.length > 1);
  assert.equal(body.params.from, '2020-01-02');
  assert.equal(body.params.to, '2026-10-22');
  assert.equal(typeof body.metrics.sharpe, 'number');
  const reads = store.gets.length;
  const warmStart = performance.now();
  const again = await handle(post({}), { HSI_BARS: store }, { limiter: createLimiter(), clock });
  const warm = performance.now() - warmStart;
  assert.equal(again.status, 200);
  assert.ok(warm < 10, `warm lookup took ${warm.toFixed(1)}ms`);
  assert.equal(store.gets.length, reads);
  const custom = await handle(post({ from: '2024-06-03', to: '2024-06-28' }), { HSI_BARS: store }, { limiter: createLimiter(), clock });
  assert.equal(custom.status, 200);
  assert.equal(store.gets.length, reads);
  const sliced = await custom.json();
  assert.equal(sliced.params.range, 'custom');
  assert.equal(sliced.byEntryHour.length, 0);
  assert.ok(sliced.metrics.sessionDays < body.metrics.sessionDays);
  assert.ok(sliced.metrics.sessionDays > 0);
});

test('year bins above the spread limit still concatenate', async () => {
  resetArchiveCache();
  const count = 240000;
  const bars = new Array(count);
  let t = Date.parse('2024-01-02T00:00:00Z');
  for (let i = 0; i < count; i++) {
    bars[i] = { time: new Date(t).toISOString().slice(0, 19), open: 1, high: 1, low: 1, close: 1, volume: 1 };
    t += 60000;
  }
  const store = bucket({ 2024: bars, 2023: [bar('2023-01-03', 9 * 60 + 15, 1, 1)] });
  const spec = validateInput({ from: '2024-01-02', to: '2024-12-31' });
  const loaded = await loadBars(store, spec);
  assert.equal(loaded.length, count + 1);
});

test('precompute script writes result keys with worker threads and no prices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hsi-pre-'));
  const csv = join(dir, 'in.csv');
  const price = '54321.25';
  writeFileSync(csv, [
    'time_key,open,high,low,close,volume',
    `2024-03-04 09:15:00,${price},54330,54310,54320,5`,
    '2024-03-04 09:16:00,54320,54340,54315,54328,6',
    '2026-01-05 09:15:00,19000,19010,18990,19002,4',
    '2026-01-05 09:16:00,19002,19020,18995,19008,4',
  ].join('\n'));
  const out = join(dir, 'results');
  const packed = spawnSync('node', ['scripts/hsi-lab-precompute.mjs', '--data', csv, '--out', out, '--years', '2026', '--threads', '2'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.equal(packed.status, 0, packed.stderr);
  assert.equal(packed.stdout.includes(price), false);
  assert.equal(packed.stdout.includes('19000'), false);
  const manifest = JSON.parse(readFileSync(join(out, 'v1/results/manifest.json'), 'utf8'));
  assert.equal(manifest.namespaceId, 'f6577e29d4b249dea5a81b4f00443082');
  assert.equal(manifest.version, 2);
  assert.equal(JSON.stringify(manifest).includes(price), false);
  assert.ok(manifest.keys.includes('v1/results/5m-14/all.json.gz'));
  assert.equal(manifest.keys.some((key) => key.includes('/2026.json.gz')), false);
  assert.equal(manifest.keys.some((key) => key.includes('/2024.json.gz')), false);
  assert.equal(manifest.keys.length, 10);
  assert.ok(manifest.keys.every((key) => key.endsWith('/all.json.gz')));
  assert.ok(manifest.totalBytes > 0);
  assert.ok(manifest.totalBytes < 25 * 1024 * 1024 * 10);
  const saved = gunzipSync(readFileSync(join(out, 'v1/results/5m-14/all.json.gz')));
  assert.equal(saved.includes(Buffer.from(price)), false);
  const decoded = decodeDaily(saved);
  assert.equal(decoded.days.length, 2);
  assert.equal(decoded.combos.size, 90);
  const refused = spawnSync('node', ['scripts/hsi-lab-precompute.mjs', '--data', csv, '--out', join(root, 'hsi-lab'), '--years', '2026', '--threads', '1'], {
    encoding: 'utf8',
    cwd: root,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing/);
});

function walk(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(BANNED.has(key.toLowerCase()), false, `${path}${key}`);
    walk(child, `${path}${key}.`);
  }
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}
