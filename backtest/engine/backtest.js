// Event loop that turns a strategy's target positions into fills, an equity curve and trades.
//
// Execution model (documented in backtest/README.md):
//  - Strategies see the full bar history (so indicators are warmed up before the start date) and
//    return target[i] ∈ {1, 0, -1, null}: the position wanted after bar i closes. null = no opinion.
//  - A decision made on bar i's close fills at bar i+1's open. No look-ahead.
//  - Each entry deploys 100% of current equity (fractional units); commission and slippage are
//    charged per side in basis points.
//  - Optional engine-level risk exits (stop loss, take profit, max bars held) are checked on the
//    close and also fill at the next open. After a risk exit the same side is not re-entered until
//    the strategy's target changes.
//  - Buy & hold buys at the close of the first bar with the same costs.

import { computeMetrics, drawdownSeries, pointsDrawdown } from './metrics.js';

export const DEFAULT_OPTIONS = Object.freeze({
  capital: 10000,
  commissionBps: 5,
  slippageBps: 5,
  allowShort: false,
  stopLossPct: 0,
  takeProfitPct: 0,
  maxHoldBars: 0,
  riskFreeRate: 0,
});

/**
 * @param {Array} bars full (adjusted, resampled) bar history
 * @param {{run: Function}} strategy
 * @param {object} params strategy parameters
 * @param {object} options { start, end } bar indices (inclusive) plus DEFAULT_OPTIONS keys
 */
export function runBacktest(bars, strategy, params, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const start = Math.max(0, o.start ?? 0);
  const end = Math.min(bars.length - 1, o.end ?? bars.length - 1);
  if (end - start < 1) throw new Error('Need at least two bars in the selected range');

  const signal = strategy.run(bars, params) || {};
  const target = signal.target || [];
  const pointsMode = o.accounting === 'points';
  const c = pointsMode ? 0 : o.commissionBps / 1e4;
  const slip = pointsMode ? 0 : o.slippageBps / 1e4;
  const stop = o.stopLossPct / 100;
  const take = o.takeProfitPct / 100;
  const flattenAtClose = o.flattenAtClose || null;

  let cash = pointsMode ? 0 : o.capital;
  let qty = 0;
  let side = 0;
  let entry = null;
  let pending = o.initialPending ?? null;
  let pendingReason = pending != null ? 'signal' : '';
  let lockSide = 0;
  const trades = [];
  const times = [];
  const equity = [];
  const positions = [];

  const open = (i, price, s) => {
    if (pointsMode) {
      qty = s;
      side = s;
      entry = { index: i, time: bars[i].time, price, qty: 1, side: s, commission: 0, equity: Math.abs(price) || 1 };
      return;
    }
    const fill = price * (1 + s * slip);
    const notional = cash / (1 + c);
    const commission = notional * c;
    const equityAtEntry = cash;
    qty = (s * notional) / fill;
    cash = cash - s * notional - commission;
    side = s;
    entry = { index: i, time: bars[i].time, price: fill, qty, side: s, commission, equity: equityAtEntry };
  };

  const close = (i, price, reason, final = false) => {
    let fill;
    let pnl;
    if (pointsMode) {
      fill = price;
      const cost = final ? 0 : Number(o.costPoints) || 0;
      pnl = side * (fill - entry.price) - cost;
      cash += pnl;
    } else {
      fill = final ? price : price * (1 - side * slip);
      const commission = final ? 0 : Math.abs(qty) * fill * c;
      cash += qty * fill - commission;
      pnl = side * (fill - entry.price) * Math.abs(qty) - entry.commission - commission;
    }
    trades.push({
      side: side === 1 ? 'long' : 'short',
      entryIndex: entry.index,
      entryTime: entry.time,
      entryPrice: entry.price,
      exitIndex: i,
      exitTime: bars[i].time,
      exitPrice: fill,
      qty: Math.abs(qty),
      pnl,
      points: pointsMode ? pnl : undefined,
      returnPct: (pnl / entry.equity) * 100,
      bars: i - entry.index + (final || reason === 'session' ? 1 : 0),
      reason,
      open: final,
    });
    qty = 0;
    side = 0;
    entry = null;
  };

  const mark = (closePrice) => (pointsMode ? cash + (side !== 0 ? side * (closePrice - entry.price) : 0) : cash + qty * closePrice);

  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (pending !== null && pending !== side) {
      if (side !== 0) close(i, b.open, pendingReason || 'signal');
      if (pending !== 0) open(i, b.open, pending);
    }
    pending = null;
    pendingReason = '';

    const held = side;
    if (side !== 0 && flattenAtClose?.[i]) close(i, b.close, 'session');

    times.push(b.time);
    equity.push(mark(b.close));
    positions.push(held);
    if (i === end) break;

    let desired = side;
    let reason = 'signal';
    const raw = target[i];
    if (raw != null) {
      const t = raw === -1 && !o.allowShort ? 0 : raw;
      if (lockSide && t !== lockSide) lockSide = 0;
      if (!(lockSide && t === lockSide)) desired = t;
    } else if (lockSide) {
      lockSide = 0;
    }
    if (side !== 0) {
      const r = side * (b.close / entry.price - 1);
      const held = i - entry.index + 1;
      let risk = '';
      if (stop > 0 && r <= -stop) risk = 'stop loss';
      else if (take > 0 && r >= take) risk = 'take profit';
      else if (o.maxHoldBars > 0 && held >= o.maxHoldBars) risk = 'max bars';
      if (risk && desired === side) {
        desired = 0;
        reason = risk;
        lockSide = side;
      }
    }
    if (desired !== side) {
      pending = desired;
      pendingReason = reason;
    }
  }

  const openTrade = side !== 0 ? (close(end, bars[end].close, 'open at end', true), trades.pop()) : null;
  // close() above settles cash at the last close with no costs; equity[] already reflects that value.

  const bh = pointsMode ? buyAndHoldPoints(bars, start, end) : buyAndHold(bars, start, end, o.capital, c, slip);
  const metrics = pointsMode
    ? pointsMetrics({ times, equity, trades, positions })
    : computeMetrics({ times, equity, trades, positions, riskFreeRate: o.riskFreeRate, benchmark: bh });
  const bhMetrics = pointsMode
    ? pointsMetrics({ times, equity: bh, trades: [], positions: bh.map(() => 1) })
    : computeMetrics({
      times,
      equity: bh,
      trades: [],
      positions: bh.map(() => 1),
      riskFreeRate: o.riskFreeRate,
    });

  return {
    start,
    end,
    times,
    equity,
    positions,
    trades,
    openTrade,
    benchmark: bh,
    drawdown: pointsMode ? pointsDrawdown(equity) : drawdownSeries(equity),
    benchmarkDrawdown: pointsMode ? pointsDrawdown(bh) : drawdownSeries(bh),
    metrics,
    benchmarkMetrics: bhMetrics,
    signal,
    accounting: pointsMode ? 'points' : 'equity',
  };
}

function pointsMetrics({ times, equity, trades, positions }) {
  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const dd = pointsDrawdown(equity);
  const maxDrawdownPoints = Math.min(0, ...dd);
  const daily = [];
  let dayStart = equity[0];
  for (let i = 1; i <= times.length; i++) {
    const prev = String(times[i - 1]).slice(0, 10);
    const cur = times[i] ? String(times[i]).slice(0, 10) : '';
    if (cur !== prev) {
      daily.push(equity[i - 1] - dayStart);
      dayStart = equity[i - 1];
    }
  }
  const mean = daily.length ? daily.reduce((s, x) => s + x, 0) / daily.length : NaN;
  let sd = NaN;
  if (daily.length > 1) {
    sd = Math.sqrt(daily.reduce((s, x) => s + (x - mean) ** 2, 0) / (daily.length - 1));
  }
  const avg = (arr, pick) => (arr.length ? arr.reduce((s, t) => s + pick(t), 0) / arr.length : NaN);
  return {
    startEquity: equity[0],
    endEquity: equity[equity.length - 1],
    points: equity[equity.length - 1] - equity[0],
    totalReturn: null,
    cagr: null,
    volatility: null,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : NaN,
    sortino: null,
    maxDrawdown: null,
    maxDrawdownPoints,
    calmar: null,
    longestDrawdownDays: null,
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : NaN,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : NaN,
    avgTradePct: avg(closed, (t) => t.pnl),
    avgWinPct: avg(wins, (t) => t.pnl),
    avgLossPct: avg(losses, (t) => t.pnl),
    bestTradePct: closed.length ? Math.max(...closed.map((t) => t.pnl)) : NaN,
    worstTradePct: closed.length ? Math.min(...closed.map((t) => t.pnl)) : NaN,
    avgBarsHeld: avg(closed, (t) => t.bars),
    exposure: positions.length ? positions.filter((p) => p !== 0).length / positions.length : 0,
    beta: null,
    correlation: null,
    periodsPerYear: 252,
    years: null,
  };
}

/** One index unit bought at the first close. The curve is the price change in points. */
export function buyAndHoldPoints(bars, start, end) {
  const base = bars[start].close;
  const out = [];
  for (let i = start; i <= end; i++) out.push(bars[i].close - base);
  return out;
}

export function buyAndHold(bars, start, end, capital, c = 0, slip = 0) {
  const fill = bars[start].close * (1 + slip);
  const notional = capital / (1 + c);
  const units = notional / fill;
  const out = [];
  for (let i = start; i <= end; i++) out.push(units * bars[i].close);
  return out;
}
