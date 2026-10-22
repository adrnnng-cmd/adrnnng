// Node-only reader for a private local bar file. Not registered in the browser
// provider list and not served by the site. Columns: time_key (bar open in
// Asia/Hong_Kong), open, high, low, close, volume. CSV is parsed here. Parquet
// is decoded by local_bars.py (pyarrow, polars, or duckdb).

import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HKT_MS = 8 * 60 * 60 * 1000;

function formatHkt(utcMs) {
  // Shift into HKT and read the UTC fields of that instant: they are the HKT wall clock.
  return new Date(utcMs + HKT_MS).toISOString().slice(0, 19);
}

function epochToUtcMs(n) {
  const abs = Math.abs(n);
  if (abs > 1e17) return n / 1e6; // nanoseconds
  if (abs > 1e14) return n / 1e3; // microseconds
  if (abs > 1e11) return n; // milliseconds
  return n * 1000; // seconds
}

/** time_key → "YYYY-MM-DDTHH:mm:ss" in Asia/Hong_Kong. Naive stamps are already HKT. */
export function normaliseTimeKey(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^-?\d+(\.\d+)?$/.test(s)) return formatHkt(epochToUtcMs(Number(s)));
  s = s.replace(' ', 'T');
  const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return '';
  const [, year, month, day, hour, minute, second, off] = m;
  const base = `${year}-${month}-${day}T${hour}:${minute}:${second || '00'}`;
  if (!off) return base;
  let offMin = 0;
  if (off !== 'Z') {
    const sign = off.startsWith('-') ? -1 : 1;
    const compact = off.slice(1).replace(':', '');
    offMin = sign * (Number(compact.slice(0, 2)) * 60 + Number(compact.slice(2) || '0'));
  }
  const utcMs = Date.parse(`${base}Z`) - offMin * 60 * 1000;
  if (!Number.isFinite(utcMs)) return '';
  return formatHkt(utcMs);
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function columnIndex(header, names) {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const name of names) {
    const i = norm.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse CSV text into ascending bars. Duplicate time_key values keep the last row.
 * @returns {{ bars: object[], skipped: number }}
 */
export function parseIntradayCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows');
  const header = splitCsvLine(lines[0]);
  const idx = {
    time: columnIndex(header, ['timekey', 'time', 'datetime', 'timestamp', 'date']),
    open: columnIndex(header, ['open']),
    high: columnIndex(header, ['high']),
    low: columnIndex(header, ['low']),
    close: columnIndex(header, ['close']),
    volume: columnIndex(header, ['volume', 'vol']),
  };
  for (const key of ['time', 'open', 'high', 'low', 'close', 'volume']) {
    if (idx[key] < 0) throw new Error(`CSV is missing a "${key === 'time' ? 'time_key' : key}" column`);
  }
  const byTime = new Map();
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const time = normaliseTimeKey(f[idx.time]);
    const bar = {
      time,
      open: Number(f[idx.open]),
      high: Number(f[idx.high]),
      low: Number(f[idx.low]),
      close: Number(f[idx.close]),
      volume: Number(f[idx.volume]),
    };
    if (!time || !Number.isFinite(bar.open) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close) || !(bar.open > 0) || !(bar.close > 0) || bar.high < bar.low) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(bar.volume)) bar.volume = 0;
    byTime.set(time, bar);
  }
  const bars = [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  if (!bars.length) throw new Error('CSV produced no valid bars');
  return { bars, skipped };
}

function parquetToCsv(path) {
  const script = fileURLToPath(new URL('./local_bars.py', import.meta.url));
  const out = join(tmpdir(), `hsi-bars-${process.pid}-${Date.now()}.csv`);
  const result = spawnSync('python3', [script, path, out], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`Could not run the parquet reader: ${result.error.message}`);
  if (result.status !== 0) {
    try { unlinkSync(out); } catch { /* the reader may not have created it */ }
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `parquet reader exited ${result.status}`);
  }
  try {
    return readFileSync(out, 'utf8');
  } finally {
    try { unlinkSync(out); } catch { /* already removed */ }
  }
}

/**
 * Load a local CSV or parquet file. `path` comes from --data or HSI_BARS_PATH.
 * Nothing is fetched from the network.
 */
export function loadLocalBars(path) {
  if (!path) throw new Error('No bar file. Pass --data <path> or set HSI_BARS_PATH to a local CSV or parquet file.');
  const lower = path.toLowerCase();
  const text = lower.endsWith('.parquet') || lower.endsWith('.pq') ? parquetToCsv(path) : readFileSync(path, 'utf8');
  const { bars, skipped } = parseIntradayCsv(text);
  return { path, bars, skipped, source: { name: 'local file', note: 'Private bars, read on this machine only.' } };
}
