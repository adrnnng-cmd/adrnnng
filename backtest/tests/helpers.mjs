// Synthetic bars for unit tests only. Never used by the site.

export function dates(n, start = '2020-01-06') {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Bars from closes; open = previous close (first open = close), high/low = max/min(open, close) ± pad. */
export function barsFromCloses(closes, pad = 0.5, start) {
  const t = dates(closes.length, start);
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: t[i], open: o, high: Math.max(o, c) + pad, low: Math.min(o, c) - pad, close: c, volume: 1000, dividend: 0 };
  });
}

/** Strategy whose target is a fixed array, for engine tests. */
export function scripted(target) {
  return { id: 'scripted', params: [], run: () => ({ target }) };
}

export const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
