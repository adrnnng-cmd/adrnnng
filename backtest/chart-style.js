// Shared chart colors for /backtest/. Live runs and stored HSI curves both use these.

export const CHART = {
  text: '#333333',
  grid: 'rgba(17,17,17,0.06)',
  border: 'rgba(17,17,17,0.14)',
  up: '#0b8a3e',
  down: '#d0182a',
  accent: '#111111',
  bh: '#8a8a8a',
  long: '#1a3fd1',
  short: '#d0182a',
  exit: '#111111',
  wickUp: 'rgba(11,138,62,0.75)',
  wickDown: 'rgba(208,24,42,0.75)',
  areaTop: 'rgba(17,17,17,0.12)',
  areaBottom: 'rgba(17,17,17,0.0)',
  ddFill1: 'rgba(208,24,42,0.04)',
  ddFill2: 'rgba(208,24,42,0.28)',
  bhDrawdown: 'rgba(148,163,184,0.7)',
  exposureLong: 'rgba(26,63,209,0.45)',
  exposureShort: 'rgba(208,24,42,0.45)',
  histUp: 'rgba(11,138,62,0.45)',
  histDown: 'rgba(208,24,42,0.45)',
};

export function candleSeriesOptions() {
  return {
    upColor: CHART.up,
    downColor: CHART.down,
    borderVisible: false,
    wickUpColor: CHART.wickUp,
    wickDownColor: CHART.wickDown,
    priceLineColor: CHART.accent,
  };
}

export function strategyAreaOptions() {
  return {
    lineColor: CHART.accent,
    lineWidth: 2,
    topColor: CHART.areaTop,
    bottomColor: CHART.areaBottom,
    priceLineVisible: false,
    title: 'Strategy',
  };
}

export function drawdownSeriesOptions() {
  return {
    baseValue: { type: 'price', price: 0 },
    bottomLineColor: CHART.down,
    bottomFillColor1: CHART.ddFill1,
    bottomFillColor2: CHART.ddFill2,
    topLineColor: CHART.down,
    lineWidth: 1.5,
    priceLineVisible: false,
    title: 'Strategy',
  };
}

export function buyHoldLineOptions() {
  return {
    color: CHART.bh,
    lineWidth: 1.5,
    priceLineVisible: false,
    title: 'Buy & hold',
  };
}

/** Buy sits under the bar. Sell sits above it. Same up and down colors as the candles. */
export function supertrendLabel(side) {
  const buy = side === 1 || side === 'long' || side === 'buy';
  return {
    position: buy ? 'belowBar' : 'aboveBar',
    shape: buy ? 'arrowUp' : 'arrowDown',
    color: buy ? CHART.up : CHART.down,
    text: buy ? 'Buy' : 'Sell',
    size: 1.4,
  };
}

export function isSupertrendOverlay(name) {
  return name === 'SuperTrend up' || name === 'SuperTrend down';
}

/** One candle per stored session day. Open is the previous close, so a rising day is green. */
export function pointCandles(points) {
  const out = [];
  let prev = 0;
  for (const point of points) {
    const close = point?.value;
    if (close == null || !Number.isFinite(close)) continue;
    const open = prev;
    out.push({
      time: point.time,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
    });
    prev = close;
  }
  return out;
}
