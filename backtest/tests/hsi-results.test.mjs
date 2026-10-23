import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOT_COMPUTED,
  NOT_SUPERTREND,
  OUTSIDE_RANGE,
  prepareHsiLookup,
  presetBounds,
  resultBundleKey,
  comboKey,
  encodeBundle,
  decodeBundleBytes,
  scoreStored,
  lookupHsiResult,
  resetHsiResultCache,
  ResultMissing,
} from '../providers/hsi-results.js';
import { hsiResultKey, serveHsiResult } from '../../functions/backtest/data/hsi/v1/results/[slug]/[file].js';

const now = new Date('2026-10-23T00:00:00Z');
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const fast = {
  strategy: 'atr-supertrend',
  entryTimeframe: '5m',
  exitTimeframe: '5m',
  atrLength: 10,
  exitAtrLength: 10,
  entryRule: 'clock',
  clock: '09:30',
  exitRule: 'reenter',
  factor: 2.5,
  smoothing: 2,
  confirm: 'none',
  flattenEod: true,
  sessionMode: 'year',
  year: 'all',
  costPoints: 6,
};

function sampleBundle() {
  return {
    entryTimeframe: 5,
    atrLength: 14,
    days: ['2024-03-04', '2024-03-05', '2025-01-02'],
    rows: {
      '5:14:clock:09:30:reenter': {
        g: [10, 5, 7],
        t: [8, 1, 2],
        w: [2, 1, 2],
        gw: [30, 5, 7],
        gl: [20, 0, 0],
        h: [8, 1, 4],
        mn: [0, 0, 0],
        hours: { all: [[9, 4, 2, 10]], years: { 2024: [[9, 4, 2, 10]] } },
      },
      '5:10:clock:09:30:reenter': {
        g: [1, 1, 1],
        t: [1, 1, 1],
        w: [1, 1, 1],
        gw: [1, 1, 1],
        gl: [0, 0, 0],
        h: [1, 1, 1],
        mn: [0, 0, 0],
        hours: { all: [], years: {} },
      },
    },
  };
}

test('Fast Response names the lab key and combo', () => {
  const spec = prepareHsiLookup(fast, now);
  assert.equal(spec.ok, true);
  assert.equal(spec.key, 'v1/results/5m-10/all.json.gz');
  assert.equal(spec.key, resultBundleKey(5, 10));
  assert.equal(spec.combo, '5:10:clock:09:30:reenter');
  assert.equal(spec.combo, comboKey({ exitTimeframe: 5, exitAtrLength: 10, entryRule: 'clock', clock: '09:30', exitRule: 'reenter' }));
  assert.equal(spec.range, 'all');
  assert.equal(spec.from, '2020-01-02');
  assert.equal(spec.to, '2026-10-23');
});

test('a combo outside the grid does not name a key', () => {
  assert.equal(prepareHsiLookup({ ...fast, atrLength: 9 }, now).ok, false);
  assert.equal(prepareHsiLookup({ ...fast, confirm: 'daily' }, now).message, NOT_COMPUTED);
  assert.equal(prepareHsiLookup({ ...fast, flattenEod: false }, now).message, NOT_COMPUTED);
  assert.equal(prepareHsiLookup({ ...fast, factor: 3 }, now).message, NOT_COMPUTED);
  assert.equal(prepareHsiLookup({ ...fast, strategy: 'td-sequential' }, now).message, NOT_SUPERTREND);
  assert.equal(prepareHsiLookup({ ...fast, sessionMode: 'year', year: '2024' }, now).ok, true);
  assert.equal(prepareHsiLookup({ ...fast, sessionMode: 'year', year: '2024' }, now).from, '2024-01-01');
  assert.equal(prepareHsiLookup({ ...fast, sessionMode: 'year', year: '2024' }, now).to, '2024-12-31');
});

test('stored points match the lab cost rules, including a single year', async () => {
  const raw = encodeBundle({
    entryTimeframe: 5,
    atrLength: 14,
    days: ['2024-03-04', '2024-03-05'],
    rows: {
      '5:14:clock:09:30:reenter': {
        g: [10, 5],
        t: [8, 1],
        w: [2, 1],
        gw: [30, 5],
        gl: [20, 0],
        h: [8, 1],
        mn: [0, 0],
        hours: { all: [[9, 4, 2, 10]], years: {} },
      },
    },
  });
  const decoded = await decodeBundleBytes(gzipSync(raw));
  const spec = prepareHsiLookup({
    ...fast,
    entryTimeframe: 5,
    atrLength: 14,
    exitAtrLength: 14,
    sessionMode: 'dates',
    from: '2024-03-04',
    to: '2024-03-05',
    costPoints: 6,
  }, now);
  const scored = scoreStored(decoded, spec);
  assert.equal(scored.metrics.grossPoints, 15);
  assert.equal(scored.metrics.netPoints, -39);
  assert.equal(scored.metrics.profitFactor, 0.3158);
  assert.equal(scored.metrics.winRate, Number((2 / 9).toFixed(4)));
  assert.equal(scored.byYear[0].netPoints, -39);
  assert.equal(scored.equity.length, 2);
});

test('lookup fetches only the one bundle and slices the selected year', async () => {
  resetHsiResultCache();
  const gz = gzipSync(encodeBundle(sampleBundle()));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('v1/results/5m-14/all.json.gz')) {
      return { status: 200, ok: true, arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) };
    }
    return { status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const year = await lookupHsiResult({
    ...fast,
    atrLength: 14,
    exitAtrLength: 14,
    sessionMode: 'year',
    year: '2024',
    costPoints: 6,
  }, { base: 'https://bars.example/', fetchImpl, now });
  assert.deepEqual(urls, ['https://bars.example/v1/results/5m-14/all.json.gz']);
  assert.equal(year.metrics.trades, 9);
  assert.equal(year.byYear.length, 1);
  assert.equal(year.byYear[0].year, '2024');
  assert.ok(!urls.some((url) => url.includes('.bin')));

  const again = await lookupHsiResult({
    ...fast,
    atrLength: 14,
    exitAtrLength: 14,
    sessionMode: 'year',
    year: 'all',
    costPoints: 0,
  }, { base: 'https://bars.example/', fetchImpl, now });
  assert.equal(urls.length, 1);
  assert.equal(again.metrics.trades, 11);
  assert.equal(again.byYear.length, 2);

  await assert.rejects(
    () => lookupHsiResult({
      ...fast,
      atrLength: 14,
      exitAtrLength: 14,
      exitRule: 'flat',
      sessionMode: 'year',
      year: 'all',
    }, { base: 'https://bars.example/', fetchImpl, now }),
    (err) => err instanceof ResultMissing && err.message === NOT_COMPUTED,
  );
  assert.equal(urls.length, 1);
});

test('a missing bundle or combo is not computed, and a bad combo is not fetched', async () => {
  resetHsiResultCache();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(
    () => lookupHsiResult({ ...fast, atrLength: 9 }, { base: 'https://bars.example/', fetchImpl, now }),
    (err) => {
      assert.equal(err instanceof ResultMissing, true);
      assert.equal(err.message, NOT_COMPUTED);
      return true;
    },
  );
  assert.equal(urls.length, 0);

  await assert.rejects(
    () => lookupHsiResult(fast, { base: 'https://bars.example/', fetchImpl, now }),
    (err) => err instanceof ResultMissing && err.message === NOT_COMPUTED,
  );
  assert.deepEqual(urls, ['https://bars.example/v1/results/5m-10/all.json.gz']);
});

test('custom dates slice the all bundle even when year is still all', async () => {
  resetHsiResultCache();
  assert.equal(presetBounds(1, now).from, '2025-10-23');
  assert.equal(presetBounds(1, now).to, '2026-10-23');
  assert.equal(presetBounds(null, now).from, '2020-01-02');
  assert.equal(presetBounds(20, now).from, '2020-01-02');
  const inverted = prepareHsiLookup({ ...fast, sessionMode: 'dates', year: 'all', from: '2024-04-01', to: '2024-03-01' }, now);
  assert.equal(inverted.ok, false);
  assert.equal(inverted.message, OUTSIDE_RANGE);

  const gz = gzipSync(encodeBundle(sampleBundle()));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('v1/results/5m-14/all.json.gz')) {
      return { status: 200, ok: true, arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) };
    }
    return { status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const view = await lookupHsiResult({
    ...fast,
    atrLength: 14,
    exitAtrLength: 14,
    sessionMode: 'dates',
    year: 'all',
    from: '2024-03-05',
    to: '2024-03-05',
    costPoints: 0,
  }, { base: 'https://bars.example/', fetchImpl, now });
  assert.deepEqual(urls, ['https://bars.example/v1/results/5m-14/all.json.gz']);
  assert.equal(view.metrics.sessionDays, 1);
  assert.equal(view.equity.length, 1);
  assert.equal(view.equity[0].date, '2024-03-05');
  assert.equal(view.params.from, '2024-03-05');
  assert.equal(view.params.to, '2024-03-05');

  const all = await lookupHsiResult({
    ...fast,
    atrLength: 14,
    exitAtrLength: 14,
    sessionMode: 'year',
    year: 'all',
    costPoints: 0,
  }, { base: 'https://bars.example/', fetchImpl, now });
  assert.equal(urls.length, 1);
  assert.equal(all.metrics.sessionDays, 3);
});

test('the results function serves the bundle key and refuses anything else', async () => {
  assert.equal(hsiResultKey('5m-10', 'all.json.gz'), 'v1/results/5m-10/all.json.gz');
  assert.equal(hsiResultKey('1m-14', '2024.json.gz'), 'v1/results/1m-14/2024.json.gz');
  assert.equal(hsiResultKey('5m-9', 'all.json.gz'), null);
  assert.equal(hsiResultKey('5m-10', '../secret.json.gz'), null);

  const gz = gzipSync(encodeBundle(sampleBundle()));
  const calls = [];
  const kv = {
    async get(key, options) {
      calls.push(key);
      if (key !== 'v1/results/5m-14/all.json.gz') return null;
      if (options?.type === 'arrayBuffer') return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
      return new Blob([gz]).stream();
    },
  };
  const res = await serveHsiResult({ method: 'GET', slug: '5m-14', file: 'all.json.gz', kv });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('cache-control'), /max-age=300/);
  const scored = scoreStored(await decodeBundleBytes(new Uint8Array(await res.arrayBuffer())), prepareHsiLookup({
    ...fast,
    atrLength: 14,
    exitAtrLength: 14,
    sessionMode: 'year',
    year: '2024',
    costPoints: 6,
  }, now));
  assert.equal(scored.metrics.trades, 9);

  const missing = await serveHsiResult({ method: 'GET', slug: '5m-10', file: 'all.json.gz', kv });
  assert.equal(missing.status, 404);
  const odd = await serveHsiResult({ method: 'GET', slug: 'notes', file: 'all.json.gz', kv });
  assert.equal(odd.status, 404);
  assert.deepEqual(calls, ['v1/results/5m-14/all.json.gz', 'v1/results/5m-10/all.json.gz']);

  const text = readFileSync(join(root, 'functions/backtest/data/hsi/v1/results/[slug]/[file].js'), 'utf8');
  const page = readFileSync(join(root, 'backtest/providers/hsi-results.js'), 'utf8');
  assert.doesNotMatch(text + page, /\byahoo\b|\bfutu\b/i);
});
