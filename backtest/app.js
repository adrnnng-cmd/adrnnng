import { PROVIDERS, getProvider } from './providers/index.js';
import hsiFutures, { BarsPending } from './providers/hsi-futures.js';
import { STRATEGIES, getStrategy, defaultParams, normaliseParams } from './strategies/index.js';
import { adjustForDividends, resample, indexAtOrAfter, indexAtOrBefore } from './engine/bars.js';
import { filterDaySession, resampleMinutes, toDaily } from './engine/intraday.js';
import { runBacktest, DEFAULT_OPTIONS } from './engine/backtest.js';
import { periodReturns } from './engine/metrics.js';
import { compose } from './composition/index.js';
import { RECIPES, getRecipe, defaultCostPoints } from './composition/recipes.js';
import { HSI_FUTURES, TIMEFRAME_CHOICES, isHsiFutures, isIntradayTimeframe, timeframeChoices, lockedSymbol } from './symbols.js';
import { BacktestCharts } from './charts.js';
import { esc } from '/assets/js/site.js';

const ENTRY_RULES = [
  { id: 'flip', label: 'Any flip' },
  { id: 'clock', label: 'Clock state' },
  { id: 'firstFlip', label: 'First flip after the clock' },
];
const EXIT_RULES = [
  { id: 'flat', label: 'Then flat for the day' },
  { id: 'reenter', label: 'Re-enter the same direction only' },
  { id: 'reverse', label: 'Reverse' },
];
const EXIT_TFS = [
  { id: '1m', label: '1m' },
  { id: '5m', label: '5m' },
];

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
  exitTf: '5m',
  entryRule: 'clock',
  exitRule: 'reenter',
  clock: '09:30',
  confirm: 'none',
  sessionMode: 'dates',
  year: 'all',
  flattenEod: true,
  costPoints: 0,
  costTouched: false,
  exitAtr: 10,
  recipe: '',
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
function locationParams() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const has = (k) => hash.has(k) || query.has(k);
  const get = (k) => (hash.has(k) ? hash.get(k) : query.get(k));
  return { has, get, hash };
}

function readHash() {
  const { has, get, hash } = locationParams();
  if (has('recipe') && getRecipe(get('recipe'))) applyRecipe(get('recipe'), { silent: true });
  if (has('symbol')) state.symbol = get('symbol').toUpperCase();
  if (has('strategy')) {
    const id = getStrategy(get('strategy')).id;
    if (id !== state.strategy) {
      state.strategy = id;
      state.recipe = '';
      state.params = {};
    }
  }
  if (has('tf') && TIMEFRAME_CHOICES.some((t) => t.id === get('tf'))) state.tf = get('tf');
  if (has('xtf') && EXIT_TFS.some((t) => t.id === get('xtf'))) state.exitTf = get('xtf');
  if (has('entry') && ENTRY_RULES.some((r) => r.id === get('entry'))) state.entryRule = get('entry');
  if (has('exit') && EXIT_RULES.some((r) => r.id === get('exit'))) state.exitRule = get('exit');
  if (has('clock') && /^\d{2}:\d{2}$/.test(get('clock'))) state.clock = get('clock');
  if (has('confirm') && (get('confirm') === 'none' || get('confirm') === 'daily')) state.confirm = get('confirm');
  if (has('session') && (get('session') === 'year' || get('session') === 'dates')) state.sessionMode = get('session');
  if (has('year')) state.year = get('year');
  if (has('flat')) state.flattenEod = get('flat') !== '0';
  if (has('cost') && isNum(+get('cost'))) {
    state.costPoints = +get('cost');
    state.costTouched = true;
  } else if (!has('recipe')) state.costTouched = false;
  if (has('xatr') && isNum(+get('xatr'))) state.exitAtr = +get('xatr');
  if (has('range') && PRESETS.some((p) => p.id === get('range'))) state.preset = get('range');
  if (has('from')) { state.from = get('from'); state.preset = has('range') || state.sessionMode === 'year' ? state.preset : 'custom'; }
  if (has('to')) state.to = get('to');
  if (has('short')) state.short = get('short') === '1';
  if (has('adj')) state.adjust = get('adj') !== '0';
  for (const [k, hk] of Object.entries(HASH_KEYS)) if (has(hk) && isNum(+get(hk))) state[k] = +get(hk);
  const raw = {};
  for (const [k, v] of hash) if (k.startsWith('p.')) raw[k.slice(2)] = v;
  for (const [k, v] of new URLSearchParams(location.search)) if (k.startsWith('p.') && !hash.has(k)) raw[k.slice(2)] = v;
  if (Object.keys(raw).length || !state.params || !Object.keys(state.params).length) {
    state.params = normaliseParams(getStrategy(state.strategy), { ...state.params, ...raw });
  }
  const lock = lockedSymbol(state.tf) || (isIntradayTimeframe(state.exitTf) && isIntradayTimeframe(state.tf) ? lockedSymbol(state.exitTf) : null);
  if (lock) state.symbol = lock;
}

function writeHash() {
  const h = new URLSearchParams();
  if (state.provider === 'site') h.set('symbol', state.symbol);
  h.set('strategy', state.strategy);
  const s = getStrategy(state.strategy);
  const def = defaultParams(s);
  for (const [k, v] of Object.entries(state.params)) if (v !== def[k]) h.set(`p.${k}`, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  h.set('tf', state.tf);
  if (showCompose()) {
    if (state.recipe) h.set('recipe', state.recipe);
    if (isIntradayTimeframe(state.tf)) {
      h.set('xtf', state.exitTf);
      h.set('entry', state.entryRule);
      h.set('exit', state.exitRule);
      if (state.entryRule !== 'flip') h.set('clock', state.clock);
      if (state.confirm !== 'none') h.set('confirm', state.confirm);
      h.set('session', state.sessionMode);
      if (state.sessionMode === 'year') h.set('year', state.year);
      if (!state.flattenEod) h.set('flat', '0');
      if (state.costTouched || state.costPoints !== defaultCostPoints(state.exitTf)) h.set('cost', String(state.costPoints));
      if (state.exitTf !== state.tf) h.set('xatr', String(state.exitAtr));
    }
  }
  if (state.preset !== 'custom' && state.preset !== 'year') h.set('range', state.preset);
  h.set('from', state.from);
  h.set('to', state.to);
  if (state.short) h.set('short', '1');
  if (!state.adjust) h.set('adj', '0');
  for (const [k, hk] of Object.entries(HASH_KEYS)) if (state[k] !== initialNumbers[k]) h.set(hk, String(state[k]));
  history.replaceState(null, '', `${location.pathname}#${h.toString()}`);
}
const initialNumbers = { capital: DEFAULT_OPTIONS.capital, commission: DEFAULT_OPTIONS.commissionBps, slippage: DEFAULT_OPTIONS.slippageBps, stop: 0, take: 0, maxbars: 0, rf: 0 };

// ---------------------------------------------------------------- controls
function buildStaticControls() {
  $('provider').innerHTML = PROVIDERS.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  $('strategy').innerHTML = STRATEGIES.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('presets').innerHTML = PRESETS.map((p) => `<button type="button" data-v="${p.id}">${p.label}</button>`).join('');
  $('recipe').innerHTML = `<option value="">Custom</option>${RECIPES.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}`;
  $('entry-rule').innerHTML = ENTRY_RULES.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');
  $('exit-rule').innerHTML = EXIT_RULES.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');

  $('provider').addEventListener('change', async (e) => {
    state.provider = e.target.value;
    syncProviderUi();
    if (getProvider(state.provider).kind === 'catalog') await loadData();
  });
  $('symbol').addEventListener('change', async (e) => {
    if (e.target.value === state.symbol) return;
    state.symbol = e.target.value;
    const lock = lockedSymbol(state.tf);
    if (lock && state.symbol !== lock) state.tf = '1d';
    await loadData();
  });
  $('file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) await loadData(f);
  });
  $('strategy').addEventListener('change', (e) => {
    state.strategy = e.target.value;
    state.recipe = '';
    state.params = defaultParams(getStrategy(state.strategy));
    state.exitAtr = state.params.atrLength ?? state.exitAtr;
    if (!isIntradayTimeframe(state.tf)) state.sessionMode = 'dates';
    buildParams();
    syncCompose();
    schedule();
  });
  $('timeframe').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const tf = b.dataset.v;
    const lock = lockedSymbol(tf);
    const prevSymbol = state.symbol;
    state.tf = tf;
    state.recipe = '';
    if (lock) state.symbol = lock;
    if (isIntradayTimeframe(tf)) {
      if (!isIntradayTimeframe(state.exitTf)) state.exitTf = tf;
      state.short = true;
      applySessionCost();
    }
    syncCompose();
    if (state.symbol !== prevSymbol) await loadData();
    else schedule();
  });
  $('exit-tf').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.exitTf = b.dataset.v;
    state.recipe = '';
    applySessionCost();
    if (!isHsiFutures(state.symbol)) {
      state.symbol = HSI_FUTURES.symbol;
      if (!isIntradayTimeframe(state.tf)) state.tf = state.exitTf;
      syncCompose();
      await loadData();
      return;
    }
    syncCompose();
    schedule();
  });
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.preset = b.dataset.v;
    state.sessionMode = 'dates';
    state.recipe = '';
    applyPreset();
    schedule();
  });
  $('recipe').addEventListener('change', async (e) => {
    if (!e.target.value) {
      state.recipe = '';
      schedule();
      return;
    }
    const prev = state.symbol;
    applyRecipe(e.target.value, { silent: true });
    syncCompose();
    buildParams();
    if (state.symbol !== prev || !dataset || dataset.symbol !== state.symbol) await loadData();
    else schedule();
  });
  $('entry-rule').addEventListener('change', (e) => { state.entryRule = e.target.value; state.recipe = ''; syncCompose(); schedule(); });
  $('exit-rule').addEventListener('change', (e) => { state.exitRule = e.target.value; state.recipe = ''; schedule(); });
  $('clock').addEventListener('change', (e) => { state.clock = e.target.value; state.recipe = ''; schedule(); });
  $('confirm').addEventListener('change', (e) => { state.confirm = e.target.value; state.recipe = ''; schedule(); });
  $('session-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.sessionMode = b.dataset.v;
    state.recipe = '';
    if (state.sessionMode === 'year') applyYear();
    schedule();
  });
  $('year').addEventListener('change', (e) => {
    state.year = e.target.value;
    state.sessionMode = 'year';
    state.recipe = '';
    applyYear();
    schedule();
  });
  $('flatten').addEventListener('change', (e) => { state.flattenEod = e.target.checked; state.recipe = ''; schedule(); });
  $('entry-atr').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    const atrLength = Math.max(1, Math.min(200, Math.round(v)));
    state.params = normaliseParams(getStrategy(state.strategy), { ...state.params, atrLength });
    if (state.exitTf === state.tf) state.exitAtr = atrLength;
    state.recipe = '';
    buildParams();
    schedule(350);
  });
  $('exit-atr').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    state.exitAtr = Math.max(1, Math.min(200, Math.round(v)));
    state.recipe = '';
    schedule(350);
  });
  $('cost-points').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (e.target.value === '' || !Number.isFinite(v) || v < 0) return;
    state.costPoints = Math.min(100, v);
    state.costTouched = true;
    state.recipe = '';
    schedule(350);
  });
  for (const id of ['from', 'to']) {
    $(id).addEventListener('change', (e) => {
      if (!e.target.value) return;
      state[id] = e.target.value;
      state.preset = 'custom';
      state.sessionMode = 'dates';
      state.recipe = '';
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

function showCompose() {
  return Boolean(getStrategy(state.strategy).capabilities?.session);
}

function sessionActive() {
  return showCompose() && isIntradayTimeframe(state.tf) && isHsiFutures(state.symbol);
}

function applyRecipe(id, { silent = false } = {}) {
  const recipe = getRecipe(id);
  if (!recipe) {
    state.recipe = '';
    return;
  }
  state.recipe = recipe.id;
  state.strategy = recipe.strategy;
  state.symbol = recipe.symbol;
  state.params = normaliseParams(getStrategy(recipe.strategy), recipe.params);
  state.tf = recipe.tf;
  state.exitTf = recipe.exitTf;
  state.entryRule = recipe.entryRule;
  state.exitRule = recipe.exitRule;
  state.clock = recipe.clock;
  state.confirm = recipe.confirm;
  state.sessionMode = recipe.sessionMode;
  state.year = recipe.year;
  state.flattenEod = recipe.flattenEod;
  state.costPoints = recipe.costPoints;
  state.costTouched = recipe.costPoints !== defaultCostPoints(recipe.exitTf);
  state.exitAtr = recipe.params.atrLength;
  state.short = true;
  if (!silent) syncCompose();
}

function renderTimeframes() {
  const choices = timeframeChoices(state.symbol);
  $('timeframe').innerHTML = choices
    .map((t) => `<button type="button" data-v="${t.id}" ${t.disabled ? 'aria-disabled="true"' : ''} title="${esc(t.reason || t.label)}">${t.label}</button>`)
    .join('');
  const exitLocked = !isHsiFutures(state.symbol);
  $('exit-tf').innerHTML = EXIT_TFS
    .map((t) => `<button type="button" data-v="${t.id}" ${exitLocked ? 'aria-disabled="true"' : ''} title="${esc(exitLocked ? '1-minute and 5-minute bars are only available for HSI futures' : t.label)}">${t.label}</button>`)
    .join('');
}

function renderSymbols() {
  const lock = isIntradayTimeframe(state.tf);
  const wanted = state.symbol;
  const groups = [...new Set(symbols.map((s) => s.group))];
  $('symbol').innerHTML = groups
    .map((g) => `<optgroup label="${esc(g)}">${symbols
      .filter((s) => s.group === g)
      .map((s) => {
        const disabled = lock && !isHsiFutures(s.symbol);
        const why = disabled ? ' title="1-minute and 5-minute bars lock the security to HSI futures"' : '';
        return `<option value="${esc(s.symbol)}"${disabled ? ' disabled' : ''}${why}>${esc(s.symbol)} · ${esc(s.name)}</option>`;
      })
      .join('')}</optgroup>`)
    .join('');
  if ([...$('symbol').options].some((o) => o.value === wanted && !o.disabled)) $('symbol').value = wanted;
}

function applySessionCost() {
  if (state.costTouched) return;
  if (!isIntradayTimeframe(state.tf) && !isIntradayTimeframe(state.exitTf)) return;
  state.costPoints = defaultCostPoints(state.exitTf);
}

function syncCompose() {
  const on = showCompose();
  ensureYears();
  $('compose-row').hidden = !on;
  $('tf-label').textContent = on ? 'Entry' : 'Period';
  renderTimeframes();
  if (symbols.length) renderSymbols();
  const session = sessionActive();
  if (session) applySessionCost();
  const hasAtr = getStrategy(state.strategy).params.some((p) => p.key === 'atrLength');
  $('entry-atr-field').hidden = !hasAtr;
  for (const id of ['entry-rule', 'exit-rule', 'clock', 'confirm', 'flatten', 'cost-points']) {
    const el = $(id);
    if (el) el.disabled = !session;
  }
  $('recipe').disabled = !on;
  $('entry-atr').disabled = !on || !hasAtr;
  $('year').disabled = !on;
  $('clock-field').hidden = state.entryRule === 'flip';
  $('year-field').hidden = state.sessionMode !== 'year';
  $('exit-atr').disabled = !session || state.exitTf === state.tf;
  $('flatten').checked = state.flattenEod;
  $('flatten').disabled = !session;
  const entryLen = state.params.atrLength ?? state.exitAtr;
  if (document.activeElement !== $('entry-atr')) $('entry-atr').value = entryLen;
  if (document.activeElement !== $('exit-atr')) $('exit-atr').value = state.exitTf === state.tf ? entryLen : state.exitAtr;
  if (document.activeElement !== $('cost-points')) $('cost-points').value = state.costPoints;
  $('entry-rule').value = state.entryRule;
  $('exit-rule').value = state.exitRule;
  $('clock').value = state.clock;
  $('confirm').value = state.confirm;
  $('recipe').value = state.recipe || '';
  if ($('year').options.length) $('year').value = [...$('year').options].some((o) => o.value === state.year) ? state.year : 'all';
  $('session-mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.sessionMode)));
  $('timeframe').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.tf)));
  $('exit-tf').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.exitTf)));
  const points = isHsiFutures(state.symbol);
  for (const id of ['commission', 'slippage', 'rf', 'stop', 'take', 'maxbars']) $(id).disabled = points;
  $('short').disabled = points;
  if (points) $('short').checked = true;
  $('exec-hint').textContent = points
    ? 'HSI futures score is index points for one unit. Basis-point commission is not applied. Cost defaults to 6 points on a 5-minute exit and 8 on a 1-minute exit. 0 is price movement only.'
    : '0 turns a risk rule off. Fills at the next open after a signal. Costs on each side.';
  $('compose-hint').textContent = session
    ? 'Day session 09:15–16:30 Hong Kong time. A flip fills at the next bar’s open. The daily confirm is a separate signal.'
    : on
      ? 'Clock, flip, and the exit timeframe apply to HSI futures 1-minute and 5-minute bars. Daily stays on this security’s daily bars.'
      : '';
}

function syncControls() {
  syncProviderUi();
  syncCompose();
  $('symbol').value = state.symbol;
  $('strategy').value = state.strategy;
  buildParams();
  $('presets').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.preset)));
  $('from').value = dayOf(state.from);
  $('to').value = dayOf(state.to);
  for (const [k, id] of Object.entries(NUM_INPUTS)) if (document.activeElement !== $(id)) $(id).value = state[k];
  $('short').checked = isHsiFutures(state.symbol) || state.short;
  $('adjust').checked = state.adjust;
  $('adjust').disabled = !dataset?.hasDividends;
}

function dayOf(t) {
  return t ? String(t).slice(0, 10) : '';
}

function applyPreset() {
  if (!dataset || state.preset === 'custom' || state.preset === 'year') return;
  const first = dayOf(dataset.bars[0].time);
  const last = dayOf(dataset.bars.at(-1).time);
  const p = PRESETS.find((x) => x.id === state.preset);
  state.to = last;
  state.from = p.years == null ? first : [shiftYears(last, p.years), first].sort().at(-1);
}

function applyYear() {
  if (!dataset) return;
  const first = dayOf(dataset.bars[0].time);
  const last = dayOf(dataset.bars.at(-1).time);
  if (state.year === 'all' || !/^\d{4}$/.test(state.year)) {
    state.from = first;
    state.to = last;
  } else {
    state.from = [`${state.year}-01-01`, first].sort().at(-1);
    state.to = [`${state.year}-12-31`, last].sort()[0];
  }
  state.preset = 'year';
}

function ensureYears() {
  if ($('year').options.length) return;
  const end = new Date().getFullYear();
  const years = [];
  for (let y = 2020; y <= end; y++) years.push(String(y));
  $('year').innerHTML = `<option value="all">All years</option>${years.map((y) => `<option value="${esc(y)}">${esc(y)}</option>`).join('')}`;
}

function fillYears() {
  if (!dataset) {
    ensureYears();
    return;
  }
  const years = [...new Set(dataset.bars.map((b) => dayOf(b.time).slice(0, 4)))].filter(Boolean);
  $('year').innerHTML = `<option value="all">All years</option>${years.map((y) => `<option value="${esc(y)}">${esc(y)}</option>`).join('')}`;
}

async function populateSymbols() {
  const siteSyms = await getProvider('site').listSymbols();
  const fut = await hsiFutures.listSymbols();
  symbols = [...siteSyms, ...fut];
  if (!symbols.some((s) => s.symbol === state.symbol)) state.symbol = 'SPY';
  renderSymbols();
}

// ---------------------------------------------------------------- data & run
async function loadData(file) {
  const p = getProvider(state.provider);
  $('results').classList.add('loading');
  $('run-title').textContent = 'Loading prices…';
  try {
    if (p.kind !== 'file' && isHsiFutures(state.symbol)) dataset = await hsiFutures.load();
    else dataset = await p.load(p.kind === 'file' ? file : state.symbol);
    fillYears();
    if (state.sessionMode === 'year') applyYear();
    else if (state.preset !== 'custom' || !state.from) applyPreset();
    const last = dayOf(dataset.bars.at(-1).time);
    if (!state.to || state.to > last) state.to = last;
    run();
  } catch (e) {
    dataset = null;
    showError(e);
  }
}

let timer = null;
function schedule(ms = 120) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
}

function viewBars(tf) {
  let bars = dataset.bars;
  const intraday = String(bars[0]?.time || '').includes('T');
  if (tf === '1m') return filterDaySession(bars);
  if (tf === '5m') return resampleMinutes(filterDaySession(bars), 5);
  if (intraday) bars = toDaily(filterDaySession(bars));
  if (state.adjust && dataset.hasDividends) bars = adjustForDividends(bars);
  return resample(bars, tf === '1w' || tf === '1mo' ? tf : '1d');
}

function run() {
  if (!dataset) return;
  syncControls();
  try {
    const strategy = getStrategy(state.strategy);
    const params = normaliseParams(strategy, state.params);
    const points = isHsiFutures(dataset.symbol);
    const minuteBars = String(dataset.bars[0]?.time || '').includes('T');
    if (isIntradayTimeframe(state.tf) && !minuteBars) {
      throw new BarsPending('1-minute and 5-minute HSI futures bars are not on this site yet.');
    }
    const session = sessionActive() && minuteBars;
    let bars;
    let signal;
    let flattenAtClose = null;
    let accounting = points ? 'points' : 'equity';
    if (session) {
      const composed = compose({
        bars: dataset.bars,
        strategy,
        params,
        spec: {
          entryTimeframe: state.tf,
          exitTimeframe: state.exitTf,
          entryRule: state.entryRule,
          exitRule: state.exitRule,
          clock: state.clock,
          confirm: state.confirm,
          from: state.from,
          to: state.to,
          flattenEod: state.flattenEod,
          exitAtrLength: state.exitTf !== state.tf ? state.exitAtr : null,
        },
      });
      bars = composed.bars;
      flattenAtClose = composed.flattenAtClose;
      accounting = composed.accounting;
      signal = composed.signal;
    } else {
      bars = viewBars(state.tf);
      const passthrough = compose({
        bars,
        strategy,
        params,
        spec: { entryTimeframe: state.tf, entryRule: 'signal' },
      });
      bars = passthrough.bars;
      signal = passthrough.signal;
    }
    const start = indexAtOrAfter(bars, state.from || dayOf(bars[0].time));
    const end = indexAtOrBefore(bars, state.to || dayOf(bars.at(-1).time));
    if (end - start < 2) throw new Error('The selected range contains fewer than three bars. Widen the dates or pick a shorter timeframe.');
    const pending = session && start > 0 && signal.target[start - 1] != null ? signal.target[start - 1] : null;
    const result = runBacktest(bars, { run: () => signal }, params, {
      start,
      end,
      capital: state.capital || 10000,
      commissionBps: points ? 0 : state.commission,
      slippageBps: points ? 0 : state.slippage,
      allowShort: points ? true : state.short,
      stopLossPct: points ? 0 : state.stop,
      takeProfitPct: points ? 0 : state.take,
      maxHoldBars: points ? 0 : state.maxbars,
      riskFreeRate: points ? 0 : state.rf / 100,
      accounting,
      flattenAtClose,
      initialPending: pending,
      costPoints: session ? state.costPoints : 0,
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

function clearWorkspace() {
  lastRun = null;
  if (charts) {
    try {
      charts.clear('price');
      charts.clear('equity');
      charts.clear('drawdown');
    } catch (err) {
      console.error(err);
    }
  }
  for (const id of ['heatmap', 'trade-bars', 'trades', 'summary', 'stats', 'stats-trades', 'run-badges']) {
    if ($(id)) $(id).innerHTML = '';
  }
}

function showError(e) {
  console.error(e);
  $('results').classList.remove('loading');
  clearWorkspace();
  const pending = e?.code === 'bars-pending' || e?.name === 'BarsPending';
  $('notices').innerHTML = `<div class="notice ${pending ? 'notice-warn' : 'notice-error'}">${esc(e.message || e)}</div>`;
  $('run-title').textContent = pending ? 'HSI futures bars are not on this site yet' : 'Could not run this backtest';
  $('run-sub').textContent = pending
    ? 'Daily strategies on the other symbols still run. 1-minute and 5-minute bars show up here when the public packs are published.'
    : '';
  if (pending) $('run-badges').innerHTML = '<span class="badge">Bars pending</span>';
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

function sourceLabel(src) {
  return src?.name || 'Market data';
}

function renderHead() {
  const { result, strategy } = lastRun;
  const points = result.accounting === 'points';
  const tf = TIMEFRAME_CHOICES.find((t) => t.id === state.tf)?.label || state.tf;
  const exit = sessionActive() && state.exitTf !== state.tf ? ` → ${state.exitTf} exit` : '';
  const rule = sessionActive() ? ` · ${ENTRY_RULES.find((r) => r.id === state.entryRule)?.label || state.entryRule}${state.entryRule === 'flip' ? '' : ' ' + state.clock} · ${EXIT_RULES.find((r) => r.id === state.exitRule)?.label || ''}` : '';
  $('run-title').textContent = `${strategy.name} · ${dataset.symbol}`;
  $('run-sub').innerHTML = `${esc(dataset.name)} · ${esc(tf)}${esc(exit)} · <span class="num">${esc(result.times[0])}</span> → <span class="num">${esc(result.times.at(-1))}</span> · <span class="num">${int(result.times.length)}</span> bars · ${esc(paramSummary())}${rule}${points ? ' · index points' : state.short ? ' · longs & shorts' : ' · long only'}`;
  const src = dataset.source || {};
  const badges = [];
  if (dataset.sample) badges.push('<span class="badge badge-sample">Sample data</span>');
  if (dataset.userSupplied) badges.push('<span class="badge badge-sample">Your file</span>');
  else badges.push(`<span class="badge" title="${esc(src.note || '')}">${esc(sourceLabel(src))} · to ${esc(src.asOf || dayOf(dataset.bars.at(-1).time))}</span>`);
  badges.push(`<span class="badge">${points ? 'Index points' : state.adjust && dataset.hasDividends ? 'Total return' : 'Price only'}</span>`);
  $('run-badges').innerHTML = badges.join('');
  $('log-equity').disabled = points;
  if (points) $('log-equity').checked = false;

  const notes = [];
  if (dataset.sample) notes.push(['warn', 'This run uses SAMPLE data, not real market prices.']);
  if (dataset.userSupplied) notes.push(['', `Using your file <b>${esc(src.name.replace('Your file: ', ''))}</b>. Its prices have not been checked by this site.`]);
  if (src.stale) notes.push(['warn', `The latest refresh of ${esc(dataset.symbol)} failed, so prices end on ${esc(src.asOf)}.`]);
  if (dataset.symbol.startsWith('^')) notes.push(['', 'Index levels are not directly tradable and exclude dividends; use an ETF (e.g. SPY, QQQ, 2800.HK) for a tradable total-return test.']);
  if (state.from && dayOf(dataset.bars[0].time) > state.from) notes.push(['', `History for ${esc(dataset.symbol)} starts on ${esc(dayOf(result.times[0]))}; the test begins there.`]);
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
  const points = lastRun.result.accounting === 'points';
  const cap = points ? 0 : lastRun.result.metrics.startEquity || state.capital;
  const s = splitSides(trades, cap);
  const cell = (v, cls = '') => `<td class="r ${cls}">${v}</td>`;
  const row = (label, pick, fmt) => {
    const L = pick(s.long);
    const S = pick(s.short);
    const T = pick(s.total);
    return `<tr><td>${label}</td>${cell(fmt(L), tone(typeof L === 'number' ? L : null))}${cell(fmt(S), tone(typeof S === 'number' ? S : null))}${cell(fmt(T), tone(typeof T === 'number' ? T : null))}</tr>`;
  };
  const pnl = (v) => (points ? (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)} pts` : '—') : money(v, dataset.currency));
  $('summary').innerHTML = `<thead><tr><th></th><th class="r">Long</th><th class="r">Short</th><th class="r">Total</th></tr></thead><tbody>
    ${row('Trades', (x) => x.n, int)}
    ${row(points ? 'Points' : 'P&amp;L', (x) => x.pnl, pnl)}
    ${points ? '' : row('% P&amp;L', (x) => x.pct, (v) => pct(v, 2))}
    ${row(points ? 'Avg pts' : 'Avg. P&amp;L', (x) => x.avg, pnl)}
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

function heatColor(r, points = false) {
  if (!isNum(r)) return 'transparent';
  const scale = points ? 400 : 0.12;
  const a = Math.min(1, Math.abs(r) / scale) * 0.55 + 0.08;
  return r >= 0 ? `rgba(11,138,62,${a.toFixed(3)})` : `rgba(208,24,42,${a.toFixed(3)})`;
}

function renderHeatmap() {
  const { result } = lastRun;
  const series = heatWhich === 'bh' ? result.benchmark : result.equity;
  const points = result.accounting === 'points';
  const { months, years } = periodReturns(result.times, series, { absolute: points });
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
                ? `<td class="flat" title="${names[mi]} ${y}: ${points ? 'flat' : 'in cash'}">0.0</td>`
                : `<td style="background:${heatColor(r, points)}" title="${names[mi]} ${y}: ${points ? `${r.toFixed(1)} pts` : pct(r, 2)}">${points ? r.toFixed(0) : (r * 100).toFixed(1)}</td>`,
          )
          .join('')}<td class="yr" style="background:${heatColor(points ? yearRet[y] : yearRet[y] / 3, points)}">${points ? (isNum(yearRet[y]) ? yearRet[y].toFixed(0) : '—') : pct(yearRet[y], 1)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function renderStats() {
  const m = lastRun.result.metrics;
  const b = lastRun.result.benchmarkMetrics;
  const points = lastRun.result.accounting === 'points';
  if (points) {
    const pts = (v) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—');
    const rows = [
      ['Net points', pts(m.points), pts(b.points)],
      ['Max drawdown (pts)', pts(m.maxDrawdownPoints), pts(b.maxDrawdownPoints)],
      ['Sharpe (ann.)', ratio(m.sharpe), ratio(b.sharpe)],
      ['Time in market', pct(m.exposure, 1, false), pct(b.exposure, 1, false)],
    ];
    const tradeRows = [
      ['Closed trades', int(m.trades)],
      ['Win rate', pct(m.winRate, 1, false)],
      ['Profit factor', ratio(m.profitFactor)],
      ['Average trade (pts)', pts(m.avgTradePct)],
      ['Best trade (pts)', pts(m.bestTradePct)],
      ['Worst trade (pts)', pts(m.worstTradePct)],
      ['Average bars held', ratio(m.avgBarsHeld, 1)],
    ];
    $('stats').innerHTML = `<thead><tr><th>Performance</th><th class="r">Strategy</th><th class="r">Buy &amp; hold</th></tr></thead><tbody>${rows
      .map((r) => `<tr><td>${r[0]}</td><td class="r">${r[1]}</td><td class="r muted">${r[2]}</td></tr>`)
      .join('')}</tbody>`;
    $('stats-trades').innerHTML = `<thead><tr><th>Trades</th><th class="r">Strategy</th></tr></thead><tbody>${tradeRows
      .map((r) => `<tr><td>${r[0]}</td><td class="r">${r[1]}</td></tr>`)
      .join('')}</tbody>`;
    return;
  }
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
  const points = lastRun.result.accounting === 'points';
  const vals = trades.map((t) => (points ? t.pnl : t.returnPct));
  const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const hi = Math.max(0, ...vals) || maxAbs * 0.1;
  const lo = Math.min(0, ...vals) || -maxAbs * 0.1;
  const y = (v) => 6 + ((hi - v) / (hi - lo)) * (H - 12);
  const step = (W - padL) / trades.length;
  const bw = Math.max(1, Math.min(18, step * 0.7));
  const ticks = [hi, 0, lo].filter((v, i, a) => a.indexOf(v) === i);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="axis">${ticks
    .map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="rgba(17,17,17,${t === 0 ? 0.28 : 0.06})"/><text x="0" y="${y(t) + 3}">${t > 0 ? '+' : ''}${t.toFixed(0)}${points ? '' : '%'}</text>`)
    .join('')}</g>${trades
    .map((t, i) => {
      const x = padL + i * step + (step - bw) / 2;
      const v = points ? t.pnl : t.returnPct;
      const top = y(Math.max(0, v));
      const h = Math.max(1, Math.abs(y(v) - y(0)));
      return `<rect data-i="${i}" x="${x}" y="${top}" width="${bw}" height="${h}" fill="${v >= 0 ? '#0b8a3e' : '#d0182a'}"><title>#${i + 1} ${t.side} ${t.entryTime} → ${t.exitTime}: ${points ? `${v.toFixed(1)} pts` : pctRaw(t.returnPct)}</title></rect>`;
    })
    .join('')}</svg>`;
  el.querySelectorAll('rect').forEach((r) => r.addEventListener('click', () => focusTrade(trades[+r.dataset.i])));
}

function renderTrades() {
  const { trades, openTrade } = lastRun.result;
  const points = lastRun.result.accounting === 'points';
  const cur = points ? 'pts' : dataset.currency;
  const all = [...trades, ...(openTrade ? [openTrade] : [])];
  const why = (t) => (t.open ? 'marked to market' : t.reason === 'session' ? 'session close' : t.reason);
  $('trades-sub').textContent = points
    ? `${trades.length} closed${openTrade ? ' + 1 open' : ''}. One index unit. Points are exit minus entry for a long, and the opposite for a short. Click a row to zoom the charts to it.`
    : `${trades.length} closed${openTrade ? ' + 1 open' : ''}. Prices are fills after slippage${state.adjust && dataset.hasDividends ? ', on dividend-adjusted prices' : ''}. Click a row to zoom the charts to it.`;
  $('trades').innerHTML = `<thead><tr><th>#</th><th>Side</th><th>Entry</th><th class="r">Price</th><th>Exit</th><th class="r">Price</th><th class="r">Bars</th><th class="r">${points ? 'Points' : 'Return'}</th><th class="r">${points ? 'Points' : 'P&amp;L'}</th><th>Exit reason</th></tr></thead><tbody>${all
    .map(
      (t, i) => `<tr data-i="${i}" class="${t.open ? 'open' : ''}"><td class="muted">${i + 1}</td><td class="side ${t.side}">${t.side === 'long' ? 'Long' : 'Short'}</td><td>${t.entryTime}</td><td class="r">${price(t.entryPrice)}</td>
      <td>${t.open ? 'open' : t.exitTime}</td><td class="r">${price(t.exitPrice)}</td><td class="r">${t.bars}</td><td class="r ${tone(points ? t.pnl : t.returnPct)}">${points ? (isNum(t.pnl) ? t.pnl.toFixed(1) : '—') : pctRaw(t.returnPct)}</td><td class="r ${tone(t.pnl)}">${points ? (isNum(t.pnl) ? t.pnl.toFixed(1) : '—') : money(t.pnl, cur)}</td><td class="muted">${esc(why(t))}</td></tr>`,
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
