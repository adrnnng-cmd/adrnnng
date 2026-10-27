// Indicator helpers. Each takes a number array and returns an array of the same length,
// with null where the indicator is not yet defined (warm-up).

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * TradingView `ta.ema`: seed equals the first finite value, then
 * ema = alpha * src + (1 - alpha) * prev, alpha = 2 / (period + 1).
 * Nulls are ignored and do not reset the recursion. This is not `ema()` below,
 * which SMA-seeds; ATR SuperTrend follows `ta.ema`.
 */
export function pineEma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1) return out;
  const alpha = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * TradingView `ta.rma` (Wilder). Seeds with the SMA of the first `period`
 * finite values, then (src + (period - 1) * prev) / period. Nulls are ignored.
 */
export function rma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1) return out;
  let sum = 0;
  let count = 0;
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (prev == null) {
      sum += v;
      count++;
      if (count === period) {
        prev = sum / period;
        out[i] = prev;
      }
    } else {
      prev = (v + (period - 1) * prev) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** True range. Bar 0 is high-low; later bars include the previous close. */
export function trueRange(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const hl = b.high - b.low;
    if (i === 0) {
      out[i] = hl;
      continue;
    }
    const prev = bars[i - 1].close;
    out[i] = Math.max(hl, Math.abs(b.high - prev), Math.abs(b.low - prev));
  }
  return out;
}

/** Wilder ATR: RMA of true range. The SuperTrend factor is applied by the strategy. */
export function atr(bars, period) {
  return rma(trueRange(bars), period);
}

/** EMA seeded with the SMA of the first `period` values. Null inputs are skipped until the first value. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < period) return out;
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i];
  let prev = seed / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI (the TradingView / original definition). */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const val = () => (avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL));
  out[period] = val();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = val();
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

/** Population standard deviation over a rolling window (Bollinger's definition). */
export function rollingStd(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = 0;
    for (let j = i - period + 1; j <= i; j++) m += values[j];
    m /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = rollingStd(values, period);
  return {
    mid,
    upper: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
    lower: mid.map((m, i) => (m == null ? null : m - mult * sd[i])),
  };
}

/** Highest high / lowest low of the `period` bars *before* bar i (excludes bar i itself). */
export function donchian(highs, lows, period) {
  const upper = new Array(highs.length).fill(null);
  const lower = new Array(highs.length).fill(null);
  for (let i = period; i < highs.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}
