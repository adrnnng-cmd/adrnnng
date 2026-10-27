import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeHsiYear, decodeHsiYear, hsiObjectKey } from '../providers/hsi-archive.js';
import { hsiPublicKey, onRequest, serveHsiBars } from '../../functions/backtest/data/hsi/v1/1m/[file].js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function kvOf(objects) {
  const calls = [];
  return {
    calls,
    async get(key, options) {
      calls.push({ key, options });
      if (!(key in objects)) return null;
      const value = objects[key];
      if (options?.type === 'stream') return new Blob([value]).stream();
      if (options?.type === 'arrayBuffer') {
        const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      return value;
    },
  };
}

test('public keys are the provider year-pack names', () => {
  assert.equal(hsiPublicKey('manifest.json'), 'v1/1m/manifest.json');
  assert.equal(hsiPublicKey('2024.bin'), hsiObjectKey(2024));
  assert.equal(hsiPublicKey('2020.bin'), 'v1/1m/2020.bin');
  assert.equal(hsiPublicKey('../manifest.json'), null);
  assert.equal(hsiPublicKey('2024.bin.bak'), null);
  assert.equal(hsiPublicKey('notes.txt'), null);
});

test('manifest and a year pack are served with the types the provider fetches', async () => {
  const bars = [{ time: '2024-06-03T09:15:00', open: 18000, high: 18010, low: 17990, close: 18005, volume: 12 }];
  const pack = encodeHsiYear(bars, 2024);
  const manifest = '{"objects":[{"year":2024,"key":"v1/1m/2024.bin"}]}';
  const kv = kvOf({ 'v1/1m/manifest.json': manifest, 'v1/1m/2024.bin': pack });

  const manifestRes = await serveHsiBars({ method: 'GET', file: 'manifest.json', kv });
  assert.equal(manifestRes.status, 200);
  assert.equal(manifestRes.headers.get('content-type'), 'application/json');
  assert.match(manifestRes.headers.get('cache-control'), /max-age=300/);
  assert.equal(await manifestRes.text(), manifest);

  const binRes = await serveHsiBars({ method: 'GET', file: '2024.bin', kv });
  assert.equal(binRes.status, 200);
  assert.equal(binRes.headers.get('content-type'), 'application/octet-stream');
  assert.match(binRes.headers.get('cache-control'), /max-age=86400/);
  assert.deepEqual(decodeHsiYear(new Uint8Array(await binRes.arrayBuffer())), bars);
  assert.deepEqual(kv.calls.map((c) => c.key), ['v1/1m/manifest.json', 'v1/1m/2024.bin']);
});

test('a missing pack is a 404 and a missing binding is not a pack', async () => {
  const kv = kvOf({});
  const missing = await serveHsiBars({ method: 'GET', file: '2021.bin', kv });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('cache-control'), /no-store/);

  const odd = await serveHsiBars({ method: 'GET', file: 'secret', kv });
  assert.equal(odd.status, 404);
  assert.equal(kv.calls.length, 1);

  const bare = await serveHsiBars({ method: 'GET', file: 'manifest.json', kv: null });
  assert.equal(bare.status, 500);
});

test('HEAD has no body and other methods are refused', async () => {
  const kv = kvOf({ 'v1/1m/manifest.json': '{}' });
  const head = await serveHsiBars({ method: 'HEAD', file: 'manifest.json', kv });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-type'), 'application/json');

  const posted = await serveHsiBars({ method: 'POST', file: 'manifest.json', kv });
  assert.equal(posted.status, 405);
  assert.match(posted.headers.get('allow'), /GET, HEAD/);
});

test('onRequest reads the HSI_BARS binding', async () => {
  const kv = kvOf({ 'v1/1m/2026.bin': encodeHsiYear([], 2026) });
  const res = await onRequest({
    request: new Request('https://adrnnng.com/backtest/data/hsi/v1/1m/2026.bin'),
    params: { file: '2026.bin' },
    env: { HSI_BARS: kv },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(kv.calls[0].key, 'v1/1m/2026.bin');
});

test('routes invoke a function only for the hsi bar paths', () => {
  const routes = JSON.parse(readFileSync(join(root, '_routes.json'), 'utf8'));
  assert.equal(routes.version, 1);
  assert.deepEqual(routes.include, ['/backtest/data/hsi/*']);
  assert.deepEqual(routes.exclude, []);
});

test('the pages function does not name a data vendor', () => {
  const text = readFileSync(join(root, 'functions/backtest/data/hsi/v1/1m/[file].js'), 'utf8');
  assert.doesNotMatch(text, /\byahoo\b|\bfutu\b/i);
});
