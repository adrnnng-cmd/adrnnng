// Entry and exit signals aligned to day-session 1-minute bars.
//
// A flip is known at the signal bar's close and is filled at the next bar's
// open, and only on that same date. The last bar of a day never opens a new
// position. A 5-minute flip is filled at the first 1-minute open of the next
// 5-minute bucket (13:00 is the next open after the 11:55 bucket).
//
// state[j] is the trend of the last completed bar as of the open of bar j:
// the previous 1-minute bar, or the previous 5-minute bucket. It is what a
// clock entry is allowed to see. The first 5-minute bucket of the whole
// series has no completed bucket yet, so its state stays 0.

import { atrSupertrend } from '../../backtest/strategies/atr-supertrend.js';
import { barDate, barMinutes, resampleMinutes } from '../../backtest/engine/intraday.js';

function blank(n) {
  return {
    flip: new Array(n).fill(0),
    state: new Array(n).fill(0),
    sigMin: new Array(n).fill(-1),
  };
}

export function buildSignals(dayBars, timeframe, params) {
  const tf = Number(timeframe);
  if (tf === 1) return signals1m(dayBars, params);
  if (tf === 5) return signals5m(dayBars, params);
  throw new Error(`Unsupported timeframe ${timeframe}`);
}

function signals1m(dayBars, params) {
  const n = dayBars.length;
  const out = blank(n);
  if (!n) return out;
  const date = dayBars.map((b) => barDate(b.time));
  const mins = dayBars.map((b) => barMinutes(b.time));
  const lastOfDay = new Array(n).fill(false);
  for (let j = 0; j < n; j++) if (j === n - 1 || date[j + 1] !== date[j]) lastOfDay[j] = true;
  const trend = atrSupertrend(dayBars, params).trend;
  for (let j = 1; j < n; j++) {
    out.state[j] = trend[j - 1] ?? 0;
    const t = trend[j - 1];
    const p = j > 1 ? trend[j - 2] : null;
    if (date[j] === date[j - 1] && !lastOfDay[j - 1] && t != null && p != null && t !== p) {
      out.flip[j] = t;
      out.sigMin[j] = mins[j - 1];
    }
  }
  return out;
}

function signals5m(dayBars, params) {
  const n = dayBars.length;
  const out = blank(n);
  if (!n) return out;
  const date = dayBars.map((b) => barDate(b.time));
  const mins = dayBars.map((b) => barMinutes(b.time));
  const b5 = resampleMinutes(dayBars, 5);
  const k5 = new Array(n);
  let k = -1;
  for (let j = 0; j < n; j++) {
    const key = `${date[j]}#${Math.floor(mins[j] / 5)}`;
    const prevKey = j > 0 ? `${date[j - 1]}#${Math.floor(mins[j - 1] / 5)}` : '';
    if (j === 0 || key !== prevKey) k += 1;
    k5[j] = k;
  }
  if (k + 1 !== b5.length) throw new Error('5m bucket mismatch');
  const b5date = b5.map((b) => barDate(b.time));
  const b5min = b5.map((b) => barMinutes(b.time));
  const b5last = b5.map((_, i) => i === b5.length - 1 || b5date[i + 1] !== b5date[i]);
  const trend = atrSupertrend(b5, params).trend;
  for (let j = 1; j < n; j++) {
    const kk = k5[j];
    if (kk === 0) continue;
    out.state[j] = trend[kk - 1] ?? 0;
    if (k5[j - 1] === kk - 1 && b5date[kk - 1] === date[j] && !b5last[kk - 1]) {
      const t = trend[kk - 1];
      const p = kk > 1 ? trend[kk - 2] : null;
      if (t != null && p != null && t !== p) {
        out.flip[j] = t;
        out.sigMin[j] = b5min[kk - 1];
      }
    }
  }
  return out;
}
