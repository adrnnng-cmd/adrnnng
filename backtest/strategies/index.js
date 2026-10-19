// Strategy registry. To add a strategy, create a module that default-exports (or exports) an
// object with this shape and add it to STRATEGIES below. The UI builds its form from `params`.
//
//   {
//     id: 'kebab-id',                 // stable: used in share URLs
//     name: 'Display name', short: 'Chip label', summary: 'One sentence', tags: ['Trend'],
//     params: [ { key, label, type: 'number' | 'select' | 'boolean', default, min, max, step, options, help } ],
//     run(bars, params) => {
//       target:   Array<1 | 0 | -1 | null>   // position wanted after bar i closes; null = no change
//       markers?: [{ index, position: 'above' | 'below', text, color, kind, shape? }]
//       overlays?: [{ name, color, values: (number|null)[], style?: 'dashed' }]   // drawn on price
//       panes?:   [{ name, series: [{ name, type?: 'line' | 'histogram', color, values }], levels?, range? }]
//     }
//   }
//
// `run` must only use bars[0..i] to decide target[i]; the engine fills at bar i+1's open.

import tdSequential from './td-sequential.js';
import { maCross, rsiReversion, macdCross, bollingerReversion, donchianBreakout } from './classic.js';

export const STRATEGIES = [tdSequential, maCross, rsiReversion, macdCross, bollingerReversion, donchianBreakout];

export function getStrategy(id) {
  return STRATEGIES.find((s) => s.id === id) || STRATEGIES[0];
}

export function defaultParams(strategy) {
  return Object.fromEntries(strategy.params.map((p) => [p.key, p.default]));
}

/** Coerce user/URL input to the declared param types and bounds. */
export function normaliseParams(strategy, input = {}) {
  const out = {};
  for (const p of strategy.params) {
    let v = input[p.key] ?? p.default;
    if (p.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) v = p.default;
      if (p.min != null) v = Math.max(p.min, v);
      if (p.max != null) v = Math.min(p.max, v);
    } else if (p.type === 'boolean') {
      v = v === true || v === 'true' || v === '1' || v === 1;
    } else if (p.type === 'select') {
      if (!p.options.some((o) => o.value === v)) v = p.default;
    }
    out[p.key] = v;
  }
  return out;
}
