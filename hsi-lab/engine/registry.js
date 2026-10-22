// Strategy plug-ins for the lab. Each build() returns entry and exit signal
// series aligned to the same 1-minute day-session bars. The simulator does
// not know which indicator produced them.
//
// ATR length is chosen per series. Factor and smoothing are shared. To add a
// strategy, append an object here and list it on the lab page.

import { buildSignals } from './signals.js';

export const STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'atr-supertrend',
    name: 'ATR SuperTrend',
    summary: 'EMA-smoothed close against a ratcheting ATR band. Bullish is long, bearish is short.',
    build(dayBars, spec) {
      const entryParams = { atrLength: spec.atrLength, factor: spec.factor, smoothing: spec.smoothing };
      const entry = buildSignals(dayBars, spec.entryTimeframe, entryParams);
      const sameSeries = spec.exitTimeframe === spec.entryTimeframe && spec.exitAtrLength === spec.atrLength;
      const exit = sameSeries
        ? entry
        : buildSignals(dayBars, spec.exitTimeframe, {
          atrLength: spec.exitAtrLength,
          factor: spec.factor,
          smoothing: spec.smoothing,
        });
      return { entry, exit };
    },
  }),
]);

export function getStrategy(id) {
  return STRATEGIES.find((s) => s.id === id) || null;
}
