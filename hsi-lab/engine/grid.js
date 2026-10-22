// The precomputed HSI lab grid. The public page can only ask for a cell in
// this table. Factor, smoothing, and the trading window are fixed.

import { ValidationError, defaultCost, formatMinute } from './validate.js';

export const FIRST_YEAR = 2020;
export const DATA_START = '2020-01-02';
const DATA_START_UTC = Date.UTC(2020, 0, 2);
export const FACTOR = 2.5;
export const SMOOTHING = 2;
export const ATR_LENGTHS = Object.freeze([10, 11, 12, 13, 14]);
export const TIMEFRAMES = Object.freeze([1, 5]);
export const WINDOW_START = '09:15';
export const WINDOW_END = '16:30';
export const WINDOW_START_MIN = 9 * 60 + 15;
export const WINDOW_END_MIN = 16 * 60 + 30;
export const MAX_EQUITY_POINTS = 250;
export const MAX_RESULT_KEYS = 150;
export const MAX_KV_VALUE_BYTES = 25 * 1024 * 1024;

export const ENTRY_CHOICES = Object.freeze([
  Object.freeze({ id: 'flip', entryRule: 'flip', clock: null, label: 'Any flip' }),
  Object.freeze({ id: 'clock@09:15', entryRule: 'clock', clock: '09:15', label: 'Clock state at 09:15' }),
  Object.freeze({ id: 'clock@09:30', entryRule: 'clock', clock: '09:30', label: 'Clock state at 09:30' }),
  Object.freeze({ id: 'firstFlip@09:15', entryRule: 'firstFlip', clock: '09:15', label: 'First flip after 09:15' }),
  Object.freeze({ id: 'firstFlip@09:30', entryRule: 'firstFlip', clock: '09:30', label: 'First flip after 09:30' }),
]);

export const EXIT_CHOICES = Object.freeze([
  Object.freeze({ id: 'flat', label: 'Then flat for the day' }),
  Object.freeze({ id: 'reenter', label: 'Re-enter the same direction only' }),
  Object.freeze({ id: 'reverse', label: 'Reverse' }),
]);

export const LOOKUP_DEFAULTS = Object.freeze({
  strategy: 'atr-supertrend',
  entryTimeframe: 5,
  atrLength: 14,
  exitTimeframe: 5,
  exitAtrLength: 14,
  entryRule: 'clock',
  clock: '09:30',
  exitRule: 'reenter',
  range: 'all',
  costs: true,
});

const FIELDS = new Set([
  'strategy',
  'entryTimeframe',
  'atrLength',
  'exitTimeframe',
  'exitAtrLength',
  'entryRule',
  'exitRule',
  'clock',
  'range',
  'from',
  'to',
  'costs',
  'costPoints',
]);

export function currentYear(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return date.getUTCFullYear();
}

export function utcDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return DATA_START;
  return date.toISOString().slice(0, 10);
}

export function dateToIndex(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - DATA_START_UTC) / 86400000);
}

export function indexToDate(index) {
  const date = new Date(DATA_START_UTC + index * 86400000);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function yearOfIndex(index) {
  return new Date(DATA_START_UTC + index * 86400000).getUTCFullYear();
}

export function rangeBounds(range, now = new Date()) {
  const cap = utcDate(now);
  if (range === 'all') return { from: DATA_START, to: cap };
  const start = `${range}-01-01`;
  const end = `${range}-12-31`;
  return { from: start < DATA_START ? DATA_START : start, to: end < cap ? end : cap };
}

export function archiveYears(now = new Date()) {
  const years = [];
  for (let year = FIRST_YEAR; year <= currentYear(now); year++) years.push(year);
  return years;
}

export function gridJobs() {
  const jobs = [];
  for (const entryTimeframe of TIMEFRAMES) {
    for (const atrLength of ATR_LENGTHS) {
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
    }
  }
  return jobs;
}

export function comboKey(job) {
  const clock = job.entryRule === 'flip' ? '-' : job.clock;
  return `${job.exitTimeframe}:${job.exitAtrLength}:${job.entryRule}:${clock}:${job.exitRule}`;
}

export function bundleKey(entryTimeframe, atrLength, range) {
  return `v1/results/${entryTimeframe}m-${atrLength}/${range}.json.gz`;
}

export function bundleKeys() {
  const keys = [];
  for (const entryTimeframe of TIMEFRAMES) {
    for (const atrLength of ATR_LENGTHS) keys.push(bundleKey(entryTimeframe, atrLength, 'all'));
  }
  return keys;
}

export function publicGrid(now = new Date()) {
  const years = archiveYears(now);
  return {
    factor: FACTOR,
    smoothing: SMOOTHING,
    timeframes: TIMEFRAMES,
    atrLengths: ATR_LENGTHS,
    entryChoices: ENTRY_CHOICES.map((choice) => ({ id: choice.id, label: choice.label })),
    exitRules: EXIT_CHOICES.map((choice) => ({ id: choice.id, label: choice.label })),
    ranges: ['all', ...years.map(String)],
    dateStart: DATA_START,
    dateEnd: utcDate(now),
    resolution: 'daily',
    session: { start: WINDOW_START, end: WINDOW_END },
    sameTimeframeSharesAtr: true,
    maxEquityPoints: MAX_EQUITY_POINTS,
  };
}

function fail(message) {
  throw new ValidationError(message);
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^(\d{4})-(\d{2})-(\d{2})$/.test(value)) fail('Dates must be YYYY-MM-DD.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail('Dates must be YYYY-MM-DD.');
  }
  return value;
}

function timeframe(value, label) {
  if (value === 1 || value === 5 || value === '1' || value === '5' || value === '1m' || value === '5m') {
    return value === 5 || value === '5' || value === '5m' ? 5 : 1;
  }
  fail(`${label} must be 1m or 5m.`);
  return 0;
}

function atr(value, label) {
  if (typeof value !== 'number' || !ATR_LENGTHS.includes(value)) {
    fail(`${label} must be one of ${ATR_LENGTHS.join(', ')}.`);
  }
  return value;
}

export function validateLookup(input, now = new Date()) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) fail('Body must be a JSON object.');
  for (const key of Object.keys(input)) {
    if (!FIELDS.has(key)) fail('Unknown field.');
  }
  const strategy = input.strategy ?? LOOKUP_DEFAULTS.strategy;
  if (strategy !== 'atr-supertrend') fail('Unknown strategy.');

  const entryTimeframe = timeframe(input.entryTimeframe ?? LOOKUP_DEFAULTS.entryTimeframe, 'Entry timeframe');
  const exitTimeframe = timeframe(input.exitTimeframe ?? LOOKUP_DEFAULTS.exitTimeframe, 'Exit timeframe');
  const atrLength = atr(input.atrLength ?? LOOKUP_DEFAULTS.atrLength, 'ATR length');
  const exitAtrLength = atr(
    input.exitAtrLength ?? (entryTimeframe === exitTimeframe ? atrLength : LOOKUP_DEFAULTS.exitAtrLength),
    'Exit ATR length',
  );
  if (entryTimeframe === exitTimeframe && exitAtrLength !== atrLength) {
    fail('The same timeframe uses one ATR length.');
  }

  const entryRule = input.entryRule ?? LOOKUP_DEFAULTS.entryRule;
  const exitRule = input.exitRule ?? LOOKUP_DEFAULTS.exitRule;
  if (!['flip', 'clock', 'firstFlip'].includes(entryRule)) fail('Unknown entry rule.');
  if (!EXIT_CHOICES.some((choice) => choice.id === exitRule)) fail('Unknown exit rule.');

  let clock = null;
  if (entryRule === 'flip') {
    if (input.clock != null && input.clock !== '') fail('Any flip has no clock.');
  } else {
    clock = input.clock ?? LOOKUP_DEFAULTS.clock;
    if (clock !== '09:15' && clock !== '09:30') fail('Clock must be 09:15 or 09:30.');
    const choice = ENTRY_CHOICES.find((row) => row.entryRule === entryRule && row.clock === clock);
    if (!choice) fail('Unknown entry rule.');
  }

  const hasFrom = input.from != null && input.from !== '';
  const hasTo = input.to != null && input.to !== '';
  if (hasFrom !== hasTo) fail('Custom dates need a start and an end.');
  if ((hasFrom || hasTo) && input.range != null && input.range !== '') fail('Send a year or custom dates, not both.');

  let range;
  let from;
  let to;
  if (hasFrom) {
    from = calendarDate(input.from);
    to = calendarDate(input.to);
    const cap = utcDate(now);
    if (from < DATA_START || to > cap) fail(`Dates must run from ${DATA_START} through ${cap}.`);
    if (from > to) fail('The start date must be on or before the end date.');
    range = 'custom';
  } else {
    const years = new Set(archiveYears(now).map(String));
    range = input.range == null || input.range === '' ? LOOKUP_DEFAULTS.range : String(input.range);
    if (range !== 'all' && !years.has(range)) fail('Range must be a year from 2020 through the current year, or all.');
    const bounds = rangeBounds(range, now);
    from = bounds.from;
    to = bounds.to;
  }

  if (typeof (input.costs ?? LOOKUP_DEFAULTS.costs) !== 'boolean') fail('Costs must be on or off.');
  const costs = input.costs ?? LOOKUP_DEFAULTS.costs;
  let costPoints = 0;
  if (costs) {
    if (input.costPoints == null) costPoints = defaultCost(exitTimeframe);
    else if (typeof input.costPoints !== 'number' || !Number.isFinite(input.costPoints) || input.costPoints < 0 || input.costPoints > 100) {
      fail('Cost must be from 0 to 100 points per round trip.');
    } else costPoints = input.costPoints;
  }

  const choice = ENTRY_CHOICES.find((row) => row.entryRule === entryRule && row.clock === clock);
  const clockMin = clock == null ? null : Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  return {
    strategy,
    atrLength,
    exitAtrLength,
    factor: FACTOR,
    smoothing: SMOOTHING,
    entryTimeframe,
    exitTimeframe,
    entryRule,
    exitRule,
    clock,
    clockMin,
    entryChoice: choice.id,
    windowStart: WINDOW_START,
    windowStartMin: WINDOW_START_MIN,
    windowEnd: WINDOW_END,
    windowEndMin: WINDOW_END_MIN,
    range,
    from,
    to,
    costs,
    costPoints,
    key: bundleKey(entryTimeframe, atrLength, 'all'),
    combo: comboKey({ exitTimeframe, exitAtrLength, entryRule, clock, exitRule }),
    windowLabel: `${formatMinute(WINDOW_START_MIN)}–${formatMinute(WINDOW_END_MIN)}`,
  };
}
