// Map a strategy's direction series onto execution bars.
// The strategy stays a signal plug-in: it never sees the session clock.
// A flip is known when its bar closes and is stamped on the next execution
// bar, which is where the engine fills. A 5-minute flip on 1-minute bars is
// stamped on the first 1-minute bar of the next 5-minute bucket.

import { barDate, barMinutes } from '../engine/intraday.js';

function blank(n) {
  return {
    flip: new Array(n).fill(0),
    state: new Array(n).fill(0),
    sigMin: new Array(n).fill(-1),
  };
}

function sameBar(execBars, trend) {
  const n = execBars.length;
  const out = blank(n);
  if (!n) return out;
  const date = execBars.map((b) => barDate(b.time));
  const mins = execBars.map((b) => barMinutes(b.time));
  const lastOfDay = new Array(n).fill(false);
  for (let j = 0; j < n; j++) if (j === n - 1 || date[j + 1] !== date[j]) lastOfDay[j] = true;
  for (let j = 1; j < n; j++) {
    out.state[j] = trend[j - 1] ?? 0;
    const t = trend[j - 1];
    const p = j > 1 ? trend[j - 2] : null;
    if (date[j] === date[j - 1] && !lastOfDay[j - 1] && t != null && p != null && t !== p) {
      out.flip[j] = t;
      out.sigMin[j] = mins[j - 1] ?? -1;
    }
  }
  return out;
}

function bucketed(execBars, signalMinutes, trend) {
  const n = execBars.length;
  const out = blank(n);
  if (!n) return out;
  const date = execBars.map((b) => barDate(b.time));
  const mins = execBars.map((b) => barMinutes(b.time));
  const bucket = mins.map((m) => Math.floor(m / signalMinutes));
  const kOf = new Array(n);
  let k = -1;
  for (let j = 0; j < n; j++) {
    const key = `${date[j]}#${bucket[j]}`;
    const prevKey = j > 0 ? `${date[j - 1]}#${bucket[j - 1]}` : '';
    if (j === 0 || key !== prevKey) k += 1;
    kOf[j] = k;
  }
  if (k + 1 !== trend.length) throw new Error('Signal bars do not match the execution buckets');
  const bDate = [];
  const bMin = [];
  for (let j = 0; j < n; j++) {
    if (j === 0 || kOf[j] !== kOf[j - 1]) {
      bDate.push(date[j]);
      bMin.push(Math.floor(mins[j] / signalMinutes) * signalMinutes);
    }
  }
  const bLast = bDate.map((d, i) => i === bDate.length - 1 || bDate[i + 1] !== d);
  for (let j = 1; j < n; j++) {
    const kk = kOf[j];
    if (kk === 0) continue;
    out.state[j] = trend[kk - 1] ?? 0;
    if (kOf[j - 1] === kk - 1 && bDate[kk - 1] === date[j] && !bLast[kk - 1]) {
      const t = trend[kk - 1];
      const p = kk > 1 ? trend[kk - 2] : null;
      if (t != null && p != null && t !== p) {
        out.flip[j] = t;
        out.sigMin[j] = bMin[kk - 1];
      }
    }
  }
  return out;
}

/**
 * @param {object[]} execBars execution bars (1-minute, or already aggregated)
 * @param {number} execMinutes size of each execution bar
 * @param {number} signalMinutes size of the bars the strategy ran on
 * @param {Array<1|-1|null>} trend strategy direction, one per signal bar
 */
export function alignSignals(execBars, execMinutes, signalMinutes, trend) {
  if (signalMinutes === execMinutes) {
    if (trend.length !== execBars.length) throw new Error('Signal length does not match the bars');
    return sameBar(execBars, trend);
  }
  if (signalMinutes < execMinutes) throw new Error('Signal timeframe is finer than the execution bars');
  return bucketed(execBars, signalMinutes, trend);
}
