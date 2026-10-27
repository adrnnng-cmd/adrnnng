// Performance statistics. Definitions are listed in backtest/README.md and checked by
// backtest/tests/metrics.test.mjs and the independent Python cross-check.

const DAY_MS = 864e5;

/** Date or 'YYYY-MM-DDTHH:mm:ss' (wall clock, no zone). */
export function parseBarTime(t) {
  const s = String(t);
  if (s.length <= 10) return Date.parse(`${s}T00:00:00Z`);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  return Date.parse(`${s}Z`);
}

export function drawdownSeries(equity) {
  let peak = -Infinity;
  return equity.map((v) => {
    if (v > peak) peak = v;
    return peak > 0 ? v / peak - 1 : 0;
  });
}

function yearsBetween(t0, t1) {
  return (parseBarTime(t1) - parseBarTime(t0)) / DAY_MS / 365.25;
}

/** Peak-to-trough in the same units as `equity` (index points, not a ratio). */
export function pointsDrawdown(equity) {
  let peak = -Infinity;
  return equity.map((v) => {
    if (v > peak) peak = v;
    return v - peak;
  });
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function sampleStd(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/**
 * @param {{times: string[], equity: number[], trades: object[], positions: number[],
 *          riskFreeRate?: number, benchmark?: number[]}} input
 */
export function computeMetrics({ times, equity, trades = [], positions = [], riskFreeRate = 0, benchmark }) {
  const n = equity.length;
  const years = yearsBetween(times[0], times[n - 1]);
  // Bars per year estimated from the data: ~252 for US daily, ~365 for crypto, ~52 weekly, ~12 monthly.
  const periodsPerYear = years > 0 ? (n - 1) / years : NaN;
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const rfPer = Math.pow(1 + riskFreeRate, 1 / periodsPerYear) - 1;
  const excess = rets.map((r) => r - rfPer);
  const sd = sampleStd(rets);
  const downside = Math.sqrt(excess.reduce((s, x) => s + Math.min(0, x) ** 2, 0) / excess.length);

  const totalReturn = equity[n - 1] / equity[0] - 1;
  const cagr = years > 0 ? Math.pow(equity[n - 1] / equity[0], 1 / years) - 1 : NaN;
  const dd = drawdownSeries(equity);
  const maxDrawdown = Math.min(0, ...dd);

  let longestDd = 0;
  let ddStart = null;
  for (let i = 0; i < n; i++) {
    if (dd[i] < 0 && ddStart === null) ddStart = i - 1;
    if ((dd[i] === 0 || i === n - 1) && ddStart !== null) {
      const days = (parseBarTime(times[i]) - parseBarTime(times[Math.max(0, ddStart)])) / DAY_MS;
      longestDd = Math.max(longestDd, days);
      ddStart = null;
    }
  }

  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const exposure = positions.length ? positions.filter((p) => p !== 0).length / positions.length : 0;

  let beta = NaN;
  let correlation = NaN;
  if (benchmark && benchmark.length === n && n > 2) {
    const b = [];
    for (let i = 1; i < n; i++) b.push(benchmark[i] / benchmark[i - 1] - 1);
    const ma = mean(rets);
    const mb = mean(b);
    let cov = 0;
    let vb = 0;
    let va = 0;
    for (let i = 0; i < b.length; i++) {
      cov += (rets[i] - ma) * (b[i] - mb);
      vb += (b[i] - mb) ** 2;
      va += (rets[i] - ma) ** 2;
    }
    beta = vb > 0 ? cov / vb : NaN;
    correlation = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
  }

  return {
    startEquity: equity[0],
    endEquity: equity[n - 1],
    totalReturn,
    cagr,
    volatility: sd * Math.sqrt(periodsPerYear),
    sharpe: sd > 0 ? (mean(excess) / sd) * Math.sqrt(periodsPerYear) : NaN,
    sortino: downside > 0 ? (mean(excess) / downside) * Math.sqrt(periodsPerYear) : NaN,
    maxDrawdown,
    calmar: maxDrawdown < 0 ? cagr / -maxDrawdown : NaN,
    longestDrawdownDays: Math.round(longestDd),
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : NaN,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : NaN,
    avgTradePct: closed.length ? mean(closed.map((t) => t.returnPct)) : NaN,
    avgWinPct: wins.length ? mean(wins.map((t) => t.returnPct)) : NaN,
    avgLossPct: losses.length ? mean(losses.map((t) => t.returnPct)) : NaN,
    bestTradePct: closed.length ? Math.max(...closed.map((t) => t.returnPct)) : NaN,
    worstTradePct: closed.length ? Math.min(...closed.map((t) => t.returnPct)) : NaN,
    avgBarsHeld: closed.length ? mean(closed.map((t) => t.bars)) : NaN,
    exposure,
    beta,
    correlation,
    periodsPerYear,
    years,
  };
}

/** Calendar-month returns of an equity curve: [{ year, month (0-11), ret }], plus yearly totals.
 *  `absolute: true` stores point changes instead of ratios. */
export function periodReturns(times, equity, { absolute = false } = {}) {
  const months = [];
  const years = [];
  let mStart = equity[0];
  let yStart = equity[0];
  const delta = (end, start) => (absolute ? end - start : end / start - 1);
  for (let i = 1; i <= times.length; i++) {
    const prev = times[i - 1];
    const cur = times[i];
    if (!cur || cur.slice(0, 7) !== prev.slice(0, 7)) {
      months.push({ year: +prev.slice(0, 4), month: +prev.slice(5, 7) - 1, ret: delta(equity[i - 1], mStart) });
      mStart = equity[i - 1];
    }
    if (!cur || cur.slice(0, 4) !== prev.slice(0, 4)) {
      years.push({ year: +prev.slice(0, 4), ret: delta(equity[i - 1], yStart) });
      yStart = equity[i - 1];
    }
  }
  return { months, years };
}
