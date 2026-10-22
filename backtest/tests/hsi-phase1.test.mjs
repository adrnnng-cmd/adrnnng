import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterDaySession, inDaySession, resampleMinutes } from '../engine/intraday.js';
import { loadLocalBars, normaliseTimeKey, parseIntradayCsv } from '../providers/local-bars.js';
import {
  ENTRY_ARMS,
  PHASE1_MATRIX,
  phase2Adjustment,
  phase2CostHook,
  runMatrix,
  simulatePhase1,
  summaryCsv,
} from '../runners/phase1.js';

const arm = (id) => ENTRY_ARMS.find((a) => a.id === id);
const root = fileURLToPath(new URL('../..', import.meta.url));

function b(time, open, close, high, low) {
  return {
    time,
    open,
    high: high ?? Math.max(open, close) + 1,
    low: low ?? Math.min(open, close) - 1,
    close,
    volume: 1,
  };
}

test('day session keeps the regular open and drops auction, lunch, and T+1', () => {
  const bars = [
    b('2024-01-02T09:14:00', 10, 10),
    b('2024-01-02T09:15:00', 10, 11),
    b('2024-01-02T11:59:00', 11, 12),
    b('2024-01-02T12:00:00', 12, 12),
    b('2024-01-02T12:30:00', 12, 12),
    b('2024-01-02T12:59:00', 12, 12),
    b('2024-01-02T13:00:00', 12, 13),
    b('2024-01-02T16:29:00', 13, 14),
    b('2024-01-02T16:30:00', 14, 14),
    b('2024-01-02T17:15:00', 14, 15),
    b('2024-01-03T02:59:00', 15, 15),
  ];
  const kept = filterDaySession(bars).map((x) => x.time);
  assert.deepEqual(kept, [
    '2024-01-02T09:15:00',
    '2024-01-02T11:59:00',
    '2024-01-02T13:00:00',
    '2024-01-02T16:29:00',
  ]);
  assert.equal(inDaySession('2024-01-02'), false);
});

test('5m resample is clock-aligned and does not cross lunch', () => {
  const bars = [];
  for (let m = 15; m <= 19; m++) bars.push(b(`2024-01-02T09:${m}:00`, 100 + m, 101 + m));
  bars.push(b('2024-01-02T11:58:00', 130, 131));
  bars.push(b('2024-01-02T11:59:00', 131, 132));
  bars.push(b('2024-01-02T13:00:00', 140, 141));
  bars.push(b('2024-01-02T13:01:00', 141, 142));
  for (let m = 25; m <= 29; m++) bars.push(b(`2024-01-02T16:${m}:00`, 150, 151));
  const out = resampleMinutes(bars, 5);
  assert.deepEqual(out.map((x) => x.time), [
    '2024-01-02T09:15:00',
    '2024-01-02T11:55:00',
    '2024-01-02T13:00:00',
    '2024-01-02T16:25:00',
  ]);
  assert.equal(out[0].open, bars[0].open);
  assert.equal(out[0].close, bars[4].close);
  assert.equal(out[0].volume, 5);
  assert.equal(out[1].open, 130);
  assert.equal(out[1].close, 132);
  assert.equal(out[3].volume, 5);
});

// Two-day trace. Day 1 only defines the trend. Day 2 is the position.
// A-S buys the 09:15 open. The 09:20 flip fills short at the 09:30 open.
const traced = [
  b('2024-01-02T09:15:00', 100, 101),
  b('2024-01-02T09:16:00', 101, 102),
  b('2024-01-02T16:29:00', 102, 103),
  b('2024-01-03T09:15:00', 140, 141),
  b('2024-01-03T09:16:00', 141, 150),
  b('2024-01-03T09:20:00', 150, 149),
  b('2024-01-03T09:30:00', 170, 160),
  b('2024-01-03T11:59:00', 160, 158),
  b('2024-01-03T13:00:00', 150, 148),
  b('2024-01-03T16:29:00', 148, 140),
];
const tracedTrend = [1, 1, 1, 1, 1, -1, -1, -1, -1, -1];

test('A-S enters on the trend at 09:15, follows the flip, and flattens at the close', () => {
  const sim = simulatePhase1(traced, tracedTrend, arm('A-S'));
  // Long 140 → 170 (+30), short 170 → 140 (+30).
  assert.equal(sim.metrics.totalPoints, 60);
  assert.equal(sim.trades.length, 2);
  const [long, short] = sim.trades;
  assert.equal(long.side, 'long');
  assert.equal(long.entryTime, '2024-01-03T09:15:00');
  assert.equal(long.entryPrice, 140);
  assert.equal(long.exitTime, '2024-01-03T09:30:00');
  assert.equal(long.exitPrice, 170);
  assert.equal(long.points, 30);
  assert.equal(long.reason, 'flip');
  assert.equal(short.side, 'short');
  assert.equal(short.entryPrice, 170);
  assert.equal(short.exitTime, '2024-01-03T16:29:00');
  assert.equal(short.exitPrice, 140);
  assert.equal(short.points, 30);
  assert.equal(short.reason, 'eod');
  assert.ok(sim.trades.every((t) => t.entryTime.slice(0, 10) === t.exitTime.slice(0, 10)));
  // Still short through the lunch gap. The 13:00 bar is not an exit.
  const atLunch = sim.equity.find((p) => p.time === '2024-01-03T13:00:00');
  assert.equal(atLunch.position, -1);
  assert.equal(sim.equity.at(-1).position, 0);
  assert.equal(sim.equity.at(-1).equityPoints, 60);
  assert.equal(sim.metrics.costsApplied, false);
  assert.equal(sim.metrics.netPoints, sim.metrics.totalPoints);
  assert.equal(sim.metrics.long.totalPoints, 30);
  assert.equal(sim.metrics.short.totalPoints, 30);
  assert.equal(sim.metrics.winRate, 1);
});

test('flip arms wait for a cross; B-S takes the 09:30 state; control matches A-F inside the session', () => {
  const aF = simulatePhase1(traced, tracedTrend, arm('A-F'));
  const control = simulatePhase1(traced, tracedTrend, arm('control'));
  const bS = simulatePhase1(traced, tracedTrend, arm('B-S'));
  const bF = simulatePhase1(traced, tracedTrend, arm('B-F'));
  // The only flip is 09:20. A-F and control both short at the 09:30 open and cover at 140.
  assert.equal(aF.metrics.totalPoints, 30);
  assert.equal(control.metrics.totalPoints, 30);
  assert.equal(aF.trades.length, 1);
  assert.equal(aF.trades[0].side, 'short');
  assert.equal(aF.trades[0].entryPrice, 170);
  assert.equal(aF.trades[0].points, 30);
  // Day 1 has no 09:30 bar, so B-S takes the first later bar (16:29) and flattens at that close (+1).
  // Day 2 enters short at the 09:30 open, which is the trend after the 09:20 flip (+30).
  assert.equal(bS.trades.length, 2);
  assert.equal(bS.trades[0].entryTime, '2024-01-02T16:29:00');
  assert.equal(bS.trades[0].points, 1);
  assert.equal(bS.trades[1].entryTime, '2024-01-03T09:30:00');
  assert.equal(bS.trades[1].side, 'short');
  assert.equal(bS.trades[1].entryPrice, 170);
  assert.equal(bS.metrics.totalPoints, 31);
  // That flip is before 09:30, so B-F never enters.
  assert.equal(bF.trades.length, 0);
  assert.equal(bF.metrics.totalPoints, 0);
  assert.equal(bF.metrics.winRate, null);
});

test('control can take a pre-09:15 flip that A-F ignores', () => {
  const bars = [
    b('2024-01-03T09:00:00', 100, 100),
    b('2024-01-03T09:10:00', 100, 95),
    b('2024-01-03T09:15:00', 90, 88),
    b('2024-01-03T16:29:00', 85, 80),
  ];
  const trend = [1, -1, -1, -1];
  const control = simulatePhase1(bars, trend, arm('control'));
  const aF = simulatePhase1(bars, trend, arm('A-F'));
  assert.equal(control.trades.length, 1);
  assert.equal(control.trades[0].entryTime, '2024-01-03T09:15:00');
  assert.equal(control.trades[0].entryPrice, 90);
  assert.equal(control.trades[0].points, 10);
  assert.equal(aF.trades.length, 0);
});

test('a flip on the last bar does not open a position, and the prior position flattens at the close', () => {
  const bars = [
    b('2024-01-02T16:29:00', 100, 100),
    b('2024-01-03T09:15:00', 110, 112),
    b('2024-01-03T16:29:00', 112, 90),
  ];
  const trend = [1, 1, -1];
  const sim = simulatePhase1(bars, trend, arm('A-S'));
  assert.equal(sim.trades.length, 1);
  assert.equal(sim.trades[0].side, 'long');
  assert.equal(sim.trades[0].exitPrice, 90);
  assert.equal(sim.trades[0].reason, 'eod');
  assert.equal(sim.metrics.totalPoints, -20);
  assert.ok(sim.metrics.maxDrawdownPoints <= 0);
});

test('Sharpe is computed on daily point returns', () => {
  const bars = [
    b('2024-01-02T09:15:00', 100, 100),
    b('2024-01-02T16:29:00', 100, 110),
    b('2024-01-03T09:15:00', 110, 110),
    b('2024-01-03T16:29:00', 110, 110),
  ];
  const trend = [1, 1, 1, 1];
  const sim = simulatePhase1(bars, trend, arm('A-S'));
  // Day 1 has no prior trend, so no trade. Day 2: long 110 → 110, zero points.
  // Force a known curve by using B-S, whose first bar at/after 09:30 on day 1 is the close.
  const bS = simulatePhase1(bars, trend, arm('B-S'));
  // Day 1 enters at 16:29 open 100 and flattens at 110: +10. Day 2: 110 → 110: 0.
  assert.equal(bS.metrics.totalPoints, 10);
  assert.equal(bS.metrics.days, 2);
  const rets = [10 / 100, 0];
  const mean = (rets[0] + rets[1]) / 2;
  const sd = Math.sqrt(((rets[0] - mean) ** 2 + (rets[1] - mean) ** 2) / 1);
  assert.equal(bS.metrics.sharpe, (mean / sd) * Math.sqrt(252));
  assert.equal(sim.metrics.totalPoints, 0);
});

test('Phase 2 hook is inert until enabled, and the adjustment is a pure quote', () => {
  const off = phase2CostHook(25, { tradeCount: 2, fillCount: 4 });
  assert.equal(off.costsApplied, false);
  assert.equal(off.netPoints, 25);
  const quote = phase2Adjustment(25, { tradeCount: 2, fillCount: 4 }, {
    pointValueHkd: 10,
    commissionRoundTurnHkd: 40,
    slippagePointsPerSide: 0.5,
  });
  // 2 round turns * 40 HKD / 10 = 8 points. 4 sides * 0.5 = 2 points.
  assert.equal(quote.commissionPoints, 8);
  assert.equal(quote.slippagePoints, 2);
  assert.equal(quote.netPoints, 15);
});

test('local CSV keeps the last duplicate and treats naive stamps as Hong Kong time', () => {
  const text = [
    'time_key,open,high,low,close,volume,turnover',
    '"2024-01-02 09:14:00",10,11,9,10,1,0',
    '2024-01-02T01:15:00Z,10,12,9,11,2,0',
    '2024-01-02 09:15:00,10,13,9,12,4,0',
    'bad,0,0,0,0,0,0',
  ].join('\n');
  const { bars, skipped } = parseIntradayCsv(text);
  assert.equal(skipped, 1);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].time, '2024-01-02T09:14:00');
  assert.equal(bars[1].time, '2024-01-02T09:15:00');
  assert.equal(bars[1].close, 12);
  assert.equal(bars[1].volume, 4);
  assert.equal(normaliseTimeKey(String(Date.parse('2024-01-02T01:15:00Z'))), '2024-01-02T09:15:00');
  assert.equal(normaliseTimeKey('2024-01-02T09:15:00+08:00'), '2024-01-02T09:15:00');
  assert.throws(() => parseIntradayCsv('open,high,low,close\n1,1,1,1\n'), /time_key/);
});

function syntheticMinuteCsv() {
  const lines = ['time_key,open,high,low,close,volume'];
  const push = (time, close, open) => {
    const o = open ?? close - 1;
    lines.push(`${time},${o},${Math.max(o, close) + 0.5},${Math.min(o, close) - 0.5},${close},10`);
  };
  for (const date of ['2024-01-02', '2024-01-03', '2024-01-04']) {
    push(`${date} 09:14:00`, 100, 100); // auction
    push(`${date} 12:30:00`, 100, 100); // afternoon pre-open
    push(`${date} 17:15:00`, 100, 100); // T+1
    let price = 100;
    for (let m = 15; m <= 40; m++) {
      price += 1;
      push(`${date} 09:${String(m).padStart(2, '0')}:00`, price);
    }
    price -= 40;
    push(`${date} 09:41:00`, price);
    for (let m = 25; m <= 29; m++) {
      price -= 1;
      push(`${date} 16:${String(m).padStart(2, '0')}:00`, price);
    }
  }
  return lines.join('\n');
}

test('the default matrix is 50 runs and control matches A-F after the session filter', () => {
  const { bars } = parseIntradayCsv(syntheticMinuteCsv());
  const matrix = runMatrix(bars);
  assert.equal(matrix.ranked.length, 50);
  assert.deepEqual(matrix.atrLengths, [10, 11, 12, 13, 14]);
  assert.deepEqual(matrix.timeframes, ['1m', '5m']);
  assert.equal(matrix.factor, PHASE1_MATRIX.factor);
  assert.equal(matrix.smoothing, 2);
  for (const timeframe of ['1m', '5m']) {
    for (const atrLength of [10, 11, 12, 13, 14]) {
      const control = matrix.runs.find((r) => r.timeframe === timeframe && r.atrLength === atrLength && r.arm === 'control');
      const aF = matrix.runs.find((r) => r.timeframe === timeframe && r.atrLength === atrLength && r.arm === 'A-F');
      assert.equal(control.metrics.totalPoints, aF.metrics.totalPoints);
      assert.equal(control.metrics.costsApplied, false);
      assert.equal(control.metrics.netPoints, control.metrics.totalPoints);
      assert.ok(control.equity.length > 0);
      assert.ok(control.trades.every((t) => inDaySession(t.entryTime) && inDaySession(t.exitTime)));
    }
  }
  const csv = summaryCsv(matrix.ranked);
  assert.equal(csv.trim().split('\n').length, 51);
  assert.equal(matrix.ranked[0].metrics.totalPoints >= matrix.ranked[49].metrics.totalPoints, true);
});

test('parquet time_key round-trips when pyarrow imports', (t) => {
  const probe = spawnSync('python3', ['-c', 'import pyarrow.parquet'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip(`pyarrow not importable: ${(probe.stderr || probe.stdout || '').trim()}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'hsi-parquet-'));
  const path = join(dir, 'bars.parquet');
  const writer = `
import sys
from datetime import datetime
import pyarrow as pa
import pyarrow.parquet as pq
pq.write_table(pa.table({
    'time_key': pa.array([datetime(2024, 1, 2, 1, 15), datetime(2024, 1, 2, 1, 16)], type=pa.timestamp('ns', tz='UTC')),
    'open': [100.0, 101.0],
    'high': [102.0, 103.0],
    'low': [99.0, 100.0],
    'close': [101.5, 102.5],
    'volume': [3.0, 4.0],
}), sys.argv[1])
`;
  const wrote = spawnSync('python3', ['-c', writer, path], { encoding: 'utf8' });
  assert.equal(wrote.status, 0, wrote.stderr);
  const loaded = loadLocalBars(path);
  assert.deepEqual(loaded.bars.map((b) => b.time), ['2024-01-02T09:15:00', '2024-01-02T09:16:00']);
  assert.equal(loaded.bars[0].close, 101.5);
  assert.equal(loaded.bars[1].volume, 4);
});

test('the CLI writes the ranked summary for a local CSV', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hsi-phase1-'));
  const data = join(dir, 'bars.csv');
  const out = join(dir, 'out');
  writeFileSync(data, syntheticMinuteCsv());
  const loaded = loadLocalBars(data);
  assert.equal(loaded.bars.length > 50, true);
  assert.equal(filterDaySession(loaded.bars).some((b) => b.time.endsWith('T09:14:00')), false);
  const cli = join(root, 'backtest/runners/hsi-supertrend-phase1.js');
  const run = spawnSync(process.execPath, [cli, '--data', data, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.phase, 1);
  assert.equal(summary.costs.enabled, false);
  assert.equal(summary.matrix.runs, 50);
  assert.equal(summary.ranked.length, 50);
  assert.equal(summary.ranked[0].rank, 1);
  assert.match(readFileSync(join(out, 'summary.csv'), 'utf8'), /^rank,id,timeframe/);
  const one = JSON.parse(readFileSync(join(out, 'runs', `${summary.ranked[0].id}.json`), 'utf8'));
  assert.ok(Array.isArray(one.equity));
  assert.equal(one.costsApplied, false);
  const envRun = spawnSync(process.execPath, [cli, '--out', join(dir, 'env-out'), '--atr', '10', '--timeframes', '1m', '--arms', 'A-S'], {
    encoding: 'utf8',
    env: { ...process.env, HSI_BARS_PATH: data },
  });
  assert.equal(envRun.status, 0, envRun.stderr);
  const narrow = JSON.parse(readFileSync(join(dir, 'env-out', 'summary.json'), 'utf8'));
  assert.equal(narrow.matrix.runs, 1);
  assert.equal(narrow.ranked[0].arm, 'A-S');
  assert.equal(narrow.ranked[0].atrLength, 10);
  const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: { ...process.env, HSI_BARS_PATH: '' } });
  assert.equal(missing.status, 1);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--data \/path\/to\/HSImain_1m\.parquet/);
});
