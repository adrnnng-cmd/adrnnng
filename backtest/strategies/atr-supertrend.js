// ATR SuperTrend [QuantAlgo] (TradingView script 5ZlvGLXX).
//
//   smoothed = ta.ema(close, smoothing)
//   atr      = ta.rma(ta.tr(true), atrLength) * factor
//   uptrend:   line = max(prev, smoothed - atr); flip bearish when smoothed < line,
//              then line = smoothed + atr
//   downtrend: line = min(prev, smoothed + atr); flip bullish when smoothed > line,
//              then line = smoothed - atr
//
// Assumptions, called out because the published page shows the formulas but not
// every seed:
//   - Source is close. The script also exposes a source input; this port locks close.
//   - ta.ema seeds with the first close (documented pine_ema), not an SMA.
//   - ta.rma seeds with the SMA of the first atrLength true ranges.
//   - ta.tr(true): the first bar's true range is high-low.
//   - Before ATR and EMA both exist there is no trend and no line.
//   - The first defined bar seeds an uptrend with line = smoothed - atr and is
//     not a flip. Pine `var` trend defaults to the bullish branch in the write-up.
//   - The cross test is strict. The line is reset to the other band on the flip
//     bar and is not tested again on that bar.
//   - Ratchet and cross use only bars[0..i].

import { atr, pineEma } from '../engine/indicators.js';

const UP = '#34d399';
const DOWN = '#fb7185';

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
  summary: 'QuantAlgo ATR SuperTrend: long while the EMA-smoothed close is above a ratcheting ATR band, short while it is below. On this page, short signals need Allow short selling.',
  tags: ['Trend'],
  params: [
    { key: 'atrLength', label: 'ATR length', type: 'number', default: 10, min: 1, max: 200, step: 1, help: 'Phase 1 HSI scan uses 10, 11, 12, 13 and 14.' },
    { key: 'factor', label: 'Factor', type: 'number', default: 2.5, min: 0.1, max: 20, step: 0.1 },
    { key: 'smoothing', label: 'EMA smoothing', type: 'number', default: 2, min: 1, max: 100, step: 1 },
  ],
  run(bars, p) {
    const st = atrSupertrend(bars, p);
    const markers = [];
    for (let i = 0; i < bars.length; i++) {
      if (st.flip[i] === 1) markers.push({ index: i, position: 'below', text: '▲', color: UP, kind: 'flip' });
      else if (st.flip[i] === -1) markers.push({ index: i, position: 'above', text: '▼', color: DOWN, kind: 'flip' });
    }
    return {
      target: st.trend.map((t) => (t == null ? null : t)),
      markers,
      overlays: [
        { name: 'SuperTrend up', color: UP, values: st.line.map((v, i) => (st.trend[i] === 1 ? v : null)) },
        { name: 'SuperTrend down', color: DOWN, values: st.line.map((v, i) => (st.trend[i] === -1 ? v : null)) },
      ],
      supertrend: st,
    };
  },
};
