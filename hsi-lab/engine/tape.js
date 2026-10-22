// Local tape for the precompute. CSV, parquet, or a directory of packed year
// bins. This module is Node-only and is not imported by the Pages Function.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLocalBars } from '../../backtest/providers/local-bars.js';
import { decodeYear } from './archive.js';

export function loadTape({ data, bins }) {
  if (bins) return loadPackedBins(bins);
  if (!data) throw new Error('Pass --data or --bins.');
  return loadLocalBars(data).bars;
}

export function loadPackedBins(dir) {
  const names = readdirSync(dir).filter((name) => /^\d{4}\.bin$/.test(name)).sort();
  if (!names.length) throw new Error('No v1/1m/YYYY.bin files in that directory.');
  const bars = [];
  for (const name of names) {
    const chunk = decodeYear(readFileSync(join(dir, name)));
    for (let i = 0; i < chunk.length; i++) bars.push(chunk[i]);
  }
  return bars;
}
