// One lab run: validate, session-filter, build signals, simulate, then a
// public result that contains points only.

import { filterDaySession } from '../../backtest/engine/intraday.js';
import { getStrategy } from './registry.js';
import { simulateHsi } from './simulate.js';
import { ValidationError, validateInput } from './validate.js';

export function roundTo(n, dp) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Number(n.toFixed(dp));
}

function groupTrades(trades, keyFn, cost) {
  const map = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    let row = map.get(key);
    if (!row) {
      row = { trades: 0, wins: 0, gross: 0 };
      map.set(key, row);
    }
    row.trades += 1;
    if (trade.points > 0) row.wins += 1;
    row.gross += trade.points;
  }
  return [...map.entries()].map(([key, row]) => ({
    key,
    trades: row.trades,
    winRate: roundTo(row.wins / row.trades, 4),
    grossPoints: roundTo(row.gross, 2),
    netPoints: roundTo(row.gross - cost * row.trades, 2),
    avgPoints: roundTo(row.gross / row.trades, 4),
  }));
}

export function toPublicResult(raw, spec) {
  const cost = spec.costs ? spec.costPoints : 0;
  const trades = raw.trades;
  const n = trades.length;
  const gross = raw.grossPoints;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let hold = 0;
  for (const trade of trades) {
    hold += trade.holdMinutes;
    if (trade.points > 0) {
      wins += 1;
      grossWin += trade.points;
    } else if (trade.points < 0) grossLoss -= trade.points;
  }
  const byYear = groupTrades(trades, (t) => t.year, cost).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((row) => ({
    year: row.key,
    trades: row.trades,
    winRate: row.winRate,
    grossPoints: row.grossPoints,
    netPoints: row.netPoints,
    avgPoints: row.avgPoints,
  }));
  const byEntryHour = groupTrades(trades, (t) => t.entryHour, cost)
    .sort((a, b) => a.key - b.key)
    .map((row) => ({
      hour: row.key,
      trades: row.trades,
      winRate: row.winRate,
      grossPoints: row.grossPoints,
      netPoints: row.netPoints,
      avgPoints: row.avgPoints,
    }));

  return {
    strategy: spec.strategy,
    params: {
      atrLength: spec.atrLength,
      exitAtrLength: spec.exitAtrLength,
      factor: spec.factor,
      smoothing: spec.smoothing,
      entryTimeframe: spec.entryTimeframe,
      exitTimeframe: spec.exitTimeframe,
      entryRule: spec.entryRule,
      exitRule: spec.exitRule,
      clock: spec.clock,
      windowStart: spec.windowStart,
      windowEnd: spec.windowEnd,
      from: spec.from,
      to: spec.to,
      costs: spec.costs,
      costPoints: spec.costs ? spec.costPoints : 0,
    },
    metrics: {
      trades: n,
      sessionDays: raw.sessionDays,
      tradesPerDay: raw.sessionDays ? roundTo(n / raw.sessionDays, 4) : null,
      winRate: n ? roundTo(wins / n, 4) : null,
      profitFactor: grossLoss > 0 ? roundTo(grossWin / grossLoss, 4) : null,
      avgPoints: n ? roundTo(gross / n, 4) : null,
      avgHoldMinutes: n ? roundTo(hold / n, 2) : null,
      maxDrawdownPoints: roundTo(raw.maxDrawdownPoints, 2),
      grossPoints: roundTo(gross, 2),
      netPoints: roundTo(gross - cost * n, 2),
    },
    equity: raw.equity.map((p) => ({ date: p.date, points: roundTo(p.points, 2) })),
    byYear,
    byEntryHour,
  };
}

export function runSpec(bars, spec) {
  const strategy = getStrategy(spec.strategy);
  if (!strategy) throw new ValidationError('Unknown strategy.');
  const day = filterDaySession(bars);
  const { entry, exit } = strategy.build(day, spec);
  const raw = simulateHsi(day, entry, exit, spec);
  return { spec, raw, result: toPublicResult(raw, spec) };
}

export function runLab(bars, input) {
  return runSpec(bars, validateInput(input));
}
