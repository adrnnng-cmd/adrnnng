// Price-data provider registry. A provider is an object with:
//
//   {
//     id: 'site', name: 'Shown in the source picker', description: '...',
//     kind: 'catalog' | 'file',
//     listSymbols?(): Promise<[{ symbol, name, group?, currency?, exchange?, first?, last?, stale? }]>  // catalog only
//     info?(): Promise<{ generatedAt, source }>
//     load(symbolOrFile): Promise<{
//       symbol, name, currency, bars: [{ time: 'YYYY-MM-DD', open, high, low, close, volume, dividend? }],
//       hasDividends: boolean,            // true → the UI offers dividend (total-return) adjustment
//       source: { name, url?, note?, asOf },
//       sample: boolean,                  // true for any non-real data; the UI then shows a SAMPLE banner
//     }>
//   }
//
// Bars must be daily, ascending, split-adjusted, with cash dividends (if any) on ex-dates.
// Weekly/monthly bars are derived in the browser. Register new providers in PROVIDERS.

import site from './static-csv.js';
import csv from './csv-upload.js';

export const PROVIDERS = [site, csv];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}
