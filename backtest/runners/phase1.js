// Phase 1 HSI execution: one notional unit of the index, P&L in points.
// The shared backtest engine invests 100% of equity and charges bps costs.
// This runner does not. It is the HSI day-session study only.

import { atrSupertrend } from '../strategies/atr-supertrend.js';
import { barDate, barMinutes, filterDaySession, resampleMinutes } from '../engine/intraday.js';

/** Planned Mini-HSI economics. Phase 1 leaves `enabled` false. */
export const PHASE2_COSTS = Object.freeze({
  enabled: false,
  contract: 'MHI',
  pointValueHkd: 10,
  commissionRoundTurnHkd: 40,
  slippagePointsPerSide: 0,
});

/**
 * Phase 2 cost sketch. Not applied to Phase 1 results.
 * Commission is one round-turn per closed trade, converted to index points
 * with pointValueHkd. Slippage is `slippagePointsPerSide * fillCount`.
 * A reversal is two trades in this simulator (the shared flip price is the
 * exit of one and the entry of the next). Whether that counts as one fill
 * or two is a Phase 2 choice: pass the fillCount you intend to charge.
 */
export function phase2Adjustment(grossPoints, { tradeCount = 0, fillCount = 0 } = {}, costs = PHASE2_COSTS) {
  const pointValue = costs.pointValueHkd;
  if (!(pointValue > 0)) throw new Error('pointValueHkd must be positive');
  const commissionPoints = ((costs.commissionRoundTurnHkd || 0) / pointValue) * tradeCount;
  const slippagePoints = (costs.slippagePointsPerSide || 0) * fillCount;
  return {
    grossPoints,
    commissionPoints,
    slippagePoints,
    netPoints: grossPoints - commissionPoints - slippagePoints,
  };
}

/** Single place Phase 1 calls. While costs are disabled, net equals gross. */
export function phase2CostHook(grossPoints, context = {}, costs = PHASE2_COSTS) {
  if (!costs?.enabled) {
    return { grossPoints, netPoints: grossPoints, commissionPoints: 0, slippagePoints: 0, costsApplied: false };
  }
  return { ...phase2Adjustment(grossPoints, context, costs), costsApplied: true };
}

export const ENTRY_ARMS = Object.freeze([
  { id: 'control', label: 'Control · any day-session flip', mode: 'flip', clock: null },
  { id: 'A-S', label: 'A-S · trend state at 09:15', mode: 'state', clock: 9 * 60 + 15 },
  { id: 'A-F', label: 'A-F · first flip at/after 09:15', mode: 'flip', clock: 9 * 60 + 15 },
  { id: 'B-S', label: 'B-S · trend state at 09:30', mode: 'state', clock: 9 * 60 + 30 },
  { id: 'B-F', label: 'B-F · first flip at/after 09:30', mode: 'flip', clock: 9 * 60 + 30 },
]);

export const PHASE1_MATRIX = Object.freeze({
  timeframes: ['1m', '5m'],
  atrLengths: [10, 11, 12, 13, 14],
  factor: 2.5,
  smoothing: 2,
  arms: ENTRY_ARMS,
});

export const PHASE1_ASSUMPTIONS = Object.freeze([
  'Source is close. ta.ema seeds with the first close; ta.rma seeds with the SMA of the first atrLength true ranges; ta.tr(true) uses high-low on the first bar.',
  'The first bar where EMA and ATR both exist seeds an uptrend (line = smoothed - atr) and is not a flip.',
  'Day session only: bar open in [09:15, 12:00) or [13:00, 16:30) Asia/Hong_Kong. Auction (before 09:15 and 12:30–13:00), lunch, and T+1 are dropped. The first regular bar at or after 09:15 is the session open.',
  'Indicators run on the concatenated day-session series, not restarted each morning. The 09:15 true range includes the overnight gap from the previous day-session close. The 13:00 true range includes the lunch gap. The position is held through lunch and flattened only at the last day-session bar.',
  '5m bars are clock-aligned resamples of those 1m day-session bars (opens at 09:15, 09:20, …). A partial bucket is kept. Buckets do not cross lunch or 16:30.',
  'A flip is known at the signal bar close and fills at the next bar open. A flip does not carry overnight: if the next bar is a new date, the order is cancelled. The last bar of the day flattens at its close and does not open a new position.',
  'State arms (A-S, B-S) enter at the open of the first bar at or after the clock, in the prior bar\'s trend, without waiting for a flip. If that prior trend is not defined yet, that day is skipped. After entry, later flips reverse until the end-of-day flatten.',
  'On a series whose first day-session bar is 09:15, control and A-F match: there is no day-session bar before 09:15 for control to take earlier.',
  'One index unit. Long points = exit - entry, short points = entry - exit. No contract multiplier, commission, or slippage. phase2CostHook is called with enabled false, so netPoints equals totalPoints.',
  'Percent return and percent drawdown divide point P&L by the first bar close of that run (constant notional, not compounded). Sharpe uses daily point P&L / that same level, sample standard deviation, rf = 0, sqrt(252). Half-days flatten on the last bar present; there is no holiday calendar.',
]);

export const PHASE1_UNITS = Object.freeze({
  totalPoints: 'index points',
  returnPct: 'percent of the run\'s first close',
  winRate: 'fraction of closed trades with points > 0',
  avgPoints: 'index points per closed trade',
  maxDrawdownPoints: 'index points, negative or zero',
  maxDrawdownPct: 'percent of the run\'s first close, negative or zero',
  sharpe: 'daily returns, rf 0, sample stdev, sqrt(252)',
});

function sideStats(trades, side) {
  const xs = trades.filter((t) => t.side === side);
  const wins = xs.filter((t) => t.points > 0).length;
  const totalPoints = xs.reduce((s, t) => s + t.points, 0);
  return {
    trades: xs.length,
    wins,
    winRate: xs.length ? wins / xs.length : null,
    totalPoints,
    avgPoints: xs.length ? totalPoints / xs.length : null,
  };
}

function sharpeRatio(returns) {
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return (mean / sd) * Math.sqrt(252);
}

export function computePhase1Metrics(equity, trades, initialLevel) {
  const totalPoints = trades.reduce((s, t) => s + t.points, 0);
  const wins = trades.filter((t) => t.points > 0).length;
  let maxDrawdownPoints = 0;
  for (const p of equity) if (p.drawdownPoints < maxDrawdownPoints) maxDrawdownPoints = p.drawdownPoints;

  const dailyPoints = [];
  let prevEquity = 0;
  let lastDate = null;
  let lastEq = 0;
  for (const p of equity) {
    const d = barDate(p.time);
    if (lastDate == null) lastDate = d;
    if (d !== lastDate) {
      dailyPoints.push(lastEq - prevEquity);
      prevEquity = lastEq;
      lastDate = d;
    }
    lastEq = p.equityPoints;
  }
  if (lastDate != null) dailyPoints.push(lastEq - prevEquity);

  const costs = phase2CostHook(totalPoints, { tradeCount: trades.length, fillCount: 0 }, PHASE2_COSTS);
  return {
    totalPoints,
    returnPct: (totalPoints / initialLevel) * 100,
    winRate: trades.length ? wins / trades.length : null,
    trades: trades.length,
    avgPoints: trades.length ? totalPoints / trades.length : null,
    maxDrawdownPoints,
    maxDrawdownPct: (maxDrawdownPoints / initialLevel) * 100,
    sharpe: sharpeRatio(dailyPoints.map((pts) => pts / initialLevel)),
    long: sideStats(trades, 'long'),
    short: sideStats(trades, 'short'),
    initialLevel,
    days: dailyPoints.length,
    ...costs,
  };
}

/**
 * Turn a trend series (+1 bull, -1 bear, null warming up) into point P&L.
 * `arm` is an ENTRY_ARMS entry. Bars are already session-filtered and resampled.
 * Signals at the close fill at the next open, except state entries (clock open)
 * and the end-of-day flatten (last bar's close).
 */
export function simulatePhase1(bars, trend, arm) {
  if (!bars.length) throw new Error('No bars to simulate');
  if (trend.length !== bars.length) throw new Error('trend length does not match bars');
  const initialLevel = bars[0].close;
  if (!(initialLevel > 0)) throw new Error('First close must be positive');

  const lastOfDay = new Map();
  for (let i = 0; i < bars.length; i++) lastOfDay.set(barDate(bars[i].time), i);

  const trades = [];
  const equity = [];
  let realized = 0;
  let pos = 0;
  let entry = null;
  let pending = null;
  const stateTaken = new Set();
  let peak = 0;

  const closeAt = (i, price, reason) => {
    const points = pos * (price - entry.price);
    realized += points;
    trades.push({
      side: pos === 1 ? 'long' : 'short',
      entryIndex: entry.index,
      entryTime: entry.time,
      entryPrice: entry.price,
      exitIndex: i,
      exitTime: bars[i].time,
      exitPrice: price,
      points,
      returnPct: (points / entry.price) * 100,
      bars: i - entry.index,
      reason,
    });
    pos = 0;
    entry = null;
  };

  const openAt = (i, price, side) => {
    pos = side;
    entry = { index: i, time: bars[i].time, price };
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const date = barDate(b.time);
    const mins = barMinutes(b.time);
    const isLast = lastOfDay.get(date) === i;

    if (pending) {
      if (pending.date === date) {
        if (pos !== 0) closeAt(i, b.open, 'flip');
        if (pending.side !== 0) openAt(i, b.open, pending.side);
      }
      pending = null;
    }

    if (arm.mode === 'state' && pos === 0 && !stateTaken.has(date) && (arm.clock == null || mins >= arm.clock)) {
      stateTaken.add(date);
      const prev = i > 0 ? trend[i - 1] : null;
      if (prev === 1 || prev === -1) openAt(i, b.open, prev);
    }

    const flipped = i > 0 && trend[i] != null && trend[i - 1] != null && trend[i] !== trend[i - 1];
    if (!isLast && flipped) {
      const clockOk = arm.clock == null || mins >= arm.clock;
      const follow = pos !== 0;
      const enter = pos === 0 && arm.mode === 'flip' && clockOk;
      if (follow || enter) pending = { side: trend[i], date };
    } else if (isLast && pos !== 0) {
      closeAt(i, b.close, 'eod');
    }

    const unrealized = pos !== 0 ? pos * (b.close - entry.price) : 0;
    const equityPoints = realized + unrealized;
    if (equityPoints > peak) peak = equityPoints;
    const drawdownPoints = equityPoints - peak;
    equity.push({
      time: b.time,
      equityPoints,
      equityPct: (equityPoints / initialLevel) * 100,
      drawdownPoints,
      drawdownPct: (drawdownPoints / initialLevel) * 100,
      position: pos,
    });
  }

  const end = equity[equity.length - 1].equityPoints;
  if (Math.abs(end - realized) > 1e-6) throw new Error('Open position left after the last bar');
  const metrics = computePhase1Metrics(equity, trades, initialLevel);
  if (Math.abs(metrics.totalPoints - end) > 1e-6) throw new Error('Trade points do not add up to the equity curve');
  return { trades, equity, metrics };
}

export function prepareSeries(bars1m, timeframe) {
  const session = filterDaySession(bars1m);
  if (session.length < 3) throw new Error('Need at least three day-session bars. Check that time_key is the bar open in Asia/Hong_Kong.');
  const minutes = timeframe === '1m' ? 1 : timeframe === '5m' ? 5 : null;
  if (minutes == null) throw new Error(`Unsupported timeframe ${timeframe}`);
  return resampleMinutes(session, minutes);
}

export function runPhase1(bars1m, { timeframe, atrLength, factor, smoothing, arm, trend, bars }) {
  const series = bars || prepareSeries(bars1m, timeframe);
  const signal = trend || atrSupertrend(series, { atrLength, factor, smoothing }).trend;
  const sim = simulatePhase1(series, signal, arm);
  const id = `${timeframe}-atr${atrLength}-${arm.id}`;
  return {
    id,
    timeframe,
    atrLength,
    factor,
    smoothing,
    arm: arm.id,
    armLabel: arm.label,
    ...sim,
  };
}

export function runMatrix(bars1m, options = {}) {
  const timeframes = options.timeframes ?? PHASE1_MATRIX.timeframes;
  const atrLengths = options.atrLengths ?? PHASE1_MATRIX.atrLengths;
  const factor = options.factor ?? PHASE1_MATRIX.factor;
  const smoothing = options.smoothing ?? PHASE1_MATRIX.smoothing;
  const arms = options.arms ?? PHASE1_MATRIX.arms;
  const runs = [];
  for (const timeframe of timeframes) {
    const series = prepareSeries(bars1m, timeframe);
    for (const atrLength of atrLengths) {
      const trend = atrSupertrend(series, { atrLength, factor, smoothing }).trend;
      for (const arm of arms) {
        runs.push(runPhase1(bars1m, { timeframe, atrLength, factor, smoothing, arm, trend, bars: series }));
      }
    }
  }
  const ranked = rankRuns(runs);
  return { runs, ranked, factor, smoothing, timeframes, atrLengths, arms: arms.map((a) => a.id) };
}

export function rankRuns(runs) {
  return [...runs].sort((a, b) => {
    if (b.metrics.totalPoints !== a.metrics.totalPoints) return b.metrics.totalPoints - a.metrics.totalPoints;
    if (b.metrics.maxDrawdownPoints !== a.metrics.maxDrawdownPoints) return b.metrics.maxDrawdownPoints - a.metrics.maxDrawdownPoints;
    const sb = b.metrics.sharpe ?? -Infinity;
    const sa = a.metrics.sharpe ?? -Infinity;
    if (sb !== sa) return sb - sa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function summaryRow(run, rank) {
  const m = run.metrics;
  return {
    rank,
    id: run.id,
    timeframe: run.timeframe,
    atrLength: run.atrLength,
    factor: run.factor,
    smoothing: run.smoothing,
    arm: run.arm,
    totalPoints: m.totalPoints,
    returnPct: m.returnPct,
    winRate: m.winRate,
    trades: m.trades,
    avgPoints: m.avgPoints,
    maxDrawdownPoints: m.maxDrawdownPoints,
    maxDrawdownPct: m.maxDrawdownPct,
    sharpe: m.sharpe,
    initialLevel: m.initialLevel,
    longTrades: m.long.trades,
    longPoints: m.long.totalPoints,
    longWinRate: m.long.winRate,
    shortTrades: m.short.trades,
    shortPoints: m.short.totalPoints,
    shortWinRate: m.short.winRate,
    netPoints: m.netPoints,
    costsApplied: m.costsApplied,
  };
}

export const SUMMARY_COLUMNS = [
  'rank', 'id', 'timeframe', 'atrLength', 'factor', 'smoothing', 'arm',
  'totalPoints', 'returnPct', 'winRate', 'trades', 'avgPoints',
  'maxDrawdownPoints', 'maxDrawdownPct', 'sharpe', 'initialLevel',
  'longTrades', 'longPoints', 'longWinRate', 'shortTrades', 'shortPoints', 'shortWinRate',
  'netPoints', 'costsApplied',
];

function csvCell(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function summaryCsv(ranked) {
  const lines = [SUMMARY_COLUMNS.join(',')];
  ranked.forEach((run, i) => {
    const row = summaryRow(run, i + 1);
    lines.push(SUMMARY_COLUMNS.map((k) => csvCell(row[k])).join(','));
  });
  return lines.join('\n') + '\n';
}

export function runJson(run, rank) {
  return {
    ...summaryRow(run, rank),
    armLabel: run.armLabel,
    units: PHASE1_UNITS,
    trades: run.trades,
    equity: run.equity,
  };
}
