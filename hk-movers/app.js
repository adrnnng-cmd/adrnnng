import {
  IMPACT_LABEL, SESSION_LABELS, SORTS,
  arrow, breadth, esc, fmtHkd, fmtPct, fmtPoints, fmtPrice, fmtSigned, fmtUpdated,
  heatColor, impactOf, isStale, layoutGroups, rankStocks, safeUrl, sectorName, squarify,
  tone, validateSnapshot, weightedChange,
} from './lib.js';

const LIVE_URL = '/hk-movers/data/latest';
const SAMPLE_URL = '/hk-movers/data/sample.json';
const params = new URLSearchParams(location.search);

const state = {
  data: null,
  load: null,
  view: params.get('view') === 'hk' ? 'hk' : 'hsi',
  sector: null,
  selected: null,
  sort: 'change',
  weight: { hsi: 'market_cap', hk: 'turnover' },
};

const $ = (sel) => document.querySelector(sel);
const body = $('#hkm-body');
let lastMapWidth = 0;

// ------------------------------------------------------------------ loading

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadData() {
  let fellBack = false;
  if (params.get('demo') !== '1') {
    try {
      const doc = await fetchJson(LIVE_URL);
      if (validateSnapshot(doc).ok) return { data: doc, fellBack: false };
    } catch {
      /* use the demo document below */
    }
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
  const item = state.data.news?.[code];
  const href = item ? safeUrl(item.url) : '';
  if (!item || !item.title || !href) return '<span class="news news-empty">暫無相關新聞</span>';
  const meta = [item.source, item.published_at_hkt].filter(Boolean).map(esc).join(' · ');
  return `<a class="news" href="${esc(href)}" target="_blank" rel="noopener noreferrer"><span class="news-t">${esc(item.title)}</span><span class="news-m">${meta} <span aria-hidden="true">↗</span><span class="sr-only">（在新分頁開啟原文）</span></span></a>`;
}

function statHtml(label, value, sub, cls = '') {
  return `<div class="hkm-stat"><div class="k">${esc(label)}</div><div class="v num ${cls}">${value}</div><div class="s">${sub}</div></div>`;
}

function breadthHtml(b) {
  return `<span class="up">${b.up}</span> / <span class="down">${b.down}</span> / <span class="flat">${b.flat}</span>`;
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

function listHtml(title, rows, emptyText, id) {
  const table = rows.length
    ? `<div class="table-wrap"><table class="hkm-table" aria-labelledby="${id}"><thead><tr>
        <th class="c-rank">#</th><th>股票</th><th class="r">現價</th><th class="r">漲跌幅</th><th class="r">成交額</th><th class="r">總市值</th>
        <th class="r" title="${esc(IMPACT_LABEL)}">近似影響度<small>漲跌幅 × 總市值</small></th>
      </tr></thead><tbody>${stockRows(rows)}</tbody></table></div>`
    : `<div class="hkm-empty"><b>${esc(emptyText)}</b>調整排序或清除板塊篩選後再試。</div>`;
  return `<section class="hkm-list"><h3 id="${id}">${esc(title)}<span class="n num">${rows.length} 隻</span></h3>${table}</section>`;
}

function moversHtml(rows, scopeNote) {
  const sector = state.sector ? sectorName(state.data, state.sector) : null;
  const up = rankStocks(rows, { dir: 'up', sort: state.sort, sector: state.sector });
  const down = rankStocks(rows, { dir: 'down', sort: state.sort, sector: state.sector });
  const scope = sector ? `${esc(sector)}` : '全部板塊';
  return `<section class="hkm-movers" aria-labelledby="hkm-movers-h">
    <div class="sh"><h2 id="hkm-movers-h">升幅榜與跌幅榜</h2><span class="aux">${esc(scopeNote)}</span></div>
    <div class="hkm-toolbar">
      <div class="field"><span class="field-label">排序</span>${seg('sort', SORTS, state.sort, '榜單排序')}</div>
      <div class="field"><span class="field-label">板塊篩選</span>
        <span class="hkm-scope">${scope}${sector ? ' <button type="button" class="btn btn-sm btn-ghost" data-clear-sector data-fk="clear-sector">清除篩選</button>' : ''}</span>
      </div>
    </div>
    ${listHtml('升幅榜 Top 10', up, '沒有符合條件的升幅股', 'hkm-up-h')}
    ${listHtml('跌幅榜 Top 10', down, '沒有符合條件的跌幅股', 'hkm-down-h')}
  </section>`;
}

const legendHtml = (cap) => `<div class="hkm-legend" aria-hidden="true">
  <span>跌</span><i style="background:${heatColor(-cap, cap).bg}"></i><i style="background:${heatColor(-cap / 2, cap).bg}"></i><i style="background:${heatColor(0, cap).bg}"></i><i style="background:${heatColor(cap / 2, cap).bg}"></i><i style="background:${heatColor(cap, cap).bg}"></i><span>升</span>
  <em>顏色：漲跌幅（±${cap}% 為最深）</em></div>`;

// ---------------------------------------------------------------------- HSI

function hsiHtml() {
  const { hsi } = state.data;
  const idx = hsi.index;
  const rows = hsi.constituents;
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
  const detail = detailHtml();
  return `
    <section class="hkm-stats" aria-label="恒生指數概況">
      ${statHtml('恒生指數', fmtPoints(idx.last), `<span class="${tone(idx.change_pct)}">${arrow(idx.change_pct)} ${fmtSigned(idx.change)} (${fmtPct(idx.change_pct)})</span>`, tone(idx.change_pct))}
      ${statHtml('升／跌／平 家數', breadthHtml(hsi.breadth), `成分股 ${rows.length} 隻`)}
      ${statHtml('總成交額', fmtHkd(hsi.turnover_hkd), '恒指成分股合計')}
      ${statHtml('更新時間（HKT）', esc(fmtUpdated(state.data.updated_at_hkt).slice(5)), esc(SESSION_LABELS[state.data.market_session] || ''))}
    </section>
    <section class="panel hkm-panel" aria-labelledby="hkm-heat-h">
      <div class="panel-head"><h2 class="panel-title" id="hkm-heat-h">恒指成分股熱力圖</h2>
        <div class="field hkm-inline"><span class="field-label">面積</span>${seg('weight', [{ id: 'market_cap', label: '總市值' }, { id: 'impact', label: '影響度（絕對值）' }], state.weight.hsi, '熱力圖面積')}</div>
      </div>
      <div class="panel-body">
        <p class="panel-sub hkm-hint">按大類板塊分組，面積代表${state.weight.hsi === 'impact' ? '「漲跌幅 × 總市值」的絕對值' : '總市值'}。點擊板塊標題或下方標籤篩選榜單，點擊個股查看詳情。</p>
        <div class="hkm-chips" role="group" aria-label="板塊強弱（按市值加權漲跌幅）">${chips}</div>
        <div class="hkm-map" id="hkm-map" data-kind="hsi" role="group" aria-label="恒指成分股熱力圖"></div>
        ${legendHtml(4)}
      </div>
    </section>
    ${detail}
    ${moversHtml(rows, `恒指成分股 ${rows.length} 隻 · 近似影響度＝漲跌幅 × 總市值，非官方指數貢獻點數`)}`;
}

function detailHtml() {
  const row = state.selected && state.data.hsi.constituents.find((r) => r.code === state.selected);
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
      ${statHtml('升／跌／平 家數', breadthHtml(hk.breadth), '合資格股票')}
      ${statHtml('合資格成交額', fmtHkd(hk.turnover_hkd), '合資格股票合計')}
      ${statHtml('更新時間（HKT）', esc(fmtUpdated(state.data.updated_at_hkt).slice(5)), esc(SESSION_LABELS[state.data.market_session] || ''))}
    </section>
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
    ${moversHtml(hk.stocks, `成交額 ≥ ${fmtHkd(f.min_turnover_hkd, { digits: 0 })} 且 總市值 > ${fmtHkd(f.min_market_cap_hkd, { digits: 0 })} · 合資格 ${hk.qualified_count.toLocaleString('en-US')} 隻`)}`;
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

function drawHsiMap(el) {
  const W = el.clientWidth;
  const H = W < 560 ? 480 : W < 900 ? 500 : 540;
  el.style.height = `${H}px`;
  const rows = state.data.hsi.constituents;
  const weightOf = state.weight.hsi === 'impact' ? (r) => Math.abs(impactOf(r)) : (r) => r.market_cap_hkd;
  const floor = Math.max(...rows.map(weightOf)) * 0.004;
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
  if (el.dataset.kind === 'hsi') drawHsiMap(el);
  else drawSectorMap(el);
}

// -------------------------------------------------------------------- render

function noticesHtml() {
  const out = [];
  const d = state.data;
  if (d.data_source === 'demo') {
    const why = state.load.fellBack
      ? '即時資料暫時無法取得，目前改為顯示示範資料。'
      : '尚未接入即時資料，目前顯示示範資料供預覽。';
    out.push(`<div class="notice notice-warn" role="status"><span class="badge badge-sample">示範數據</span><span>${esc(why)}${esc(d.notice || '價格、成交額、市值與新聞標題均為模擬，並非即時報價。')}</span></div>`);
  }
  if (isStale(d)) {
    out.push(`<div class="notice notice-warn" role="status"><span>資料可能已延遲，最後更新時間為 ${esc(fmtUpdated(d.updated_at_hkt))}（HKT）。</span></div>`);
  }
  return out.join('');
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
    const d = state.data;
    $('#hkm-updated').innerHTML = `資料更新：<span class="num">${esc(fmtUpdated(d.updated_at_hkt))}</span>（HKT） · ${esc(SESSION_LABELS[d.market_session] || '')}${d.data_source === 'demo' ? ' <span class="badge badge-sample">示範數據</span>' : ''}`;
    $('#hkm-notice').innerHTML = noticesHtml();
    body.innerHTML = state.view === 'hsi' ? hsiHtml() : hkHtml();
    drawMap();
    if (active) document.querySelector(`[data-fk="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
  }
}

function renderError(message) {
  $('#hkm-updated').textContent = '資料無法載入';
  $('#hkm-notice').innerHTML = '';
  body.innerHTML = `<div class="hkm-empty hkm-error" role="alert"><b>暫時無法載入港股異動資料</b>${esc(message)}<br><button type="button" class="btn btn-sm" data-retry>重新載入</button></div>`;
}

function setView(view) {
  if (view === state.view) return;
  state.view = view;
  state.sector = null;
  state.selected = null;
  const url = new URL(location.href);
  if (view === 'hk') url.searchParams.set('view', 'hk');
  else url.searchParams.delete('view');
  history.replaceState(null, '', url);
  render();
}

async function start() {
  body.innerHTML = '<p class="hkm-loading">資料載入中…</p>';
  try {
    state.load = await loadData();
    state.data = state.load.data;
    render();
  } catch (e) {
    renderError('請稍後再試，或重新整理此頁。');
    console.warn('hk-movers:', e);
  }
}

body.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.retry !== undefined) return void start();
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
  const next = state.view === 'hsi' ? 'hk' : 'hsi';
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

start();
