// Turn one stored daily bundle into the public score for a date window.
// Net points are gross minus the round-trip cost times the trade count.
// Drawdown is the peak-to-trough of that end-of-day curve. No prices.

import { ArchiveError } from './archive.js';
import { decodeDaily, sliceDays } from './daily.js';
import { FACTOR, SMOOTHING, WINDOW_END, WINDOW_START } from './grid.js';

function roundTo(n, dp) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Number(n.toFixed(dp));
}

function bucket(rows, label, cost) {
  return rows.map((row) => ({
    [label]: row[label],
    trades: row.trades,
    winRate: row.trades ? roundTo(row.wins / row.trades, 4) : null,
    grossPoints: roundTo(row.gross, 2),
    netPoints: roundTo(row.gross - cost * row.trades, 2),
    avgPoints: row.trades ? roundTo(row.gross / row.trades, 4) : null,
  }));
}

export function scoreStored(decoded, spec) {
  const cost = spec.costs ? spec.costPoints : 0;
  const sliced = sliceDays(decoded, spec.combo, spec.from, spec.to, cost, spec.range);
  if (!sliced) return null;
  const trades = sliced.trades;
  return {
    strategy: spec.strategy,
    params: {
      atrLength: spec.atrLength,
      exitAtrLength: spec.exitAtrLength,
      factor: FACTOR,
      smoothing: SMOOTHING,
      entryTimeframe: spec.entryTimeframe,
      exitTimeframe: spec.exitTimeframe,
      entryRule: spec.entryRule,
      exitRule: spec.exitRule,
      clock: spec.clock,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      range: spec.range,
      from: spec.from,
      to: spec.to,
      resolution: 'daily',
      costs: spec.costs,
      costPoints: cost,
    },
    metrics: {
      trades,
      sessionDays: sliced.sessionDays,
      tradesPerDay: sliced.sessionDays ? roundTo(trades / sliced.sessionDays, 4) : null,
      winRate: trades ? roundTo(sliced.wins / trades, 4) : null,
      profitFactor: sliced.netLoss > 0 ? roundTo(sliced.netWin / sliced.netLoss, 4) : null,
      avgPoints: trades ? roundTo(sliced.gross / trades, 4) : null,
      avgHoldMinutes: trades ? roundTo(sliced.hold / trades, 2) : null,
      maxDrawdownPoints: roundTo(sliced.maxDrawdown, 2),
      sharpe: roundTo(sliced.sharpe, 4),
      grossPoints: roundTo(sliced.gross, 2),
      netPoints: roundTo(sliced.gross - cost * trades, 2),
    },
    equity: sliced.equity.map((point) => ({ date: point.date, points: roundTo(point.points, 2) })),
    byYear: bucket(sliced.byYear.map((row) => ({ ...row, year: row.year })), 'year', cost),
    byEntryHour: bucket(sliced.hours.map((row) => ({ ...row, hour: row.hour })), 'hour', cost),
  };
}

export async function decodeBundle(bytes) {
  try {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    return decodeDaily(raw);
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError();
  }
}
