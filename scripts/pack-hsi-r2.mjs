#!/usr/bin/env node
// Pack a private cleaned HSI file into year objects for Workers KV.
//
//   node scripts/pack-hsi-r2.mjs --data /secure/HK_HSImain_1m.parquet --out /secure/hsi-bars
//
// Input columns: time_key (bar open, Asia/Hong_Kong), open, high, low, close, volume.
// CSV is read directly. Parquet needs pyarrow, polars, or duckdb already installed.
// Writes v1/1m/YYYY.bin and v1/1m/manifest.json. Does not upload and does not
// print prices. Refuses to write inside this repository.
//
// Upload (KV namespace bound to the Pages project as HSI_BARS):
//   npx wrangler kv key put --namespace-id <id> v1/1m/2020.bin --path /secure/hsi-bars/v1/1m/2020.bin --remote

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalBars } from '../backtest/providers/local-bars.js';
import { ARCHIVE, encodeYear, objectKey } from '../hsi-lab/engine/archive.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return `Usage: node scripts/pack-hsi-r2.mjs --data <csv-or-parquet> --out <dir-outside-this-repo>

Writes one private object per calendar year plus a manifest. Prints keys and
counts only. Upload those files to the Workers KV namespace bound as HSI_BARS.
`;
}

function parseArgs(argv) {
  const out = { data: '', out: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--data' || arg === '-d') out.data = next();
    else if (arg === '--out' || arg === '-o') out.out = next();
    else throw new Error(`Unknown argument ${arg}`);
  }
  return out;
}

export function assertOutDir(outDir, root = ROOT) {
  if (!outDir) throw new Error('Pass --out, a directory outside this repository.');
  const resolved = resolve(outDir);
  const rootResolved = resolve(root);
  if (resolved === rootResolved || resolved.startsWith(rootResolved + sep)) {
    throw new Error('Refusing to write bar objects inside the repository. Pass --out to a private directory outside this repo.');
  }
  return resolved;
}

function splitYears(bars) {
  const byYear = new Map();
  for (const bar of bars) {
    const year = Number(bar.time.slice(0, 4));
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(bar);
  }
  return [...byYear.entries()].sort((a, b) => a[0] - b[0]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.data) throw new Error('Pass --data, the cleaned CSV or parquet path.');
  const outDir = assertOutDir(args.out);
  const loaded = loadLocalBars(args.data);
  const years = splitYears(loaded.bars);
  if (!years.length) throw new Error('No bars to pack.');
  mkdirSync(join(outDir, 'v1/1m'), { recursive: true });
  const objects = [];
  for (const [year, bars] of years) {
    const bytes = encodeYear(bars, year);
    const key = objectKey(year);
    const path = join(outDir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const row = { key, year, bars: bars.length, from: bars[0].time, to: bars[bars.length - 1].time };
    objects.push(row);
    process.stdout.write(`${key}  bars=${row.bars}  from=${row.from}  to=${row.to}\n`);
  }
  const manifest = {
    format: ARCHIVE.format,
    version: ARCHIVE.version,
    binding: 'HSI_BARS',
    storage: 'kv',
    prefix: ARCHIVE.prefix,
    timezone: ARCHIVE.timezone,
    priceEncoding: ARCHIVE.priceEncoding,
    headerBytes: ARCHIVE.headerBytes,
    recordBytes: ARCHIVE.recordBytes,
    skippedRows: loaded.skipped,
    objects,
  };
  const manifestPath = join(outDir, 'v1/1m/manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`v1/1m/manifest.json  years=${objects.length}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}
