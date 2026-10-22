// Lab page. Sends settings to /api/hsi-lab and draws points. No bar access.

const ENTRY_HELP = {
  flip: 'Enter on every entry-timeframe flip, in that flip’s direction.',
  'clock@09:15': 'At 09:15, take the direction of the last completed entry bar. No flip required.',
  'clock@09:30': 'At 09:30, take the direction of the last completed entry bar. No flip required.',
  'firstFlip@09:15': 'Take the first entry-timeframe flip whose signal bar is at or after 09:15.',
  'firstFlip@09:30': 'Take the first entry-timeframe flip whose signal bar is at or after 09:30.',
};

const EXIT_HELP = {
  flat: 'The opposite flip on the exit timeframe closes the trade. No new entry that day.',
  reenter: 'Flatten on the opposite exit flip, then enter again only when the entry timeframe flips back to the original direction.',
  reverse: 'Flatten on the opposite exit flip, then take the next entry-timeframe flip in either direction. When both timeframes match, the position reverses at that same open.',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function selectedTf(id) {
  const on = document.querySelector(`#${id} button[aria-pressed="true"]`);
  return Number(on?.dataset.tf || 5);
}

function wireSeg(id, onChange) {
  const root = $(id);
  root.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    for (const el of root.querySelectorAll('button')) el.setAttribute('aria-pressed', String(el === btn));
    onChange?.(Number(btn.dataset.tf));
  });
}

function fmtPoints(n, digits = 1) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return sign + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtPf(metrics) {
  if (!metrics || metrics.trades === 0) return '—';
  if (metrics.profitFactor == null) return metrics.grossPoints > 0 ? '∞' : '—';
  return metrics.profitFactor.toFixed(3);
}

function fmtHold(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toFixed(0);
}

function num(id) {
  return Number($(id).value);
}

function entryChoice() {
  const value = $('entry-rule').value;
  const at = value.indexOf('@');
  if (at === -1) return { entryRule: value, clock: null };
  return { entryRule: value.slice(0, at), clock: value.slice(at + 1) };
}

function rangeMode() {
  const on = document.querySelector('#range-mode button[aria-pressed="true"]');
  return on?.dataset.mode || 'year';
}

function payload() {
  const entry = entryChoice();
  const entryTimeframe = selectedTf('entry-tf');
  const exitTimeframe = selectedTf('exit-tf');
  const atrLength = num('atr-length');
  const body = {
    strategy: $('strategy').value,
    atrLength,
    exitAtrLength: entryTimeframe === exitTimeframe ? atrLength : num('exit-atr-length'),
    entryTimeframe,
    exitTimeframe,
    entryRule: entry.entryRule,
    exitRule: $('exit-rule').value,
    costs: $('costs').checked,
  };
  if (rangeMode() === 'custom') {
    body.from = $('from').value;
    body.to = $('to').value;
  } else {
    body.range = $('range').value;
  }
  if (entry.clock) body.clock = entry.clock;
  if (body.costs) body.costPoints = num('cost-points');
  return body;
}

function syncRangeMode() {
  const custom = rangeMode() === 'custom';
  $('range-year').hidden = custom;
  $('range-custom').hidden = !custom;
}

function syncDates() {
  const from = $('from');
  const to = $('to');
  if (from.value && to.value && from.value > to.value) to.value = from.value;
}

function syncTimeframes() {
  const same = selectedTf('entry-tf') === selectedTf('exit-tf');
  const exitAtr = $('exit-atr-length');
  exitAtr.disabled = same;
  if (same) exitAtr.value = $('atr-length').value;
  $('tf-help').textContent = same
    ? 'The same timeframe uses one ATR length.'
    : 'The exit timeframe keeps its own ATR length, from 10 to 14.';
}

function syncEntry() {
  $('entry-help').textContent = ENTRY_HELP[$('entry-rule').value] || '';
}

function syncExit() {
  $('exit-help').textContent = EXIT_HELP[$('exit-rule').value] || '';
}

function syncCosts() {
  $('cost-points').disabled = !$('costs').checked;
}

let costDirty = false;

function defaultCost(tf) {
  return tf === 1 ? 8 : 6;
}

function curveSvg(points) {
  const w = 640;
  const h = 220;
  const padL = 52;
  const padR = 8;
  const padT = 14;
  const padB = 8;
  const ys = points.map((p) => p.points);
  let min = Math.min(0, ...ys);
  let max = Math.max(0, ...ys);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const x = (i) => padL + (points.length === 1 ? 0.5 : i / (points.length - 1)) * (w - padL - padR);
  const y = (v) => padT + ((max - v) / (max - min)) * (h - padT - padB);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.points).toFixed(1)}`).join(' ');
  const zero = y(0);
  const label = (v) => fmtPoints(v, Math.abs(max - min) >= 100 ? 0 : 1);
  const title = `Equity in points, ${points.length} sessions, ending ${fmtPoints(points[points.length - 1].points, 1)}.`;
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
    <line x1="${padL}" y1="${zero.toFixed(1)}" x2="${w - padR}" y2="${zero.toFixed(1)}" stroke="#111" stroke-width="1"/>
    <path d="${d}" fill="none" stroke="#111" stroke-width="1.6"/>
    <text class="axis" x="0" y="${(y(max) + 4).toFixed(1)}">${esc(label(max))}</text>
    <text class="axis" x="0" y="${(zero + 4).toFixed(1)}">0</text>
    <text class="axis" x="0" y="${(y(min) + 4).toFixed(1)}">${esc(label(min))}</text>
  </svg>`;
}

function table(headers, rows) {
  const head = headers.map((h) => `<th${h.right ? ' class="r"' : ''}>${esc(h.label)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((cell, i) => `<td${headers[i].right ? ' class="r num"' : ''}>${cell}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td colspan="5">No trades</td></tr>'}</tbody></table></div>`;
}

function render(result) {
  const m = result.metrics;
  const net = m.netPoints;
  const cls = net > 0 ? 'up' : net < 0 ? 'down' : '';
  const span = result.params.from && result.params.to ? `${result.params.from} – ${result.params.to}` : '';
  const costLine = result.params.costs
    ? `after ${fmtPoints(result.params.costPoints, 2).replace('+', '')} pts × ${m.trades.toLocaleString('en-US')} round trips · gross ${fmtPoints(m.grossPoints, 1)}`
    : `costs off · gross ${fmtPoints(m.grossPoints, 1)}`;
  const stats = [
    ['Trades', m.trades.toLocaleString('en-US')],
    ['Trades/day', m.tradesPerDay == null ? '—' : m.tradesPerDay.toFixed(2)],
    ['Win rate', fmtPct(m.winRate)],
    ['Profit factor', fmtPf(m)],
    ['Avg pts', fmtPoints(m.avgPoints, 2)],
    ['Avg hold', m.avgHoldMinutes == null ? '—' : `${fmtHold(m.avgHoldMinutes)} min`],
    ['Max DD', fmtPoints(m.maxDrawdownPoints, 1)],
    ['Gross', fmtPoints(m.grossPoints, 1)],
  ];
  const equity = (result.equity || []).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.points === 'number');
  const years = table(
    [
      { label: 'Year' },
      { label: 'Trades', right: true },
      { label: 'Win', right: true },
      { label: 'Avg', right: true },
      { label: 'Net', right: true },
    ],
    (result.byYear || []).map((row) => [
      esc(/^\d{4}$/.test(row.year) ? row.year : '—'),
      esc(row.trades),
      esc(fmtPct(row.winRate)),
      esc(fmtPoints(row.avgPoints, 2)),
      esc(fmtPoints(row.netPoints, 1)),
    ]),
  );
  const hours = table(
    [
      { label: 'Hour' },
      { label: 'Trades', right: true },
      { label: 'Win', right: true },
      { label: 'Avg', right: true },
      { label: 'Net', right: true },
    ],
    (result.byEntryHour || []).map((row) => [
      esc(Number.isInteger(row.hour) && row.hour >= 0 && row.hour <= 23 ? `${String(row.hour).padStart(2, '0')}:00` : '—'),
      esc(row.trades),
      esc(fmtPct(row.winRate)),
      esc(fmtPoints(row.avgPoints, 2)),
      esc(fmtPoints(row.netPoints, 1)),
    ]),
  );
  $('results').innerHTML = `
    <p class="kicker lab-kicker">Net points</p>
    <p class="lab-net num ${cls}">${esc(fmtPoints(net, 1))}</p>
    <p class="lab-net-sub">${esc(costLine)} · ${esc(m.sessionDays)} session days${span ? ` · ${esc(span)}` : ''}</p>
    <div class="stat-grid">${stats.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <div class="curve">
      <h2>Equity</h2>
      <p class="panel-sub">Cumulative points from zero, one point per session.</p>
      ${equity.length ? curveSvg(equity) : '<p class="lab-help">No session days in this range.</p>'}
      ${equity.length ? `<div class="eq-dates"><span>${esc(equity[0].date)}</span><span>${esc(equity[equity.length - 1].date)}</span></div>` : ''}
    </div>
    <div class="split">
      <div><h2>By year</h2>${years}</div>
      <div><h2>By entry hour</h2>${(result.byEntryHour || []).length ? hours : '<p class="lab-help">Shown for a whole year, or for all stored years.</p>'}</div>
    </div>
    <p class="notice lab-note">Win rate and profit factor are on gross points. Net is after the round-trip cost. No prices are in this result.</p>`;
}

function renderError(message) {
  $('results').innerHTML = `<div class="notice notice-error">${esc(message)}</div>`;
}

async function run() {
  const button = $('run');
  button.disabled = true;
  button.textContent = 'Running…';
  try {
    const res = await fetch('/api/hsi-lab', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      renderError(body?.error || `The run failed (${res.status}).`);
      return;
    }
    if (!body?.metrics) {
      renderError('The result was not a score.');
      return;
    }
    render(body);
  } catch {
    renderError('The lab API did not answer. A static preview has no Pages function.');
  } finally {
    button.disabled = false;
    button.textContent = 'Run';
  }
}

function fillRanges(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return;
  const sel = $('range');
  const current = sel.value;
  sel.innerHTML = ranges.map((range) => {
    const label = range === 'all' ? 'All years' : range;
    return `<option value="${esc(range)}">${esc(label)}</option>`;
  }).join('');
  if ([...sel.options].some((option) => option.value === current)) sel.value = current;
}

let datesDirty = false;

function fillDates(grid) {
  if (!grid?.dateStart || !grid?.dateEnd) return;
  const from = $('from');
  const to = $('to');
  from.min = grid.dateStart;
  from.max = grid.dateEnd;
  to.min = grid.dateStart;
  to.max = grid.dateEnd;
  if (datesDirty) return;
  from.value = grid.dateStart;
  to.value = grid.dateEnd;
}

function boot() {
  wireSeg('entry-tf', () => syncTimeframes());
  wireSeg('exit-tf', (tf) => {
    if (!costDirty) $('cost-points').value = String(defaultCost(tf));
    syncTimeframes();
  });
  $('atr-length').addEventListener('change', syncTimeframes);
  $('entry-rule').addEventListener('change', syncEntry);
  $('exit-rule').addEventListener('change', syncExit);
  $('range-mode').addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    for (const el of $('range-mode').querySelectorAll('button')) el.setAttribute('aria-pressed', String(el === btn));
    syncRangeMode();
  });
  $('from').addEventListener('input', () => {
    datesDirty = true;
    syncDates();
  });
  $('to').addEventListener('input', () => {
    datesDirty = true;
    syncDates();
  });
  $('costs').addEventListener('change', syncCosts);
  $('cost-points').addEventListener('input', () => {
    costDirty = true;
  });
  $('lab-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run();
  });
  syncEntry();
  syncExit();
  syncCosts();
  syncTimeframes();
  syncRangeMode();
  fetch('/api/hsi-lab')
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (!body?.strategies?.length) return;
      const sel = $('strategy');
      const current = sel.value;
      sel.innerHTML = body.strategies.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
      if ([...sel.options].some((o) => o.value === current)) sel.value = current;
      const chosen = body.strategies.find((s) => s.id === sel.value);
      if (chosen?.summary) $('strategy-help').textContent = chosen.summary;
      fillRanges(body.grid?.ranges);
      fillDates(body.grid);
    })
    .catch(() => {});
}

boot();
