import {
  BREADTH_COLORS, DEFAULT_MEMBER_SORT, IMPACT_LABEL, INDEX_VIEWS, MEMBER_COLUMNS, NEWS_EMPTY_TEXT, SESSION_LABELS, SORTS, VIEW_ORDER,
  ageMinutes, ariaSort, arrow, breadthSegments, esc, fmtAge, fmtHkd, fmtPct, fmtPoints, fmtPrice, fmtSigned, fmtUpdated,
  heatColor, impactOf, isIndexView, isNum, isStale, layoutGroups, memberStats, newsReference, nextSort, rankStocks, rankSummary,
  membersLabels, membersWindow, reconcileSelection, returnRefs, rosterNotes, safeUrl, sectorName, shortRefDate, sortAnnouncement,
  squarify, tone,
  usableNews, validateSnapshot, weightedChange,
} from './lib.js';
import { createRefresher } from './poll.js';

const LIVE_URL = '/movers/data/latest';
const SAMPLE_URL = '/movers/data/sample.json';
const params = new URLSearchParams(location.search);

const state = {
  data: null,
  load: null,
  view: VIEW_ORDER.includes(params.get('view')) ? params.get('view') : 'hsi',
  sector: null,
  selected: null,
  sort: 'change',
  weight: { hsi: 'market_cap', hk: 'turnover', hstech: 'market_cap' },
  msort: { hsi: { ...DEFAULT_MEMBER_SORT }, hstech: { ...DEFAULT_MEMBER_SORT } },
  expanded: { hsi: false, hstech: false },
};

const $ = (sel) => document.querySelector(sel);
const body = $('#hkm-body');
let lastMapWidth = 0;

// ------------------------------------------------------------------ loading

const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * First load falls back to the labelled demo document. Background refreshes are strict:
 * a failed or invalid fetch rejects, so the page keeps the snapshot it already has.
 */
async function loadData({ strict = false } = {}) {
  let fellBack = false;
  if (params.get('demo') !== '1') {
    try {
      const doc = await fetchJson(LIVE_URL);
      const check = validateSnapshot(doc);
      if (check.ok) return { data: doc, fellBack: false };
      if (strict) throw new Error(`快照格式不正確：${check.errors[0]}`);
    } catch (e) {
      if (strict) throw e;
    }
    if (strict) throw new Error('live data unavailable');
    fellBack = true;
  }
  const sample = await fetchJson(SAMPLE_URL);
  const check = validateSnapshot(sample);
  if (!check.ok) throw new Error(`示範資料格式不正確：${check.errors[0]}`);
  return { data: sample, fellBack };
}

// ---------------------------------------------------------------- fragments

const chg = (pct) => `<span class="num ${tone(pct)}">${arrow(pct)} ${fmtPct(pct)}</span>`;
const heatStyle = (pct, cap) => {
  const c = heatColor(pct, cap);
  return `background:${c.bg};color:${c.fg}`;
};

function newsHtml(code) {
  const item = usableNews(state.data.news?.[code], newsReference(state.data));
  if (!item) return `<span class="news news-empty">${NEWS_EMPTY_TEXT}</span>`;
  const meta = [item.source, item.published_at_hkt, item.sameDay ? '今日' : ''].filter(Boolean).map(esc).join(' · ');
  return `<a class="news" href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer"><span class="news-t">${esc(item.title)}</span><span class="news-m">${meta} <span aria-hidden="true">↗</span><span class="sr-only">（在新分頁開啟原文）</span></span></a>`;
}

function statHtml(label, value, sub, cls = '') {
  return `<div class="hkm-stat"><div class="k">${esc(label)}</div><div class="v num ${cls}">${value}</div><div class="s">${sub}</div></div>`;
}

function breadthHtml(b) {
  return `<span class="hkm-bt" aria-label="上升 ${b.up}、下跌 ${b.down}、平盤 ${b.flat}"><span class="up" aria-hidden="true">${b.up}</span> / <span class="down" aria-hidden="true">${b.down}</span> / <span class="flat" aria-hidden="true">${b.flat}</span></span>`;
}

/** Advance / flat / decline stacked bar, same look as the morning report's market breadth. Safe for a zero total. */
function breadthBarHtml(b, label, unit) {
  const { total, segments, aria } = breadthSegments(b);
  const bar = total
    ? segments.filter((x) => x.count > 0)
      .map((x) => `<span class="${x.key}" style="flex-grow:${x.count};background:${BREADTH_COLORS[x.key]}">${x.count}</span>`).join('')
    : '<span class="empty">暫無資料</span>';
  const legend = segments
    .map((x) => `<li style="color:${BREADTH_COLORS[x.key]}"><i style="background:${BREADTH_COLORS[x.key]}" aria-hidden="true"></i>${x.label} <b class="num">${x.count}</b> ${unit}${total ? ` <span class="pct num">（${x.pct.toFixed(1)}%）</span>` : ''}</li>`)
    .join('');
  return `<section class="hkm-sb" aria-label="${esc(label)}">
    <div class="hkm-sb-l"><span class="nm">${esc(label)}</span><span class="tot num">共 ${total} ${unit}</span></div>
    <div class="hkm-sb-bar" role="img" aria-label="${esc(`${label}：${aria}`)}">${bar}</div>
    <ul class="hkm-sb-leg">${legend}</ul>
  </section>`;
}

function seg(group, options, current, label) {
  return `<div class="seg" role="group" aria-label="${esc(label)}">${options
    .map((o) => `<button type="button" data-${group}="${esc(o.id)}" data-fk="${group}-${esc(o.id)}" aria-pressed="${o.id === current}">${esc(o.label)}</button>`)
    .join('')}</div>`;
}

function stockRows(rows, { showImpact = true } = {}) {
  return rows
    .map((r, i) => `<tr class="hkm-row${tone(r.change_pct) === 'up' ? ' is-up' : ' is-down'}">
      <td class="c-rank num">${i + 1}</td>
      <td class="c-stock"><b>${esc(r.name)}</b><span class="code num">${esc(r.code)}</span><span class="ind">${esc(r.industry || '')}</span></td>
      <td class="r num c-last" data-l="現價">${fmtPrice(r.last)}</td>
      <td class="r c-chg" data-l="漲跌幅">${chg(r.change_pct)}</td>
      <td class="r num c-to" data-l="成交額">${fmtHkd(r.turnover_hkd)}</td>
      <td class="r num c-cap" data-l="總市值">${fmtHkd(r.market_cap_hkd)}</td>
      ${showImpact ? `<td class="r num c-imp ${tone(r.change_pct)}" data-l="近似影響度">${fmtHkd(impactOf(r), { sign: true })}</td>` : ''}
    </tr>
    <tr class="hkm-news-row"><td colspan="7">${newsHtml(r.code)}</td></tr>`)
    .join('');
}

function listHtml(sum, rows, id) {
  const table = rows.length
    ? `<div class="table-wrap"><table class="hkm-table" aria-labelledby="${id}"><thead><tr>
        <th class="c-rank">#</th><th>股票</th><th class="r">現價</th><th class="r">漲跌幅</th><th class="r">成交額</th><th class="r">總市值</th>
        <th class="r" title="${esc(IMPACT_LABEL)}">近似影響度<small>漲跌幅 × 總市值</small></th>
      </tr></thead><tbody>${stockRows(rows)}</tbody></table></div>`
    : `<div class="hkm-empty"><b>沒有符合條件的${sum.dir === 'up' ? '升幅' : '跌幅'}股</b>${state.sector ? '清除板塊篩選後再試。' : '待下一次快照更新後再看。'}</div>`;
  const count = sum.countLabel || `${rows.length} 隻`;
  const note = sum.reason ? `<p class="hkm-note${sum.short ? ' is-short' : ''}" role="note">${esc(sum.reason)}</p>` : '';
  return `<section class="hkm-list" data-dir="${sum.dir}"><h3 class="hkm-list-h is-${sum.dir}" id="${id}"><span class="t">${esc(sum.title)}</span><span class="n num">${esc(count)}</span></h3>${note}${table}</section>`;
}

function moversHtml(rows, scopeNote, universeLabel) {
  const sector = state.sector ? sectorName(state.data, state.sector) : null;
  const up = rankStocks(rows, { dir: 'up', sort: state.sort, sector: state.sector });
  const down = rankStocks(rows, { dir: 'down', sort: state.sort, sector: state.sector });
  const summary = (dir) => rankSummary(rows, { dir, sector: state.sector, sectorLabel: sector || '', universeLabel });
  const scope = sector ? `${esc(sector)}` : '全部板塊';
  return `<section class="hkm-movers" aria-labelledby="hkm-movers-h">
    <div class="sh"><h2 id="hkm-movers-h">升幅榜與跌幅榜</h2><span class="aux">${esc(scopeNote)}</span></div>
    <div class="hkm-toolbar">
      <div class="field"><span class="field-label">排序</span>${seg('sort', SORTS, state.sort, '榜單排序')}</div>
      <div class="field"><span class="field-label">板塊篩選</span>
        <span class="hkm-scope">${scope}${sector ? ' <button type="button" class="btn btn-sm btn-ghost" data-clear-sector data-fk="clear-sector">清除篩選</button>' : ''}</span>
      </div>
    </div>
    ${listHtml(summary('up'), up, 'hkm-up-h')}
    ${listHtml(summary('down'), down, 'hkm-down-h')}
  </section>`;
}

const legendHtml = (cap) => `<div class="hkm-legend" aria-hidden="true">
  <span>跌</span><i style="background:${heatColor(-cap, cap).bg}"></i><i style="background:${heatColor(-cap / 2, cap).bg}"></i><i style="background:${heatColor(0, cap).bg}"></i><i style="background:${heatColor(cap / 2, cap).bg}"></i><i style="background:${heatColor(cap, cap).bg}"></i><span>升</span>
  <em>顏色：漲跌幅（±${cap}% 為最深）</em></div>`;

// -------------------------------------------------------------- index views

const na = (label = '暫無資料') => `<span class="na" aria-label="${esc(label)}">—</span>`;

function missingViewHtml(key) {
  const view = INDEX_VIEWS[key];
  return `<div class="hkm-empty"><b>${esc(view.name)}的資料尚未提供</b>目前的快照不包含此指數。收集程式更新並寫入新快照後，此視圖會自動出現；其他視圖不受影響。</div>`;
}

function rosterNoteHtml(block, view) {
  const notes = rosterNotes(block.roster, view.name);
  const count = block.members?.length || block.roster?.count || block.constituents.length;
  return `<div class="hkm-criteria hkm-roster" role="note" aria-label="成分股名單與計算範圍">
      <b>計算範圍</b>
      <span class="hkm-tag">官方成分股 ${count} 隻</span>
      <span class="hkm-tag">不套用成交額／市值篩選</span>
      <span class="hkm-hint">${esc(notes.basis)}成分股一律全部計入，沒有報價的成員在下方表內顯示為「暫無報價」。</span>
      ${notes.upcoming ? `<p class="hkm-upcoming"><span class="hkm-pill">已公佈 · 未生效</span><span>${esc(notes.upcoming)}</span></p>` : ''}
    </div>`;
}

function memberCell(m, col) {
  const v = col.get(m);
  if (col.id === 'weight' && isNum(v)) return fmtPct(v, 2, { sign: false });
  if (m.available === false || !isNum(v)) return na(m.available === false ? '暫無報價' : '暫無資料');
  if (col.id === 'last') return fmtPrice(v);
  if (col.id === 'cap') return fmtHkd(v);
  return chg(v);
}

function sortHead(col, sort, refs) {
  const refLine = {
    d5: refs.d5, m1: refs.m1, ytd: refs.ytd,
  };
  let sub = '';
  if (col.id in refLine) {
    sub = !refs.available ? '未提供' : refLine[col.id] ? `對比 ${shortRefDate(refLine[col.id], refs.asOf)}` : '無資料';
    sub = `<small>${esc(sub)}</small>`;
  } else if (col.id === 'd1') sub = '<small>對比前收</small>';
  const on = sort.key === col.id;
  const mark = on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  const hint = on ? `目前由${sort.dir === 'asc' ? '低至高' : '高至低'}，再按一次反轉` : '按此排序';
  return `<th scope="col" class="r" aria-sort="${ariaSort(sort, col.id)}"><button type="button" class="hkm-sortbtn${on ? ' is-on' : ''}" data-msort="${col.id}" data-fk="msort-${col.id}" title="${esc(`${col.label}：${hint}`)}"><span class="lbl">${esc(col.label)}${col.unit ? ` ${esc(col.unit)}` : ''}</span>${sub}<span class="arr" aria-hidden="true">${mark}</span></button></th>`;
}

function membersToggleHtml(key, win, labels, where) {
  if (!win.collapsible) return '';
  const label = win.expanded ? labels.collapse : labels.expand;
  return `<button type="button" class="btn btn-sm hkm-members-toggle" data-members-toggle data-fk="members-toggle-${where}" aria-expanded="${win.expanded}" aria-controls="hkm-members-panel-${key}">${esc(label)}<span class="arr" aria-hidden="true">${win.expanded ? '▲' : '▼'}</span></button>`;
}

function membersHtml(key) {
  const block = state.data[key];
  const view = INDEX_VIEWS[key];
  const members = block.members;
  if (!Array.isArray(members) || !members.length) {
    return `<section class="hkm-members" aria-labelledby="hkm-members-h"><div class="sh"><h2 id="hkm-members-h">成分股一覽</h2></div>
      <div class="hkm-empty"><b>成分股權重表尚未提供</b>目前的快照沒有官方成分股與權重資料，待收集程式更新後會顯示。</div></section>`;
  }
  const sort = state.msort[key];
  const refs = returnRefs(state.data.returns);
  const stats = memberStats(members);
  const win = membersWindow(members, sort, state.expanded[key]);
  const labels = membersLabels(win, sort);
  const rows = win.rows.map((m) => `<tr class="${m.available === false ? 'is-na' : ''}">
      <th scope="row" class="m-stock"><b>${esc(m.name)}</b><span class="code num">${esc(m.code)}</span>${m.available === false ? '<span class="hkm-tag hkm-tag-na">暫無報價</span>' : ''}</th>
      ${MEMBER_COLUMNS.map((col) => `<td class="r num" data-l="${esc(col.label)}">${memberCell(m, col)}</td>`).join('')}
    </tr>`).join('');
  const head = MEMBER_COLUMNS.map((col) => sortHead(col, sort, refs)).join('');
  const count = `共 ${stats.total} 隻官方成分股 · ${stats.priced} 隻有報價${stats.missing ? ` · ${stats.missing} 隻暫無報價（仍列入表內）` : ''}`;
  return `<section class="hkm-members" aria-labelledby="hkm-members-h">
    <div class="sh"><h2 id="hkm-members-h">成分股一覽</h2><span class="aux hkm-members-count">${esc(labels.aux)}</span></div>
    <p class="hkm-hint hkm-members-hint">${esc(count)} · 不受板塊篩選影響。點擊欄位標題排序：再按一次由高至低／由低至高切換；沒有數據的成分股一律排在最後，同值時維持官方名單順序。</p>
    <p class="hkm-note hkm-members-window" role="note">${esc(labels.note)}</p>
    <div class="hkm-members-bar">${membersToggleHtml(key, win, labels, 'top')}</div>
    <div class="table-wrap hkm-members-wrap" id="hkm-members-panel-${key}" tabindex="0" role="region" aria-label="${esc(view.name)}成分股，${esc(labels.aux)}，可橫向捲動">
      <table class="hkm-table hkm-members-table"><caption class="sr-only">${esc(view.name)}成分股：官方權重、升跌幅、現價與總市值（${esc(labels.aux)}）</caption>
        <thead><tr><th scope="col" class="m-stock">股票</th>${head}</tr></thead>
        <tbody>${rows}</tbody></table>
    </div>
    <div class="hkm-members-bar">${membersToggleHtml(key, win, labels, 'bottom')}</div>
    <p class="hkm-note hkm-refnote" role="note">${esc(refs.note)}</p>
  </section>`;
}

function indexHtml(key) {
  const view = INDEX_VIEWS[key];
  const block = state.data[key];
  if (!block) return missingViewHtml(key);
  const idx = block.index || {};
  const rows = block.constituents;
  const sectors = state.data.macro_sectors
    .map((s) => ({ s, rows: rows.filter((r) => r.sector === s.id) }))
    .filter((g) => g.rows.length);
  const chips = [
    `<button type="button" class="hkm-chip" data-clear-sector data-fk="chip-all" aria-pressed="${state.sector === null}">全部</button>`,
    ...sectors.map(({ s, rows: members }) => {
      const pct = weightedChange(members);
      return `<button type="button" class="hkm-chip" data-sector="${esc(s.id)}" data-fk="chip-${esc(s.id)}" aria-pressed="${state.sector === s.id}"><span class="sw" style="${heatStyle(pct, 2)}"></span>${esc(s.name)}<span class="num ${tone(pct)}">${fmtPct(pct)}</span></button>`;
    }),
  ].join('');
  const stats = block.members ? memberStats(block.members) : null;
  const unpriced = stats && stats.missing ? `（另有 ${stats.missing} 隻暫無報價）` : '';
  const weight = state.weight[key];
  return `
    <section class="hkm-stats" aria-label="${esc(view.name)}概況">
      ${statHtml(view.name, fmtPoints(idx.last), isNum(idx.change_pct) ? `<span class="${tone(idx.change_pct)}">${arrow(idx.change_pct)} ${fmtSigned(idx.change)} (${fmtPct(idx.change_pct)})</span>` : '<span class="flat">指數報價暫無資料</span>', tone(idx.change_pct))}
      ${statHtml('總成交額', fmtHkd(block.turnover_hkd), `${esc(view.members)} ${rows.length} 隻合計`)}
      ${statHtml('更新快照（HKT）', esc(fmtUpdated(state.data.updated_at_hkt).slice(5)), esc(SESSION_LABELS[state.data.market_session] || ''))}
    </section>
    ${breadthBarHtml(block.breadth, `${view.short}成分股 升跌家數`, '隻')}
    ${rosterNoteHtml(block, view)}
    <section class="panel hkm-panel" aria-labelledby="hkm-heat-h">
      <div class="panel-head"><h2 class="panel-title" id="hkm-heat-h">${esc(view.short)}成分股熱力圖</h2>
        <div class="field hkm-inline"><span class="field-label">面積</span>${seg('weight', [{ id: 'market_cap', label: '總市值' }, { id: 'impact', label: '影響度（絕對值）' }], weight, '熱力圖面積')}</div>
      </div>
      <div class="panel-body">
        <p class="panel-sub hkm-hint">按大類板塊分組，面積代表${weight === 'impact' ? '「漲跌幅 × 總市值」的絕對值' : '總市值'}。點擊板塊標題或下方標籤篩選榜單，點擊個股查看詳情。</p>
        <div class="hkm-chips" role="group" aria-label="板塊強弱（按市值加權漲跌幅）">${chips}</div>
        <div class="hkm-map" id="hkm-map" data-kind="index" data-index="${key}" role="group" aria-label="${esc(view.short)}成分股熱力圖"></div>
        ${legendHtml(4)}
      </div>
    </section>
    ${detailHtml(key)}
    ${moversHtml(rows, `${view.members} ${rows.length} 隻${unpriced} · 近似影響度＝漲跌幅 × 總市值，非官方指數貢獻點數`, view.members)}
    ${membersHtml(key)}`;
}

function detailHtml(key) {
  const row = state.selected && state.data[key].constituents.find((r) => r.code === state.selected);
  if (!row) {
    return `<section class="panel hkm-detail"><div class="panel-body"><p class="hkm-hint">尚未選擇個股。點擊熱力圖中的個股，這裡會顯示價格、成交額、市值與最新相關新聞。</p></div></section>`;
  }
  return `<section class="panel hkm-detail" aria-live="polite"><div class="panel-body">
    <div class="hkm-detail-head"><div><h3>${esc(row.name)} <span class="code num">${esc(row.code)}</span></h3>
      <p class="panel-sub">${esc(sectorName(state.data, row.sector))} · ${esc(row.industry || '')}</p></div>
      <button type="button" class="btn btn-sm btn-ghost" data-clear-stock data-fk="clear-stock">關閉</button></div>
    <dl class="hkm-dl">
      <div><dt>現價</dt><dd class="num">${fmtPrice(row.last)}</dd></div>
      <div><dt>漲跌幅</dt><dd>${chg(row.change_pct)}</dd></div>
      <div><dt>成交額</dt><dd class="num">${fmtHkd(row.turnover_hkd)}</dd></div>
      <div><dt>總市值</dt><dd class="num">${fmtHkd(row.market_cap_hkd)}</dd></div>
      <div><dt>近似影響度</dt><dd class="num ${tone(row.change_pct)}">${fmtHkd(impactOf(row), { sign: true })}</dd></div>
    </dl>
    ${newsHtml(row.code)}
  </div></section>`;
}

// ----------------------------------------------------------------------- HK

function hkHtml() {
  const hk = state.data.hk_market;
  const f = hk.filters;
  const sectors = state.data.macro_sectors;
  const rows = sectorTable(sectors);
  return `
    <section class="hkm-stats" aria-label="港股全市場概況">
      ${statHtml('合資格股票', `${hk.qualified_count.toLocaleString('en-US')}`, `全市場 ${hk.universe_count.toLocaleString('en-US')} 隻`)}
      ${statHtml('合資格成交額', fmtHkd(hk.turnover_hkd), '合資格股票合計')}
      ${statHtml('更新快照（HKT）', esc(fmtUpdated(state.data.updated_at_hkt).slice(5)), esc(SESSION_LABELS[state.data.market_session] || ''))}
    </section>
    ${breadthBarHtml(hk.breadth, '合資格股票 升跌家數', '隻')}
    <div class="hkm-criteria" role="note" aria-label="篩選條件">
      <b>篩選條件</b>
      <span class="hkm-tag">成交額 ≥ ${esc(fmtHkd(f.min_turnover_hkd, { digits: 0 }))}</span>
      <span class="hkm-tag">總市值 &gt; ${esc(fmtHkd(f.min_market_cap_hkd, { digits: 0 }))}</span>
      <span class="hkm-hint">只計流動性與規模達標的股票；榜單與板塊明細同樣套用。</span>
    </div>
    <section class="panel hkm-panel" aria-labelledby="hkm-heat-h">
      <div class="panel-head"><h2 class="panel-title" id="hkm-heat-h">大類板塊熱力圖</h2>
        <div class="field hkm-inline"><span class="field-label">面積</span>${seg('weight', [{ id: 'turnover', label: '成交額' }, { id: 'market_cap', label: '總市值' }], state.weight.hk, '熱力圖面積')}</div>
      </div>
      <div class="panel-body">
        <p class="panel-sub hkm-hint">${sectors.length} 個大類板塊，由約 113 個細分行業彙整。面積代表${state.weight.hk === 'market_cap' ? '總市值' : '成交額'}，顏色代表市值加權漲跌幅。點擊板塊可篩選榜單並展開細分行業。</p>
        <div class="hkm-map" id="hkm-map" data-kind="sector" role="group" aria-label="大類板塊熱力圖"></div>
        ${legendHtml(3)}
      </div>
    </section>
    <section class="hkm-sectors" aria-labelledby="hkm-sectors-h">
      <div class="sh"><h2 id="hkm-sectors-h">板塊明細</h2><span class="aux">按成交額排序 · 點擊板塊名稱篩選</span></div>
      <div class="table-wrap"><table class="hkm-table hkm-sector-table"><thead><tr>
        <th>板塊</th><th class="r">漲跌幅</th><th class="r">成交額</th><th class="r">總市值</th><th class="r">升／跌／平</th><th>領漲股</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    </section>
    ${sectorDetailHtml()}
    ${moversHtml(hk.stocks, `成交額 ≥ ${fmtHkd(f.min_turnover_hkd, { digits: 0 })} 且 總市值 > ${fmtHkd(f.min_market_cap_hkd, { digits: 0 })} · 合資格 ${hk.qualified_count.toLocaleString('en-US')} 隻`, '合資格股票')}`;
}

function sectorTable(sectors) {
  return [...sectors]
    .sort((a, b) => b.turnover_hkd - a.turnover_hkd)
    .map((s) => `<tr class="${state.sector === s.id ? 'is-selected' : ''}">
      <td class="c-sector" data-l="板塊"><button type="button" class="hkm-link" data-sector="${esc(s.id)}" data-fk="row-${esc(s.id)}" aria-pressed="${state.sector === s.id}">${esc(s.name)}</button></td>
      <td class="r c-chg" data-l="漲跌幅">${chg(s.change_pct)}</td>
      <td class="r num" data-l="成交額">${fmtHkd(s.turnover_hkd)}</td>
      <td class="r num" data-l="總市值">${fmtHkd(s.market_cap_hkd)}</td>
      <td class="r num" data-l="升／跌／平">${breadthHtml(s)}</td>
      <td class="c-leader" data-l="領漲股">${s.leader ? `<b>${esc(s.leader.name)}</b> <span class="num ${tone(s.leader.change_pct)}">${fmtPct(s.leader.change_pct)}</span>` : '—'}</td>
    </tr>`)
    .join('');
}

function sectorDetailHtml() {
  const s = state.sector && state.data.macro_sectors.find((x) => x.id === state.sector);
  if (!s) {
    return `<section class="panel hkm-detail"><div class="panel-body"><p class="hkm-hint">尚未選擇板塊。點擊熱力圖或板塊明細中的板塊，這裡會展開細分行業與代表個股。</p></div></section>`;
  }
  const industries = [...s.industries].sort((a, b) => b.turnover_hkd - a.turnover_hkd);
  const rows = industries
    .map((i) => `<tr>
      <td class="c-sector" data-l="細分行業"><b>${esc(i.name)}</b></td>
      <td class="r c-chg" data-l="漲跌幅">${chg(i.change_pct)}</td>
      <td class="r num" data-l="成交額">${fmtHkd(i.turnover_hkd)}</td>
      <td class="r num" data-l="升／跌／平">${breadthHtml(i)}</td>
      <td class="c-leader" data-l="代表個股">${i.leaders?.length
        ? i.leaders.map((l) => `<span class="hkm-tag">${esc(l.name)} <span class="num ${tone(l.change_pct)}">${fmtPct(l.change_pct)}</span></span>`).join(' ')
        : '<span class="hkm-hint">—</span>'}</td>
    </tr>`)
    .join('');
  return `<section class="panel hkm-detail" aria-live="polite"><div class="panel-body">
    <div class="hkm-detail-head"><div><h3>${esc(s.name)} · 細分行業</h3>
      <p class="panel-sub">共 ${industries.length} 個細分行業 · 成交額 ${esc(fmtHkd(s.turnover_hkd))} · ${chg(s.change_pct)}</p></div>
      <button type="button" class="btn btn-sm btn-ghost" data-clear-sector data-fk="clear-sector-detail">清除篩選</button></div>
    <div class="table-wrap"><table class="hkm-table hkm-sector-table"><thead><tr>
      <th>細分行業</th><th class="r">漲跌幅</th><th class="r">成交額</th><th class="r">升／跌／平</th><th>代表個股</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
  </div></section>`;
}

// ------------------------------------------------------------------- heatmap

const px = (n) => `${Math.round(n * 10) / 10}px`;
const boxStyle = (b, inset = 0) => `left:${px(b.x + inset)};top:${px(b.y + inset)};width:${px(Math.max(b.w - inset * 2, 0))};height:${px(Math.max(b.h - inset * 2, 0))}`;

function drawIndexMap(el, key) {
  const W = el.clientWidth;
  const H = W < 560 ? 480 : W < 900 ? 500 : 540;
  el.style.height = `${H}px`;
  const rows = state.data[key].constituents;
  const weightOf = state.weight[key] === 'impact' ? (r) => Math.abs(impactOf(r)) : (r) => r.market_cap_hkd;
  const floor = rows.length ? Math.max(...rows.map(weightOf)) * 0.004 : 0;
  const groups = state.data.macro_sectors
    .map((s) => {
      const members = rows.filter((r) => r.sector === s.id);
      const items = members.map((r) => ({ key: r.code, value: Math.max(weightOf(r), floor) }));
      return { id: s.id, name: s.name, members, items, value: items.reduce((t, i) => t + i.value, 0) };
    })
    .filter((g) => g.members.length);
  const byRow = new Map(rows.map((r) => [r.code, r]));
  const layout = layoutGroups(groups, W, H);
  const html = layout.map((g) => {
    const meta = groups.find((x) => x.id === g.id);
    const dim = state.sector && state.sector !== g.id ? ' is-dim' : '';
    const pct = weightedChange(meta.members);
    const label = g.label
      ? `<button type="button" class="hm-gl${dim}" data-sector="${esc(g.id)}" data-fk="gl-${esc(g.id)}" style="left:${px(g.box.x + 2)};top:${px(g.box.y + 2)};width:${px(g.box.w - 4)}" title="${esc(meta.name)} ${esc(fmtPct(pct))}"><span>${esc(meta.name)}</span> <span class="num">${fmtPct(pct)}</span></button>`
      : '';
    const tiles = g.tiles.map((t) => {
      const r = byRow.get(t.key);
      const big = t.w >= 54 && t.h >= 36;
      const wide = t.w >= 92 && t.h >= 52;
      const text = big
        ? `<span class="c num">${esc(r.code)}</span>${wide ? `<span class="n">${esc(r.name)}</span>` : ''}<span class="p num">${fmtPct(r.change_pct, 1)}</span>`
        : '';
      const sel = state.selected === r.code ? ' is-selected' : '';
      return `<button type="button" class="hm-tile${dim}${sel}" data-code="${esc(r.code)}" data-fk="tile-${esc(r.code)}" style="${boxStyle(t, 0.75)};${heatStyle(r.change_pct, 4)}" aria-pressed="${state.selected === r.code}" aria-label="${esc(`${r.name} ${r.code} ${fmtPct(r.change_pct)}，成交額 ${fmtHkd(r.turnover_hkd)}`)}" title="${esc(`${r.name} ${r.code}  ${fmtPct(r.change_pct)}`)}">${text}</button>`;
    }).join('');
    return `<div class="hm-group${dim}" style="${boxStyle(g.box)}"></div>${label}${tiles}`;
  }).join('');
  el.innerHTML = html;
}

function drawSectorMap(el) {
  const W = el.clientWidth;
  const H = W < 560 ? 420 : 400;
  el.style.height = `${H}px`;
  const key = state.weight.hk === 'market_cap' ? 'market_cap_hkd' : 'turnover_hkd';
  const sectors = state.data.macro_sectors;
  const boxes = squarify(sectors.map((s) => ({ key: s.id, value: Math.max(s[key], 1) })), 0, 0, W, H);
  const byId = new Map(sectors.map((s) => [s.id, s]));
  el.innerHTML = boxes.map((b) => {
    const s = byId.get(b.key);
    const dim = state.sector && state.sector !== s.id ? ' is-dim' : '';
    const sel = state.sector === s.id ? ' is-selected' : '';
    const lines = [`<span class="n">${esc(s.name)}</span>`];
    if (b.h >= 38 && b.w >= 62) lines.push(`<span class="p num">${fmtPct(s.change_pct)}</span>`);
    if (b.h >= 74 && b.w >= 96) lines.push(`<span class="b">升 ${s.up} · 跌 ${s.down}</span>`);
    if (b.h >= 100 && b.w >= 120 && s.leader) lines.push(`<span class="l">領漲 ${esc(s.leader.name)} ${fmtPct(s.leader.change_pct, 1)}</span>`);
    return `<button type="button" class="hm-tile hm-sector${b.w < 100 || b.h < 70 ? ' compact' : ''}${b.w < 80 ? ' tiny' : ''}${dim}${sel}" data-sector="${esc(s.id)}" data-fk="tile-${esc(s.id)}" style="${boxStyle(b, 1)};${heatStyle(s.change_pct, 3)}" aria-pressed="${state.sector === s.id}" aria-label="${esc(`${s.name} ${fmtPct(s.change_pct)}，升 ${s.up} 跌 ${s.down}`)}" title="${esc(`${s.name} ${fmtPct(s.change_pct)}`)}">${b.w >= 56 && b.h >= 22 ? lines.join('') : ''}</button>`;
  }).join('');
}

function drawMap() {
  const el = $('#hkm-map');
  if (!el || !state.data) return;
  if (!el.clientWidth) return;
  lastMapWidth = el.clientWidth;
  if (el.dataset.kind === 'index') drawIndexMap(el, el.dataset.index);
  else drawSectorMap(el);
}

// -------------------------------------------------------------------- render

const refreshState = () => refresher?.status() ?? { fails: 0, inFlight: false, lastCheckedAt: 0 };
const clock = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 19);

function noticesHtml(now) {
  const out = [];
  const d = state.data;
  const rs = refreshState();
  if (d.data_source === 'demo') {
    const why = state.load.fellBack
      ? '即時資料暫時無法取得，目前改為顯示示範資料。'
      : '尚未接入即時資料，目前顯示示範資料供預覽。';
    out.push(`<div class="notice notice-warn" role="status"><span class="badge badge-sample">示範數據</span><span>${esc(why)}${esc(d.notice || '價格、成交額、市值與新聞標題均為模擬，並非即時報價。')}</span></div>`);
  }
  const retry = `<button type="button" class="btn btn-sm" data-refresh${rs.inFlight ? ' disabled' : ''}>${rs.inFlight ? '更新中…' : '立即重試'}</button>`;
  if (d.data_source === 'live' && rs.fails > 0) {
    out.push(`<div class="notice notice-error hkm-alert" role="status"><span class="badge badge-stale">更新失敗</span><span>無法取得最新快照（已連續失敗 ${rs.fails} 次，最近一次嘗試 ${esc(clock(rs.lastAttemptAt))} HKT）。畫面仍是 <b>${esc(fmtUpdated(d.updated_at_hkt))}（HKT）</b>的舊快照，並非最新資料；系統會自動重試。</span>${retry}</div>`);
  }
  if (isStale(d, now)) {
    const age = ageMinutes(d.updated_at_hkt, now);
    out.push(`<div class="notice notice-warn hkm-alert" role="status"><span class="badge badge-stale">快照過時</span><span>最新快照時間為 ${esc(fmtUpdated(d.updated_at_hkt))}（HKT），距今 ${esc(fmtAge(age))}，超過預期的更新間隔。目前顯示的並非最新資料。</span>${rs.fails > 0 ? '' : retry}</div>`);
  }
  return out.join('');
}

let lastNotice = '';
let lastUpdated = '';

/** Header line and notices. Cheap and idempotent, so the interval can call it to age the stale state. */
function renderStatus() {
  if (!state.data) return;
  const now = new Date();
  const d = state.data;
  const rs = refreshState();
  const stale = isStale(d, now);
  const failing = d.data_source === 'live' && rs.fails > 0;
  const checked = rs.lastCheckedAt ? ` · 上次檢查 <span class="num">${esc(clock(rs.lastCheckedAt))}</span>` : '';
  const html = `快照更新：<span class="num">${esc(fmtUpdated(d.updated_at_hkt))}</span>（HKT） · ${esc(SESSION_LABELS[d.market_session] || '')}${d.data_source === 'demo' ? ' <span class="badge badge-sample">示範數據</span>' : ''}${stale ? ' <span class="badge badge-stale">資料已過時</span>' : failing ? ' <span class="badge badge-stale">更新失敗</span>' : ''}${checked}`;
  if (html !== lastUpdated) {
    $('#hkm-updated').innerHTML = html;
    lastUpdated = html;
  }
  const notice = noticesHtml(now);
  if (notice !== lastNotice) {
    $('#hkm-notice').innerHTML = notice;
    lastNotice = notice;
  }
  const btn = $('#hkm-refresh');
  if (btn) {
    btn.disabled = rs.inFlight;
    btn.textContent = rs.inFlight ? '更新中…' : '立即更新';
  }
}

/** Tab sub-labels follow the roster in force, so the count changes by itself once a new roster takes effect. */
function syncTabs() {
  for (const key of Object.keys(INDEX_VIEWS)) {
    const count = state.data[key]?.members?.length || state.data[key]?.roster?.count;
    const small = document.querySelector(`#tab-${key} small`);
    if (small && count) small.textContent = `${count} 隻成分股`;
  }
}

function render() {
  const active = document.activeElement?.dataset?.fk;
  for (const tab of document.querySelectorAll('[data-view]')) {
    const on = tab.dataset.view === state.view;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  body.setAttribute('aria-labelledby', `tab-${state.view}`);
  if (state.data) {
    renderStatus();
    syncTabs();
    body.innerHTML = state.view === 'hk' ? hkHtml() : indexHtml(state.view);
    drawMap();
    if (active) document.querySelector(`[data-fk="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
  }
}

function renderError(message) {
  $('#hkm-updated').textContent = '資料無法載入';
  $('#hkm-notice').innerHTML = '';
  lastNotice = '';
  lastUpdated = '';
  body.innerHTML = `<div class="hkm-empty hkm-error" role="alert"><b>暫時無法載入港股異動資料</b>${esc(message)}<br><button type="button" class="btn btn-sm" data-retry>重新載入</button></div>`;
}

function setView(view) {
  if (view === state.view) return;
  state.view = view;
  state.sector = null;
  state.selected = null;
  const url = new URL(location.href);
  if (view === 'hsi') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  history.replaceState(null, '', url);
  render();
}

// ------------------------------------------------------------------- refresh

/** A newer snapshot arrived. The view, sector, stock, sort and weight choices stay; only the data changes. */
function applyData(doc, { changed, meta }) {
  const wasFallback = state.load?.fellBack;
  state.load = { fellBack: Boolean(meta?.fellBack), data: doc };
  if (!changed && wasFallback === state.load.fellBack) return;
  const keep = reconcileSelection(state, doc, state.view);
  state.data = doc;
  state.sector = keep.sector;
  state.selected = keep.selected;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

const polling = params.get('demo') !== '1';
const refresher = polling
  ? createRefresher({
    load: () => loadData({ strict: true }),
    getCurrent: () => state.data,
    onData: applyData,
    onStatus: () => renderStatus(),
  })
  : null;

let starting = false;
let startFailedAt = 0;

async function start() {
  if (starting) return;
  starting = true;
  if (!state.data) body.innerHTML = '<p class="hkm-loading">資料載入中…</p>';
  try {
    state.load = await loadData();
    state.data = state.load.data;
    startFailedAt = 0;
    refresher?.seed();
    render();
  } catch (e) {
    startFailedAt = Date.now();
    renderError('請稍後再試，或重新整理此頁。');
    console.warn('movers:', e);
  } finally {
    starting = false;
  }
}

function pageTick() {
  if (document.hidden) return;
  if (!state.data) {
    if (!starting && startFailedAt && Date.now() - startFailedAt >= 30_000) start();
    return;
  }
  refresher?.tick({ visible: true });
  renderStatus();
}

function pageRecover() {
  if (document.hidden) return;
  if (!state.data) {
    if (!starting) start();
    return;
  }
  refresher?.recover({ visible: true });
  renderStatus();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-refresh]');
  if (!t) return;
  if (!refresher) return;
  refresher.refresh();
  renderStatus();
});

body.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.retry !== undefined) return void start();
  if (t.dataset.msort && isIndexView(state.view)) {
    state.msort[state.view] = nextSort(state.msort[state.view], t.dataset.msort);
    render();
    const block = state.data[state.view];
    $('#hkm-live').textContent = sortAnnouncement(state.msort[state.view], membersWindow(block.members, state.msort[state.view], state.expanded[state.view]));
    return;
  }
  if (t.dataset.membersToggle !== undefined && isIndexView(state.view)) {
    const key = state.view;
    state.expanded[key] = !state.expanded[key];
    render();
    const win = membersWindow(state.data[key].members, state.msort[key], state.expanded[key]);
    const labels = membersLabels(win, state.msort[key]);
    $('#hkm-live').textContent = state.expanded[key] ? labels.announceExpand : labels.announceCollapse;
    if (!state.expanded[key]) document.querySelector(`[data-fk="${CSS.escape(t.dataset.fk)}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (t.dataset.weight) state.weight[state.view] = t.dataset.weight;
  else if (t.dataset.sort) state.sort = t.dataset.sort;
  else if (t.dataset.sector) state.sector = state.sector === t.dataset.sector ? null : t.dataset.sector;
  else if (t.dataset.clearSector !== undefined) state.sector = null;
  else if (t.dataset.code) state.selected = state.selected === t.dataset.code ? null : t.dataset.code;
  else if (t.dataset.clearStock !== undefined) state.selected = null;
  else return;
  render();
});

const tabs = document.querySelector('.hkm-switch');
tabs.addEventListener('click', (e) => {
  const t = e.target.closest('[data-view]');
  if (t) setView(t.dataset.view);
});
tabs.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const at = VIEW_ORDER.indexOf(state.view);
  const next = VIEW_ORDER[(at + (e.key === 'ArrowRight' ? 1 : VIEW_ORDER.length - 1)) % VIEW_ORDER.length];
  setView(next);
  document.getElementById(`tab-${next}`).focus();
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const el = $('#hkm-map');
    if (el && el.clientWidth !== lastMapWidth) drawMap();
  }, 120);
});

const TICK_MS = 15_000;
setInterval(pageTick, TICK_MS);
document.addEventListener('visibilitychange', pageRecover);
window.addEventListener('focus', pageRecover);
window.addEventListener('online', pageRecover);
window.addEventListener('pageshow', (e) => { if (e.persisted) pageRecover(); });

start();
