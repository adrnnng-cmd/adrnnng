// Bar utilities. A bar is { time: 'YYYY-MM-DD', open, high, low, close, volume, dividend?, split? }.
// All functions are pure and return new arrays.

const NUM_FIELDS = ['open', 'high', 'low', 'close', 'volume', 'dividend', 'split'];

/** Parse CSV with a header row containing at least date/open/high/low/close. */
export function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows');
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const col = (names) => head.findIndex((h) => names.includes(h));
  const idx = {
    time: col(['date', 'time', 'timestamp', 'datetime']),
    open: col(['open', 'o']),
    high: col(['high', 'h']),
    low: col(['low', 'l']),
    close: col(['close', 'c', 'last', 'price']),
    adjclose: col(['adjclose', 'adjustedclose']),
    volume: col(['volume', 'vol', 'v']),
    dividend: col(['dividend', 'dividends']),
    split: col(['split', 'splits', 'stocksplits']),
  };
  for (const k of ['time', 'open', 'high', 'low', 'close']) {
    if (idx[k] < 0) throw new Error(`CSV is missing a "${k === 'time' ? 'date' : k}" column`);
  }
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const time = normaliseDate(f[idx.time]);
    const bar = { time };
    for (const k of NUM_FIELDS) bar[k] = idx[k] >= 0 ? Number(f[idx[k]]) || 0 : 0;
    if (!time || !(bar.close > 0) || !(bar.open > 0)) continue;
    bars.push(bar);
  }
  bars.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return dedupeByTime(bars);
}

function normaliseDate(s) {
  if (!s) return '';
  s = s.trim().replace(/^"|"$/g, '');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/) || s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (/^\d{9,13}$/.test(s)) {
    const ms = s.length > 10 ? Number(s) : Number(s) * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return '';
}

function dedupeByTime(bars) {
  const out = [];
  for (const b of bars) {
    if (out.length && out[out.length - 1].time === b.time) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}

/**
 * Back-adjust OHLC for cash dividends (total-return prices). Each ex-dividend day scales every
 * earlier bar by (1 - dividend / previous close), the usual cash-dividend convention. Volume is untouched.
 */
export function adjustForDividends(bars) {
  const out = new Array(bars.length);
  let factor = 1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    out[i] = { ...b, open: b.open * factor, high: b.high * factor, low: b.low * factor, close: b.close * factor };
    if (b.dividend > 0 && i > 0 && bars[i - 1].close > 0) factor *= 1 - b.dividend / bars[i - 1].close;
  }
  return out;
}

const periodKey = {
  '1d': (t) => t,
  '1w': (t) => {
    // ISO week: key by the Monday of the bar's week.
    const d = new Date(t + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  },
  '1mo': (t) => t.slice(0, 7),
};

export const TIMEFRAMES = [
  { id: '1d', label: 'Daily' },
  { id: '1w', label: 'Weekly' },
  { id: '1mo', label: 'Monthly' },
];

/** Aggregate daily bars into weekly/monthly bars, stamped with the period's last trading day. */
export function resample(bars, timeframe) {
  if (timeframe === '1d' || !timeframe) return bars.slice();
  const keyOf = periodKey[timeframe];
  if (!keyOf) throw new Error(`Unknown timeframe ${timeframe}`);
  const out = [];
  let cur = null;
  let curKey = null;
  for (const b of bars) {
    const k = keyOf(b.time);
    if (k !== curKey) {
      if (cur) out.push(cur);
      curKey = k;
      cur = { ...b, dividend: b.dividend || 0, split: b.split || 0 };
    } else {
      cur.time = b.time;
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume || 0;
      cur.dividend += b.dividend || 0;
      if (b.split) cur.split = b.split;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Index of the first bar with time >= date (bars.length if none). */
export function indexAtOrAfter(bars, date) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the last bar with time <= date (-1 if none). */
export function indexAtOrBefore(bars, date) {
  return indexAtOrAfter(bars, date + '\uffff') - 1;
}
