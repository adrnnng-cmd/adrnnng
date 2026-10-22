// Build the precomputed grid from day-session bars. One simulation covers
// 2020 through the current year; each calendar year is sliced from that run.
// ALL is the same run, not a stitch of the years. No prices are written.

import { filterDaySession } from '../../backtest/engine/intraday.js';
import { buildSignals } from './signals.js';
import { simulateHsi } from './simulate.js';
import {
  ATR_LENGTHS,
  ENTRY_CHOICES,
  EXIT_CHOICES,
  FACTOR,
  FIRST_YEAR,
  SMOOTHING,
  TIMEFRAMES,
  WINDOW_END_MIN,
  WINDOW_START_MIN,
  archiveYears,
  comboKey,
  currentYear,
} from './grid.js';
import { compactCell, emptyCell } from './results.js';

export function studySpec(now = new Date()) {
  const end = currentYear(now);
  return {
    entryRule: 'flip',
    exitRule: 'flat',
    clock: null,
    clockMin: null,
    windowStartMin: WINDOW_START_MIN,
    windowEndMin: WINDOW_END_MIN,
    from: `${FIRST_YEAR}-01-01`,
    to: `${end}-12-31`,
    trackCosts: true,
    splitYears: true,
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

function cellFor(raw, range) {
  if (range !== 'all' && !raw.years?.[String(range)]) return emptyCell(0);
  return compactCell(raw, range);
}

/**
 * Simulate every exit and rule for one entry timeframe and ATR.
 * `ranges` is a list of 'all' and/or year strings. The tape is still read
 * across the whole window, because ALL is one continuous run.
 */
export function computeEntryGroup(dayBars, { entryTimeframe, atrLength, ranges, now = new Date() }) {
  const entry = buildSignals(dayBars, entryTimeframe, { atrLength, factor: FACTOR, smoothing: SMOOTHING });
  const signals = new Map([[`${entryTimeframe}:${atrLength}`, entry]]);
  const signalFor = (tf, atr) => {
    const key = `${tf}:${atr}`;
    if (!signals.has(key)) {
      signals.set(key, buildSignals(dayBars, tf, { atrLength: atr, factor: FACTOR, smoothing: SMOOTHING }));
    }
    return signals.get(key);
  };
  const bundles = {};
  for (const range of ranges) {
    bundles[range] = {
      v: 1,
      entryTimeframe,
      atrLength,
      range: String(range),
      rows: {},
    };
  }
  for (const job of jobsForEntry(entryTimeframe, atrLength)) {
    const exit = signalFor(job.exitTimeframe, job.exitAtrLength);
    const raw = simulateHsi(dayBars, entry, exit, specFor(job, now));
    const id = comboKey(job);
    for (const range of ranges) bundles[range].rows[id] = cellFor(raw, range);
  }
  return { entryTimeframe, atrLength, bundles };
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
