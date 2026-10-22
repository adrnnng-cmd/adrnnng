#!/usr/bin/env node
// Precompute the HSI lab grid from a private tape. Does not upload and does
// not print prices. Refuses to write inside this repository.
//
//   node scripts/hsi-lab-precompute.mjs \
//     --data /secure/HK_HSImain_1m.parquet \
//     --out /secure/hsi-results
//
//   node scripts/hsi-lab-precompute.mjs \
//     --bins /secure/hsi-bars/v1/1m \
//     --out /secure/hsi-results \
//     --years 2026
//
// Every run writes the ten ALL daily bundles. A year and a custom date
// window are sliced at lookup, so there is no per-year file. --years checks
// that those years are inside 2020..current; the full tape is still read,
// because the daily series is one continuous run. Old per-year files in
// --out are removed so the folder matches the manifest.
//
// Upload each written key to Workers KV namespace hsi-bars
// (id f6577e29d4b249dea5a81b4f00443082), bound on Pages as HSI_BARS:
//
//   npx wrangler kv key put --namespace-id f6577e29d4b249dea5a81b4f00443082 \
//     v1/results/5m-14/all.json.gz \
//     --path /secure/hsi-results/v1/results/5m-14/all.json.gz --remote

import { readdirSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { encodeBundle } from '../hsi-lab/engine/daily.js';
import { DATA_START, MAX_KV_VALUE_BYTES, bundleKey, utcDate } from '../hsi-lab/engine/grid.js';
import { entryGroups, requestedRanges } from '../hsi-lab/engine/precompute.js';
import { assertOutDir } from './pack-hsi-r2.mjs';

const NAMESPACE = 'hsi-bars';
const NAMESPACE_ID = 'f6577e29d4b249dea5a81b4f00443082';

function usage() {
  return `Usage: node scripts/hsi-lab-precompute.mjs (--data <csv-or-parquet> | --bins <dir>) --out <dir> [--years 2026] [--threads N]

Writes v1/results/<tf>m-<atr>/all.json.gz and v1/results/manifest.json.
Prints keys, row counts, session counts, and byte sizes only.
`;
}

function parseArgs(argv) {
  const out = { data: '', bins: '', out: '', years: '', threads: 0, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--data' || arg === '-d') out.data = next();
    else if (arg === '--bins') out.bins = next();
    else if (arg === '--out' || arg === '-o') out.out = next();
    else if (arg === '--years') out.years = next();
    else if (arg === '--threads') out.threads = Number(next());
    else throw new Error(`Unknown argument ${arg}`);
  }
  return out;
}

function runPool({ data, bins, groups, threads, now }) {
  const n = Math.max(1, Math.min(threads, groups.length));
  return new Promise((resolve, reject) => {
    let cursor = 0;
    let finished = 0;
    let failed = false;
    const results = [];
    const workers = [];
    const fail = (err) => {
      if (failed) return;
      failed = true;
      for (const worker of workers) worker.terminate();
      reject(err);
    };
    const launch = (worker) => {
      if (cursor >= groups.length) return;
      const group = groups[cursor];
      cursor += 1;
      worker.postMessage({ ...group, now });
    };
    for (let i = 0; i < n; i++) {
      const worker = new Worker(new URL('../hsi-lab/engine/precompute-worker.mjs', import.meta.url), {
        workerData: { data: data || '', bins: bins || '' },
      });
      workers.push(worker);
      worker.on('message', (msg) => {
        if (!msg?.ok) {
          fail(new Error(msg?.error || 'A precompute thread failed.'));
          return;
        }
        results.push(msg.group);
        finished += 1;
        if (finished === groups.length) {
          for (const item of workers) item.terminate();
          resolve(results);
        } else launch(worker);
      });
      worker.on('error', fail);
      launch(worker);
    }
  });
}

function listResultKeys(outDir) {
  const root = join(outDir, 'v1/results');
  const keys = [];
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return keys;
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name === 'all.json.gz') keys.push(`v1/results/${entry}/${name}`);
    }
  }
  keys.sort();
  return keys;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return Promise.resolve();
  }
  if (!args.data && !args.bins) throw new Error('Pass --data or --bins.');
  if (args.data && args.bins) throw new Error('Pass only one of --data or --bins.');
  const outDir = assertOutDir(args.out);
  const now = new Date();
  const years = args.years ? args.years.split(',').map((part) => part.trim()).filter(Boolean) : [];
  if (years.length) requestedRanges(years, now);
  const threads = Number.isInteger(args.threads) && args.threads > 0 ? args.threads : Math.max(1, availableParallelism() - 1);
  return runPool({
    data: args.data,
    bins: args.bins,
    groups: entryGroups(),
    threads,
    now: now.toISOString(),
  }).then((groups) => {
    const written = [];
    let totalBytes = 0;
    let sessions = 0;
    for (const group of groups) {
      const bundle = group.bundle;
      const key = bundleKey(group.entryTimeframe, group.atrLength, 'all');
      const path = join(outDir, key);
      mkdirSync(dirname(path), { recursive: true });
      const encoded = encodeBundle(bundle);
      const body = gzipSync(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength));
      if (body.length > MAX_KV_VALUE_BYTES) {
        throw new Error(`${key} is ${body.length} bytes, over the 25MB KV value limit.`);
      }
      writeFileSync(path, body);
      const dir = dirname(path);
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.json.gz') && name !== 'all.json.gz') unlinkSync(join(dir, name));
      }
      written.push(key);
      totalBytes += body.length;
      sessions = bundle.days.length;
      process.stdout.write(`${key}  rows=${Object.keys(bundle.rows).length}  days=${bundle.days.length}  bytes=${body.length}\n`);
    }
    const keys = listResultKeys(outDir);
    const manifest = {
      format: 'hsi-lab-results',
      version: 2,
      binding: 'HSI_BARS',
      namespace: NAMESPACE,
      namespaceId: NAMESPACE_ID,
      factor: 2.5,
      smoothing: 2,
      generated: now.toISOString(),
      dateStart: DATA_START,
      dateEnd: utcDate(now),
      resolution: 'daily',
      sessions,
      keys,
      totalBytes,
    };
    const manifestPath = join(outDir, 'v1/results/manifest.json');
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`v1/results/manifest.json  keys=${keys.length}  totalBytes=${totalBytes}  wrote=${written.length}\n`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
