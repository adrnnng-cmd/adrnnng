import test from 'node:test';
import assert from 'node:assert/strict';
import { CHART, candleSeriesOptions, pointCandles, strategyAreaOptions, drawdownSeriesOptions } from '../chart-style.js';

test('stored point candles use the same up and down colors as the price series', () => {
  const candles = candleSeriesOptions();
  const area = strategyAreaOptions();
  const drop = drawdownSeriesOptions();
  assert.equal(candles.upColor, CHART.up);
  assert.equal(candles.downColor, CHART.down);
  assert.equal(candles.upColor, '#0b8a3e');
  assert.equal(candles.downColor, '#d0182a');
  assert.equal(area.lineColor, CHART.accent);
  assert.equal(area.topColor, 'rgba(17,17,17,0.12)');
  assert.equal(drop.bottomLineColor, CHART.down);
  assert.equal(drop.topLineColor, CHART.down);

  const bars = pointCandles([
    { time: '2024-03-04', value: 10 },
    { time: '2024-03-05', value: 4 },
    { time: '2024-03-06', value: 4 },
  ]);
  assert.deepEqual(bars, [
    { time: '2024-03-04', open: 0, high: 10, low: 0, close: 10 },
    { time: '2024-03-05', open: 10, high: 10, low: 4, close: 4 },
    { time: '2024-03-06', open: 4, high: 4, low: 4, close: 4 },
  ]);
  assert.ok(bars[0].close >= bars[0].open);
  assert.ok(bars[1].close < bars[1].open);
});
