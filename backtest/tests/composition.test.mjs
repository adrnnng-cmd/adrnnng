import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionPlan } from '../composition/session.js';
import { alignSignals } from '../composition/align.js';
import { compose } from '../composition/index.js';
import { runBacktest } from '../engine/backtest.js';
import { defaultCostPoints, RECIPES } from '../composition/recipes.js';
import { timeframeChoices, lockedSymbol } from '../symbols.js';
import { resampleMinutes } from '../engine/intraday.js';

function stamp(date, minute) {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:00`;
}

function sessionBars(date = '2024-06-03') {
  const out = [];
  for (let m = 9 * 60 + 15; m < 9 * 60 + 40; m++) {
    const px = 1000 + (m - (9 * 60 + 15));
    out.push({ time: stamp(date, m), open: px, high: px + 1, low: px - 1, close: px + 0.5, volume: 1 });
  }
  return out;
}

function signals(n, { state = 0, flipAt = -1, flip = 1, sigMin = 0 } = {}) {
  return {
    flip: Array.from({ length: n }, (_, i) => (i === flipAt ? flip : 0)),
    state: Array.from({ length: n }, () => state),
    sigMin: Array.from({ length: n }, () => sigMin),
  };
}

const window = { windowStartMin: 9 * 60 + 15, windowEndMin: 9 * 60 + 40, from: '2024-06-03', to: '2024-06-03' };

function runPoints(bars, plan) {
  return runBacktest(bars, { run: () => ({ target: plan.target }) }, {}, {
    accounting: 'points',
    allowShort: true,
    flattenAtClose: plan.flattenAtClose,
    commissionBps: 0,
    slippageBps: 0,
    costPoints: 0,
  });
}

test('clock entry fills at the clock bar open and flattens at the session close', () => {
  const bars = sessionBars();
  const clock = 9 * 60 + 30;
  const entry = signals(bars.length, { state: 1 });
  const exit = signals(bars.length);
  const plan = sessionPlan(bars, entry, exit, { ...window, entryRule: 'clock', exitRule: 'reenter', clockMin: clock, flattenEod: true });
  const at = bars.findIndex((b) => b.time.endsWith('T09:30:00'));
  assert.equal(plan.target[at - 1], 1);
  assert.equal(plan.flattenAtClose.at(-1), true);
  const result = runPoints(bars, plan);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, bars[at].open);
  assert.equal(result.trades[0].exitPrice, bars.at(-1).close);
  assert.equal(result.trades[0].reason, 'session');
  assert.equal(result.trades[0].points, bars.at(-1).close - bars[at].open);
  assert.equal(result.accounting, 'points');
});

test('flat stays out after the opposite flip; reenter takes the same direction again', () => {
  const bars = sessionBars();
  const entry = signals(bars.length);
  entry.flip[2] = 1;
  entry.flip[6] = -1;
  entry.flip[10] = 1;
  const exit = entry;
  const flat = sessionPlan(bars, entry, exit, { ...window, entryRule: 'flip', exitRule: 'flat', clockMin: 0, flattenEod: true });
  const again = sessionPlan(bars, entry, exit, { ...window, entryRule: 'flip', exitRule: 'reenter', clockMin: 0, flattenEod: true });
  const flatRun = runPoints(bars, flat);
  const againRun = runPoints(bars, again);
  assert.equal(flatRun.trades.length, 1);
  assert.equal(againRun.trades.length, 2);
  assert.equal(againRun.trades[1].side, 'long');
});

test('first flip ignores flips before the clock', () => {
  const bars = sessionBars();
  const entry = signals(bars.length);
  const early = bars.findIndex((b) => b.time.endsWith('T09:20:00'));
  const late = bars.findIndex((b) => b.time.endsWith('T09:35:00'));
  entry.flip[early] = -1;
  entry.sigMin[early] = 9 * 60 + 19;
  entry.flip[late] = 1;
  entry.sigMin[late] = 9 * 60 + 34;
  const plan = sessionPlan(bars, entry, signals(bars.length), {
    ...window,
    entryRule: 'firstFlip',
    exitRule: 'flat',
    clockMin: 9 * 60 + 30,
    flattenEod: true,
  });
  const result = runPoints(bars, plan);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, bars[late].time);
  assert.equal(result.trades[0].side, 'long');
});

test('reverse takes the new direction on the opposite flip', () => {
  const bars = sessionBars();
  const entry = signals(bars.length);
  entry.flip[2] = 1;
  entry.flip[8] = -1;
  const plan = sessionPlan(bars, entry, entry, { ...window, entryRule: 'flip', exitRule: 'reverse', clockMin: 0, flattenEod: false });
  const result = runPoints(bars, plan);
  assert.equal(result.trades[0].side, 'long');
  assert.ok(result.openTrade);
  assert.equal(result.openTrade.side, 'short');
});

test('a 5-minute flip is stamped on the next 5-minute bucket', () => {
  const bars = [];
  for (let m = 9 * 60 + 15; m < 9 * 60 + 30; m++) {
    bars.push({ time: stamp('2024-06-03', m), open: 10, high: 11, low: 9, close: 10, volume: 1 });
  }
  const five = resampleMinutes(bars, 5);
  const trend = five.map((_, i) => (i === 0 ? 1 : i === 1 ? 1 : -1));
  trend[0] = 1;
  trend[1] = -1;
  const aligned = alignSignals(bars, 1, 5, trend);
  const next = bars.findIndex((b) => b.time.endsWith('T09:25:00'));
  assert.equal(aligned.flip[next], -1);
  assert.equal(aligned.flip[next - 1], 0);
});

test('round-trip cost defaults follow the exit timeframe', () => {
  assert.equal(defaultCostPoints('5m'), 6);
  assert.equal(defaultCostPoints('1m'), 8);
  assert.equal(defaultCostPoints('30m'), 6);
  assert.equal(defaultCostPoints('1h'), 6);
  assert.equal(RECIPES.find((r) => r.id === 'fast-response').costPoints, 6);
  assert.equal(RECIPES.find((r) => r.id === 'daily-confirm').costPoints, 6);
});

test('30-minute and 1-hour bars resample from the 1-minute session tape', () => {
  const bars = [];
  for (let m = 9 * 60 + 15; m < 11 * 60; m++) {
    const px = 100 + (m - (9 * 60 + 15));
    bars.push({ time: stamp('2024-06-03', m), open: px, high: px + 2, low: px - 2, close: px + 1, volume: 1 });
  }
  const half = resampleMinutes(bars, 30);
  assert.deepEqual(half.map((b) => b.time), ['2024-06-03T09:00:00', '2024-06-03T09:30:00', '2024-06-03T10:00:00', '2024-06-03T10:30:00']);
  assert.equal(half[0].open, bars[0].open);
  assert.equal(half[0].close, bars[14].close);
  assert.equal(half[1].open, bars[15].open);
  const hour = resampleMinutes(bars, 60);
  assert.deepEqual(hour.map((b) => b.time), ['2024-06-03T09:00:00', '2024-06-03T10:00:00']);
  assert.equal(hour[0].open, bars[0].open);
  assert.equal(hour[0].close, bars[44].close);
  assert.equal(hour[1].open, bars[45].open);
  assert.equal(hour[1].close, bars.at(-1).close);
});

test('daily confirm blocks an entry when the previous daily direction disagrees', () => {
  const day = (date, dir) => {
    const bars = sessionBars(date);
    return bars.map((b) => ({ ...b, close: b.close + (dir === 1 ? 0 : 0) }));
  };
  const bars = [...sessionBars('2024-06-03'), ...sessionBars('2024-06-04')];
  let calls = [];
  const strategy = {
    id: 'stub',
    params: [],
    run(series, params) {
      calls.push({ n: series.length, atr: params.atrLength, first: series[0].time });
      const daily = !String(series[0].time).includes('T');
      const signal = series.map(() => (daily ? -1 : 1));
      return { signal, target: signal, markers: [], overlays: [] };
    },
  };
  const composed = compose({
    bars,
    strategy,
    params: { atrLength: 10, factor: 2.5, smoothing: 2 },
    spec: {
      entryTimeframe: '1m',
      exitTimeframe: '1m',
      entryRule: 'clock',
      exitRule: 'flat',
      clock: '09:30',
      confirm: 'daily',
      from: '2024-06-03',
      to: '2024-06-04',
      flattenEod: true,
    },
  });
  assert.ok(calls.some((c) => c.first === '2024-06-03'));
  const result = runBacktest(composed.bars, { run: () => composed.signal }, {}, {
    accounting: 'points',
    allowShort: true,
    flattenAtClose: composed.flattenAtClose,
  });
  assert.equal(result.trades.length, 0);
});

test('ticker timeframe policy: 1m, 5m, 30m, and 1h only for HSI futures', () => {
  const spy = timeframeChoices('SPY');
  assert.equal(spy.find((t) => t.id === '1d').disabled, false);
  assert.equal(spy.find((t) => t.id === '15m'), undefined);
  for (const id of ['1m', '5m', '30m', '1h']) {
    assert.equal(spy.find((t) => t.id === id).disabled, true, id);
    assert.match(spy.find((t) => t.id === id).reason, /1m, 5m, 30m, and 1h are only available for HSI futures/);
    assert.equal(lockedSymbol(id), 'HSImain');
  }
  const hsi = timeframeChoices('HSImain');
  assert.equal(hsi.every((t) => t.disabled === false), true);
  assert.deepEqual(hsi.filter((t) => t.intraday).map((t) => t.id), ['1m', '5m', '30m', '1h']);
  assert.equal(lockedSymbol('1d'), null);
});
