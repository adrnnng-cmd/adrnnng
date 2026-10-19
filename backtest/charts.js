// Chart rendering for the Backtest page (TradingView Lightweight Charts, vendored).
// Three charts (price, equity, drawdown) share the same bars, so their logical ranges are synced.

import {
  createChart,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
  BaselineSeries,
  createSeriesMarkers,
  LineStyle,
  PriceScaleMode,
  CrosshairMode,
} from '/assets/vendor/lightweight-charts.mjs';

const C = {
  text: '#7d889c',
  grid: 'rgba(148,163,184,0.07)',
  border: 'rgba(148,163,184,0.14)',
  up: '#34d399',
  down: '#fb7185',
  accent: '#38bdf8',
  bh: '#94a3b8',
  long: '#22d3ee',
  short: '#f472b6',
  exit: '#e2e8f0',
};

function baseOptions() {
  return {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: C.text,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11,
      attributionLogo: true,
      panes: { separatorColor: C.border, separatorHoverColor: 'rgba(56,189,248,0.2)' },
    },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderColor: C.border, rightOffset: 4, minBarSpacing: 0.2 },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: 'rgba(148,163,184,0.35)', labelBackgroundColor: '#161c2b' },
      horzLine: { color: 'rgba(148,163,184,0.35)', labelBackgroundColor: '#161c2b' },
    },
    localization: { priceFormatter: (p) => fmtAxis(p) },
  };
}

function fmtAxis(p) {
  const a = Math.abs(p);
  if (a >= 1e6) return (p / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (p / 1e3).toFixed(1) + 'k';
  if (a >= 100) return p.toFixed(0);
  if (a >= 1) return p.toFixed(2);
  return p.toPrecision(3);
}

const line = (times, values, from = 0) => {
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const v = values[from + i];
    out.push(v == null || !Number.isFinite(v) ? { time: times[i] } : { time: times[i], value: v });
  }
  return out;
};

export class BacktestCharts {
  constructor({ price, equity, drawdown }) {
    this.price = createChart(price, baseOptions());
    this.equity = createChart(equity, baseOptions());
    this.drawdown = createChart(drawdown, {
      ...baseOptions(),
      localization: { priceFormatter: (p) => `${(p * 100).toFixed(0)}%` },
      rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.06, bottom: 0.02 } },
    });
    this.series = { price: [], equity: [], drawdown: [] };
    this.markers = null;
    this.syncing = false;
    const charts = [this.price, this.equity, this.drawdown];
    for (const ch of charts) {
      ch.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (this.syncing || !range) return;
        this.syncing = true;
        for (const other of charts) if (other !== ch) other.timeScale().setVisibleLogicalRange(range);
        this.syncing = false;
      });
    }
  }

  clear(name) {
    const chart = this[name];
    for (const s of this.series[name]) chart.removeSeries(s);
    this.series[name] = [];
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
  }

  /**
   * @param ctx { bars (full history), result (runBacktest output), show: { tdCounts, overlays, logEquity } }
   */
  render({ bars, result, show }) {
    const { start, end, times } = result;
    const view = bars.slice(start, end + 1);
    const sig = result.signal || {};

    // ---- Price
    this.clear('price');
    if (this.markers) {
      this.markers.detach();
      this.markers = null;
    }
    const candles = this.price.addSeries(CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      borderVisible: false,
      wickUpColor: 'rgba(52,211,153,0.7)',
      wickDownColor: 'rgba(251,113,133,0.7)',
      priceLineColor: C.accent,
    });
    candles.setData(view.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    this.series.price.push(candles);

    if (show.overlays) {
      for (const o of sig.overlays || []) {
        const s = this.price.addSeries(LineSeries, {
          color: o.color,
          lineWidth: 1.5,
          lineStyle: o.style === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          title: '',
        });
        s.setData(line(times, o.values, start));
        this.series.price.push(s);
      }
    }

    (sig.panes || []).forEach((pane, k) => {
      const idx = k + 1;
      for (const ser of pane.series) {
        const s =
          ser.type === 'histogram'
            ? this.price.addSeries(HistogramSeries, { color: ser.color, priceLineVisible: false, lastValueVisible: false }, idx)
            : this.price.addSeries(LineSeries, { color: ser.color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }, idx);
        const data = line(times, ser.values, start);
        s.setData(ser.type === 'histogram' ? data.map((d) => (d.value == null ? d : { ...d, color: d.value >= 0 ? 'rgba(52,211,153,0.45)' : 'rgba(251,113,133,0.45)' })) : data);
        this.series.price.push(s);
        if (ser === pane.series[0]) {
          for (const lv of pane.levels || []) s.createPriceLine({ price: lv, color: 'rgba(148,163,184,0.35)', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false });
        }
      }
      const p = this.price.panes()[idx];
      if (p) p.setStretchFactor(0.32);
    });

    const markers = [];
    const tdKinds = new Set(show.tdCounts ? ['setup', 'countdown', 'count'] : ['setup', 'countdown']);
    for (const m of sig.markers || []) {
      if (m.index < start || m.index > end || !tdKinds.has(m.kind)) continue;
      const small = m.kind === 'count';
      markers.push({
        time: bars[m.index].time,
        position: m.position === 'above' ? 'aboveBar' : 'belowBar',
        shape: m.shape || 'circle',
        color: m.color,
        text: m.text,
        size: small ? 0 : m.kind === 'countdown' ? 1 : 0.1,
      });
    }
    const allTrades = [...result.trades, ...(result.openTrade ? [result.openTrade] : [])];
    for (const t of allTrades) {
      const isLong = t.side === 'long';
      markers.push({
        time: t.entryTime,
        position: isLong ? 'belowBar' : 'aboveBar',
        shape: isLong ? 'arrowUp' : 'arrowDown',
        color: isLong ? C.long : C.short,
        text: isLong ? 'BUY' : 'SHORT',
        size: 1.4,
      });
      if (!t.open) {
        markers.push({
          time: t.exitTime,
          position: isLong ? 'aboveBar' : 'belowBar',
          shape: 'square',
          color: t.pnl >= 0 ? C.up : C.down,
          text: `${t.returnPct >= 0 ? '+' : ''}${t.returnPct.toFixed(1)}%`,
          size: 0.8,
        });
      }
    }
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    this.markers = createSeriesMarkers(candles, markers);

    // ---- Equity vs buy & hold
    this.clear('equity');
    this.equity.priceScale('right').applyOptions({ mode: show.logEquity ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
    const bh = this.equity.addSeries(LineSeries, { color: C.bh, lineWidth: 1.5, lineStyle: LineStyle.Solid, priceLineVisible: false, title: 'Buy & hold' });
    bh.setData(times.map((t, i) => ({ time: t, value: result.benchmark[i] })));
    const eq = this.equity.addSeries(AreaSeries, {
      lineColor: C.accent,
      lineWidth: 2,
      topColor: 'rgba(56,189,248,0.28)',
      bottomColor: 'rgba(56,189,248,0.0)',
      priceLineVisible: false,
      title: 'Strategy',
    });
    eq.setData(times.map((t, i) => ({ time: t, value: result.equity[i] })));
    const exposure = this.equity.addSeries(HistogramSeries, { priceScaleId: 'pos', priceLineVisible: false, lastValueVisible: false });
    this.equity.priceScale('pos').applyOptions({ scaleMargins: { top: 0.94, bottom: 0 }, visible: false });
    exposure.setData(times.map((t, i) => ({ time: t, value: result.positions[i] === 0 ? 0 : 1, color: result.positions[i] > 0 ? 'rgba(34,211,238,0.5)' : 'rgba(244,114,182,0.5)' })));
    this.series.equity.push(bh, eq, exposure);

    // ---- Drawdown
    this.clear('drawdown');
    const bhd = this.drawdown.addSeries(LineSeries, { color: 'rgba(148,163,184,0.7)', lineWidth: 1, priceLineVisible: false, title: 'B&H' });
    bhd.setData(times.map((t, i) => ({ time: t, value: result.benchmarkDrawdown[i] })));
    const dd = this.drawdown.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      bottomLineColor: C.down,
      bottomFillColor1: 'rgba(251,113,133,0.05)',
      bottomFillColor2: 'rgba(251,113,133,0.35)',
      topLineColor: C.down,
      lineWidth: 1.5,
      priceLineVisible: false,
      title: 'Strategy',
    });
    dd.setData(times.map((t, i) => ({ time: t, value: result.drawdown[i] })));
    this.series.drawdown.push(bhd, dd);

    for (const ch of [this.price, this.equity, this.drawdown]) ch.timeScale().fitContent();
  }

  focus(fromTime, toTime, padBars = 25) {
    const ts = this.price.timeScale();
    const a = ts.timeToIndex(fromTime, true);
    const b = ts.timeToIndex(toTime, true);
    if (a == null || b == null) return;
    ts.setVisibleLogicalRange({ from: a - padBars, to: b + padBars });
  }
}
