// HSI futures bars. Same shape as the daily catalog provider: load() returns
// { symbol, name, currency, bars, source, sample }.
//
// The year packs are not in git. A Pages Function reads the HSI_BARS KV binding
// and serves them at this provider's default base, /backtest/data/hsi/. A 404
// from that path still becomes BarsPending.
//
// Bind and env (never shown as a vendor on the page):
//   HSI_BARS       Cloudflare binding name for the bar bucket (R2 or KV)
//   HSI_BARS_URL   public base URL a worker or the page should fetch
//   HSI_BARS_BASE  same, read in the browser from window.__HSI_BARS_BASE
//                  or <meta name="hsi-bars-base" content="https://…/">
//   prefix         v1/1m/   year packs v1/1m/YYYY.bin and v1/1m/manifest.json
//   daily          v1/1d/HSImain.csv  page load for daily, weekly, and monthly
//   static fallback  /backtest/data/hsi/  (this provider's default base)

import { parseCsv } from '../engine/bars.js';
import { HSI_FUTURES } from '../symbols.js';
import { decodeHsiYear, HSI_ARCHIVE, hsiObjectKey } from './hsi-archive.js';

export const HSI_BARS_BINDING = HSI_ARCHIVE.binding;
export const HSI_BARS_PREFIX = HSI_ARCHIVE.prefix;
export const HSI_BARS_ENV = Object.freeze(['HSI_BARS', 'HSI_BARS_URL', 'HSI_BARS_BASE']);

export class BarsPending extends Error {
  constructor(message) {
    super(message || 'HSI futures bars are not on this site yet.');
    this.name = 'BarsPending';
    this.code = 'bars-pending';
  }
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export function hsiBarsBase(doc = globalThis.document, win = globalThis) {
  const meta = doc?.querySelector?.('meta[name="hsi-bars-base"]')?.getAttribute('content');
  if (meta) return meta;
  if (win?.__HSI_BARS_BASE) return win.__HSI_BARS_BASE;
  return new URL('../data/hsi/', import.meta.url).href;
}

async function fetchBytes(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HSI futures bars HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function fetchText(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HSI futures bars HTTP ${res.status}`);
  return res.text();
}

function manifestYears(manifest) {
  const objects = manifest?.objects || manifest?.years || [];
  const years = [];
  for (const row of objects) {
    const year = Number(row.year ?? row);
    if (Number.isInteger(year)) years.push(year);
  }
  return [...new Set(years)].sort((a, b) => a - b);
}

/**
 * Load HSI futures bars from a public base. `fetchImpl` is injectable for tests.
 * Returns 1-minute bars when year packs exist, otherwise daily bars from v1/1d/.
 */
export async function loadHsiFutures({ base, fetchImpl = globalThis.fetch } = {}) {
  const root = base || hsiBarsBase();
  const manifestText = await fetchText(fetchImpl, joinUrl(root, 'v1/1m/manifest.json'));
  if (manifestText) {
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      throw new BarsPending('HSI futures bars are not on this site yet.');
    }
    const years = manifestYears(manifest);
    if (!years.length) throw new BarsPending('HSI futures bars are not on this site yet.');
    const bars = [];
    for (const year of years) {
      const bytes = await fetchBytes(fetchImpl, joinUrl(root, hsiObjectKey(year)));
      if (!bytes) continue;
      const chunk = decodeHsiYear(bytes);
      for (let i = 0; i < chunk.length; i++) bars.push(chunk[i]);
    }
    if (!bars.length) throw new BarsPending('HSI futures bars are not on this site yet.');
    return pack(bars, '1m', bars.at(-1).time.slice(0, 10));
  }

  const dailyText = await fetchText(fetchImpl, joinUrl(root, 'v1/1d/HSImain.csv'));
  if (!dailyText) throw new BarsPending('HSI futures bars are not on this site yet.');
  const daily = parseCsv(dailyText);
  if (daily.length < 2) throw new BarsPending('HSI futures bars are not on this site yet.');
  return pack(daily, '1d', daily.at(-1).time.slice(0, 10));
}

/** Daily file only. The page uses this for HSImain daily, weekly, and monthly. */
export async function loadHsiDaily({ base, fetchImpl = globalThis.fetch } = {}) {
  const root = base || hsiBarsBase();
  const dailyText = await fetchText(fetchImpl, joinUrl(root, 'v1/1d/HSImain.csv'));
  if (!dailyText) throw new BarsPending('HSI futures bars are not on this site yet.');
  const daily = parseCsv(dailyText);
  if (daily.length < 2) throw new BarsPending('HSI futures bars are not on this site yet.');
  return pack(daily, '1d', daily.at(-1).time.slice(0, 10));
}

function pack(bars, resolution, asOf) {
  return {
    symbol: HSI_FUTURES.symbol,
    name: HSI_FUTURES.name,
    currency: HSI_FUTURES.currency,
    exchange: HSI_FUTURES.exchange,
    bars,
    resolution,
    intraday: resolution !== '1d',
    hasDividends: false,
    source: {
      name: 'HSI futures',
      note: 'Hang Seng futures, continuous. Day session in Hong Kong time. 1-minute and 5-minute bars when the public packs are published.',
      asOf,
    },
    sample: false,
  };
}

const catalog = Object.freeze([{
  symbol: HSI_FUTURES.symbol,
  name: HSI_FUTURES.name,
  group: HSI_FUTURES.group,
  currency: HSI_FUTURES.currency,
  exchange: HSI_FUTURES.exchange,
  timeframes: ['1d', '1w', '1mo', '1m', '5m'],
}]);

export default {
  id: 'hsi-futures',
  name: 'HSI futures',
  kind: 'catalog',
  description: 'Hang Seng futures. 1-minute and 5-minute ATR SuperTrend reads a stored result. Daily bars come from v1/1d/HSImain.csv when that file is published.',
  async listSymbols() {
    return catalog.map((s) => ({ ...s }));
  },
  load() {
    return loadHsiFutures();
  },
};
