// Turn entry and exit signals into the position the engine should hold.
// Strategies do not call this. Composition does.
//
// target[i] is the position wanted after bar i closes (filled at the next open).
// flattenAtClose[i] exits at bar i's close, which is how a day session ends.

import { barDate, barMinutes, HSI_DAY_SESSION } from '../engine/intraday.js';

export function parseClock(value, label = 'Clock') {
  if (typeof value !== 'string') throw new Error(`${label} must be HH:MM`);
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must be HH:MM`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) throw new Error(`${label} must be HH:MM`);
  return h * 60 + m;
}

/**
 * @param {object[]} bars day-session execution bars
 * @param {{flip:number[], state:number[], sigMin:number[]}} entry
 * @param {{flip:number[], state:number[], sigMin:number[]}} exit
 * @param {object} spec entryRule, exitRule, clock, from, to, window, flattenEod
 */
export function sessionPlan(bars, entry, exit, spec) {
  const n = bars.length;
  const target = new Array(n).fill(null);
  const flattenAtClose = new Array(n).fill(false);
  if (!n) return { target, flattenAtClose };

  const date = bars.map((b) => barDate(b.time));
  const mins = bars.map((b) => barMinutes(b.time));
  const inRange = date.map((d) => (!spec.from || d >= spec.from) && (!spec.to || d <= spec.to));
  const windowStart = spec.windowStartMin ?? HSI_DAY_SESSION.morningOpenMin;
  const windowEnd = spec.windowEndMin ?? HSI_DAY_SESSION.dayCloseMin;
  const flattenEod = spec.flattenEod !== false;

  const sessionEnd = new Array(n).fill(false);
  let lastFlat = -1;
  let prevDate = null;
  const flush = () => {
    if (lastFlat >= 0) sessionEnd[lastFlat] = true;
  };
  for (let j = 0; j < n; j++) {
    if (date[j] !== prevDate) {
      flush();
      lastFlat = -1;
      prevDate = date[j];
    }
    if (inRange[j] && mins[j] != null && mins[j] >= windowStart && mins[j] < windowEnd) lastFlat = j;
  }
  flush();

  let pos = 0;
  let orig = 0;
  let opened = false;
  let done = false;
  let clockTaken = false;

  for (let j = 0; j < n; j++) {
    if (j === 0 || date[j] !== date[j - 1]) {
      done = false;
      clockTaken = false;
      orig = 0;
      opened = false;
    }
    const tradable = inRange[j] && mins[j] != null && mins[j] >= windowStart && mins[j] < windowEnd;
    let next = pos;
    if (pos !== 0 && tradable && exit.flip[j] === -pos) {
      next = 0;
      if (spec.exitRule === 'flat') done = true;
    }
    if (next === 0 && !done && tradable && !(flattenEod && sessionEnd[j])) {
      if (!opened) {
        if (spec.entryRule === 'clock') {
          if (!clockTaken && mins[j] >= spec.clockMin) {
            clockTaken = true;
            const side = entry.state[j];
            if (side) next = side;
            else done = true;
          }
        } else if (spec.entryRule === 'firstFlip') {
          if (entry.flip[j] && entry.sigMin[j] >= spec.clockMin) next = entry.flip[j];
        } else if (spec.entryRule === 'flip' && entry.flip[j]) {
          next = entry.flip[j];
        }
      } else if (spec.exitRule === 'reenter') {
        if (orig && entry.flip[j] === orig) next = orig;
      } else if (spec.exitRule === 'reverse' && entry.flip[j]) {
        next = entry.flip[j];
      }
    }
    if (next !== pos) {
      if (j > 0) target[j - 1] = next;
      if (next !== 0) {
        if (!orig) orig = next;
        opened = true;
      }
      pos = next;
    }
    if (flattenEod && sessionEnd[j] && pos !== 0) {
      flattenAtClose[j] = true;
      target[j] = 0;
      pos = 0;
    }
  }
  return { target, flattenAtClose };
}
