import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeHsiYear, decodeHsiYear, hsiObjectKey, HSI_ARCHIVE } from '../providers/hsi-archive.js';
import { loadHsiFutures, BarsPending, HSI_BARS_BINDING, HSI_BARS_ENV } from '../providers/hsi-futures.js';

const bars = [
  { time: '2024-06-03T09:15:00', open: 18000, high: 18010, low: 17990, close: 18005, volume: 12 },
  { time: '2024-06-03T09:16:00', open: 18005, high: 18020, low: 18000, close: 18015, volume: 8 },
];

test('year packs round-trip and name the public bind', () => {
  const bytes = encodeHsiYear(bars, 2024);
  const back = decodeHsiYear(bytes);
  assert.deepEqual(back, bars.map((b) => ({ ...b, volume: b.volume })));
  assert.equal(hsiObjectKey(2024), 'v1/1m/2024.bin');
  assert.equal(HSI_ARCHIVE.binding, 'HSI_BARS');
  assert.equal(HSI_ARCHIVE.prefix, 'v1/1m/');
  assert.equal(HSI_BARS_BINDING, 'HSI_BARS');
  assert.ok(HSI_BARS_ENV.includes('HSI_BARS_URL'));
  assert.ok(HSI_BARS_ENV.includes('HSI_BARS_BASE'));
});

test('a missing public store is a clean bars-pending error', async () => {
  const fetchImpl = async () => ({ status: 404, ok: false, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(() => loadHsiFutures({ base: 'https://bars.example/', fetchImpl }), (err) => {
    assert.equal(err instanceof BarsPending, true);
    assert.equal(err.code, 'bars-pending');
    assert.doesNotMatch(err.message, /\byahoo\b|\bfutu\b/i);
    return true;
  });
});

test('load reads a published year pack from the public base', async () => {
  const bytes = encodeHsiYear(bars, 2024);
  const manifest = JSON.stringify({ objects: [{ year: 2024, key: 'v1/1m/2024.bin' }] });
  const fetchImpl = async (url) => {
    if (String(url).endsWith('manifest.json')) return { status: 200, ok: true, text: async () => manifest };
    if (String(url).endsWith('2024.bin')) return { status: 200, ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    return { status: 404, ok: false, text: async () => '' };
  };
  const loaded = await loadHsiFutures({ base: 'https://bars.example/', fetchImpl });
  assert.equal(loaded.symbol, 'HSImain');
  assert.equal(loaded.resolution, '1m');
  assert.equal(loaded.bars.length, 2);
  assert.equal(loaded.bars[1].close, 18015);
  assert.equal(loaded.source.name, 'HSI futures');
  assert.equal(loaded.sample, false);
});
