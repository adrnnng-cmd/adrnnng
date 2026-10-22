// Build the precomputed grid from day-session bars. One simulation covers
// the whole tape. Each combo keeps one number per session day, and the
// lookup slices a year or a custom pair of dates from that series.
// No prices are written.

import { barDate, filterDaySession } from '../../backtest/engine/intraday.js';
import { buildSignals } from './signals.js';
import { simulateHsi } from './simulate.js';
import {
  ATR_LENGTHS,
  DATA_START,
  ENTRY_CHOICES,
  EXIT_CHOICES,
  FACTOR,
  SMOOTHING,
  TIMEFRAMES,
  WINDOW_END_MIN,
  WINDOW_START_MIN,
  archiveYears,
  comboKey,
  currentYear,
} from './grid.js';

export function studySpec(now = new Date()) {
  const end = currentYear(now);
  return {
    entryRule: 'flip',
    exitRule: 'flat',
    clock: null,
    clockMin: null,
    windowStartMin: WINDOW_START_MIN,
    windowEndMin: WINDOW_END_MIN,
    from: DATA_START,
    to: `${end}-12-31`,
    trackDays: true,
  };
}

function specFor(job, now) {
  const spec = studySpec(now);
  spec.entryRule = job.entryRule;
  spec.exitRule = job.exitRule;
  spec.clock = job.clock;
  spec.clockMin = job.clock == null ? null : Number(job.clock.slice(0, 2)) * 60 + Number(job.clock.slice(3));
  return spec;
}

function jobsForEntry(entryTimeframe, atrLength) {
  const jobs = [];
  for (const exitTimeframe of TIMEFRAMES) {
    const exitAtrs = exitTimeframe === entryTimeframe ? [atrLength] : ATR_LENGTHS;
    for (const exitAtrLength of exitAtrs) {
      for (const entry of ENTRY_CHOICES) {
        for (const exit of EXIT_CHOICES) {
          jobs.push({
            entryTimeframe,
            atrLength,
            exitTimeframe,
            exitAtrLength,
            entryRule: entry.entryRule,
            clock: entry.clock,
            exitRule: exit.id,
          });
        }
      }
    }
  }
  return jobs;
}

function hourList(map) {
  if (!map || !map.size) return [];
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([hour, row]) => [hour, row.t, row.w, row.g]);
}

export function sessionDates(dayBars, now = new Date()) {
  const from = DATA_START;
  const to = `${currentYear(now)}-12-31`;
  const dates = [];
  let prev = '';
  for (let i = 0; i < dayBars.length; i++) {
    const date = barDate(dayBars[i].time);
    if (!date || date === prev) continue;
    prev = date;
    if (date >= from && date <= to) dates.push(date);
  }
  return dates;
}

function blankRow(count) {
  return {
    g: new Array(count).fill(0),
    t: new Array(count).fill(0),
    w: new Array(count).fill(0),
    gw: new Array(count).fill(0),
    gl: new Array(count).fill(0),
    h: new Array(count).fill(0),
    mn: new Array(count).fill(0),
    hours: { all: [], years: {} },
  };
}

function fillRow(count, raw, index) {
  const row = blankRow(count);
  for (const day of raw.days || []) {
    const at = index.get(day.date);
    if (at == null) continue;
    row.g[at] = day.g;
    row.t[at] = day.t;
    row.w[at] = day.w;
    row.gw[at] = day.gw;
    row.gl[at] = day.gl;
    row.h[at] = day.h;
    row.mn[at] = day.mn;
  }
  const years = {};
  for (const [year, map] of raw.hours?.years || []) years[year] = hourList(map);
  row.hours = { all: hourList(raw.hours?.all), years };
  return row;
}

/**
 * Simulate every exit and rule for one entry timeframe and ATR.
 * The bundle is the full daily series. Callers gzip one key per entry pair.
 */
export function computeEntryGroup(dayBars, { entryTimeframe, atrLength, now = new Date() }) {
  const dates = sessionDates(dayBars, now);
  const index = new Map(dates.map((date, at) => [date, at]));
  const entry = buildSignals(dayBars, entryTimeframe, { atrLength, factor: FACTOR, smoothing: SMOOTHING });
  const signals = new Map([[`${entryTimeframe}:${atrLength}`, entry]]);
  const signalFor = (tf, atr) => {
    const key = `${tf}:${atr}`;
    if (!signals.has(key)) {
      signals.set(key, buildSignals(dayBars, tf, { atrLength: atr, factor: FACTOR, smoothing: SMOOTHING }));
    }
    return signals.get(key);
  };
  const rows = {};
  for (const job of jobsForEntry(entryTimeframe, atrLength)) {
    const exit = signalFor(job.exitTimeframe, job.exitAtrLength);
    const raw = simulateHsi(dayBars, entry, exit, specFor(job, now));
    rows[comboKey(job)] = fillRow(dates.length, raw, index);
  }
  return {
    entryTimeframe,
    atrLength,
    bundle: { v: 2, entryTimeframe, atrLength, days: dates, rows },
  };
}

export function prepareDayBars(bars) {
  return filterDaySession(bars);
}

export function requestedRanges(years, now = new Date()) {
  const allowed = new Set(archiveYears(now).map(String));
  if (!years || !years.length) return [...allowed, 'all'];
  const out = [];
  for (const year of years) {
    const text = String(year);
    if (!allowed.has(text)) {
      throw new Error(`Year ${text} is outside 2020 through ${currentYear(now)}.`);
    }
    out.push(text);
  }
  out.push('all');
  return out;
}

export function entryGroups() {
  const groups = [];
  for (const entryTimeframe of TIMEFRAMES) {
    for (const atrLength of ATR_LENGTHS) groups.push({ entryTimeframe, atrLength });
  }
  return groups;
}
