import { PROVIDERS, getProvider } from './providers/index.js';
import { STRATEGIES, getStrategy, defaultParams, normaliseParams } from './strategies/index.js';
import { adjustForDividends, resample, indexAtOrAfter, indexAtOrBefore, TIMEFRAMES } from './engine/bars.js';
import { runBacktest, DEFAULT_OPTIONS } from './engine/backtest.js';
import { periodReturns } from './engine/metrics.js';
import { BacktestCharts } from './charts.js';
import { esc } from '/assets/js/site.js';

const $ = (id) => document.getElementById(id);
const PRESETS = [
  { id: '1y', label: '1Y', years: 1 },
  { id: '3y', label: '3Y', years: 3 },
  { id: '5y', label: '5Y', years: 5 },
  { id: '10y', label: '10Y', years: 10 },
  { id: '20y', label: '20Y', years: 20 },
  { id: 'max', label: 'Max', years: null },
];
const NUM_INPUTS = { capital: 'capital', commission: 'commission', slippage: 'slippage', stop: 'stop', take: 'take', maxbars: 'maxbars', rf: 'rf' };
const HASH_KEYS = { capital: 'cap', commission: 'comm', slippage: 'slip', stop: 'sl', take: 'tp', maxbars: 'mb', rf: 'rf' };

const state = {
  provider: 'site',
  symbol: 'SPY',
  strategy: 'td-sequential',
  params: {},
  tf: '1d',
  from: '',
  to: '',
  preset: '10y',
  short: false,
  adjust: true,
  capital: DEFAULT_OPTIONS.capital,
  commission: DEFAULT_OPTIONS.commissionBps,
  slippage: DEFAULT_OPTIONS.slippageBps,
  stop: 0,
  take: 0,
  maxbars: 0,
  rf: 0,
};
let dataset = null;
let lastRun = null;
let charts = null;
let heatWhich = 'strategy';
let symbols = [];

// ---------------------------------------------------------------- formatting
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v, d = 1, sign = true) => (isNum(v) ? `${sign && v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : v === Infinity ? '∞' : '—');
const pctRaw = (v, d = 2) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : '—');
const ratio = (v, d = 2) => (isNum(v) ? v.toFixed(d) : v === Infinity ? '∞' : '—');
const int = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : '—');
const money = (v, cur = '') => (isNum(v) ? `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}${cur ? ' ' + cur : ''}` : '—');
const price = (v) => (isNum(v) ? (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(4)) : '—');
const tone = (v) => (isNum(v) ? (v > 0 ? 'up' : v < 0 ? 'down' : '') : '');

function shiftYears(date, years) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- URL state
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has('symbol')) state.symbol = h.get('symbol').toUpperCase();
  if (h.has('strategy')) state.strategy = getStrategy(h.get('strategy')).id;
  if (h.has('tf') && TIMEFRAMES.some((t) => t.id === h.get('tf'))) state.tf = h.get('tf');
  if (h.has('range') && PRESETS.some((p) => p.id === h.get('range'))) state.preset = h.get('range');
  if (h.has('from')) { state.from = h.get('from'); state.preset = h.has('range') ? state.preset : 'custom'; }
  if (h.has('to')) state.to = h.get('to');
  if (h.has('short')) state.short = h.get('short') === '1';
  if (h.has('adj')) state.adjust = h.get('adj') !== '0';
  for (const [k, hk] of Object.entries(HASH_KEYS)) if (h.has(hk) && isNum(+h.get(hk))) state[k] = +h.get(hk);
  const raw = {};
  for (const [k, v] of h) if (k.startsWith('p.')) raw[k.slice(2)] = v;
  state.params = normaliseParams(getStrategy(state.strategy), raw);
}

function writeHash() {
  const h = new URLSearchParams();
  if (state.provider === 'site') h.set('symbol', state.symbol);
  h.set('strategy', state.strategy);
  const s = getStrategy(state.strategy);
  const def = defaultParams(s);
  for (const [k, v] of Object.entries(state.params)) if (v !== def[k]) h.set(`p.${k}`, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  h.set('tf', state.tf);
  if (state.preset !== 'custom') h.set('range', state.preset);
  h.set('from', state.from);
  h.set('to', state.to);
  if (state.short) h.set('short', '1');
  if (!state.adjust) h.set('adj', '0');
  for (const [k, hk] of Object.entries(HASH_KEYS)) if (state[k] !== initialNumbers[k]) h.set(hk, String(state[k]));
  history.replaceState(null, '', `#${h.toString()}`);
}
const initialNumbers = { capital: DEFAULT_OPTIONS.capital, commission: DEFAULT_OPTIONS.commissionBps, slippage: DEFAULT_OPTIONS.slippageBps, stop: 0, take: 0, maxbars: 0, rf: 0 };

// ---------------------------------------------------------------- controls
function buildStaticControls() {
  $('provider').innerHTML = PROVIDERS.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('strategy').innerHTML = STRATEGIES.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('timeframe').innerHTML = TIMEFRAMES.map((t) => `<button type="button" data-v="${t.id}">${t.label}</button>`).join('');
  $('presets').innerHTML = PRESETS.map((p) => `<button type="button" data-v="${p.id}">${p.label}</button>`).join('');

  $('provider').addEventListener('change', async (e) => {
    state.provider = e.target.value;
    syncProviderUi();
    if (getProvider(state.provider).kind === 'catalog') await loadData();
  });
  $('symbol').addEventListener('change', async (e) => {
    state.symbol = e.target.value;
    await loadData();
  });
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) await loadData(f);
  });
  $('strategy').addEventListener('change', (e) => {
    state.strategy = e.target.value;
    state.params = defaultParams(getStrategy(state.strategy));
    buildParams();
    schedule();
  });
  $('timeframe').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.tf = b.dataset.v;
    schedule();
  });
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.preset = b.dataset.v;
    applyPreset();
    schedule();
  });
  for (const id of ['from', 'to']) {
    $(id).addEventListener('change', (e) => {
      if (!e.target.value) return;
      state[id] = e.target.value;
      state.preset = 'custom';
      schedule();
    });
  }
  for (const [k, id] of Object.entries(NUM_INPUTS)) {
    $(id).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      if (e.target.value === '' || !Number.isFinite(v) || v < 0) return;
      state[k] = v;
      schedule(350);
    });
  }
  $('short').addEventListener('change', (e) => { state.short = e.target.checked; schedule(); });
  $('adjust').addEventListener('change', (e) => { state.adjust = e.target.checked; schedule(); });
  $('settings-toggle').addEventListener('click', () => {
    const extra = $('cmd-extra');
    extra.hidden = !extra.hidden;
    $('settings-toggle').setAttribute('aria-expanded', String(!extra.hidden));
  });
  $('side-toggle').addEventListener('click', () => $('results').classList.add('side-closed'));
  $('side-reopen').addEventListener('click', () => $('results').classList.remove('side-closed'));
  $('side-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    const tab = b.dataset.tab;
    $('side-tabs').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    document.querySelectorAll('.side-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  });
  $('run').addEventListener('click', () => run());
  $('share').addEventListener('click', async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      $('share').textContent = 'Copied ✓';
    } catch {
      $('share').textContent = 'Link in address bar';
    }
    setTimeout(() => ($('share').textContent = 'Copy link'), 1800);
  });
  for (const id of ['show-overlays', 'show-tdcounts', 'log-equity']) $(id).addEventListener('change', () => lastRun && renderCharts());
  $('heat-which').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    heatWhich = b.dataset.v;
    $('heat-which').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    if (lastRun) renderHeatmap();
  });
  $('csv-export').addEventListener('click', exportTrades);
  window.addEventListener('hashchange', async () => {
    const before = state.symbol;
    readHash();
    syncControls();
    if (state.symbol !== before && state.provider === 'site') await loadData();
    else schedule(0);
  });
}

function buildParams() {
  const s = getStrategy(state.strategy);
  $('strategy-summary').textContent = s.summary;
  $('params').innerHTML = s.params
    .map((p) => {
      const v = state.params[p.key];
      if (p.type === 'boolean') return `<label class="check" title="${esc(p.help || '')}"><input type="checkbox" data-param="${esc(p.key)}" ${v ? 'checked' : ''}> ${esc(p.label)}</label>`;
      if (p.type === 'select')
        return `<label class="field wide"><span>${esc(p.label)}</span><select class="select" data-param="${esc(p.key)}">${p.options.map((o) => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      return `<label class="field"><span>${esc(p.label)}</span><input class="input num" type="number" data-param="${esc(p.key)}" value="${esc(v)}" min="${p.min ?? ''}" max="${p.max ?? ''}" step="${p.step ?? 'any'}"></label>`;
    })
    .join('');
  $('params').querySelectorAll('[data-param]').forEach((el) => {
    el.addEventListener(el.type === 'number' ? 'input' : 'change', () => {
      const raw = { ...state.params, [el.dataset.param]: el.type === 'checkbox' ? el.checked : el.value };
      if (el.type === 'number' && (el.value === '' || !Number.isFinite(+el.value))) return;
      state.params = normaliseParams(s, raw);
      schedule(el.type === 'number' ? 350 : 0);
    });
  });
  $('tdcounts-wrap').hidden = s.id !== 'td-sequential';
}

function syncProviderUi() {
  const p = getProvider(state.provider);
  $('provider').value = p.id;
  $('symbol-field').hidden = p.kind !== 'catalog';
  $('file-field').hidden = p.kind !== 'file';
}

function syncControls() {
  syncProviderUi();
  $('symbol').value = state.symbol;
  $('strategy').value = state.strategy;
  buildParams();
  $('timeframe').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.tf)));
  $('presets').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.preset)));
  $('from').value = state.from;
  $('to').value = state.to;
  for (const [k, id] of Object.entries(NUM_INPUTS)) if (document.activeElement !== $(id)) $(id).value = state[k];
  $('short').checked = state.short;
  $('adjust').checked = state.adjust;
  $('adjust').disabled = !dataset?.hasDividends;
}

function applyPreset() {
  if (!dataset || state.preset === 'custom') return;
  const first = dataset.bars[0].time;
  const last = dataset.bars.at(-1).time;
  const p = PRESETS.find((x) => x.id === state.preset);
  state.to = last;
  state.from = p.years == null ? first : [shiftYears(last, p.years), first].sort().at(-1);
}

async function populateSymbols() {
  const p = getProvider('site');
  symbols = await p.listSymbols();
  const groups = [...new Set(symbols.map((s) => s.group))];
  $('symbol').innerHTML = groups
    .map((g) => `<optgroup label="${esc(g)}">${symbols.filter((s) => s.group === g).map((s) => `<option value="${esc(s.symbol)}">${esc(s.symbol)} · ${esc(s.name)}</option>`).join('')}</optgroup>`)
    .join('');
  if (!symbols.some((s) => s.symbol === state.symbol)) state.symbol = 'SPY';
}

// ---------------------------------------------------------------- data & run
async function loadData(file) {
  const p = getProvider(state.provider);
  $('results').classList.add('loading');
  $('run-title').textContent = 'Loading prices…';
  try {
    dataset = await p.load(p.kind === 'file' ? file : state.symbol);
    if (state.preset !== 'custom' || !state.from) applyPreset();
    if (!state.to || state.to > dataset.bars.at(-1).time) state.to = dataset.bars.at(-1).time;
    run();
  } catch (e) {
    showError(e);
  }
}

let timer = null;
function schedule(ms = 120) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
}

function run() {
  if (!dataset) return;
  syncControls();
  try {
    let bars = state.adjust && dataset.hasDividends ? adjustForDividends(dataset.bars) : dataset.bars;
    bars = resample(bars, state.tf);
    const start = indexAtOrAfter(bars, state.from || bars[0].time);
    const end = indexAtOrBefore(bars, state.to || bars.at(-1).time);
    if (end - start < 2) throw new Error('The selected range contains fewer than three bars. Widen the dates or pick a shorter timeframe.');
    const strategy = getStrategy(state.strategy);
    const params = normaliseParams(strategy, state.params);
    const result = runBacktest(bars, strategy, params, {
      start,
      end,
      capital: state.capital || 10000,
      commissionBps: state.commission,
      slippageBps: state.slippage,
      allowShort: state.short,
      stopLossPct: state.stop,
      takeProfitPct: state.take,
      maxHoldBars: state.maxbars,
      riskFreeRate: state.rf / 100,
    });
    lastRun = { bars, result, strategy, params };
    writeHash();
    render();
  } catch (e) {
    showError(e);
  } finally {
    $('results').classList.remove('loading');
  }
}

function showError(e) {
  console.error(e);
  $('results').classList.remove('loading');
  $('notices').innerHTML = `<div class="notice notice-error">${esc(e.message || e)}</div>`;
  $('run-title').textContent = 'Could not run this backtest';
}

// ---------------------------------------------------------------- render
function render() {
  renderHead();
  renderSummary();
  renderCharts();
  renderHeatmap();
  renderStats();
  renderTradeBars();
  renderTrades();
}

function paramSummary() {
  const { strategy, params } = lastRun;
  return strategy.params
    .filter((p) => p.type === 'select' || params[p.key] !== p.default || (p.type === 'number' && strategy.params.length <= 4))
    .map((p) => {
      if (p.type === 'select') return p.options.find((o) => o.value === params[p.key])?.label;
      if (p.type === 'boolean') return `${params[p.key] ? '' : 'no '}${p.label.toLowerCase()}`;
      return `${p.label.toLowerCase()} ${params[p.key]}`;
    })
    .join(', ');
}

function renderHead() {
  const { result, strategy } = lastRun;
  const tf = TIMEFRAMES.find((t) => t.id === state.tf).label;
  $('run-title').textContent = `${strategy.name} · ${dataset.symbol}`;
  $('run-sub').innerHTML = `${esc(dataset.name)} · ${tf} · <span class="num">${result.times[0]}</span> → <span class="num">${result.times.at(-1)}</span> · <span class="num">${int(result.times.length)}</span> bars · ${esc(paramSummary())}${state.short ? ' · longs & shorts' : ' · long only'}`;
  const src = dataset.source || {};
  const badges = [];
  if (dataset.sample) badges.push('<span class="badge badge-sample">Sample data</span>');
  if (dataset.userSupplied) badges.push('<span class="badge badge-sample">Your file</span>');
  else badges.push(`<span class="badge" title="${esc(src.note || '')}">${esc(src.name || 'Data')} · to ${esc(src.asOf || dataset.bars.at(-1).time)}</span>`);
  badges.push(`<span class="badge">${state.adjust && dataset.hasDividends ? 'Total return' : 'Price only'}</span>`);
  $('run-badges').innerHTML = badges.join('');

  const notes = [];
  if (dataset.sample) notes.push(['warn', 'This run uses SAMPLE data, not real market prices.']);
  if (dataset.userSupplied) notes.push(['', `Using your file <b>${esc(src.name.replace('Your file: ', ''))}</b>. Its prices have not been checked by this site.`]);
  if (src.stale) notes.push(['warn', `The latest refresh of ${esc(dataset.symbol)} failed, so prices end on ${esc(src.asOf)}.`]);
  if (dataset.symbol.startsWith('^')) notes.push(['', 'Index levels are not directly tradable and exclude dividends; use an ETF (e.g. SPY, QQQ, 2800.HK) for a tradable total-return test.']);
  if (state.from && dataset.bars[0].time > state.from) notes.push(['', `History for ${esc(dataset.symbol)} starts on ${result.times[0]}; the test begins there.`]);
  if (result.trades.length === 0 && !result.openTrade) notes.push(['warn', 'No trades were triggered in this range. Try a longer range, another timeframe or different parameters.']);
  $('notices').innerHTML = notes.map(([k, t]) => `<div class="notice ${k ? 'notice-' + k : ''}">${t}</div>`).join('');
}

function splitSides(trades, capital) {
  const pack = (arr) => {
    const pnl = arr.reduce((s, t) => s + t.pnl, 0);
    return {
      n: arr.length,
      pnl,
      pct: capital ? pnl / capital : null,
      avg: arr.length ? pnl / arr.length : null,
    };
  };
  return {
    long: pack(trades.filter((t) => t.side === 'long')),
    short: pack(trades.filter((t) => t.side === 'short')),
    total: pack(trades),
  };
}

function renderSummary() {
  const trades = lastRun.result.trades;
  const cap = lastRun.result.metrics.startEquity || state.capital;
  const s = splitSides(trades, cap);
  const cell = (v, cls = '') => `<td class="r ${cls}">${v}</td>`;
  const row = (label, pick, fmt) => {
    const L = pick(s.long);
    const S = pick(s.short);
    const T = pick(s.total);
    return `<tr><td>${label}</td>${cell(fmt(L), tone(typeof L === 'number' ? L : null))}${cell(fmt(S), tone(typeof S === 'number' ? S : null))}${cell(fmt(T), tone(typeof T === 'number' ? T : null))}</tr>`;
  };
  $('summary').innerHTML = `<thead><tr><th></th><th class="r">Long</th><th class="r">Short</th><th class="r">Total</th></tr></thead><tbody>
    ${row('Trades', (x) => x.n, int)}
    ${row('P&amp;L', (x) => x.pnl, (v) => money(v, dataset.currency))}
    ${row('% P&amp;L', (x) => x.pct, (v) => pct(v, 2))}
    ${row('Avg. P&amp;L', (x) => x.avg, (v) => money(v, dataset.currency))}
  </tbody>`;
}

function renderCharts() {
  charts ??= new BacktestCharts({ price: $('chart-price'), equity: $('chart-equity'), drawdown: $('chart-dd') });
  charts.render({
    bars: lastRun.bars,
    result: lastRun.result,
    show: { overlays: $('show-overlays').checked, tdCounts: $('show-tdcounts').checked, logEquity: $('log-equity').checked },
  });
}

function heatColor(r) {
  if (!isNum(r)) return 'transparent';
  const a = Math.min(1, Math.abs(r) / 0.12) * 0.55 + 0.08;
  return r >= 0 ? `rgba(11,138,62,${a.toFixed(3)})` : `rgba(208,24,42,${a.toFixed(3)})`;
}

function renderHeatmap() {
  const { result } = lastRun;
  const series = heatWhich === 'bh' ? result.benchmark : result.equity;
  const { months, years } = periodReturns(result.times, series);
  const byYear = new Map();
  for (const m of months) {
    if (!byYear.has(m.year)) byYear.set(m.year, new Array(12).fill(null));
    byYear.get(m.year)[m.month] = m.ret;
  }
  const yearRet = Object.fromEntries(years.map((y) => [y.year, y.ret]));
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const rows = [...byYear.entries()].sort((a, b) => b[0] - a[0]);
  $('heatmap').innerHTML = `<table class="heat"><thead><tr><th class="y"></th>${names.map((n) => `<th>${n}</th>`).join('')}<th>Year</th></tr></thead><tbody>${rows
    .map(
      ([y, ms]) =>
        `<tr><th class="y">${y}</th>${ms
          .map((r, mi) =>
            r == null
              ? '<td class="empty">·</td>'
              : Math.abs(r) < 1e-12
                ? `<td class="flat" title="${names[mi]} ${y}: in cash">0.0</td>`
                : `<td style="background:${heatColor(r)}" title="${names[mi]} ${y}: ${pct(r, 2)}">${(r * 100).toFixed(1)}</td>`,
          )
          .join('')}<td class="yr" style="background:${heatColor(yearRet[y] / 3)}">${pct(yearRet[y], 1)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function renderStats() {
  const m = lastRun.result.metrics;
  const b = lastRun.result.benchmarkMetrics;
  const cur = dataset.currency;
  const rows = [
    ['Start equity', money(m.startEquity, cur), money(b.startEquity, cur)],
    ['End equity', money(m.endEquity, cur), money(b.endEquity, cur)],
    ['Total return', pct(m.totalReturn, 2), pct(b.totalReturn, 2)],
    ['CAGR', pct(m.cagr, 2), pct(b.cagr, 2)],
    ['Volatility (ann.)', pct(m.volatility, 1, false), pct(b.volatility, 1, false)],
    ['Sharpe ratio', ratio(m.sharpe), ratio(b.sharpe)],
    ['Sortino ratio', ratio(m.sortino), ratio(b.sortino)],
    ['Max drawdown', pct(m.maxDrawdown, 2), pct(b.maxDrawdown, 2)],
    ['Longest drawdown', `${int(m.longestDrawdownDays)} days`, `${int(b.longestDrawdownDays)} days`],
    ['Calmar ratio', ratio(m.calmar), ratio(b.calmar)],
    ['Time in market', pct(m.exposure, 1, false), '100.0%'],
    ['Beta vs B&H', ratio(m.beta), '1.00'],
    ['Correlation vs B&H', ratio(m.correlation), '1.00'],
    ['Bars per year (measured)', ratio(m.periodsPerYear, 1), ratio(b.periodsPerYear, 1)],
  ];
  const t = lastRun.result.openTrade;
  const tradeRows = [
    ['Closed trades', int(m.trades)],
    ['Win rate', pct(m.winRate, 1, false)],
    ['Profit factor', ratio(m.profitFactor)],
    ['Average trade', pctRaw(m.avgTradePct)],
    ['Average win', pctRaw(m.avgWinPct)],
    ['Average loss', pctRaw(m.avgLossPct)],
    ['Best trade', pctRaw(m.bestTradePct)],
    ['Worst trade', pctRaw(m.worstTradePct)],
    ['Average bars held', ratio(m.avgBarsHeld, 1)],
    ['Open position at end', t ? `${t.side} since ${t.entryTime} (${pctRaw(t.returnPct)})` : 'none'],
  ];
  $('stats').innerHTML = `<thead><tr><th>Performance</th><th class="r">Strategy</th><th class="r">Buy &amp; hold</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${r[0]}</td><td class="r">${r[1]}</td><td class="r muted">${r[2]}</td></tr>`)
    .join('')}</tbody>`;
  $('stats-trades').innerHTML = `<thead><tr><th>Trades</th><th class="r">Strategy</th></tr></thead><tbody>${tradeRows
    .map((r) => `<tr><td>${r[0]}</td><td class="r">${r[1]}</td></tr>`)
    .join('')}</tbody>`;
}

function renderTradeBars() {
  const el = $('trade-bars');
  const trades = lastRun.result.trades;
  if (!trades.length) {
    el.innerHTML = '<p class="muted" style="padding:50px 0;text-align:center;font-size:13px">No closed trades.</p>';
    return;
  }
  const W = el.clientWidth || 800;
  const H = el.clientHeight || 150;
  const padL = 44;
  const vals = trades.map((t) => t.returnPct);
  const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const hi = Math.max(0, ...vals) || maxAbs * 0.1;
  const lo = Math.min(0, ...vals) || -maxAbs * 0.1;
  const y = (v) => 6 + ((hi - v) / (hi - lo)) * (H - 12);
  const step = (W - padL) / trades.length;
  const bw = Math.max(1, Math.min(18, step * 0.7));
  const ticks = [hi, 0, lo].filter((v, i, a) => a.indexOf(v) === i);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="axis">${ticks
    .map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="rgba(17,17,17,${t === 0 ? 0.28 : 0.06})"/><text x="0" y="${y(t) + 3}">${t > 0 ? '+' : ''}${t.toFixed(0)}%</text>`)
    .join('')}</g>${trades
    .map((t, i) => {
      const x = padL + i * step + (step - bw) / 2;
      const top = y(Math.max(0, t.returnPct));
      const h = Math.max(1, Math.abs(y(t.returnPct) - y(0)));
      return `<rect data-i="${i}" x="${x}" y="${top}" width="${bw}" height="${h}" fill="${t.returnPct >= 0 ? '#0b8a3e' : '#d0182a'}"><title>#${i + 1} ${t.side} ${t.entryTime} → ${t.exitTime}: ${pctRaw(t.returnPct)}</title></rect>`;
    })
    .join('')}</svg>`;
  el.querySelectorAll('rect').forEach((r) => r.addEventListener('click', () => focusTrade(trades[+r.dataset.i])));
}

function renderTrades() {
  const { trades, openTrade } = lastRun.result;
  const cur = dataset.currency;
  const all = [...trades, ...(openTrade ? [openTrade] : [])];
  $('trades-sub').textContent = `${trades.length} closed${openTrade ? ' + 1 open' : ''}. Prices are fills after slippage${state.adjust && dataset.hasDividends ? ', on dividend-adjusted prices' : ''}. Click a row to zoom the charts to it.`;
  $('trades').innerHTML = `<thead><tr><th>#</th><th>Side</th><th>Entry</th><th class="r">Price</th><th>Exit</th><th class="r">Price</th><th class="r">Bars</th><th class="r">Return</th><th class="r">P&amp;L</th><th>Exit reason</th></tr></thead><tbody>${all
    .map(
      (t, i) => `<tr data-i="${i}" class="${t.open ? 'open' : ''}"><td class="muted">${i + 1}</td><td class="side ${t.side}">${t.side === 'long' ? 'Long' : 'Short'}</td><td>${t.entryTime}</td><td class="r">${price(t.entryPrice)}</td>
      <td>${t.open ? 'open' : t.exitTime}</td><td class="r">${price(t.exitPrice)}</td><td class="r">${t.bars}</td><td class="r ${tone(t.returnPct)}">${pctRaw(t.returnPct)}</td><td class="r ${tone(t.pnl)}">${money(t.pnl, cur)}</td><td class="muted">${esc(t.open ? 'marked to market' : t.reason)}</td></tr>`,
    )
    .join('')}</tbody>`;
  $('trades').querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => focusTrade(all[+tr.dataset.i])));
}

function focusTrade(t) {
  charts.focus(t.entryTime, t.exitTime);
  $('chart-price').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function exportTrades() {
  if (!lastRun) return;
  const { trades, openTrade } = lastRun.result;
  const rows = [['n', 'side', 'entry_date', 'entry_price', 'exit_date', 'exit_price', 'bars', 'return_pct', 'pnl', 'exit_reason', 'open']];
  [...trades, ...(openTrade ? [openTrade] : [])].forEach((t, i) => rows.push([i + 1, t.side, t.entryTime, t.entryPrice, t.exitTime, t.exitPrice, t.bars, t.returnPct, t.pnl, t.reason, t.open ? 1 : 0]));
  const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `backtest-${dataset.symbol}-${state.strategy}-${state.tf}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- boot
async function init() {
  buildStaticControls();
  readHash();
  syncControls();
  try {
    await populateSymbols();
    $('symbol').value = state.symbol;
    await loadData();
  } catch (e) {
    showError(e);
  }
  let rw;
  window.addEventListener('resize', () => {
    clearTimeout(rw);
    rw = setTimeout(() => lastRun && renderTradeBars(), 150);
  });
}

init();
