// Slim SuperTrend drawing for one stored combo. The page does not build this
// from the minute tape.
//
// KV key (binding HSI_BARS), public path under /backtest/data/hsi/:
//   v1/results/{entryTf}m-{entryAtr}/ov/{exitTf}-{exitAtr}-{entryRule}-{clock}-{exitRule}.json.gz
//     entryTf, exitTf   1 or 5
//     atr               10–14
//     entryRule         flip | clock | firstFlip
//     clock             na for flip, otherwise 0915 or 0930
//     exitRule          flat | reenter | reverse
//   Fast Response: v1/results/5m-10/ov/5-10-clock-0930-reenter.json.gz
//
// Body is gzip (magic 1f 8b) of an HSIO v1 payload. The name ends in .json.gz.
// The bytes are not JSON. encodeOverlay() writes them.
//
// Keep a line point when direction changes, and at least every 15 minutes of
// the session. Same timestamps can carry an OHLC sample. Markers are the fills
// to draw: side 1 is Buy, side -1 is Sell. Caps: 60,000 candles, 60,000 line
// points, 8,000 markers. The page slices from–to the same way it slices the
// score. A missing object leaves the score chart up.

import { hsiBarsBase } from './hsi-futures.js';
import { dateToIndex, indexToDate } from './hsi-results.js';

export const OVERLAY_MAX_CANDLES = 60000;
export const OVERLAY_MAX_LINE = 60000;
export const OVERLAY_MAX_MARKERS = 8000;
const HEADER = 22;
const CANDLE_STRIDE = 20;
const LINE_STRIDE = 9;
const MARKER_STRIDE = 5;
const SCALE = 100;

export class OverlayError extends Error {
  constructor(message = 'The stored SuperTrend line could not be read.') {
    super(message);
    this.name = 'OverlayError';
  }
}

function asTf(value) {
  if (value === 1 || value === '1' || value === '1m') return '1';
  if (value === 5 || value === '5' || value === '5m') return '5';
  return null;
}

function asAtr(value) {
  const n = Math.round(Number(value));
  return n >= 10 && n <= 14 ? String(n) : null;
}

/** File name for a combo key such as 5:10:clock:09:30:reenter. The clock keeps its colon. */
export function overlayFileName(combo) {
  const match = /^(1|5):(10|11|12|13|14):(flip|clock|firstFlip):(-|09:15|09:30):(flat|reenter|reverse)$/.exec(String(combo || ''));
  if (!match) return null;
  const [, exitTf, exitAtr, entryRule, clock, exitRule] = match;
  let clockSlug = null;
  if (entryRule === 'flip') clockSlug = clock === '-' ? 'na' : null;
  else if (clock === '09:15') clockSlug = '0915';
  else if (clock === '09:30') clockSlug = '0930';
  if (!clockSlug) return null;
  return `${exitTf}-${exitAtr}-${entryRule}-${clockSlug}-${exitRule}.json.gz`;
}

export function overlayObjectKey(entryTimeframe, atrLength, combo) {
  const tf = asTf(entryTimeframe);
  const atr = asAtr(atrLength);
  const file = overlayFileName(combo);
  if (!tf || !atr || !file) return null;
  return `v1/results/${tf}m-${atr}/ov/${file}`;
}

function stamp(time) {
  const text = String(time || '');
  const day = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new OverlayError();
  const index = dateToIndex(day);
  if (index < 0 || index > 65535) throw new OverlayError();
  let minute = 0;
  if (text.length > 10) {
    const match = /T(\d{2}):(\d{2})/.exec(text);
    if (!match) throw new OverlayError();
    minute = Number(match[1]) * 60 + Number(match[2]);
    if (minute < 0 || minute > 1439) throw new OverlayError();
  }
  return { index, minute, order: index * 1440 + minute };
}

function timeFromStamp(index, minute) {
  const day = indexToDate(index);
  if (!minute) return day;
  const hour = String(Math.floor(minute / 60)).padStart(2, '0');
  const min = String(minute % 60).padStart(2, '0');
  return `${day}T${hour}:${min}:00`;
}

function cents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new OverlayError();
  const scaled = Math.round(n * SCALE);
  if (scaled > 2147483647 || scaled < -2147483648) throw new OverlayError();
  return scaled;
}

function priceOf(centsValue) {
  return centsValue / SCALE;
}

function assertOrder(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].order <= rows[i - 1].order) throw new OverlayError();
  }
}

export function encodeOverlay(overlay) {
  const candles = (overlay?.candles || []).map((bar) => ({ ...stamp(bar.time), bar }));
  const line = (overlay?.line || []).map((point) => ({ ...stamp(point.time), point }));
  const markers = (overlay?.markers || []).map((mark) => ({ ...stamp(mark.time), mark }));
  if (candles.length > OVERLAY_MAX_CANDLES || line.length > OVERLAY_MAX_LINE || markers.length > OVERLAY_MAX_MARKERS) {
    throw new OverlayError('SuperTrend overlay is too large.');
  }
  assertOrder(candles);
  assertOrder(line);
  assertOrder(markers);
  const total = HEADER + candles.length * CANDLE_STRIDE + line.length * LINE_STRIDE + markers.length * MARKER_STRIDE;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set([0x48, 0x53, 0x49, 0x4f], 0);
  bytes[4] = 1;
  view.setUint32(8, candles.length, true);
  view.setUint32(12, line.length, true);
  view.setUint32(16, markers.length, true);
  let p = HEADER;
  for (const row of candles) {
    view.setUint16(p, row.index, true);
    view.setUint16(p + 2, row.minute, true);
    view.setInt32(p + 4, cents(row.bar.open), true);
    view.setInt32(p + 8, cents(row.bar.high), true);
    view.setInt32(p + 12, cents(row.bar.low), true);
    view.setInt32(p + 16, cents(row.bar.close), true);
    p += CANDLE_STRIDE;
  }
  for (const row of line) {
    const dir = row.point.dir === 1 || row.point.dir === -1 ? row.point.dir : null;
    if (dir == null) throw new OverlayError();
    view.setUint16(p, row.index, true);
    view.setUint16(p + 2, row.minute, true);
    view.setInt32(p + 4, cents(row.point.value), true);
    view.setInt8(p + 8, dir);
    p += LINE_STRIDE;
  }
  for (const row of markers) {
    const side = row.mark.side === 1 || row.mark.side === -1 ? row.mark.side : null;
    if (side == null) throw new OverlayError();
    view.setUint16(p, row.index, true);
    view.setUint16(p + 2, row.minute, true);
    view.setInt8(p + 4, side);
    p += MARKER_STRIDE;
  }
  if (p !== total) throw new OverlayError();
  return bytes;
}

export function decodeOverlay(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.length < HEADER) throw new OverlayError();
  if (raw[0] !== 0x48 || raw[1] !== 0x53 || raw[2] !== 0x49 || raw[3] !== 0x4f || raw[4] !== 1) throw new OverlayError();
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const candleCount = view.getUint32(8, true);
  const lineCount = view.getUint32(12, true);
  const markerCount = view.getUint32(16, true);
  if (
    candleCount > OVERLAY_MAX_CANDLES * 4 ||
    lineCount > OVERLAY_MAX_LINE * 4 ||
    markerCount > OVERLAY_MAX_MARKERS * 4
  ) {
    throw new OverlayError('SuperTrend overlay is too large.');
  }
  const total = HEADER + candleCount * CANDLE_STRIDE + lineCount * LINE_STRIDE + markerCount * MARKER_STRIDE;
  if (raw.length !== total) throw new OverlayError();
  let p = HEADER;
  const candles = [];
  for (let i = 0; i < candleCount; i++) {
    candles.push({
      time: timeFromStamp(view.getUint16(p, true), view.getUint16(p + 2, true)),
      open: priceOf(view.getInt32(p + 4, true)),
      high: priceOf(view.getInt32(p + 8, true)),
      low: priceOf(view.getInt32(p + 12, true)),
      close: priceOf(view.getInt32(p + 16, true)),
    });
    p += CANDLE_STRIDE;
  }
  const line = [];
  for (let i = 0; i < lineCount; i++) {
    const dir = view.getInt8(p + 8);
    if (dir !== 1 && dir !== -1) throw new OverlayError();
    line.push({
      time: timeFromStamp(view.getUint16(p, true), view.getUint16(p + 2, true)),
      value: priceOf(view.getInt32(p + 4, true)),
      dir,
    });
    p += LINE_STRIDE;
  }
  const markers = [];
  for (let i = 0; i < markerCount; i++) {
    const side = view.getInt8(p + 4);
    if (side !== 1 && side !== -1) throw new OverlayError();
    markers.push({
      time: timeFromStamp(view.getUint16(p, true), view.getUint16(p + 2, true)),
      side,
    });
    p += MARKER_STRIDE;
  }
  return { candles, line, markers };
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeOverlayBytes(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) return decodeOverlay(await gunzip(raw));
  return decodeOverlay(raw);
}

function inWindow(time, from, to) {
  const day = String(time).slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function stride(rows, max, keep) {
  if (rows.length <= max) return rows;
  const must = new Set(keep || []);
  must.add(0);
  must.add(rows.length - 1);
  const required = [...must].filter((i) => i >= 0 && i < rows.length).sort((a, b) => a - b);
  if (required.length >= max) {
    const picked = [];
    const last = required.length - 1;
    let prev = -1;
    for (let i = 0; i < max; i++) {
      const idx = required[Math.round((i * last) / (max - 1))];
      if (idx !== prev) picked.push(rows[idx]);
      prev = idx;
    }
    return picked;
  }
  const room = max - required.length;
  const optional = [];
  for (let i = 0; i < rows.length; i++) if (!must.has(i)) optional.push(i);
  const chosen = new Set(required);
  if (optional.length && room > 0) {
    const last = optional.length - 1;
    const take = Math.min(room, optional.length);
    for (let i = 0; i < take; i++) chosen.add(optional[Math.round((i * last) / Math.max(1, take - 1))]);
  }
  return [...chosen].sort((a, b) => a - b).map((i) => rows[i]);
}

/** Drop days outside from–to, then keep the drawing under the caps. */
export function sliceOverlay(decoded, from, to, limits = {}) {
  const maxCandles = limits.maxCandles ?? OVERLAY_MAX_CANDLES;
  const maxLine = limits.maxLine ?? OVERLAY_MAX_LINE;
  const maxMarkers = limits.maxMarkers ?? OVERLAY_MAX_MARKERS;
  const candles = (decoded?.candles || []).filter((bar) => inWindow(bar.time, from, to));
  const line = (decoded?.line || []).filter((point) => inWindow(point.time, from, to));
  const markers = (decoded?.markers || []).filter((mark) => inWindow(mark.time, from, to));
  const flips = [];
  for (let i = 1; i < line.length; i++) if (line[i].dir !== line[i - 1].dir) flips.push(i);
  return {
    candles: stride(candles, maxCandles),
    line: stride(line, maxLine, flips),
    markers: stride(markers, maxMarkers),
  };
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

const overlayCache = new Map();

export function resetHsiOverlayCache() {
  overlayCache.clear();
}

async function fetchBytes(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HSI overlay HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Load one combo's drawing and slice it. Null means it is not stored.
 * `view` is a scored result (combo + params). The score bundle is not fetched again.
 */
export async function lookupHsiOverlay(view, { from, to, base, fetchImpl = globalThis.fetch } = {}) {
  const key = overlayObjectKey(view?.params?.entryTimeframe, view?.params?.atrLength, view?.combo);
  if (!key) return null;
  let decoded = overlayCache.get(key);
  if (decoded === undefined) {
    const root = base || hsiBarsBase();
    const bytes = await fetchBytes(fetchImpl, joinUrl(root, key));
    if (!bytes) {
      overlayCache.set(key, null);
      decoded = null;
    } else {
      try {
        decoded = await decodeOverlayBytes(bytes);
      } catch (err) {
        if (err instanceof OverlayError || err?.name === 'OverlayError') {
          overlayCache.set(key, null);
          return null;
        }
        throw err;
      }
      overlayCache.set(key, decoded);
    }
  }
  if (!decoded) return null;
  return sliceOverlay(decoded, from || view?.params?.from, to || view?.params?.to);
}
