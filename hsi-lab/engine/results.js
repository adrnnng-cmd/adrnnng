// Compact a simulation into one grid cell, and turn that cell back into the
// public score once a round-trip cost is chosen. No prices.

import { ArchiveError } from './archive.js';
import { FACTOR, MAX_EQUITY_POINTS, SMOOTHING, WINDOW_END, WINDOW_START } from './grid.js';

function roundTo(n, dp) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Number(n.toFixed(dp));
}

export function downsampleEquity(points, max = MAX_EQUITY_POINTS) {
  if (!points.length) return [];
  if (points.length <= max) return points.map(copyPoint);
  const last = points.length - 1;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * last) / (max - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(copyPoint(points[idx]));
  }
  return out;
}

function copyPoint(point) {
  return {
    date: point.date,
    points: roundTo(point.points, 2),
    trades: point.trades || 0,
  };
}

function summarize(trades) {
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let gross = 0;
  let hold = 0;
  for (const trade of trades) {
    gross += trade.points;
    hold += trade.holdMinutes;
    if (trade.points > 0) {
      wins += 1;
      grossWin += trade.points;
    } else if (trade.points < 0) grossLoss -= trade.points;
  }
  return { trades: trades.length, wins, grossWin, grossLoss, gross, hold };
}

function group(trades, keyFn) {
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
  return [...map.entries()].map(([key, row]) => [
    key,
    row.trades,
    row.wins,
    roundTo(row.gross, 2),
  ]);
}

export function emptyCell(sessionDays = 0) {
  return {
    t: 0,
    d: sessionDays,
    w: 0,
    gw: 0,
    gl: 0,
    g: 0,
    h: 0,
    dd: 0,
    dd6: 0,
    dd8: 0,
    eq: [],
    y: [],
    hr: [],
  };
}

export function compactCell(raw, range) {
  const yearSlice = range !== 'all';
  const trades = yearSlice ? raw.trades.filter((trade) => trade.year === String(range)) : raw.trades;
  const stats = summarize(trades);
  const slice = yearSlice ? raw.years?.[String(range)] : null;
  if (yearSlice && !slice) return emptyCell(0);
  const equity = downsampleEquity(slice ? slice.equity : raw.equity);
  const years = group(trades, (trade) => trade.year).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const hours = group(trades, (trade) => trade.entryHour).sort((a, b) => a[0] - b[0]);
  return {
    t: stats.trades,
    d: slice ? slice.sessionDays : raw.sessionDays,
    w: stats.wins,
    gw: roundTo(stats.grossWin, 2),
    gl: roundTo(stats.grossLoss, 2),
    g: roundTo(stats.gross, 2),
    h: roundTo(stats.hold, 2),
    dd: roundTo(slice ? slice.maxDrawdownPoints : raw.maxDrawdownPoints, 2),
    dd6: roundTo(slice ? slice.maxDrawdownAt6 : raw.maxDrawdownAt6, 2),
    dd8: roundTo(slice ? slice.maxDrawdownAt8 : raw.maxDrawdownAt8, 2),
    eq: equity.map((point) => [point.date, point.points, point.trades]),
    y: years,
    hr: hours,
  };
}

function drawdownAt(cell, cost) {
  const dd = cell.dd || 0;
  const dd6 = cell.dd6 ?? dd;
  const dd8 = cell.dd8 ?? dd6;
  if (cost === 0) return dd;
  if (cost === 6) return dd6;
  if (cost === 8) return dd8;
  if (cost < 6) return dd + ((dd6 - dd) * cost) / 6;
  if (cost < 8) return dd6 + ((dd8 - dd6) * (cost - 6)) / 2;
  return dd8 + ((dd8 - dd6) * (cost - 8)) / 2;
}

function bucketRows(rows, label, cost) {
  return rows.map(([key, trades, wins, gross]) => ({
    [label]: key,
    trades,
    winRate: trades ? roundTo(wins / trades, 4) : null,
    grossPoints: gross,
    netPoints: roundTo(gross - cost * trades, 2),
    avgPoints: trades ? roundTo(gross / trades, 4) : null,
  }));
}

export function applyCost(cell, spec) {
  const cost = spec.costs ? spec.costPoints : 0;
  const trades = cell.t || 0;
  const gross = cell.g || 0;
  const equity = (cell.eq || []).map(([date, points, closed]) => ({
    date,
    points: roundTo(points - cost * (closed || 0), 2),
  }));
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
      costs: spec.costs,
      costPoints: cost,
    },
    metrics: {
      trades,
      sessionDays: cell.d || 0,
      tradesPerDay: cell.d ? roundTo(trades / cell.d, 4) : null,
      winRate: trades ? roundTo((cell.w || 0) / trades, 4) : null,
      profitFactor: cell.gl > 0 ? roundTo(cell.gw / cell.gl, 4) : null,
      avgPoints: trades ? roundTo(gross / trades, 4) : null,
      avgHoldMinutes: trades ? roundTo((cell.h || 0) / trades, 2) : null,
      maxDrawdownPoints: roundTo(drawdownAt(cell, cost), 2),
      grossPoints: roundTo(gross, 2),
      netPoints: roundTo(gross - cost * trades, 2),
    },
    equity,
    byYear: bucketRows(cell.y || [], 'year', cost),
    byEntryHour: bucketRows(cell.hr || [], 'hour', cost),
  };
}

export async function decodeBundle(bytes) {
  try {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    const bundle = JSON.parse(text);
    if (!bundle || typeof bundle !== 'object' || !bundle.rows) throw new ArchiveError();
    return bundle;
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError();
  }
}
