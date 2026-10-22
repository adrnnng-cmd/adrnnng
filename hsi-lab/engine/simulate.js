// Point simulator for one index unit. No prices leave this module's caller:
// a trade keeps points, hold (in 1-minute bars), entry year, and entry hour.
//
// Fills match the exit-variant study. Exits are processed before entries on
// the same bar. A flip fills at that bar's open. The last bar inside the
// trading window flattens at its close, which adds one minute to the hold.
// Mark-to-market drawdown uses the 1-minute close. The published curve keeps
// only the equity at each session date after that flatten.

import { barDate, barMinutes } from '../../backtest/engine/intraday.js';

function emptyRaw() {
  return { trades: [], sessionDays: 0, grossPoints: 0, maxDrawdownPoints: 0, equity: [] };
}

/**
 * @param {object[]} dayBars day-session 1-minute bars, ascending
 * @param {{flip:number[], state:number[], sigMin:number[]}} entry
 * @param {{flip:number[], state:number[], sigMin:number[]}} exit
 * @param {object} spec validated run spec
 */
export function simulateHsi(dayBars, entry, exit, spec) {
  const n = dayBars.length;
  if (!n) return emptyRaw();
  const date = dayBars.map((b) => barDate(b.time));
  const mins = dayBars.map((b) => barMinutes(b.time));
  const inRange = date.map((d) => (!spec.from || d >= spec.from) && (!spec.to || d <= spec.to));
  const windowStart = spec.windowStartMin;
  const windowEnd = spec.windowEndMin;

  const flattenAt = new Array(n).fill(false);
  const lastInRange = new Array(n).fill(false);
  let lastFlat = -1;
  let lastRange = -1;
  let prevDate = null;
  const flush = () => {
    if (lastFlat >= 0) flattenAt[lastFlat] = true;
    if (lastRange >= 0) lastInRange[lastRange] = true;
  };
  for (let j = 0; j < n; j++) {
    if (date[j] !== prevDate) {
      flush();
      lastFlat = -1;
      lastRange = -1;
      prevDate = date[j];
    }
    if (inRange[j]) {
      lastRange = j;
      if (mins[j] >= windowStart && mins[j] < windowEnd) lastFlat = j;
    }
  }
  flush();

  const days = new Set();
  for (let j = 0; j < n; j++) if (inRange[j]) days.add(date[j]);

  const trades = [];
  const equity = [];
  let pos = 0;
  let ep = 0;
  let ej = 0;
  let orig = 0;
  let opened = false;
  let done = false;
  let clockTaken = false;
  let real = 0;
  let peak = 0;
  let dd = 0;

  const closeAt = (j, px, reason) => {
    const points = pos * (px - ep);
    real += points;
    trades.push({
      points,
      holdMinutes: (j - ej) + (reason === 'eod' ? 1 : 0),
      year: date[ej].slice(0, 4),
      entryHour: Math.floor(mins[ej] / 60),
    });
    pos = 0;
  };

  const openAt = (j, side) => {
    pos = side;
    ep = dayBars[j].open;
    ej = j;
    if (!orig) orig = side;
    opened = true;
  };

  for (let j = 0; j < n; j++) {
    if (j === 0 || date[j] !== date[j - 1]) {
      done = false;
      clockTaken = false;
      orig = 0;
      opened = false;
    }
    const tradable = inRange[j] && mins[j] >= windowStart && mins[j] < windowEnd;
    if (pos !== 0 && j > ej && tradable && exit.flip[j] === -pos) {
      closeAt(j, dayBars[j].open, 'x');
      if (spec.exitRule === 'flat') done = true;
    }
    if (pos === 0 && !done && tradable && !flattenAt[j]) {
      if (!opened) {
        if (spec.entryRule === 'clock') {
          if (!clockTaken && mins[j] >= spec.clockMin) {
            clockTaken = true;
            const side = entry.state[j];
            if (side) openAt(j, side);
            else done = true;
          }
        } else if (spec.entryRule === 'firstFlip') {
          if (entry.flip[j] && entry.sigMin[j] >= spec.clockMin) openAt(j, entry.flip[j]);
        } else if (spec.entryRule === 'flip' && entry.flip[j]) {
          openAt(j, entry.flip[j]);
        }
      } else if (spec.exitRule === 'reenter') {
        if (orig && entry.flip[j] === orig) openAt(j, orig);
      } else if (spec.exitRule === 'reverse' && entry.flip[j]) {
        openAt(j, entry.flip[j]);
      }
    }
    if (flattenAt[j] && pos !== 0) closeAt(j, dayBars[j].close, 'eod');
    if (inRange[j]) {
      const eq = real + (pos ? pos * (dayBars[j].close - ep) : 0);
      if (eq > peak) peak = eq;
      if (eq - peak < dd) dd = eq - peak;
      if (lastInRange[j]) equity.push({ date: date[j], points: eq });
    }
  }

  return { trades, sessionDays: days.size, grossPoints: real, maxDrawdownPoints: dd, equity };
}
