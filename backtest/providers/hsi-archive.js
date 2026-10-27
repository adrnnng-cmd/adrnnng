// Year-pack format for HSI futures 1-minute bars.
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
//   0  uint16   days since 1970-01-01 (Hong Kong calendar date)
//   2  uint16   minutes from midnight (bar open)
//   4  float64  open
//   12 float64  high
//   20 float64  low
//   28 float64  close
//   36 uint32   volume, rounded, saturated at 2^32-1
//
// `time` is the bar open in Asia/Hong_Kong. This module has no I/O.

const HEADER = 16;
const RECORD = 40;
const MAGIC = 'HSI1';
const VERSION = 1;
const MAX_VOLUME = 0xffffffff;

export const HSI_ARCHIVE = Object.freeze({
  format: 'hsi1',
  version: VERSION,
  headerBytes: HEADER,
  recordBytes: RECORD,
  priceEncoding: 'float64-le',
  prefix: 'v1/1m/',
  timezone: 'Asia/Hong_Kong',
  binding: 'HSI_BARS',
});

export function hsiObjectKey(year) {
  return `v1/1m/${year}.bin`;
}

export class HsiArchiveError extends Error {
  constructor() {
    super('HSI futures bar pack could not be read.');
    this.name = 'HsiArchiveError';
  }
}

function viewOf(bytes) {
  if (bytes instanceof ArrayBuffer) return new DataView(bytes);
  if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new HsiArchiveError();
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

/**
 * Encode one calendar year of bars. `bars` must already be ascending and share `year`.
 */
export function encodeHsiYear(bars, year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1970 || y > 2100) throw new HsiArchiveError();
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
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(time) || Number(date.slice(0, 4)) !== y || time <= prev) {
      throw new HsiArchiveError();
    }
    prev = time;
    if (minute < 0 || minute > 1439 || !Number.isInteger(minute)) throw new HsiArchiveError();
    const px = [bar.open, bar.high, bar.low, bar.close];
    if (px.some((n) => !Number.isFinite(n))) throw new HsiArchiveError();
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

/** Decode one year object. Throws HsiArchiveError on any malformed byte. */
export function decodeHsiYear(bytes) {
  try {
    const len = byteLength(bytes);
    if (len < HEADER) throw new HsiArchiveError();
    const view = viewOf(bytes);
    let magic = '';
    for (let i = 0; i < 4; i++) magic += String.fromCharCode(view.getUint8(i));
    if (magic !== MAGIC || view.getUint8(4) !== VERSION) throw new HsiArchiveError();
    const year = view.getUint16(6, true);
    const count = view.getUint32(8, true);
    if (HEADER + count * RECORD !== len) throw new HsiArchiveError();
    const bars = new Array(count);
    let prev = '';
    for (let i = 0; i < count; i++) {
      const off = HEADER + i * RECORD;
      const day = view.getUint16(off, true);
      const minute = view.getUint16(off + 2, true);
      if (minute > 1439) throw new HsiArchiveError();
      const date = dayIndexToDate(day);
      if (Number(date.slice(0, 4)) !== year) throw new HsiArchiveError();
      const time = stamp(date, minute);
      if (time <= prev) throw new HsiArchiveError();
      prev = time;
      const open = view.getFloat64(off + 4, true);
      const high = view.getFloat64(off + 12, true);
      const low = view.getFloat64(off + 20, true);
      const close = view.getFloat64(off + 28, true);
      if (![open, high, low, close].every(Number.isFinite)) throw new HsiArchiveError();
      bars[i] = { time, open, high, low, close, volume: view.getUint32(off + 36, true) };
    }
    return bars;
  } catch (err) {
    if (err instanceof HsiArchiveError) throw err;
    throw new HsiArchiveError();
  }
}
