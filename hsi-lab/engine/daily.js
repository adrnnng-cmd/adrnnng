// Compact daily scores for one entry timeframe and ATR.
// One gzip of this blob is one KV value. A lookup reads that one key and
// slices dates. There are no prices in the record.
//
// Header, 16 bytes, little-endian:
//   magic "HSID", version u8 = 1, entry timeframe u8, ATR u8, flags u8,
//   day count u32, combo count u16, stride u16.
// Then uint16 days since 2020-01-02, a directory of combo keys, then
// dayCount records per combo:
//   int32 gross cents, uint16 trades, uint16 wins,
//   int32 gross-win cents, int32 gross-loss cents,
//   uint16 hold minutes, uint16 reserved,
//   int32 intraday min cents (session mark minus the session's starting equity).
// Then a small hour table per combo, for a whole year and for the full tape.

import { ArchiveError } from './archive.js';
import { dateToIndex, indexToDate, yearOfIndex } from './grid.js';

export const DAILY_VERSION = 1;
export const STRIDE = 24;
const SCALE = 100;
const MAX_DAYS = 20000;
const MAX_COMBOS = 500;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
    const bytes = textEncoder.encode(key);
    if (bytes.length === 0 || bytes.length > 255) throw new ArchiveError();
    encodedKeys.push(bytes);
    directory += 1 + bytes.length;
    hours += hourBytes(row.hours);
  }
  const records = keys.length * days.length * STRIDE;
  const total = 16 + days.length * 2 + directory + records + hours;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set([0x48, 0x53, 0x49, 0x44], 0);
  bytes[4] = DAILY_VERSION;
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
    if (raw[4] !== DAILY_VERSION) throw new ArchiveError();
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
    return {
      entryTimeframe: raw[5],
      atrLength: raw[6],
      days,
      combos,
      view,
      stride,
    };
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError();
  }
}

export function readDay(decoded, combo, index) {
  const row = decoded.combos.get(combo);
  if (!row || index < 0 || index >= decoded.days.length) return null;
  const offset = row.offset + index * decoded.stride;
  const view = decoded.view;
  return {
    g: view.getInt32(offset, true) / SCALE,
    t: view.getUint16(offset + 4, true),
    w: view.getUint16(offset + 6, true),
    gw: view.getInt32(offset + 8, true) / SCALE,
    gl: view.getInt32(offset + 12, true) / SCALE,
    h: view.getUint16(offset + 16, true),
    mn: view.getInt32(offset + 20, true) / SCALE,
  };
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
    trades += t;
    wins += w;
    grossCenti += gCenti;
    winCenti += gw;
    lossCenti += gl;
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
    bucket.wins += w;
    bucket.grossCenti += gCenti;
    if (keep[i - lo]) {
      equity.push({ date: indexToDate(days[i]), points: cum, trades: cumTrades });
    }
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

function sharpeRatio(days, mean, m2) {
  if (days < 2) return null;
  const sd = Math.sqrt(m2 / (days - 1));
  if (!(sd > 0)) return null;
  return (mean / sd) * Math.sqrt(252);
}
