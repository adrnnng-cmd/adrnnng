// ATR SuperTrend.
//
//   smoothed = EMA(close, smoothing) seeded with the first close
//   atr      = Wilder ATR(atrLength) * factor
//   uptrend:   line = max(prev, smoothed - atr); flip bearish when smoothed < line,
//              then line = smoothed + atr
//   downtrend: line = min(prev, smoothed + atr); flip bullish when smoothed > line,
//              then line = smoothed - atr
//
// The study only emits a direction. Session clocks, higher-timeframe gates and
// fills live in composition/, not here.
//
//   - Source is close.
//   - Before ATR and EMA both exist there is no trend and no line.
//   - The first defined bar seeds an uptrend with line = smoothed - atr and is not a flip.
//   - The cross test is strict. The line resets to the other band on the flip bar
//     and is not tested again on that bar.
//   - Ratchet and cross use only bars[0..i].

import { atr, pineEma } from '../engine/indicators.js';
import { CHART } from '../chart-style.js';

export function atrSupertrend(bars, params = {}) {
  const atrLength = Math.max(1, Math.round(Number(params.atrLength ?? 10)));
  const smoothing = Math.max(1, Math.round(Number(params.smoothing ?? 2)));
  const factor = Number(params.factor ?? 2.5);
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('factor must be a positive number');

  const n = bars.length;
  const smoothed = pineEma(bars.map((b) => b.close), smoothing);
  const band = atr(bars, atrLength).map((v) => (v == null ? null : v * factor));
  const trend = new Array(n).fill(null);
  const line = new Array(n).fill(null);
  const flip = new Array(n).fill(0);

  let dir = 1;
  let prevLine = null;
  let seeded = false;

  for (let i = 0; i < n; i++) {
    const src = smoothed[i];
    const width = band[i];
    if (src == null || width == null) continue;
    if (!seeded) {
      prevLine = src - width;
      dir = 1;
      seeded = true;
      trend[i] = dir;
      line[i] = prevLine;
      continue;
    }
    if (dir === 1) {
      let next = Math.max(prevLine, src - width);
      if (src < next) {
        dir = -1;
        next = src + width;
        flip[i] = -1;
      }
      prevLine = next;
    } else {
      let next = Math.min(prevLine, src + width);
      if (src > next) {
        dir = 1;
        next = src - width;
        flip[i] = 1;
      }
      prevLine = next;
    }
    trend[i] = dir;
    line[i] = prevLine;
  }

  return { trend, line, smoothed, atr: band, flip, atrLength, factor, smoothing };
}

export default {
  id: 'atr-supertrend',
  name: 'ATR SuperTrend',
  short: 'SuperTrend',
  summary: 'Long while the smoothed close holds above a ratcheting ATR band, short while it holds below. On HSI futures, 1m, 5m, 30m, and 1h add the session clock.',
  tags: ['Trend'],
  capabilities: {
    timeframes: ['1d', '1w', '1mo', '1m', '5m', '30m', '1h'],
    session: true,
  },
  params: [
    { key: 'atrLength', label: 'ATR length', type: 'number', default: 10, min: 1, max: 200, step: 1 },
    { key: 'factor', label: 'Factor', type: 'number', default: 2.5, min: 0.1, max: 20, step: 0.1 },
    { key: 'smoothing', label: 'EMA smoothing', type: 'number', default: 2, min: 1, max: 100, step: 1 },
  ],
  run(bars, p) {
    const st = atrSupertrend(bars, p);
    const signal = st.trend.map((t) => (t == null ? null : t));
    const markers = [];
    for (let i = 0; i < bars.length; i++) {
      if (st.flip[i] === 1) markers.push({ index: i, position: 'below', text: '▲', color: CHART.up, kind: 'flip' });
      else if (st.flip[i] === -1) markers.push({ index: i, position: 'above', text: '▼', color: CHART.down, kind: 'flip' });
    }
    return {
      signal,
      target: signal,
      flip: st.flip,
      markers,
      overlays: [
        { name: 'SuperTrend up', color: CHART.up, values: st.line.map((v, i) => (st.trend[i] === 1 ? v : null)) },
        { name: 'SuperTrend down', color: CHART.down, values: st.line.map((v, i) => (st.trend[i] === -1 ? v : null)) },
      ],
    };
  },
};
