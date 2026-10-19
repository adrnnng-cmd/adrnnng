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

import { computeMetrics, drawdownSeries } from './metrics.js';

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
  const c = o.commissionBps / 1e4;
  const slip = o.slippageBps / 1e4;
  const stop = o.stopLossPct / 100;
  const take = o.takeProfitPct / 100;

  let cash = o.capital;
  let qty = 0;
  let side = 0;
  let entry = null;
  let pending = null;
  let pendingReason = '';
  let lockSide = 0;
  const trades = [];
  const times = [];
  const equity = [];
  const positions = [];

  const open = (i, price, s) => {
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
    const fill = final ? price : price * (1 - side * slip);
    const commission = final ? 0 : Math.abs(qty) * fill * c;
    cash += qty * fill - commission;
    const pnl = side * (fill - entry.price) * Math.abs(qty) - entry.commission - commission;
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
      returnPct: (pnl / entry.equity) * 100,
      bars: i - entry.index + (final ? 1 : 0),
      reason,
      open: final,
    });
    qty = 0;
    side = 0;
    entry = null;
  };

  for (let i = start; i <= end; i++) {
    const b = bars[i];
    if (pending !== null && pending !== side) {
      if (side !== 0) close(i, b.open, pendingReason || 'signal');
      if (pending !== 0) open(i, b.open, pending);
    }
    pending = null;
    pendingReason = '';

    times.push(b.time);
    equity.push(cash + qty * b.close);
    positions.push(side);
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

  const bh = buyAndHold(bars, start, end, o.capital, c, slip);
  const metrics = computeMetrics({ times, equity, trades, positions, riskFreeRate: o.riskFreeRate, benchmark: bh });
  const bhMetrics = computeMetrics({
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
    drawdown: drawdownSeries(equity),
    benchmarkDrawdown: drawdownSeries(bh),
    metrics,
    benchmarkMetrics: bhMetrics,
    signal,
  };
}

export function buyAndHold(bars, start, end, capital, c = 0, slip = 0) {
  const fill = bars[start].close * (1 + slip);
  const notional = capital / (1 + c);
  const units = notional / fill;
  const out = [];
  for (let i = start; i <= end; i++) out.push(units * bars[i].close);
  return out;
}
