#!/usr/bin/env node
// Phase 1 ATR SuperTrend matrix on a local HSI 1-minute file.
//
//   node backtest/runners/hsi-supertrend-phase1.js --data /path/to/HSImain_1m.parquet
//   HSI_BARS_PATH=/path/to/HSImain_1m.parquet node backtest/runners/hsi-supertrend-phase1.js
//
// Writes summary.csv, summary.json, and one JSON file per run under --out
// (default backtest/output/hsi-supertrend-phase1, gitignored). Does not fetch
// market data and does not read anything except the file you pass.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLocalBars } from '../providers/local-bars.js';
import { barDate, barMinutes, filterDaySession } from '../engine/intraday.js';
import {
  ENTRY_ARMS,
  PHASE1_ASSUMPTIONS,
  PHASE1_MATRIX,
  PHASE1_UNITS,
  PHASE2_COSTS,
  runMatrix,
  runJson,
  summaryCsv,
  summaryRow,
} from './phase1.js';

const HELP = `Phase 1 ATR SuperTrend matrix (index points, day session, no costs).

  node backtest/runners/hsi-supertrend-phase1.js --data /path/to/HSImain_1m.parquet

  HSI_BARS_PATH=/path/to/HSImain_1m.parquet node backtest/runners/hsi-supertrend-phase1.js

The file is local CSV or parquet with columns time_key, open, high, low, close, volume.
time_key is the bar open in Asia/Hong_Kong. Parquet needs pyarrow, polars, or duckdb.
Default matrix: 1m and 5m × ATR 10,11,12,13,14 × arms control,A-S,A-F,B-S,B-F (50 runs).
Factor 2.5, EMA smoothing 2. One index unit. No commission or slippage.
`;

function parseArgs(argv) {
  const out = {
    data: process.env.HSI_BARS_PATH || '',
    out: 'backtest/output/hsi-supertrend-phase1',
    factor: PHASE1_MATRIX.factor,
    smoothing: PHASE1_MATRIX.smoothing,
    atrLengths: PHASE1_MATRIX.atrLengths,
    timeframes: PHASE1_MATRIX.timeframes,
    arms: ENTRY_ARMS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--data' || a === '-d') out.data = next();
    else if (a === '--out' || a === '-o') out.out = next();
    else if (a === '--factor') out.factor = Number(next());
    else if (a === '--smoothing') out.smoothing = Number(next());
    else if (a === '--atr') out.atrLengths = next().split(',').map((s) => Number(s.trim()));
    else if (a === '--timeframes') out.timeframes = next().split(',').map((s) => s.trim());
    else if (a === '--arms') {
      const ids = next().split(',').map((s) => s.trim());
      out.arms = ids.map((id) => {
        const arm = ENTRY_ARMS.find((x) => x.id === id);
        if (!arm) throw new Error(`Unknown arm ${id}. Use ${ENTRY_ARMS.map((x) => x.id).join(', ')}`);
        return arm;
      });
    } else throw new Error(`Unknown argument ${a}`);
  }
  return out;
}

function warnIfNotOneMinute(bars) {
  const gaps = [];
  for (let i = 1; i < bars.length && gaps.length < 800; i++) {
    if (barDate(bars[i].time) !== barDate(bars[i - 1].time)) continue;
    const delta = barMinutes(bars[i].time) - barMinutes(bars[i - 1].time);
    if (delta > 0 && delta < 60) gaps.push(delta);
  }
  if (!gaps.length) return;
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1];
  if (median !== 1) {
    console.error(`warning: median gap between day-session bars is ${median} minutes. This runner expects 1-minute bars and resamples 5m from them.`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const loaded = loadLocalBars(args.data);
  const session = filterDaySession(loaded.bars);
  warnIfNotOneMinute(session);
  const matrix = runMatrix(loaded.bars, {
    timeframes: args.timeframes,
    atrLengths: args.atrLengths,
    factor: args.factor,
    smoothing: args.smoothing,
    arms: args.arms,
  });
  const dir = args.out;
  const runsDir = join(dir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  matrix.ranked.forEach((run, i) => {
    writeFileSync(join(runsDir, `${run.id}.json`), JSON.stringify(runJson(run, i + 1), null, 2));
  });
  writeFileSync(join(dir, 'summary.csv'), summaryCsv(matrix.ranked));
  const summary = {
    phase: 1,
    costs: PHASE2_COSTS,
    units: PHASE1_UNITS,
    assumptions: PHASE1_ASSUMPTIONS,
    data: {
      path: loaded.path,
      bars: loaded.bars.length,
      skipped: loaded.skipped,
      sessionBars: session.length,
      from: session[0]?.time ?? null,
      to: session.at(-1)?.time ?? null,
    },
    matrix: {
      timeframes: matrix.timeframes,
      atrLengths: matrix.atrLengths,
      factor: matrix.factor,
      smoothing: matrix.smoothing,
      arms: matrix.arms,
      runs: matrix.ranked.length,
    },
    ranked: matrix.ranked.map((run, i) => summaryRow(run, i + 1)),
  };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const top = matrix.ranked.slice(0, 10).map((run, i) => {
    const row = summaryRow(run, i + 1);
    return `${String(row.rank).padStart(2, ' ')}  ${row.id.padEnd(22, ' ')}  ${row.totalPoints.toFixed(2).padStart(10, ' ')} pts  ${row.returnPct.toFixed(3).padStart(8, ' ')}%  dd ${row.maxDrawdownPoints.toFixed(2)}`;
  });
  console.log(`Wrote ${matrix.ranked.length} runs to ${dir}`);
  console.log(top.join('\n'));
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
