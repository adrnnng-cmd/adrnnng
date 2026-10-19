// Classic indicator strategies. Each follows the contract in strategies/index.js.

import { sma, ema, rsi, macd, bollinger, donchian } from '../engine/indicators.js';

const closes = (bars) => bars.map((b) => b.close);

export const maCross = {
  id: 'ma-cross',
  name: 'Moving-average crossover',
  short: 'MA cross',
  summary: 'Long while the fast average is above the slow one (golden cross); flat or short below it (death cross).',
  tags: ['Trend'],
  params: [
    { key: 'kind', label: 'Average', type: 'select', default: 'sma', options: [{ value: 'sma', label: 'Simple (SMA)' }, { value: 'ema', label: 'Exponential (EMA)' }] },
    { key: 'fast', label: 'Fast period', type: 'number', default: 50, min: 2, max: 400, step: 1 },
    { key: 'slow', label: 'Slow period', type: 'number', default: 200, min: 3, max: 600, step: 1 },
  ],
  run(bars, p) {
    const avg = p.kind === 'ema' ? ema : sma;
    const c = closes(bars);
    const f = avg(c, p.fast);
    const s = avg(c, p.slow);
    const target = c.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] > s[i] ? 1 : -1));
    return {
      target,
      overlays: [
        { name: `${p.kind.toUpperCase()} ${p.fast}`, color: '#38bdf8', values: f },
        { name: `${p.kind.toUpperCase()} ${p.slow}`, color: '#f59e0b', values: s },
      ],
    };
  },
};

export const rsiReversion = {
  id: 'rsi-reversion',
  name: 'RSI mean reversion',
  short: 'RSI',
  summary: 'Buy when Wilder RSI drops below the oversold level, exit when it crosses back through the exit level. Shorts mirror at overbought.',
  tags: ['Mean reversion', 'Oscillator'],
  params: [
    { key: 'period', label: 'RSI period', type: 'number', default: 14, min: 2, max: 50, step: 1 },
    { key: 'oversold', label: 'Oversold', type: 'number', default: 30, min: 1, max: 50, step: 1 },
    { key: 'overbought', label: 'Overbought', type: 'number', default: 70, min: 50, max: 99, step: 1 },
    { key: 'exit', label: 'Exit level', type: 'number', default: 50, min: 1, max: 99, step: 1 },
  ],
  run(bars, p) {
    const r = rsi(closes(bars), p.period);
    const target = r.map((v, i) => {
      if (v == null) return null;
      if (v < p.oversold) return 1;
      if (v > p.overbought) return -1;
      const prev = r[i - 1];
      if (prev != null && ((prev < p.exit && v >= p.exit) || (prev > p.exit && v <= p.exit))) return 0;
      return null;
    });
    return {
      target,
      panes: [{ name: `RSI ${p.period}`, series: [{ name: 'RSI', color: '#a78bfa', values: r }], levels: [p.oversold, p.exit, p.overbought], range: [0, 100] }],
    };
  },
};

export const macdCross = {
  id: 'macd-cross',
  name: 'MACD signal cross',
  short: 'MACD',
  summary: 'Long while the MACD line is above its signal line, flat or short below. Optional zero-line filter for longs.',
  tags: ['Trend', 'Momentum'],
  params: [
    { key: 'fast', label: 'Fast EMA', type: 'number', default: 12, min: 2, max: 100, step: 1 },
    { key: 'slow', label: 'Slow EMA', type: 'number', default: 26, min: 3, max: 200, step: 1 },
    { key: 'signal', label: 'Signal EMA', type: 'number', default: 9, min: 2, max: 50, step: 1 },
    { key: 'zeroFilter', label: 'Longs only above zero line', type: 'boolean', default: false },
  ],
  run(bars, p) {
    const m = macd(closes(bars), p.fast, p.slow, p.signal);
    const target = m.line.map((v, i) => {
      const s = m.signal[i];
      if (v == null || s == null) return null;
      if (v > s) return p.zeroFilter && v <= 0 ? 0 : 1;
      return -1;
    });
    return {
      target,
      panes: [
        {
          name: `MACD ${p.fast}/${p.slow}/${p.signal}`,
          series: [
            { name: 'Histogram', type: 'histogram', color: '#64748b', values: m.hist },
            { name: 'MACD', color: '#38bdf8', values: m.line },
            { name: 'Signal', color: '#f59e0b', values: m.signal },
          ],
          levels: [0],
        },
      ],
    };
  },
};

export const bollingerReversion = {
  id: 'bollinger-reversion',
  name: 'Bollinger band reversion',
  short: 'Bollinger',
  summary: 'Buy a close below the lower band, exit when price crosses back over the middle band. Shorts mirror at the upper band.',
  tags: ['Mean reversion', 'Volatility'],
  params: [
    { key: 'period', label: 'Period', type: 'number', default: 20, min: 5, max: 200, step: 1 },
    { key: 'mult', label: 'Std-dev multiple', type: 'number', default: 2, min: 0.5, max: 4, step: 0.1 },
  ],
  run(bars, p) {
    const c = closes(bars);
    const bb = bollinger(c, p.period, p.mult);
    const target = c.map((v, i) => {
      if (bb.mid[i] == null) return null;
      if (v < bb.lower[i]) return 1;
      if (v > bb.upper[i]) return -1;
      const pm = bb.mid[i - 1];
      if (pm != null && ((c[i - 1] < pm && v >= bb.mid[i]) || (c[i - 1] > pm && v <= bb.mid[i]))) return 0;
      return null;
    });
    return {
      target,
      overlays: [
        { name: 'Upper', color: '#64748b', values: bb.upper },
        { name: 'Middle', color: '#94a3b8', values: bb.mid, style: 'dashed' },
        { name: 'Lower', color: '#64748b', values: bb.lower },
      ],
    };
  },
};

export const donchianBreakout = {
  id: 'donchian-breakout',
  name: 'Donchian breakout (Turtle)',
  short: 'Donchian',
  summary: 'Turtle-style: buy a close above the prior N-bar high, exit on a close below the prior M-bar low. Shorts mirror.',
  tags: ['Trend', 'Breakout'],
  params: [
    { key: 'entry', label: 'Entry channel', type: 'number', default: 20, min: 2, max: 300, step: 1 },
    { key: 'exit', label: 'Exit channel', type: 'number', default: 10, min: 2, max: 300, step: 1 },
  ],
  run(bars, p) {
    const hi = bars.map((b) => b.high);
    const lo = bars.map((b) => b.low);
    const en = donchian(hi, lo, p.entry);
    const ex = donchian(hi, lo, p.exit);
    const target = new Array(bars.length).fill(null);
    let state = 0;
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      if (en.upper[i] == null || ex.upper[i] == null) continue;
      if (c > en.upper[i]) state = 1;
      else if (c < en.lower[i]) state = -1;
      else if (state === 1 && c < ex.lower[i]) state = 0;
      else if (state === -1 && c > ex.upper[i]) state = 0;
      target[i] = state;
    }
    return {
      target,
      overlays: [
        { name: `${p.entry}-bar high`, color: '#34d39999', values: en.upper },
        { name: `${p.entry}-bar low`, color: '#fb718599', values: en.lower },
      ],
    };
  },
};
