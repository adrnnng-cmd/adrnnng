// Private R2 object format for 1-minute HSI bars.
//
// Key:    v1/1m/YYYY.bin
// Header: 16 bytes, little-endian
//   0  char[4]  magic "HSI1"
//   4  uint8    version = 1
//   5  uint8    flags = 0 (OHLC are float64)
//   6  uint16   year
//   8  uint32   bar count
//   12 uint32   reserved = 0
// Record: 40 bytes, little-endian, one per bar, ascending time
//   0  uint16   days since 1970-01-01 (the Hong Kong calendar date)
//   2  uint16   minutes from midnight (bar open)
//   4  float64  open
//   12 float64  high
//   20 float64  low
//   28 float64  close
//   36 uint32   volume, rounded, saturated at 2^32-1
//
// time_key is the bar open in Asia/Hong_Kong. There is no timezone conversion.
// This module has no I/O. The pack script writes the bytes; the worker reads them.

const HEADER = 16;
const RECORD = 40;
const MAGIC = 'HSI1';
const VERSION = 1;
const MAX_VOLUME = 0xffffffff;

export const ARCHIVE = Object.freeze({
  format: 'hsi1',
  version: VERSION,
  headerBytes: HEADER,
  recordBytes: RECORD,
  priceEncoding: 'float64-le',
  prefix: 'v1/1m/',
  timezone: 'Asia/Hong_Kong',
});

export function objectKey(year) {
  return `v1/1m/${year}.bin`;
}

export class ArchiveError extends Error {
  constructor() {
    super('Bar archive could not be read.');
    this.name = 'ArchiveError';
    this.status = 500;
  }
}

function viewOf(bytes) {
  if (bytes instanceof ArrayBuffer) return new DataView(bytes);
  if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new ArchiveError();
}

function byteLength(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes.byteLength;
  if (ArrayBuffer.isView(bytes)) return bytes.byteLength;
  return -1;
}

export function dateToDayIndex(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function dayIndexToDate(dayIndex) {
  return new Date(dayIndex * 86400000).toISOString().slice(0, 10);
}

function stamp(isoDate, minute) {
  const hh = String(Math.floor(minute / 60)).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${isoDate}T${hh}:${mm}:00`;
}

function failPack(message) {
  const err = new Error(message);
  err.name = 'PackError';
  throw err;
}

/**
 * Encode one calendar year of bars. `bars` must already be ascending and share `year`.
 * Prices are stored as float64 so a later decode matches the cleaned file.
 */
export function encodeYear(bars, year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1970 || y > 2100) failPack(`Bad archive year ${year}`);
  const count = bars.length;
  const buffer = new ArrayBuffer(HEADER + count * RECORD);
  const view = new DataView(buffer);
  for (let i = 0; i < MAGIC.length; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint8(4, VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, y, true);
  view.setUint32(8, count, true);
  view.setUint32(12, 0, true);

  let prev = '';
  for (let i = 0; i < count; i++) {
    const bar = bars[i];
    const time = String(bar.time || '');
    const date = time.slice(0, 10);
    const minute = Number(time.slice(11, 13)) * 60 + Number(time.slice(14, 16));
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(time) || Number(date.slice(0, 4)) !== y) {
      failPack(`Bar ${i} is not a ${y} minute-open Hong Kong timestamp`);
    }
    if (time <= prev) failPack('Bars must be strictly ascending');
    prev = time;
    if (minute < 0 || minute > 1439 || !Number.isInteger(minute)) failPack(`Bad minute in ${time}`);
    const px = [bar.open, bar.high, bar.low, bar.close];
    if (px.some((n) => !Number.isFinite(n))) failPack('OHLC must be finite');
    if (!(bar.high >= bar.low) || bar.high < bar.open || bar.high < bar.close || bar.low > bar.open || bar.low > bar.close) {
      failPack('OHLC is inconsistent');
    }
    const off = HEADER + i * RECORD;
    view.setUint16(off, dateToDayIndex(date), true);
    view.setUint16(off + 2, minute, true);
    view.setFloat64(off + 4, bar.open, true);
    view.setFloat64(off + 12, bar.high, true);
    view.setFloat64(off + 20, bar.low, true);
    view.setFloat64(off + 28, bar.close, true);
    let volume = Number(bar.volume);
    if (!Number.isFinite(volume) || volume < 0) volume = 0;
    view.setUint32(off + 36, Math.min(MAX_VOLUME, Math.round(volume)), true);
  }
  return new Uint8Array(buffer);
}

/** Decode one year object. Throws ArchiveError on any malformed byte. */
export function decodeYear(bytes) {
  try {
    const len = byteLength(bytes);
    if (len < HEADER) throw new ArchiveError();
    const view = viewOf(bytes);
    let magic = '';
    for (let i = 0; i < 4; i++) magic += String.fromCharCode(view.getUint8(i));
    if (magic !== MAGIC || view.getUint8(4) !== VERSION) throw new ArchiveError();
    const year = view.getUint16(6, true);
    const count = view.getUint32(8, true);
    if (HEADER + count * RECORD !== len) throw new ArchiveError();
    const bars = new Array(count);
    let prev = '';
    for (let i = 0; i < count; i++) {
      const off = HEADER + i * RECORD;
      const day = view.getUint16(off, true);
      const minute = view.getUint16(off + 2, true);
      if (minute > 1439) throw new ArchiveError();
      const date = dayIndexToDate(day);
      if (Number(date.slice(0, 4)) !== year) throw new ArchiveError();
      const time = stamp(date, minute);
      if (time <= prev) throw new ArchiveError();
      prev = time;
      const open = view.getFloat64(off + 4, true);
      const high = view.getFloat64(off + 12, true);
      const low = view.getFloat64(off + 20, true);
      const close = view.getFloat64(off + 28, true);
      if (![open, high, low, close].every(Number.isFinite)) throw new ArchiveError();
      bars[i] = { time, open, high, low, close, volume: view.getUint32(off + 36, true) };
    }
    return bars;
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError();
  }
}
