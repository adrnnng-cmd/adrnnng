// Pure helpers for /hk-movers/: formatting, ranking, validation and treemap layout.
// No DOM access, so node --test can import this file.

export const SCHEMA_VERSION = 1;

export const SESSION_LABELS = {
  pre_open: '開市前時段',
  morning: '上午盤',
  lunch: '午間休市',
  afternoon: '下午盤',
  closing_auction: '收市競價',
  closed: '已收市',
};
const OPEN_SESSIONS = new Set(['pre_open', 'morning', 'afternoon', 'closing_auction']);

export const SORTS = [
  { id: 'change', label: '漲跌幅' },
  { id: 'turnover', label: '成交額' },
  { id: 'market_cap', label: '總市值' },
  { id: 'impact', label: '近似影響度' },
];

export const IMPACT_LABEL = '近似影響度（漲跌幅 × 總市值）';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Only http(s) links are ever rendered as hrefs. */
export function safeUrl(value) {
  try {
    const u = new URL(String(value ?? ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

const group = (n, digits) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function fmtPrice(v) {
  if (!isNum(v)) return '—';
  return group(v, Math.abs(v) < 1 ? 3 : 2);
}

export function fmtPoints(v) {
  return isNum(v) ? group(v, 2) : '—';
}

export function fmtPct(v, digits = 2, { sign = true } = {}) {
  if (!isNum(v)) return '—';
  const text = Math.abs(v).toFixed(digits);
  if (!sign) return `${text}%`;
  if (Number(text) === 0) return `${text}%`;
  return `${v > 0 ? '+' : '-'}${text}%`;
}

export function fmtSigned(v, digits = 2) {
  if (!isNum(v)) return '—';
  const text = group(Math.abs(v), digits);
  if (Number(Math.abs(v).toFixed(digits)) === 0) return text;
  return `${v > 0 ? '+' : '-'}${text}`;
}

/** HK$ amount in Chinese units: 萬億 / 億 / 萬. */
export function fmtHkd(v, { sign = false, digits } = {}) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  let body;
  if (a >= 1e12) body = `${group(a / 1e12, digits ?? 2)} 萬億`;
  else if (a >= 1e8) body = `${group(a / 1e8, digits ?? (a >= 1e11 ? 0 : a >= 1e10 ? 1 : 2))} 億`;
  else if (a >= 1e4) body = `${group(a / 1e4, digits ?? 0)} 萬`;
  else body = group(a, 0);
  const prefix = sign && a > 0 ? (v > 0 ? '+' : '-') : v < 0 ? '-' : '';
  return `${prefix}HK$${body}`;
}

export const isFlat = (pct) => Number(Math.abs(pct).toFixed(2)) === 0;
export const tone = (pct) => (!isNum(pct) || isFlat(pct) ? 'flat' : pct > 0 ? 'up' : 'down');
export const arrow = (pct) => ({ up: '▲', down: '▼', flat: '–' })[tone(pct)];

export function impactOf(row) {
  if (isNum(row.impact_hkd)) return row.impact_hkd;
  return (row.change_pct / 100) * row.market_cap_hkd;
}

export function breadth(rows) {
  let up = 0;
  let down = 0;
  for (const r of rows) {
    const t = tone(r.change_pct);
    if (t === 'up') up++;
    else if (t === 'down') down++;
  }
  return { up, down, flat: rows.length - up - down };
}

export function qualifies(row, filters) {
  return row.turnover_hkd >= filters.min_turnover_hkd && row.market_cap_hkd > filters.min_market_cap_hkd;
}

const SORT_VALUE = {
  change: (r) => r.change_pct,
  turnover: (r) => r.turnover_hkd,
  market_cap: (r) => r.market_cap_hkd,
  impact: (r) => impactOf(r),
};

/**
 * Top list for one direction. Gainers are rows with a positive move, losers a
 * negative one. `change` and `impact` order by distance from zero in that
 * direction; `turnover` and `market_cap` order large to small.
 */
export function rankStocks(rows, { dir = 'up', sort = 'change', limit = 10, sector = null } = {}) {
  const want = dir === 'up' ? 'up' : 'down';
  const value = SORT_VALUE[sort] || SORT_VALUE.change;
  const signed = sort === 'change' || sort === 'impact';
  const pool = rows.filter((r) => tone(r.change_pct) === want && (!sector || r.sector === sector));
  pool.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const primary = signed && want === 'down' ? x - y : y - x;
    return primary || b.turnover_hkd - a.turnover_hkd || a.code.localeCompare(b.code);
  });
  return pool.slice(0, limit);
}

export function sectorName(data, id) {
  return data.macro_sectors.find((s) => s.id === id)?.name ?? '綜合及其他';
}

/** Cap-weighted change of a row set, for the strength chips and group labels. */
export function weightedChange(rows) {
  const cap = rows.reduce((s, r) => s + r.market_cap_hkd, 0);
  if (!cap) return 0;
  return rows.reduce((s, r) => s + r.change_pct * r.market_cap_hkd, 0) / cap;
}

/** Minutes since updated_at_hkt (a Hong Kong wall-clock string). */
export function ageMinutes(updatedAtHkt, now = new Date()) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/.exec(updatedAtHkt || '');
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3] || '00'}+08:00`);
  return Number.isNaN(t) ? null : (now.getTime() - t) / 60000;
}

/** True when a live document should be flagged as late. */
export function isStale(data, now = new Date()) {
  if (!data || data.data_source === 'demo') return false;
  const age = ageMinutes(data.updated_at_hkt, now);
  if (age == null) return false;
  if (OPEN_SESSIONS.has(data.market_session)) return age > 30;
  return age > 4 * 24 * 60;
}

export const fmtUpdated = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '—');

// ---------------------------------------------------------------- validation

const CODE = /^\d{5}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

function checkStock(row, where, errors, sectorIds) {
  if (!row || typeof row !== 'object') return errors.push(`${where}: not an object`);
  if (!CODE.test(row.code || '')) errors.push(`${where}: code must be 5 digits`);
  if (!row.name || typeof row.name !== 'string') errors.push(`${where}: name missing`);
  for (const k of ['last', 'change_pct', 'turnover_hkd', 'market_cap_hkd']) {
    if (!isNum(row[k])) errors.push(`${where}: ${k} must be a number`);
  }
  if (isNum(row.turnover_hkd) && row.turnover_hkd < 0) errors.push(`${where}: turnover_hkd is negative`);
  if (isNum(row.market_cap_hkd) && row.market_cap_hkd < 0) errors.push(`${where}: market_cap_hkd is negative`);
  if (sectorIds && !sectorIds.has(row.sector)) errors.push(`${where}: unknown sector ${row.sector}`);
}

/** Shape check for the document served by /hk-movers/data/latest. */
export function validateSnapshot(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return { ok: false, errors: ['document is not an object'] };
  if (d.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!['live', 'demo'].includes(d.data_source)) errors.push('data_source must be live or demo');
  if (!STAMP.test(d.updated_at_hkt || '')) errors.push('updated_at_hkt must be YYYY-MM-DD HH:MM[:SS]');
  if (!(d.market_session in SESSION_LABELS)) errors.push('market_session is not a known session');

  const sectors = Array.isArray(d.macro_sectors) ? d.macro_sectors : [];
  if (sectors.length < 10 || sectors.length > 12) errors.push('macro_sectors must hold 10 to 12 sectors');
  const sectorIds = new Set(sectors.map((s) => s.id));
  sectors.forEach((s, i) => {
    const w = `macro_sectors[${i}]`;
    if (!s.id || !s.name) errors.push(`${w}: id and name required`);
    for (const k of ['change_pct', 'turnover_hkd', 'market_cap_hkd', 'up', 'down', 'flat']) {
      if (!isNum(s[k])) errors.push(`${w}: ${k} must be a number`);
    }
    if (!Array.isArray(s.industries)) errors.push(`${w}: industries must be an array`);
  });

  const hsi = d.hsi;
  if (!hsi || typeof hsi !== 'object') errors.push('hsi missing');
  else {
    for (const k of ['last', 'prev_close', 'change', 'change_pct']) {
      if (!isNum(hsi.index?.[k])) errors.push(`hsi.index.${k} must be a number`);
    }
    for (const k of ['up', 'down', 'flat']) if (!isNum(hsi.breadth?.[k])) errors.push(`hsi.breadth.${k} must be a number`);
    if (!isNum(hsi.turnover_hkd)) errors.push('hsi.turnover_hkd must be a number');
    if (!Array.isArray(hsi.constituents) || !hsi.constituents.length) errors.push('hsi.constituents must be a non-empty array');
    else hsi.constituents.forEach((r, i) => checkStock(r, `hsi.constituents[${i}]`, errors, sectorIds));
  }

  const hk = d.hk_market;
  if (!hk || typeof hk !== 'object') errors.push('hk_market missing');
  else {
    for (const k of ['min_turnover_hkd', 'min_market_cap_hkd']) {
      if (!isNum(hk.filters?.[k])) errors.push(`hk_market.filters.${k} must be a number`);
    }
    for (const k of ['up', 'down', 'flat']) if (!isNum(hk.breadth?.[k])) errors.push(`hk_market.breadth.${k} must be a number`);
    for (const k of ['turnover_hkd', 'universe_count', 'qualified_count']) {
      if (!isNum(hk[k])) errors.push(`hk_market.${k} must be a number`);
    }
    if (!Array.isArray(hk.stocks)) errors.push('hk_market.stocks must be an array');
    else hk.stocks.forEach((r, i) => checkStock(r, `hk_market.stocks[${i}]`, errors, sectorIds));
  }

  for (const u of ['hsi', 'hk']) {
    for (const side of ['gainers', 'losers']) {
      if (!Array.isArray(d.movers?.[u]?.[side])) errors.push(`movers.${u}.${side} must be an array`);
    }
  }
  if (d.news != null && (typeof d.news !== 'object' || Array.isArray(d.news))) errors.push('news must be an object keyed by code');
  return { ok: errors.length === 0, errors };
}

// ------------------------------------------------------------------- colours

const NEUTRAL = [233, 233, 229];
const UP_STRONG = [11, 138, 62];
const DOWN_STRONG = [200, 22, 40];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Diverging fill for a move. `cap` is the % that reaches full strength. */
export function heatColor(pct, cap = 4) {
  if (!isNum(pct) || isFlat(pct)) return { bg: `rgb(${NEUTRAL.join(',')})`, fg: '#111' };
  const t = Math.min(Math.abs(pct) / cap, 1);
  const rgb = mix(NEUTRAL, pct > 0 ? UP_STRONG : DOWN_STRONG, 0.18 + 0.82 * t);
  return { bg: `rgb(${rgb.join(',')})`, fg: t > 0.38 ? '#fff' : '#111' };
}

// ------------------------------------------------------------------- treemap

/** Squarified treemap (Bruls et al.). items: [{key, value}], returns [{key,x,y,w,h}]. */
export function squarify(items, x, y, w, h) {
  const nodes = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = nodes.reduce((s, n) => s + n.value, 0);
  if (!(total > 0) || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const queue = nodes.map((n) => ({ key: n.key, area: n.value * scale }));
  const out = [];
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;

  const worst = (row, side) => {
    const s = row.reduce((t, n) => t + n.area, 0);
    const max = Math.max(...row.map((n) => n.area));
    const min = Math.min(...row.map((n) => n.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const place = (row) => {
    const s = row.reduce((t, n) => t + n.area, 0);
    if (rw >= rh) {
      const cw = s / rh;
      let cy = ry;
      for (const n of row) {
        const nh = n.area / cw;
        out.push({ key: n.key, x: rx, y: cy, w: cw, h: nh });
        cy += nh;
      }
      rx += cw;
      rw -= cw;
    } else {
      const rowH = s / rw;
      let cx = rx;
      for (const n of row) {
        const nw = n.area / rowH;
        out.push({ key: n.key, x: cx, y: ry, w: nw, h: rowH });
        cx += nw;
      }
      ry += rowH;
      rh -= rowH;
    }
  };

  let row = [];
  let i = 0;
  while (i < queue.length) {
    const side = Math.min(rw, rh);
    const next = queue[i];
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      i++;
    } else {
      place(row);
      row = [];
    }
  }
  if (row.length) place(row);
  return out;
}

/**
 * Two-level treemap in pixels. groups: [{id, value, items:[{key,value}]}].
 * A group shows a label strip when it is big enough to read one.
 */
export function layoutGroups(groups, width, height, { gap = 2, labelH = 18, minLabelW = 70, minLabelH = 46 } = {}) {
  const outer = squarify(groups.map((g) => ({ key: g.id, value: g.value })), 0, 0, width, height);
  const byId = new Map(groups.map((g) => [g.id, g]));
  return outer.map((box) => {
    const g = byId.get(box.key);
    const label = box.w >= minLabelW && box.h >= minLabelH;
    const top = label ? labelH : 0;
    const inner = { x: box.x + gap, y: box.y + gap + top, w: Math.max(box.w - gap * 2, 0), h: Math.max(box.h - gap * 2 - top, 0) };
    return { id: g.id, box, label, tiles: squarify(g.items, inner.x, inner.y, inner.w, inner.h) };
  });
}
