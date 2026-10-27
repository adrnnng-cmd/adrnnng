// Composition: higher-timeframe confirm, entry, exit, session.
// Strategies emit a direction. This module is the only place that turns those
// directions into a target[] for the engine. Strategies do not call each other.

import { filterDaySession, resampleMinutes, toDaily, HSI_DAY_SESSION } from '../engine/intraday.js';
import { INTRADAY_MINUTES, isIntradayTimeframe } from '../symbols.js';
import { alignSignals } from './align.js';
import { gateEntries } from './confirm.js';
import { parseClock, sessionPlan } from './session.js';

const TF_MINUTES = INTRADAY_MINUTES;

function trendOf(out) {
  return out.signal || out.target || [];
}

function mapMarkers(markers, tfBars, execBars) {
  if (!markers?.length) return [];
  if (tfBars.length === execBars.length && tfBars[0]?.time === execBars[0]?.time) return markers;
  const at = new Map(execBars.map((b, i) => [b.time, i]));
  const out = [];
  for (const m of markers) {
    const time = tfBars[m.index]?.time;
    const index = time != null ? at.get(time) : undefined;
    if (index != null) out.push({ ...m, index });
  }
  return out;
}

function mapOverlay(execBars, tfBars, values) {
  if (!values) return [];
  if (tfBars.length === execBars.length) return values.slice();
  const out = new Array(execBars.length).fill(null);
  let k = 0;
  for (let j = 0; j < execBars.length; j++) {
    while (k + 1 < tfBars.length && tfBars[k + 1].time <= execBars[j].time) k += 1;
    if (tfBars[k] && tfBars[k].time <= execBars[j].time) out[j] = values[k];
  }
  return out;
}

function seriesFor(sessionBars, minutes) {
  return minutes === 1 ? sessionBars : resampleMinutes(sessionBars, minutes);
}

/**
 * @returns {{
 *   bars: object[],
 *   signal: object,
 *   accounting: 'equity' | 'points',
 *   flattenAtClose: boolean[] | null,
 * }}
 */
export function compose({ bars, strategy, params, spec }) {
  const entryTf = spec.entryTimeframe || '1d';
  const exitTf = spec.exitTimeframe || entryTf;
  const session = spec.entryRule && spec.entryRule !== 'signal' && (isIntradayTimeframe(entryTf) || isIntradayTimeframe(exitTf));
  if (!session) {
    const signal = strategy.run(bars, params) || {};
    return {
      bars,
      signal: { ...signal, target: signal.target || signal.signal || [] },
      accounting: 'equity',
      flattenAtClose: null,
    };
  }

  const sessionBars = filterDaySession(bars);
  const entryMin = TF_MINUTES[entryTf];
  const exitMin = TF_MINUTES[exitTf] || entryMin;
  const execMin = Math.min(entryMin, exitMin);
  const exec = seriesFor(sessionBars, execMin);
  const entryBars = entryMin === execMin ? exec : seriesFor(sessionBars, entryMin);
  const exitAtr = spec.exitAtrLength;
  const exitParams = exitAtr != null && Number(exitAtr) !== Number(params.atrLength) ? { ...params, atrLength: Number(exitAtr) } : params;
  const exitBars = exitMin === execMin ? exec : seriesFor(sessionBars, exitMin);
  const sameRun = entryBars === exitBars && exitParams === params;
  const entryOut = strategy.run(entryBars, params) || {};
  const exitOut = sameRun ? entryOut : strategy.run(exitBars, exitParams) || {};

  let entrySig = alignSignals(exec, execMin, entryMin, trendOf(entryOut));
  const exitSig = sameRun && exitMin === entryMin ? entrySig : alignSignals(exec, execMin, exitMin, trendOf(exitOut));

  if (spec.confirm === 'daily') {
    const daily = toDaily(sessionBars);
    const dailyOut = strategy.run(daily, params) || {};
    entrySig = gateEntries(exec, entrySig, daily, trendOf(dailyOut));
  }

  const plan = sessionPlan(exec, entrySig, exitSig, {
    entryRule: spec.entryRule,
    exitRule: spec.exitRule || 'reenter',
    clockMin: parseClock(spec.clock || '09:30'),
    from: spec.from || '',
    to: spec.to || '',
    windowStartMin: spec.windowStartMin ?? HSI_DAY_SESSION.morningOpenMin,
    windowEndMin: spec.windowEndMin ?? HSI_DAY_SESSION.dayCloseMin,
    flattenEod: spec.flattenEod !== false,
  });

  const overlays = (entryOut.overlays || []).map((o) => ({
    ...o,
    values: mapOverlay(exec, entryBars, o.values),
  }));

  return {
    bars: exec,
    signal: {
      target: plan.target,
      markers: mapMarkers(entryOut.markers, entryBars, exec),
      overlays,
      panes: [],
    },
    accounting: 'points',
    flattenAtClose: plan.flattenAtClose,
  };
}
