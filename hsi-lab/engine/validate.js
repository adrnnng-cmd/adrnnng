// Bounds for the public lab. The handler rejects anything outside this list
// before it touches the archive.

import { HSI_DAY_SESSION } from '../../backtest/engine/intraday.js';

export const BOUNDS = Object.freeze({
  atrLength: Object.freeze({ min: 2, max: 100 }),
  factor: Object.freeze({ min: 0.1, max: 10 }),
  smoothing: Object.freeze({ min: 1, max: 50 }),
  timeframes: Object.freeze([1, 5]),
  entryRules: Object.freeze(['flip', 'clock', 'firstFlip']),
  exitRules: Object.freeze(['flat', 'reenter', 'reverse']),
  costPoints: Object.freeze({ min: 0, max: 100 }),
  maxRangeDays: 3660,
  sessionStart: HSI_DAY_SESSION.morningOpenMin,
  sessionEnd: HSI_DAY_SESSION.dayCloseMin,
});

export const DEFAULTS = Object.freeze({
  strategy: 'atr-supertrend',
  atrLength: 14,
  exitAtrLength: 14,
  factor: 2.5,
  smoothing: 2,
  entryTimeframe: 5,
  exitTimeframe: 5,
  entryRule: 'clock',
  exitRule: 'reenter',
  clock: '09:30',
  windowStart: '09:15',
  windowEnd: '16:30',
  costs: true,
});

const FIELDS = new Set([
  'strategy',
  'atrLength',
  'exitAtrLength',
  'factor',
  'smoothing',
  'entryTimeframe',
  'exitTimeframe',
  'entryRule',
  'exitRule',
  'clock',
  'windowStart',
  'windowEnd',
  'from',
  'to',
  'costs',
  'costPoints',
]);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function fail(message) {
  throw new ValidationError(message);
}

export function defaultCost(exitTimeframe) {
  return Number(exitTimeframe) === 1 ? 8 : 6;
}

export function formatMinute(mins) {
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseClock(value, label) {
  if (typeof value !== 'string') fail(`${label} must be HH:MM.`);
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) fail(`${label} must be HH:MM.`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) fail(`${label} must be HH:MM.`);
  return h * 60 + m;
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1970 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return value;
}

function timeframe(value, label) {
  if (value === '1m' || value === '1') return 1;
  if (value === '5m' || value === '5') return 5;
  if (value === 1 || value === 5) return value;
  fail(`${label} must be 1m or 5m.`);
  return 0;
}

function integer(value, label, { min, max }) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function validateInput(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) fail('Body must be a JSON object.');
  for (const key of Object.keys(input)) {
    if (!FIELDS.has(key)) fail('Unknown field.');
  }
  const strategy = input.strategy ?? DEFAULTS.strategy;
  if (strategy !== 'atr-supertrend') fail('Unknown strategy.');

  const atrLength = integer(input.atrLength ?? DEFAULTS.atrLength, 'ATR length', BOUNDS.atrLength);
  const exitAtrLength = integer(input.exitAtrLength ?? atrLength, 'Exit ATR length', BOUNDS.atrLength);
  const factorRaw = input.factor ?? DEFAULTS.factor;
  if (typeof factorRaw !== 'number' || !Number.isFinite(factorRaw) || factorRaw < BOUNDS.factor.min || factorRaw > BOUNDS.factor.max) {
    fail(`Factor must be from ${BOUNDS.factor.min} to ${BOUNDS.factor.max}.`);
  }
  const smoothing = integer(input.smoothing ?? DEFAULTS.smoothing, 'Smoothing', BOUNDS.smoothing);
  const entryTimeframe = timeframe(input.entryTimeframe ?? DEFAULTS.entryTimeframe, 'Entry timeframe');
  const exitTimeframe = timeframe(input.exitTimeframe ?? DEFAULTS.exitTimeframe, 'Exit timeframe');
  const entryRule = input.entryRule ?? DEFAULTS.entryRule;
  const exitRule = input.exitRule ?? DEFAULTS.exitRule;
  if (!BOUNDS.entryRules.includes(entryRule)) fail('Unknown entry rule.');
  if (!BOUNDS.exitRules.includes(exitRule)) fail('Unknown exit rule.');

  const windowStartMin = parseClock(input.windowStart ?? DEFAULTS.windowStart, 'Window start');
  const windowEndMin = parseClock(input.windowEnd ?? DEFAULTS.windowEnd, 'Window end');
  if (windowStartMin < BOUNDS.sessionStart || windowEndMin > BOUNDS.sessionEnd || windowStartMin >= windowEndMin) {
    fail('Window must sit inside the day session, 09:15 to 16:30, with the start before the end.');
  }

  let clock = null;
  let clockMin = null;
  if (entryRule === 'clock' || entryRule === 'firstFlip') {
    clockMin = parseClock(input.clock ?? DEFAULTS.clock, 'Clock');
    if (clockMin < windowStartMin || clockMin >= windowEndMin) fail('Clock must sit inside the trading window.');
    clock = formatMinute(clockMin);
  }

  let from = null;
  let to = null;
  const hasFrom = input.from != null && input.from !== '';
  const hasTo = input.to != null && input.to !== '';
  if (hasFrom !== hasTo) fail('Provide both dates, or leave both empty for the full archive.');
  if (hasFrom) {
    from = parseDate(input.from);
    to = parseDate(input.to);
    if (!from || !to) fail('Dates must be YYYY-MM-DD.');
    if (from > to) fail('The start date is after the end date.');
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
    if (span > BOUNDS.maxRangeDays) fail('Date range is limited to 10 years.');
  }

  if (typeof (input.costs ?? DEFAULTS.costs) !== 'boolean') fail('Costs must be on or off.');
  const costs = input.costs ?? DEFAULTS.costs;
  let costPoints = 0;
  if (costs) {
    if (input.costPoints == null) costPoints = defaultCost(exitTimeframe);
    else if (typeof input.costPoints !== 'number' || !Number.isFinite(input.costPoints) || input.costPoints < BOUNDS.costPoints.min || input.costPoints > BOUNDS.costPoints.max) {
      fail(`Cost must be from ${BOUNDS.costPoints.min} to ${BOUNDS.costPoints.max} points per round trip.`);
    } else costPoints = input.costPoints;
  }

  return {
    strategy,
    atrLength,
    exitAtrLength,
    factor: factorRaw,
    smoothing,
    entryTimeframe,
    exitTimeframe,
    entryRule,
    exitRule,
    clock,
    clockMin,
    windowStart: formatMinute(windowStartMin),
    windowStartMin,
    windowEnd: formatMinute(windowEndMin),
    windowEndMin,
    from,
    to,
    costs,
    costPoints,
  };
}
