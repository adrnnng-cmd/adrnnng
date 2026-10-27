import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERLAY_MAX_LINE,
  OverlayError,
  decodeOverlayBytes,
  encodeOverlay,
  lookupHsiOverlay,
  overlayObjectKey,
  resetHsiOverlayCache,
  sliceOverlay,
} from '../providers/hsi-overlay.js';
import { hsiOverlayKey, serveHsiOverlay } from '../../functions/backtest/data/hsi/v1/results/[slug]/ov/[file].js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const sample = {
  candles: [
    { time: '2024-03-04T09:15:00', open: 18000, high: 18010, low: 17990, close: 18005 },
    { time: '2024-03-04T09:30:00', open: 18005, high: 18020, low: 18000, close: 18012 },
    { time: '2024-03-05T09:15:00', open: 18012, high: 18012, low: 17950, close: 17960 },
  ],
  line: [
    { time: '2024-03-04T09:15:00', value: 17980, dir: 1 },
    { time: '2024-03-04T09:30:00', value: 17990, dir: 1 },
    { time: '2024-03-04T09:45:00', value: 18040, dir: -1 },
    { time: '2024-03-05T09:15:00', value: 18020, dir: -1 },
  ],
  markers: [
    { time: '2024-03-04T09:30:00', side: 1 },
    { time: '2024-03-05T09:15:00', side: -1 },
  ],
};

const view = {
  combo: '5:10:clock:09:30:reenter',
  params: { entryTimeframe: 5, atrLength: 10, from: '2020-01-02', to: '2026-10-23' },
};

test('Fast Response overlay key stays beside the score bundle', () => {
  assert.equal(overlayObjectKey(5, 10, '5:10:clock:09:30:reenter'), 'v1/results/5m-10/ov/5-10-clock-0930-reenter.json.gz');
  assert.equal(overlayObjectKey('1m', 14, '1:14:flip:-:flat'), 'v1/results/1m-14/ov/1-14-flip-na-flat.json.gz');
  assert.equal(overlayObjectKey(5, 10, '5:10:clock:09:00:reenter'), null);
  assert.equal(hsiOverlayKey('5m-10', '5-10-clock-0930-reenter.json.gz'), 'v1/results/5m-10/ov/5-10-clock-0930-reenter.json.gz');
  assert.equal(hsiOverlayKey('5m-10', 'all.json.gz'), null);
  assert.equal(hsiOverlayKey('5m-9', '5-10-clock-0930-reenter.json.gz'), null);
});

test('overlay bytes round-trip and a date window keeps the direction change', async () => {
  const decoded = await decodeOverlayBytes(gzipSync(encodeOverlay(sample)));
  assert.equal(decoded.candles[1].close, 18012);
  assert.equal(decoded.line[2].dir, -1);
  assert.equal(decoded.line[2].value, 18040);
  assert.deepEqual(decoded.markers.map((mark) => mark.side), [1, -1]);

  const day = sliceOverlay(decoded, '2024-03-04', '2024-03-04');
  assert.equal(day.candles.length, 2);
  assert.equal(day.markers.length, 1);
  assert.equal(day.markers[0].side, 1);
  assert.ok(day.line.some((point) => point.dir === -1));

  const capped = sliceOverlay(decoded, '2024-03-04', '2024-03-05', { maxLine: 3 });
  assert.equal(capped.line.length, 3);
  assert.ok(capped.line.some((point) => point.time === '2024-03-04T09:45:00'));
  assert.throws(() => encodeOverlay({ markers: [{ time: '2024-03-04T09:30:00', side: 2 }] }), OverlayError);
  assert.ok(OVERLAY_MAX_LINE <= 60000);
});

test('a missing overlay is not fetched twice and does not touch the minute tape', async () => {
  resetHsiOverlayCache();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const first = await lookupHsiOverlay(view, { base: 'https://bars.example/', fetchImpl, from: '2024-03-01', to: '2024-03-31' });
  const second = await lookupHsiOverlay({ ...view, params: { ...view.params } }, { base: 'https://bars.example/', fetchImpl, from: '2024-03-04', to: '2024-03-04' });
  assert.equal(first, null);
  assert.equal(second, null);
  assert.deepEqual(urls, ['https://bars.example/v1/results/5m-10/ov/5-10-clock-0930-reenter.json.gz']);
  assert.ok(!urls.some((url) => url.includes('.bin')));

  resetHsiOverlayCache();
  const gz = gzipSync(encodeOverlay(sample));
  const hit = [];
  const found = await lookupHsiOverlay(view, {
    base: 'https://bars.example/',
    from: '2024-03-05',
    to: '2024-03-05',
    fetchImpl: async (url) => {
      hit.push(String(url));
      return { status: 200, ok: true, arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) };
    },
  });
  assert.equal(found.candles.length, 1);
  assert.equal(found.markers[0].side, -1);
  assert.equal(hit.length, 1);
});

test('the overlay function serves the combo key and refuses anything else', async () => {
  const gz = gzipSync(encodeOverlay(sample));
  const kv = {
    async get(key, options) {
      if (key !== 'v1/results/5m-10/ov/5-10-clock-0930-reenter.json.gz') return null;
      if (options?.type === 'arrayBuffer') return gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength);
      return new Blob([gz]).stream();
    },
  };
  const res = await serveHsiOverlay({ method: 'GET', slug: '5m-10', file: '5-10-clock-0930-reenter.json.gz', kv });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('cache-control'), /max-age=300/);
  const decoded = await decodeOverlayBytes(new Uint8Array(await res.arrayBuffer()));
  assert.equal(decoded.line.length, 4);

  const missing = await serveHsiOverlay({ method: 'GET', slug: '5m-10', file: '5-10-clock-0915-reenter.json.gz', kv });
  assert.equal(missing.status, 404);
  const odd = await serveHsiOverlay({ method: 'GET', slug: '5m-10', file: '../all.json.gz', kv });
  assert.equal(odd.status, 404);

  const text = readFileSync(join(root, 'functions/backtest/data/hsi/v1/results/[slug]/ov/[file].js'), 'utf8');
  const page = readFileSync(join(root, 'backtest/providers/hsi-overlay.js'), 'utf8');
  assert.doesNotMatch(text + page, /\byahoo\b|\bfutu\b/i);
});
