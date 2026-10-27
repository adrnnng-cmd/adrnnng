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
import {
  CHART as C,
  buyHoldLineOptions,
  candleSeriesOptions,
  drawdownSeriesOptions,
  isSupertrendOverlay,
  pointCandles,
  strategyAreaOptions,
  supertrendLabel,
} from './chart-style.js';

function baseOptions() {
  return {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: C.text,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12,
      attributionLogo: true,
      panes: { separatorColor: C.border, separatorHoverColor: 'rgba(17,17,17,0.2)' },
    },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderColor: C.border, rightOffset: 4, minBarSpacing: 0.2 },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: 'rgba(17,17,17,0.28)', labelBackgroundColor: '#111111' },
      horzLine: { color: 'rgba(17,17,17,0.28)', labelBackgroundColor: '#111111' },
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

/** Daily stays a business-day string. Intraday wall-clock is drawn as labelled, so 09:15 reads 09:15. */
function chartTime(t) {
  const s = String(t);
  if (s.length <= 10) return s;
  const ms = Date.parse(s.endsWith('Z') ? s : `${s}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : s;
}

function snapTime(bars, time) {
  let best = null;
  for (const bar of bars) {
    if (bar.time <= time) best = bar.time;
    else break;
  }
  return best ?? bars[0]?.time ?? null;
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
    const { start, end } = result;
    const points = result.accounting === 'points';
    const times = result.times.map(chartTime);
    const view = bars.slice(start, end + 1).map((b) => ({ ...b, time: chartTime(b.time) }));
    const sig = result.signal || {};
    const logOk = show.logEquity && !points && result.equity.every((v) => v > 0) && result.benchmark.every((v) => v > 0);

    // ---- Price
    this.clear('price');
    if (this.markers) {
      this.markers.detach();
      this.markers = null;
    }
    const candles = this.price.addSeries(CandlestickSeries, candleSeriesOptions());
    candles.setData(view.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
    this.series.price.push(candles);

    for (const o of sig.overlays || []) {
      const trend = isSupertrendOverlay(o.name);
      if (trend ? show.supertrend !== true : !show.overlays) continue;
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

    (sig.panes || []).forEach((pane, k) => {
      const idx = k + 1;
      for (const ser of pane.series) {
        const s =
          ser.type === 'histogram'
            ? this.price.addSeries(HistogramSeries, { color: ser.color, priceLineVisible: false, lastValueVisible: false }, idx)
            : this.price.addSeries(LineSeries, { color: ser.color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }, idx);
        const data = line(times, ser.values, start);
        s.setData(ser.type === 'histogram' ? data.map((d) => (d.value == null ? d : { ...d, color: d.value >= 0 ? C.histUp : C.histDown })) : data);
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
        time: chartTime(bars[m.index].time),
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
      if (show.supertrend !== false) {
        const label = show.supertrend === true ? supertrendLabel(t.side) : null;
        markers.push({
          time: chartTime(t.entryTime),
          position: label?.position || (isLong ? 'belowBar' : 'aboveBar'),
          shape: label?.shape || (isLong ? 'arrowUp' : 'arrowDown'),
          color: label?.color || (isLong ? C.long : C.short),
          text: label?.text || (isLong ? 'BUY' : 'SHORT'),
          size: label?.size || 1.4,
        });
      }
      if (!t.open) {
        markers.push({
          time: chartTime(t.exitTime),
          position: isLong ? 'aboveBar' : 'belowBar',
          shape: 'square',
          color: t.pnl >= 0 ? C.up : C.down,
          text: points ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(1)}` : `${t.returnPct >= 0 ? '+' : ''}${t.returnPct.toFixed(1)}%`,
          size: 0.8,
        });
      }
    }
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    this.markers = createSeriesMarkers(candles, markers);

    // ---- Equity vs buy & hold
    this.clear('equity');
    this.equity.priceScale('right').applyOptions({ mode: logOk ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
    this.drawdown.applyOptions({
      localization: { priceFormatter: (p) => (points ? p.toFixed(0) : `${(p * 100).toFixed(0)}%`) },
    });
    const bh = this.equity.addSeries(LineSeries, { ...buyHoldLineOptions(), lineStyle: LineStyle.Solid });
    bh.setData(times.map((t, i) => ({ time: t, value: result.benchmark[i] })));
    const eq = this.equity.addSeries(AreaSeries, strategyAreaOptions());
    eq.setData(times.map((t, i) => ({ time: t, value: result.equity[i] })));
    const exposure = this.equity.addSeries(HistogramSeries, { priceScaleId: 'pos', priceLineVisible: false, lastValueVisible: false });
    this.equity.priceScale('pos').applyOptions({ scaleMargins: { top: 0.94, bottom: 0 }, visible: false });
    exposure.setData(times.map((t, i) => ({ time: t, value: result.positions[i] === 0 ? 0 : 1, color: result.positions[i] > 0 ? C.exposureLong : C.exposureShort })));
    this.series.equity.push(bh, eq, exposure);

    // ---- Drawdown
    this.clear('drawdown');
    const bhd = this.drawdown.addSeries(LineSeries, { color: C.bhDrawdown, lineWidth: 1, priceLineVisible: false, title: 'B&H' });
    bhd.setData(times.map((t, i) => ({ time: t, value: result.benchmarkDrawdown[i] })));
    const dd = this.drawdown.addSeries(BaselineSeries, drawdownSeriesOptions());
    dd.setData(times.map((t, i) => ({ time: t, value: result.drawdown[i] })));
    this.series.drawdown.push(bhd, dd);

    for (const ch of [this.price, this.equity, this.drawdown]) ch.timeScale().fitContent();
  }

  /** Daily point curve from a stored result. An optional overlay adds the SuperTrend line. */
  renderCurve({ times, values, overlay, showSupertrend }) {
    this.clear('price');
    this.clear('equity');
    this.clear('drawdown');
    if (this.markers) {
      this.markers.detach();
      this.markers = null;
    }
    const data = [];
    const dd = [];
    let peak = -Infinity;
    for (let i = 0; i < times.length; i++) {
      const time = chartTime(times[i]);
      const value = values[i];
      if (value == null || !Number.isFinite(value)) continue;
      if (data.length && data[data.length - 1].time === time) continue;
      data.push({ time, value });
      if (value > peak) peak = value;
      dd.push({ time, value: value - peak });
    }
    const candlesIn = (overlay?.candles || []).map((bar) => ({ ...bar, time: chartTime(bar.time) })).filter((bar) => bar.time != null);
    const priceBars = candlesIn.length ? candlesIn : data.length ? pointCandles(data) : [];
    if (!priceBars.length && !data.length) return;
    if (priceBars.length) {
      const price = this.price.addSeries(CandlestickSeries, candleSeriesOptions());
      price.setData(priceBars.map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      this.series.price.push(price);
      if (showSupertrend && candlesIn.length && overlay?.line?.length) this.drawStoredLine(overlay.line);
      if (showSupertrend && candlesIn.length && overlay?.markers?.length) {
        const marks = overlay.markers.map((mark) => {
          const label = supertrendLabel(mark.side);
          return { ...label, time: snapTime(priceBars, chartTime(mark.time)) };
        }).filter((mark) => mark.time != null);
        marks.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
        this.markers = createSeriesMarkers(price, marks);
      }
    }
    if (!data.length) {
      this.price.timeScale().fitContent();
      return;
    }
    this.equity.priceScale('right').applyOptions({ mode: PriceScaleMode.Normal });
    this.drawdown.applyOptions({ localization: { priceFormatter: (p) => p.toFixed(0) } });
    const eq = this.equity.addSeries(AreaSeries, strategyAreaOptions());
    eq.setData(data);
    this.series.equity.push(eq);
    const drop = this.drawdown.addSeries(BaselineSeries, drawdownSeriesOptions());
    drop.setData(dd);
    this.series.drawdown.push(drop);
    for (const ch of [this.price, this.equity, this.drawdown]) ch.timeScale().fitContent();
  }

  drawStoredLine(points) {
    for (const dir of [1, -1]) {
      const series = points.map((point) => {
        const time = chartTime(point.time);
        return point.dir === dir ? { time, value: point.value } : { time };
      });
      if (!series.some((point) => point.value != null)) continue;
      const s = this.price.addSeries(LineSeries, {
        color: dir === 1 ? C.up : C.down,
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: '',
      });
      s.setData(series);
      this.series.price.push(s);
    }
  }

  focus(fromTime, toTime, padBars = 25) {
    const ts = this.price.timeScale();
    const a = ts.timeToIndex(chartTime(fromTime), true);
    const b = ts.timeToIndex(chartTime(toTime), true);
    if (a == null || b == null) return;
    ts.setVisibleLogicalRange({ from: a - padBars, to: b + padBars });
  }
}
