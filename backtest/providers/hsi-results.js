// Stored ATR SuperTrend scores for HSI futures. The page looks these up.
// It does not run the 1-minute tape in the browser.
//
// KV key (binding HSI_BARS), also the public path under /backtest/data/hsi/:
//   v1/results/{entryTf}m-{entryAtr}/all.json.gz
//     entryTf   1 or 5
//     entryAtr  10, 11, 12, 13, or 14
//   Body is gzip (magic 1f 8b) of an HSID v1 daily bundle. The name ends in
//   .json.gz so it matches the lab key. The bytes are not JSON.
//   A year file v1/results/{entryTf}m-{entryAtr}/{year}.json.gz may be stored.
//   The page reads the all bundle and slices it.
//
// Combo key inside the bundle, one row per cell:
//   {exitTf}:{exitAtr}:{entryRule}:{clock}:{exitRule}
//     exitTf     1 or 5
//     exitAtr    10–14, and equal to entryAtr when the timeframes match
//     entryRule  flip | clock | firstFlip
//     clock      "-" for flip, otherwise 09:15 or 09:30
//     exitRule   flat | reenter | reverse
//
// Fixed for every cell, and not part of the key: factor 2.5, EMA smoothing 2,
// day session 09:15–16:30 Hong Kong, flatten at the session close, no separate
// daily confirm. Fast Response is v1/results/5m-10/all.json.gz and combo
// 5:10:clock:09:30:reenter.
//
// Year, custom dates, and the round-trip point cost are applied when the page
// reads. They are not part of the key. encodeBundle() writes the HSID bytes
// the gzip body contains.

import { hsiBarsBase } from './hsi-futures.js';

export const NOT_COMPUTED = 'This combination is not computed yet.';
export const NOT_SUPERTREND = '1-minute and 5-minute HSI futures use the stored ATR SuperTrend result.';
export const OUTSIDE_RANGE = 'That date range is outside the stored results.';
export const UNREADABLE = 'The stored result could not be read.';

export const RESULT_FACTOR = 2.5;
export const RESULT_SMOOTHING = 2;
export const RESULT_ATR = Object.freeze([10, 11, 12, 13, 14]);
export const RESULT_DATA_START = '2020-01-02';
const DATA_START_UTC = Date.UTC(2020, 0, 2);
const STRIDE = 24;
const SCALE = 100;
const MAX_DAYS = 20000;
const MAX_COMBOS = 500;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class ResultMissing extends Error {
  constructor(message = NOT_COMPUTED) {
    super(message);
    this.name = 'ResultMissing';
    this.code = 'results-pending';
  }
}

export class ArchiveError extends Error {
  constructor() {
    super(UNREADABLE);
    this.name = 'ArchiveError';
  }
}

export function resultBundleKey(entryTimeframe, atrLength) {
  return `v1/results/${entryTimeframe}m-${atrLength}/all.json.gz`;
}

export function comboKey({ exitTimeframe, exitAtrLength, entryRule, clock, exitRule }) {
  const at = entryRule === 'flip' ? '-' : clock;
  return `${exitTimeframe}:${exitAtrLength}:${entryRule}:${at}:${exitRule}`;
}

function roundTo(n, dp) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Number(n.toFixed(dp));
}

function centi(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  const scaled = Math.round(n * SCALE);
  if (scaled > 2147483647) return 2147483647;
  if (scaled < -2147483648) return -2147483648;
  return scaled;
}

function u16(n) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 65535) return 65535;
  return Math.round(n);
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

function yearOfIndex(index) {
  return new Date(DATA_START_UTC + index * 86400000).getUTCFullYear();
}

export function utcDay(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return RESULT_DATA_START;
  return date.toISOString().slice(0, 10);
}

function shiftYears(iso, years) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

/** From–to for a Range preset against the stored archive. `years` null is the whole archive. */
export function presetBounds(years, now = new Date()) {
  const to = utcDay(now);
  if (years == null) return { from: RESULT_DATA_START, to };
  const shifted = shiftYears(to, years);
  return { from: shifted < RESULT_DATA_START ? RESULT_DATA_START : shifted, to };
}

function archiveYears(now) {
  const end = (now instanceof Date ? now : new Date(now)).getUTCFullYear();
  const years = [];
  for (let year = 2020; year <= end; year++) years.push(year);
  return years;
}

function rangeBounds(range, now) {
  const cap = utcDay(now);
  if (range === 'all') return { from: RESULT_DATA_START, to: cap };
  const start = `${range}-01-01`;
  const end = `${range}-12-31`;
  return {
    from: start < RESULT_DATA_START ? RESULT_DATA_START : start,
    to: end < cap ? end : cap,
  };
}

function asTf(value) {
  if (value === 1 || value === '1' || value === '1m') return 1;
  if (value === 5 || value === '5' || value === '5m') return 5;
  return null;
}

function asAtr(value) {
  const n = Math.round(Number(value));
  return RESULT_ATR.includes(n) ? n : null;
}

/**
 * Turn the page controls into a bundle key and a combo, or a reason to stop.
 * A rejected combo does not fetch.
 */
export function prepareHsiLookup(input, now = new Date()) {
  if (input?.strategy && input.strategy !== 'atr-supertrend') {
    return { ok: false, message: NOT_SUPERTREND };
  }
  const entryTimeframe = asTf(input?.entryTimeframe);
  const exitTimeframe = asTf(input?.exitTimeframe ?? input?.entryTimeframe);
  const atrLength = asAtr(input?.atrLength);
  const exitAtrLength = asAtr(input?.exitAtrLength ?? (entryTimeframe === exitTimeframe ? input?.atrLength : input?.exitAtrLength));
  const entryRule = input?.entryRule;
  const exitRule = input?.exitRule;
  const factor = Number(input?.factor ?? RESULT_FACTOR);
  const smoothing = Math.round(Number(input?.smoothing ?? RESULT_SMOOTHING));
  if (
    entryTimeframe == null ||
    exitTimeframe == null ||
    atrLength == null ||
    exitAtrLength == null ||
    (entryTimeframe === exitTimeframe && exitAtrLength !== atrLength) ||
    !['flip', 'clock', 'firstFlip'].includes(entryRule) ||
    !['flat', 'reenter', 'reverse'].includes(exitRule) ||
    factor !== RESULT_FACTOR ||
    smoothing !== RESULT_SMOOTHING ||
    input?.confirm === 'daily' ||
    input?.flattenEod === false
  ) {
    return { ok: false, message: NOT_COMPUTED };
  }
  let clock = null;
  if (entryRule !== 'flip') {
    clock = input?.clock;
    if (clock !== '09:15' && clock !== '09:30') return { ok: false, message: NOT_COMPUTED };
  }
  const costPoints = Number(input?.costPoints ?? 0);
  if (!Number.isFinite(costPoints) || costPoints < 0 || costPoints > 100) {
    return { ok: false, message: NOT_COMPUTED };
  }

  let range;
  let from;
  let to;
  const mode = input?.sessionMode;
  const wantsDates = mode === 'dates' || (input?.from && input?.to && mode !== 'year' && input?.range == null);
  if (wantsDates && input?.from && input?.to) {
    from = String(input.from).slice(0, 10);
    to = String(input.to).slice(0, 10);
    if (from > to) return { ok: false, message: OUTSIDE_RANGE };
    const cap = utcDay(now);
    if (to < RESULT_DATA_START || from > cap) return { ok: false, message: OUTSIDE_RANGE };
    if (from < RESULT_DATA_START) from = RESULT_DATA_START;
    if (to > cap) to = cap;
    range = 'custom';
  } else {
    const picked = input?.range ?? input?.year ?? 'all';
    range = picked == null || picked === '' ? 'all' : String(picked);
    if (range !== 'all' && !archiveYears(now).map(String).includes(range)) {
      return { ok: false, message: NOT_COMPUTED };
    }
    const bounds = rangeBounds(range, now);
    from = bounds.from;
    to = bounds.to;
  }

  return {
    ok: true,
    strategy: 'atr-supertrend',
    atrLength,
    exitAtrLength,
    factor: RESULT_FACTOR,
    smoothing: RESULT_SMOOTHING,
    entryTimeframe,
    exitTimeframe,
    entryRule,
    exitRule,
    clock,
    range,
    from,
    to,
    costs: costPoints > 0,
    costPoints,
    key: resultBundleKey(entryTimeframe, atrLength),
    combo: comboKey({ exitTimeframe, exitAtrLength, entryRule, clock, exitRule }),
    maxEquity: input?.maxEquity ?? 5000,
  };
}

function hourSlots(hours) {
  const all = hours?.all || [];
  const years = hours?.years || {};
  const yearKeys = Object.keys(years).sort();
  return { all, years, yearKeys };
}

function hourBytes(hours) {
  const slots = hourSlots(hours);
  let size = 1 + 3 + slots.all.length * 9;
  for (const key of slots.yearKeys) size += 3 + (slots.years[key]?.length || 0) * 9;
  return size;
}

function writeHours(view, bytes, offset, hours) {
  const slots = hourSlots(hours);
  let p = offset;
  bytes[p] = 1 + slots.yearKeys.length;
  p += 1;
  const writeSlot = (year, list) => {
    view.setUint16(p, year, true);
    p += 2;
    const rows = list || [];
    bytes[p] = rows.length;
    p += 1;
    for (const [hour, trades, wins, gross] of rows) {
      bytes[p] = u16(hour) & 255;
      p += 1;
      view.setUint16(p, u16(trades), true);
      p += 2;
      view.setUint16(p, u16(wins), true);
      p += 2;
      view.setInt32(p, centi(gross), true);
      p += 4;
    }
  };
  writeSlot(0, slots.all);
  for (const key of slots.yearKeys) writeSlot(Number(key), slots.years[key]);
  return p;
}

function readHours(view, bytes, offset) {
  let p = offset;
  if (p >= bytes.length) throw new ArchiveError();
  const slots = bytes[p];
  p += 1;
  const hours = { all: [], years: {} };
  for (let s = 0; s < slots; s++) {
    if (p + 3 > bytes.length) throw new ArchiveError();
    const year = view.getUint16(p, true);
    p += 2;
    const count = bytes[p];
    p += 1;
    const list = [];
    if (p + count * 9 > bytes.length) throw new ArchiveError();
    for (let i = 0; i < count; i++) {
      const hour = bytes[p];
      p += 1;
      const trades = view.getUint16(p, true);
      p += 2;
      const wins = view.getUint16(p, true);
      p += 2;
      const gross = view.getInt32(p, true);
      p += 4;
      list.push([hour, trades, wins, gross]);
    }
    if (year === 0) hours.all = list;
    else hours.years[String(year)] = list;
  }
  return { hours, offset: p };
}

/** HSID bytes for one entry timeframe and entry ATR. Gzip this for the KV value. */
export function encodeBundle(bundle) {
  const days = bundle?.days || [];
  const keys = Object.keys(bundle?.rows || {}).sort();
  if (days.length > MAX_DAYS || keys.length > MAX_COMBOS) throw new ArchiveError();
  const indexes = days.map((iso) => dateToIndex(iso));
  for (let i = 0; i < indexes.length; i++) {
    if (indexes[i] < 0 || indexes[i] > 65535) throw new ArchiveError();
    if (i && indexes[i] <= indexes[i - 1]) throw new ArchiveError();
  }
  let directory = 0;
  let hours = 0;
  const encodedKeys = [];
  for (const key of keys) {
    const row = bundle.rows[key];
    for (const name of ['g', 't', 'w', 'gw', 'gl', 'h', 'mn']) {
      if (!row || row[name]?.length !== days.length) throw new ArchiveError();
    }
    const encoded = textEncoder.encode(key);
    if (encoded.length === 0 || encoded.length > 255) throw new ArchiveError();
    encodedKeys.push(encoded);
    directory += 1 + encoded.length;
    hours += hourBytes(row.hours);
  }
  const records = keys.length * days.length * STRIDE;
  const total = 16 + days.length * 2 + directory + records + hours;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set([0x48, 0x53, 0x49, 0x44], 0);
  bytes[4] = 1;
  bytes[5] = bundle.entryTimeframe & 255;
  bytes[6] = bundle.atrLength & 255;
  view.setUint32(8, days.length, true);
  view.setUint16(12, keys.length, true);
  view.setUint16(14, STRIDE, true);
  let p = 16;
  for (const index of indexes) {
    view.setUint16(p, index, true);
    p += 2;
  }
  encodedKeys.forEach((key) => {
    bytes[p] = key.length;
    p += 1;
    bytes.set(key, p);
    p += key.length;
  });
  for (const key of keys) {
    const row = bundle.rows[key];
    for (let i = 0; i < days.length; i++) {
      view.setInt32(p, centi(row.g[i]), true);
      view.setUint16(p + 4, u16(row.t[i]), true);
      view.setUint16(p + 6, u16(row.w[i]), true);
      view.setInt32(p + 8, centi(row.gw[i]), true);
      view.setInt32(p + 12, centi(row.gl[i]), true);
      view.setUint16(p + 16, u16(row.h[i]), true);
      view.setInt32(p + 20, centi(row.mn[i]), true);
      p += STRIDE;
    }
  }
  for (const key of keys) p = writeHours(view, bytes, p, bundle.rows[key].hours);
  if (p !== total) throw new ArchiveError();
  return bytes;
}

export function decodeDaily(bytes) {
  try {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.length < 16) throw new ArchiveError();
    if (raw[0] !== 0x48 || raw[1] !== 0x53 || raw[2] !== 0x49 || raw[3] !== 0x44) throw new ArchiveError();
    if (raw[4] !== 1) throw new ArchiveError();
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const dayCount = view.getUint32(8, true);
    const comboCount = view.getUint16(12, true);
    const stride = view.getUint16(14, true);
    if (stride !== STRIDE || dayCount > MAX_DAYS || comboCount > MAX_COMBOS) throw new ArchiveError();
    let p = 16;
    if (p + dayCount * 2 > raw.length) throw new ArchiveError();
    const days = new Uint16Array(dayCount);
    for (let i = 0; i < dayCount; i++) {
      days[i] = view.getUint16(p, true);
      p += 2;
      if (i && days[i] <= days[i - 1]) throw new ArchiveError();
    }
    const keys = [];
    for (let i = 0; i < comboCount; i++) {
      if (p >= raw.length) throw new ArchiveError();
      const length = raw[p];
      p += 1;
      if (!length || p + length > raw.length) throw new ArchiveError();
      keys.push(textDecoder.decode(raw.subarray(p, p + length)));
      p += length;
    }
    const recordBase = p;
    const records = comboCount * dayCount * STRIDE;
    if (recordBase + records > raw.length) throw new ArchiveError();
    p = recordBase + records;
    const combos = new Map();
    for (let i = 0; i < keys.length; i++) {
      if (combos.has(keys[i])) throw new ArchiveError();
      const read = readHours(view, raw, p);
      p = read.offset;
      combos.set(keys[i], { offset: recordBase + i * dayCount * STRIDE, hours: read.hours });
    }
    if (p !== raw.length) throw new ArchiveError();
    return { entryTimeframe: raw[5], atrLength: raw[6], days, combos, view, stride };
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError();
  }
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeBundleBytes(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) return decodeDaily(await gunzip(raw));
  return decodeDaily(raw);
}

export function netOfCost(grossWin, grossLoss, trades, wins, cost) {
  const costCenti = Math.round((Number(cost) || 0) * SCALE);
  const t = u16(trades);
  const w = Math.min(u16(wins), t);
  let netWin = centi(grossWin) - costCenti * w;
  let netLoss = centi(grossLoss) + costCenti * (t - w);
  let netWins = w;
  if (netWin < 0) {
    netLoss -= netWin;
    netWin = 0;
    netWins = 0;
  }
  return { netWin: netWin / SCALE, netLoss: netLoss / SCALE, netWins };
}

function lowerBound(days, target) {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(days, target) {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function yearSpan(days, year) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < days.length; i++) {
    const at = yearOfIndex(days[i]);
    if (at === year) {
      if (first < 0) first = i;
      last = i;
    } else if (first >= 0) break;
  }
  return [first, last];
}

function keptIndexes(count, max) {
  const keep = new Uint8Array(count);
  if (count <= max) {
    keep.fill(1);
    return keep;
  }
  const last = count - 1;
  for (let i = 0; i < max; i++) keep[Math.round((i * last) / (max - 1))] = 1;
  return keep;
}

function sharpeRatio(days, mean, m2) {
  if (days < 2) return null;
  const sd = Math.sqrt(m2 / (days - 1));
  if (!(sd > 0)) return null;
  return (mean / sd) * Math.sqrt(252);
}

export function sliceDays(decoded, combo, fromIso, toIso, cost, range, maxEquity = 250) {
  const row = decoded.combos.get(combo);
  if (!row) return null;
  const days = decoded.days;
  const lo = lowerBound(days, dateToIndex(fromIso));
  const hi = upperBound(days, dateToIndex(toIso));
  const count = hi - lo;
  const keep = count ? keptIndexes(count, maxEquity) : null;
  const view = decoded.view;
  let trades = 0;
  let wins = 0;
  let grossCenti = 0;
  let winCenti = 0;
  let lossCenti = 0;
  let netWin = 0;
  let netLoss = 0;
  let hold = 0;
  let cumTrades = 0;
  let cum = 0;
  let peak = 0;
  let drawdown = 0;
  let sharpeMean = 0;
  let sharpeM2 = 0;
  const equity = [];
  const years = new Map();
  for (let i = lo; i < hi; i++) {
    const offset = row.offset + i * decoded.stride;
    const gCenti = view.getInt32(offset, true);
    const t = view.getUint16(offset + 4, true);
    const w = view.getUint16(offset + 6, true);
    const gw = view.getInt32(offset + 8, true);
    const gl = view.getInt32(offset + 12, true);
    const h = view.getUint16(offset + 16, true);
    const net = netOfCost(gw / SCALE, gl / SCALE, t, w, cost);
    trades += t;
    wins += net.netWins;
    grossCenti += gCenti;
    winCenti += gw;
    lossCenti += gl;
    netWin += net.netWin;
    netLoss += net.netLoss;
    hold += h;
    cumTrades += t;
    const seen = i - lo + 1;
    const dayNet = gCenti / SCALE - cost * t;
    const delta = dayNet - sharpeMean;
    sharpeMean += delta / seen;
    sharpeM2 += delta * (dayNet - sharpeMean);
    cum = grossCenti / SCALE - cost * cumTrades;
    if (cum > peak) peak = cum;
    if (cum - peak < drawdown) drawdown = cum - peak;
    const year = yearOfIndex(days[i]);
    let bucket = years.get(year);
    if (!bucket) {
      bucket = { trades: 0, wins: 0, grossCenti: 0 };
      years.set(year, bucket);
    }
    bucket.trades += t;
    bucket.wins += net.netWins;
    bucket.grossCenti += gCenti;
    if (keep[i - lo]) equity.push({ date: indexToDate(days[i]), points: cum, trades: cumTrades });
  }
  let hours = [];
  if (range === 'all' && lo === 0 && hi === days.length && count) hours = row.hours.all;
  else if (range && range !== 'all' && range !== 'custom') {
    const [first, last] = yearSpan(days, Number(range));
    if (first >= 0 && first >= lo && last < hi) hours = row.hours.years[String(range)] || [];
  }
  return {
    sessionDays: count,
    trades,
    wins,
    gross: grossCenti / SCALE,
    grossWin: winCenti / SCALE,
    grossLoss: lossCenti / SCALE,
    netWin,
    netLoss,
    hold,
    maxDrawdown: drawdown,
    equity,
    byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, bucket]) => ({
      year: String(year),
      trades: bucket.trades,
      wins: bucket.wins,
      gross: bucket.grossCenti / SCALE,
    })),
    hours: hours.map(([hour, t, w, gCenti]) => ({
      hour,
      trades: t,
      wins: w,
      gross: gCenti / SCALE,
    })),
    sharpe: sharpeRatio(count, sharpeMean, sharpeM2),
  };
}

function bucket(rows, label, cost) {
  return rows.map((row) => ({
    [label]: row[label],
    trades: row.trades,
    winRate: row.trades ? roundTo(row.wins / row.trades, 4) : null,
    grossPoints: roundTo(row.gross, 2),
    netPoints: roundTo(row.gross - cost * row.trades, 2),
    avgPoints: row.trades ? roundTo(row.gross / row.trades, 4) : null,
  }));
}

export function scoreStored(decoded, spec) {
  const cost = spec.costs ? spec.costPoints : 0;
  const sliced = sliceDays(decoded, spec.combo, spec.from, spec.to, cost, spec.range, spec.maxEquity ?? 250);
  if (!sliced) return null;
  const trades = sliced.trades;
  return {
    strategy: spec.strategy,
    key: spec.key,
    combo: spec.combo,
    params: {
      atrLength: spec.atrLength,
      exitAtrLength: spec.exitAtrLength,
      factor: RESULT_FACTOR,
      smoothing: RESULT_SMOOTHING,
      entryTimeframe: spec.entryTimeframe,
      exitTimeframe: spec.exitTimeframe,
      entryRule: spec.entryRule,
      exitRule: spec.exitRule,
      clock: spec.clock,
      range: spec.range,
      from: spec.from,
      to: spec.to,
      resolution: 'daily',
      costs: spec.costs,
      costPoints: cost,
    },
    metrics: {
      trades,
      sessionDays: sliced.sessionDays,
      tradesPerDay: sliced.sessionDays ? roundTo(trades / sliced.sessionDays, 4) : null,
      winRate: trades ? roundTo(sliced.wins / trades, 4) : null,
      profitFactor: sliced.netLoss > 0 ? roundTo(sliced.netWin / sliced.netLoss, 4) : null,
      avgPoints: trades ? roundTo(sliced.gross / trades, 4) : null,
      avgHoldMinutes: trades ? roundTo(sliced.hold / trades, 2) : null,
      maxDrawdownPoints: roundTo(sliced.maxDrawdown, 2),
      sharpe: roundTo(sliced.sharpe, 4),
      grossPoints: roundTo(sliced.gross, 2),
      netPoints: roundTo(sliced.gross - cost * trades, 2),
    },
    equity: sliced.equity.map((point) => ({ date: point.date, points: roundTo(point.points, 2) })),
    byYear: bucket(sliced.byYear, 'year', cost),
    byEntryHour: bucket(sliced.hours, 'hour', cost),
  };
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

const bundleCache = new Map();

export function resetHsiResultCache() {
  bundleCache.clear();
}

async function fetchBytes(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HSI result HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Fetch one stored bundle and score the selected combo.
 * `base` defaults to the same public prefix as the bar packs.
 */
export async function lookupHsiResult(input, { base, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const spec = prepareHsiLookup(input, now);
  if (!spec.ok) throw new ResultMissing(spec.message);
  let decoded = bundleCache.get(spec.key);
  if (!decoded) {
    const root = base || hsiBarsBase();
    const bytes = await fetchBytes(fetchImpl, joinUrl(root, spec.key));
    if (!bytes) throw new ResultMissing();
    try {
      decoded = await decodeBundleBytes(bytes);
    } catch (err) {
      if (err instanceof ArchiveError || err?.name === 'ArchiveError') throw new ResultMissing(UNREADABLE);
      throw new ResultMissing(UNREADABLE);
    }
    bundleCache.set(spec.key, decoded);
  }
  const scored = scoreStored(decoded, spec);
  if (!scored) throw new ResultMissing();
  return scored;
}
