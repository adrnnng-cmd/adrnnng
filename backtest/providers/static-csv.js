// Default provider: daily CSVs published with the site by the scheduled
// "Backtest prices refresh" workflow (.github/backtest/prices).

import { parseCsv } from '../engine/bars.js';

const BASE = new URL('../data/prices/', import.meta.url);

let manifestPromise = null;
const cache = new Map();

function getManifest() {
  manifestPromise ??= fetch(new URL('manifest.json', BASE), { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`price manifest HTTP ${r.status}`);
    return r.json();
  });
  return manifestPromise;
}

export default {
  id: 'site',
  name: 'Daily history',
  kind: 'catalog',
  description: 'Daily OHLCV with dividends and splits, refreshed on a schedule and served as static files.',

  async listSymbols() {
    const m = await getManifest();
    return m.symbols.map((s) => ({ ...s }));
  },

  async info() {
    const m = await getManifest();
    return { generatedAt: m.generated_at, source: m.source };
  },

  async load(symbol) {
    const m = await getManifest();
    const entry = m.symbols.find((s) => s.symbol === symbol);
    if (!entry) throw new Error(`${symbol} is not in the site's price set`);
    if (!cache.has(symbol)) {
      cache.set(
        symbol,
        fetch(new URL(entry.file, BASE)).then(async (r) => {
          if (!r.ok) throw new Error(`${symbol} prices HTTP ${r.status}`);
          return parseCsv(await r.text());
        }),
      );
    }
    let bars;
    try {
      bars = await cache.get(symbol);
    } catch (e) {
      cache.delete(symbol);
      throw e;
    }
    return {
      symbol,
      name: entry.name,
      currency: entry.currency,
      exchange: entry.exchange,
      bars,
      hasDividends: true,
      source: { ...m.source, asOf: entry.last, stale: entry.stale, fetchedAt: m.generated_at },
      sample: false,
    };
  },
};
