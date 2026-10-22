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
  let closed = 0;
  const trackCosts = spec.trackCosts === true;
  const splitYears = spec.splitYears === true;
  const trackDays = spec.trackDays === true;
  const dayRows = trackDays ? [] : null;
  const hourAll = trackDays ? new Map() : null;
  const hourYears = trackDays ? new Map() : null;
  let dayBase = 0;
  let dayMin = 0;
  let dayGross = 0;
  let dayTrades = 0;
  let dayWins = 0;
  let dayGw = 0;
  let dayGl = 0;
  let dayHold = 0;

  const bumpHour = (map, hour, points) => {
    let row = map.get(hour);
    if (!row) {
      row = { t: 0, w: 0, g: 0 };
      map.set(hour, row);
    }
    row.t += 1;
    if (points > 0) row.w += 1;
    row.g += points;
  };
  let real6 = 0;
  let real8 = 0;
  let peak6 = 0;
  let dd6 = 0;
  let peak8 = 0;
  let dd8 = 0;
  const yearMap = splitYears ? new Map() : null;

  const closeAt = (j, px, reason) => {
    const points = pos * (px - ep);
    const holdMinutes = (j - ej) + (reason === 'eod' ? 1 : 0);
    const entryHour = Math.floor(mins[ej] / 60);
    real += points;
    if (trackCosts) {
      real6 += points - 6;
      real8 += points - 8;
    }
    closed += 1;
    trades.push({
      points,
      holdMinutes,
      year: date[ej].slice(0, 4),
      entryHour,
    });
    if (trackDays && inRange[j]) {
      dayGross += points;
      dayTrades += 1;
      dayHold += holdMinutes;
      if (points > 0) {
        dayWins += 1;
        dayGw += points;
      } else if (points < 0) dayGl -= points;
      bumpHour(hourAll, entryHour, points);
      const year = date[j].slice(0, 4);
      let yearHours = hourYears.get(year);
      if (!yearHours) {
        yearHours = new Map();
        hourYears.set(year, yearHours);
      }
      bumpHour(yearHours, entryHour, points);
    }
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
      if (trackDays) {
        dayBase = real;
        dayMin = Infinity;
        dayGross = 0;
        dayTrades = 0;
        dayWins = 0;
        dayGw = 0;
        dayGl = 0;
        dayHold = 0;
      }
    }
    const tradable = inRange[j] && mins[j] >= windowStart && mins[j] < windowEnd;
    let yearRow = null;
    if (yearMap && inRange[j]) {
      const y = date[j].slice(0, 4);
      yearRow = yearMap.get(y);
      if (!yearRow) {
        yearRow = {
          base: real,
          base6: real6,
          base8: real8,
          closed0: closed,
          days: new Set(),
          equity: [],
          peak: 0,
          dd: 0,
          peak6: 0,
          dd6: 0,
          peak8: 0,
          dd8: 0,
        };
        yearMap.set(y, yearRow);
      }
      yearRow.days.add(date[j]);
    }
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
      const unreal = pos ? pos * (dayBars[j].close - ep) : 0;
      const eq = real + unreal;
      if (eq > peak) peak = eq;
      if (eq - peak < dd) dd = eq - peak;
      let eq6 = 0;
      let eq8 = 0;
      if (trackCosts) {
        eq6 = real6 + unreal;
        eq8 = real8 + unreal;
        if (eq6 > peak6) peak6 = eq6;
        if (eq6 - peak6 < dd6) dd6 = eq6 - peak6;
        if (eq8 > peak8) peak8 = eq8;
        if (eq8 - peak8 < dd8) dd8 = eq8 - peak8;
      }
      if (yearRow) {
        const rel = eq - yearRow.base;
        if (rel > yearRow.peak) yearRow.peak = rel;
        if (rel - yearRow.peak < yearRow.dd) yearRow.dd = rel - yearRow.peak;
        if (trackCosts) {
          const rel6 = eq6 - yearRow.base6;
          const rel8 = eq8 - yearRow.base8;
          if (rel6 > yearRow.peak6) yearRow.peak6 = rel6;
          if (rel6 - yearRow.peak6 < yearRow.dd6) yearRow.dd6 = rel6 - yearRow.peak6;
          if (rel8 > yearRow.peak8) yearRow.peak8 = rel8;
          if (rel8 - yearRow.peak8 < yearRow.dd8) yearRow.dd8 = rel8 - yearRow.peak8;
        }
      }
      if (trackDays) {
        const rel = eq - dayBase;
        if (rel < dayMin) dayMin = rel;
      }
      if (lastInRange[j]) {
        equity.push({ date: date[j], points: eq, trades: closed });
        if (yearRow) yearRow.equity.push({ date: date[j], points: eq - yearRow.base, trades: closed - yearRow.closed0 });
        if (trackDays) {
          dayRows.push({
            date: date[j],
            g: dayGross,
            t: dayTrades,
            w: dayWins,
            gw: dayGw,
            gl: dayGl,
            h: dayHold,
            mn: dayMin === Infinity ? 0 : dayMin,
          });
        }
      }
    }
  }

  const result = { trades, sessionDays: days.size, grossPoints: real, maxDrawdownPoints: dd, equity };
  if (trackCosts) {
    result.maxDrawdownAt6 = dd6;
    result.maxDrawdownAt8 = dd8;
  }
  if (trackDays) {
    result.days = dayRows;
    result.hours = { all: hourAll, years: hourYears };
  }
  if (yearMap) {
    const years = {};
    for (const [y, row] of yearMap) {
      years[y] = {
        sessionDays: row.days.size,
        maxDrawdownPoints: row.dd,
        maxDrawdownAt6: row.dd6,
        maxDrawdownAt8: row.dd8,
        equity: row.equity,
      };
    }
    result.years = years;
  }
  return result;
}
