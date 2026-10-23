// Named compositions the page can select. A recipe fills the controls.
// It does not nest strategies; it only records slots.

/** Round-trip points until the visitor types their own. 1-minute exits cost 8, 5-minute exits cost 6. */
export function defaultCostPoints(exitTf) {
  return exitTf === '1m' ? 8 : 6;
}

export const RECIPES = Object.freeze([
  Object.freeze({
    id: 'fast-response',
    name: 'SuperTrend Fast Response',
    summary: 'ATR 10, factor 2.5, smoothing 2. 5-minute clock at 09:30, re-enter the same way, flatten at the day-session close. Index points.',
    strategy: 'atr-supertrend',
    symbol: 'HSImain',
    params: Object.freeze({ atrLength: 10, factor: 2.5, smoothing: 2 }),
    tf: '5m',
    exitTf: '5m',
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    confirm: 'none',
    sessionMode: 'year',
    year: 'all',
    flattenEod: true,
    costPoints: defaultCostPoints('5m'),
  }),
  Object.freeze({
    id: 'daily-confirm',
    name: 'SuperTrend 5m · daily confirm',
    summary: 'Same Fast Response entry, but only when the daily SuperTrend agrees. The daily study is a separate signal, not a strategy inside a strategy.',
    strategy: 'atr-supertrend',
    symbol: 'HSImain',
    params: Object.freeze({ atrLength: 10, factor: 2.5, smoothing: 2 }),
    tf: '5m',
    exitTf: '5m',
    entryRule: 'clock',
    clock: '09:30',
    exitRule: 'reenter',
    confirm: 'daily',
    sessionMode: 'year',
    year: 'all',
    flattenEod: true,
    costPoints: defaultCostPoints('5m'),
  }),
]);

export function getRecipe(id) {
  return RECIPES.find((r) => r.id === id) || null;
}
