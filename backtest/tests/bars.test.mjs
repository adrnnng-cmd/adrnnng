import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, adjustForDividends, resample, indexAtOrAfter, indexAtOrBefore } from '../engine/bars.js';
import { close } from './helpers.mjs';

test('parseCsv reads the site format, sorts, dedupes and skips bad rows', () => {
  const csv = [
    'date,open,high,low,close,volume,dividend,split',
    '2024-01-03,10,11,9,10.5,100,0,0',
    '2024-01-02,9,10,8,9.5,200,0.1,0',
    '2024-01-04,,,,,0,0,0',
    '2024-01-03,10,12,9,11,150,0,0',
  ].join('\n');
  const bars = parseCsv(csv);
  assert.deepEqual(bars.map((b) => b.time), ['2024-01-02', '2024-01-03']);
  assert.equal(bars[0].dividend, 0.1);
  assert.equal(bars[1].close, 11);
});

test('parseCsv accepts Yahoo/Stooq-style headers and slash dates', () => {
  const bars = parseCsv('Date,Open,High,Low,Close,Adj Close,Volume\r\n2024/1/2,1,2,0.5,1.5,1.4,10\r\n');
  assert.equal(bars[0].time, '2024-01-02');
  assert.equal(bars[0].volume, 10);
  assert.throws(() => parseCsv('when,price\n2024-01-01,1\n'), /missing/);
});

test('adjustForDividends uses the (1 - D / previous close) back-adjustment', () => {
  const raw = [
    { time: '2024-01-02', open: 100, high: 100, low: 100, close: 100, dividend: 0 },
    { time: '2024-01-03', open: 102, high: 102, low: 102, close: 102, dividend: 0 },
    { time: '2024-01-04', open: 98, high: 98, low: 98, close: 98, dividend: 2 },
    { time: '2024-01-05', open: 99, high: 99, low: 99, close: 99, dividend: 0 },
  ];
  const adj = adjustForDividends(raw);
  const f = 1 - 2 / 102;
  assert.ok(close(adj[0].close, 100 * f));
  assert.ok(close(adj[1].close, 100));
  assert.equal(adj[2].close, 98);
  assert.equal(adj[3].close, 99);
  assert.equal(raw[0].close, 100, 'input not mutated');
});

test('resample builds weekly and monthly OHLCV stamped with the last trading day', () => {
  const days = ['2024-01-29', '2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02', '2024-02-05'];
  const bars = days.map((t, i) => ({ time: t, open: 10 + i, high: 20 + i, low: 5 - i, close: 11 + i, volume: 1, dividend: i === 1 ? 0.5 : 0 }));
  const w = resample(bars, '1w');
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { time: '2024-02-02', open: 10, high: 24, low: 1, close: 15, volume: 5, dividend: 0.5, split: 0 });
  assert.equal(w[1].time, '2024-02-05');
  const m = resample(bars, '1mo');
  assert.deepEqual(m.map((b) => [b.time, b.open, b.close, b.high, b.low]), [
    ['2024-01-31', 10, 13, 22, 3],
    ['2024-02-05', 13, 16, 25, 0],
  ]);
});

test('date index helpers', () => {
  const bars = ['2024-01-02', '2024-01-03', '2024-01-05'].map((time) => ({ time }));
  assert.equal(indexAtOrAfter(bars, '2024-01-04'), 2);
  assert.equal(indexAtOrAfter(bars, '2024-01-01'), 0);
  assert.equal(indexAtOrAfter(bars, '2024-02-01'), 3);
  assert.equal(indexAtOrBefore(bars, '2024-01-04'), 1);
  assert.equal(indexAtOrBefore(bars, '2024-01-05'), 2);
  assert.equal(indexAtOrBefore(bars, '2023-12-31'), -1);
});
