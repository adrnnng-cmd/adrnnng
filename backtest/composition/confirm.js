// Higher-timeframe gate. A separate strategy run, not a strategy calling another.
// An entry is allowed only when the last completed higher-timeframe bar agrees.

import { barDate } from '../engine/intraday.js';

export function confirmDirAt(time, higherBars, higherTrend) {
  const date = barDate(time);
  let idx = -1;
  for (let i = 0; i < higherBars.length; i++) {
    if (barDate(higherBars[i].time) < date) idx = i;
    else break;
  }
  if (idx < 0) return null;
  const dir = higherTrend[idx];
  return dir == null ? null : dir;
}

/** Zero entry flips and clock state that disagree with the confirming direction. */
export function gateEntries(bars, entry, higherBars, higherTrend) {
  const flip = entry.flip.slice();
  const state = entry.state.slice();
  for (let j = 0; j < bars.length; j++) {
    const dir = confirmDirAt(bars[j].time, higherBars, higherTrend);
    if (flip[j] && flip[j] !== dir) flip[j] = 0;
    if (state[j] && state[j] !== dir) state[j] = 0;
  }
  return { flip, state, sigMin: entry.sigMin };
}
