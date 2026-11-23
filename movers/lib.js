// Pure helpers for /movers/: formatting, ranking, validation and treemap layout.
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

/** The two index views. `hk` is the whole-market view and has its own filters. */
export const INDEX_VIEWS = {
  hsi: {
    key: 'hsi', short: '恒指', name: '恒生指數', members: '恒生指數成分股', mapTitle: '恒指板塊熱力圖',
    mapHint: '面積 = 總市值 · 顏色 = 今日漲跌幅',
  },
  hstech: {
    key: 'hstech', short: '恒生科技', name: '恒生科技指數', members: '恒生科技指數成分股', mapTitle: '恒生科技板塊熱力圖',
    mapHint: '面積 = 總市值 · 顏色 = 今日漲跌幅',
  },
};
export const VIEW_ORDER = ['hsi', 'hk', 'hstech'];
export const isIndexView = (v) => Object.hasOwn(INDEX_VIEWS, v);

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

const HKT_OFFSET_MS = 8 * 3600 * 1000;
const STAMP_FULL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Strict "YYYY-MM-DD HH:MM[:SS]" (Hong Kong wall clock) -> epoch ms, or null when missing or not a real date. */
export function parseHktStamp(text) {
  const m = STAMP_FULL.exec(String(text ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map((v) => Number(v ?? 0));
  const utc = Date.UTC(y, mo - 1, d, h, mi, sec);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== sec) return null;
  return utc - HKT_OFFSET_MS;
}

/** "YYYY-MM-DD" of an instant on the Hong Kong calendar. */
export const hktDay = (ms) => new Date(ms + HKT_OFFSET_MS).toISOString().slice(0, 10);

const toMs = (now) => (now instanceof Date ? now.getTime() : Number(now));

/** Minutes since updated_at_hkt (a Hong Kong wall-clock string). */
export function ageMinutes(updatedAtHkt, now = new Date()) {
  const t = parseHktStamp(updatedAtHkt);
  return t == null ? null : (toMs(now) - t) / 60000;
}

/** Hong Kong trading session at an instant. Weekday schedule only; public holidays are not modelled. */
export function sessionAt(now = new Date()) {
  const hk = new Date(toMs(now) + HKT_OFFSET_MS);
  const day = hk.getUTCDay();
  if (day === 0 || day === 6) return 'closed';
  const minutes = hk.getUTCHours() * 60 + hk.getUTCMinutes();
  if (minutes >= 9 * 60 && minutes < 9 * 60 + 30) return 'pre_open';
  if (minutes >= 9 * 60 + 30 && minutes < 12 * 60) return 'morning';
  if (minutes >= 12 * 60 && minutes < 13 * 60) return 'lunch';
  if (minutes >= 13 * 60 && minutes < 16 * 60) return 'afternoon';
  if (minutes >= 16 * 60 && minutes < 16 * 60 + 10) return 'closing_auction';
  return 'closed';
}

export const isTradingNow = (now = new Date()) => OPEN_SESSIONS.has(sessionAt(now));

/** Minutes a snapshot may age before it is called stale. The collector writes about every 6 minutes. */
export const STALE_AFTER_MIN = { trading: 10, lunch: 30 };
export const STALE_AFTER_CLOSED_MIN = 4 * 24 * 60;

/**
 * True when a live document is late for the clock at `now`. The session is read from the clock, not from the
 * document, so a Friday snapshot on Monday 09:40 is stale even though it says "closed".
 * updated_at_hkt is when the collector run started, not an exchange quote time.
 */
export function isStale(data, now = new Date()) {
  if (!data || data.data_source === 'demo') return false;
  const age = ageMinutes(data.updated_at_hkt, now);
  if (age == null) return false;
  const session = sessionAt(now);
  if (OPEN_SESSIONS.has(session)) return age > STALE_AFTER_MIN.trading;
  if (session === 'lunch') return age > STALE_AFTER_MIN.lunch;
  return age > STALE_AFTER_CLOSED_MIN;
}

/** "5 分鐘" / "2 小時 5 分鐘" / "1 日 3 小時" for an age in minutes. */
export function fmtAge(minutes) {
  if (!isNum(minutes) || minutes < 0) return '—';
  const m = Math.floor(minutes);
  if (m < 1) return '不足 1 分鐘';
  if (m < 60) return `${m} 分鐘`;
  if (m < 1440) return `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分鐘` : ''}`;
  return `${Math.floor(m / 1440)} 日${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)} 小時` : ''}`;
}

// -------------------------------------------------------------------- polling

export const POLL_MS = { trading: 60_000, idle: 300_000, retryBase: 30_000, retryMax: 300_000, minGap: 10_000 };

/** Delay before the next background fetch. Failures back off 30 s, 60 s, 120 s ... up to 5 minutes. */
export function pollDelayMs({ now = new Date(), fails = 0 } = {}) {
  if (fails > 0) return Math.min(POLL_MS.retryBase * 2 ** (fails - 1), POLL_MS.retryMax);
  const session = sessionAt(now);
  return OPEN_SESSIONS.has(session) || session === 'lunch' ? POLL_MS.trading : POLL_MS.idle;
}

/**
 * Decide what to do with a freshly fetched document. Never replaces good live data with demo data
 * or with an older snapshot.
 *   {accept:false, kind:'error'}  the server answered, but not with usable live data
 *   {accept:false, kind:'older'}  an edge cache served an older snapshot: ignore it quietly
 *   {accept:true, changed:false}  same snapshot as before: no re-render needed
 */
export function acceptRefresh(prev, next) {
  if (!prev) return { accept: true, changed: true };
  if (prev.data_source === 'live' && next.data_source !== 'live') return { accept: false, kind: 'error', reason: 'demo_downgrade' };
  const a = parseHktStamp(prev.updated_at_hkt);
  const b = parseHktStamp(next.updated_at_hkt);
  if (a != null && b != null && b < a && prev.data_source === next.data_source) return { accept: false, kind: 'older', reason: 'older_snapshot' };
  const changed = next.updated_at_hkt !== prev.updated_at_hkt || next.data_source !== prev.data_source;
  return { accept: true, changed };
}

/** After new data arrives, keep the sector and stock the user picked only if they still exist. */
export function reconcileSelection({ sector = null, selected = null } = {}, data, view = 'hsi') {
  const sectorOk = sector && data.macro_sectors?.some((s) => s.id === sector);
  const stockOk = selected && isIndexView(view) && data[view]?.constituents?.some((r) => r.code === selected);
  return { sector: sectorOk ? sector : null, selected: stockOk ? selected : null };
}

// ----------------------------------------------------------------------- news

export const NEWS_MAX_AGE_HOURS = 72;
export const NEWS_EMPTY_TEXT = '暫無近3日相關新聞';

/** The instant a document's headlines are judged against: the clock for live data, the snapshot time for the demo. */
export function newsReference(data, now = new Date()) {
  if (data?.data_source === 'demo') return parseHktStamp(data.updated_at_hkt) ?? toMs(now);
  return toMs(now);
}

/**
 * Strict freshness gate. A headline passes only when its time parses, is not in the future,
 * and is at most 72 hours old at `now`. There is no fallback to older headlines.
 */
export function newsFreshness(item, now = new Date()) {
  const t = parseHktStamp(item?.published_at_hkt);
  if (t == null) return { ok: false, reason: 'invalid_time' };
  const age = toMs(now) - t;
  if (age < 0) return { ok: false, reason: 'future' };
  if (age > NEWS_MAX_AGE_HOURS * 3600 * 1000) return { ok: false, reason: 'too_old' };
  return { ok: true, sameDay: hktDay(t) === hktDay(toMs(now)), ageHours: age / 3600000 };
}

/** The headline to show for a stock, or null. Also needs a title and a safe link. */
export function usableNews(item, now = new Date()) {
  if (!item || !item.title || !safeUrl(item.url)) return null;
  const fresh = newsFreshness(item, now);
  return fresh.ok ? { ...item, sameDay: fresh.sameDay } : null;
}

// --------------------------------------------------------------- breadth + lists

export const BREADTH_COLORS = { up: '#008259', flat: '#6b6b6b', down: '#A50034' };

/** Segments for the advance / flat / decline bar. Safe for an empty or malformed breadth. */
export function breadthSegments(b) {
  const count = (k) => (isNum(b?.[k]) && b[k] > 0 ? Math.floor(b[k]) : 0);
  const parts = [
    { key: 'up', label: '上升', count: count('up') },
    { key: 'flat', label: '平盤', count: count('flat') },
    { key: 'down', label: '下跌', count: count('down') },
  ];
  const total = parts.reduce((t, p) => t + p.count, 0);
  const segments = parts.map((p) => ({ ...p, pct: total ? (p.count / total) * 100 : 0 }));
  const aria = total
    ? `${segments.map((p) => `${p.label} ${p.count} 隻（${p.pct.toFixed(1)}%）`).join('，')}，共 ${total} 隻`
    : '暫無升跌家數資料';
  return { total, segments, aria };
}

/**
 * Honest heading for one ranked list. `shown` is what the table will hold: only stocks that really moved
 * in that direction, at most `limit`, never padded with the other side.
 */
export function rankSummary(rows, { dir = 'up', sector = null, sectorLabel = '', universeLabel = '股票', limit = 10 } = {}) {
  const scope = rows.filter((r) => !sector || r.sector === sector);
  const counts = { up: 0, down: 0, flat: 0 };
  for (const r of scope) counts[tone(r.change_pct)]++;
  const want = dir === 'up' ? 'up' : 'down';
  const other = dir === 'up' ? 'down' : 'up';
  const word = dir === 'up' ? '上升' : '下跌';
  const otherWord = dir === 'up' ? '下跌' : '上升';
  const matching = counts[want];
  const shown = Math.min(matching, limit);
  const where = sector ? `「${sectorLabel || sector}」板塊的${universeLabel}` : universeLabel;
  let reason = '';
  if (!scope.length) {
    reason = `${where}目前沒有資料。`;
  } else if (matching === 0) {
    reason = `${where}共 ${scope.length} 隻，沒有${word}的股票，所以此榜為空；榜單不會以${otherWord}股補位。`;
  } else if (matching < limit) {
    const rest = [`${counts[other]} 隻${otherWord}`, counts.flat ? `${counts.flat} 隻持平` : ''].filter(Boolean).join('、');
    reason = `${where}共 ${scope.length} 隻，只有 ${matching} 隻${word}（${rest}），不足 ${limit} 隻；榜單只列出實際${word}的股票，不以${otherWord}股補位。`;
  } else if (matching > limit) {
    reason = `${where}共 ${matching} 隻${word}，只列出前 ${limit} 隻。`;
  }
  const name = dir === 'up' ? '升幅榜' : '跌幅榜';
  return {
    dir, shown, matching, limit, scopeTotal: scope.length, counts, reason, short: matching < limit,
    title: matching >= limit ? `${name} Top ${limit}` : name,
    countLabel: matching >= limit ? '' : `實際 ${shown} 隻 · 最多 ${limit} 隻`,
  };
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nullableNum = (v) => v == null || isNum(v);

function validateExtras(block, where, errors) {
  if (block.members != null) {
    if (!Array.isArray(block.members)) errors.push(`${where}.members must be an array`);
    else block.members.forEach((m, i) => {
      const w = `${where}.members[${i}]`;
      if (!m || typeof m !== 'object') return errors.push(`${w}: not an object`);
      if (!CODE.test(m.code || '')) errors.push(`${w}: code must be 5 digits`);
      if (!m.name || typeof m.name !== 'string') errors.push(`${w}: name missing`);
      if (!isNum(m.weight_pct)) errors.push(`${w}: weight_pct must be a number`);
      for (const k of ['last', 'change_pct', 'ret_5d', 'ret_1m', 'ret_ytd', 'market_cap_hkd']) {
        if (!nullableNum(m[k])) errors.push(`${w}: ${k} must be a number or null`);
      }
    });
  }
  if (block.roster != null) {
    const r = block.roster;
    if (typeof r !== 'object' || Array.isArray(r)) errors.push(`${where}.roster must be an object`);
    else {
      if (!isNum(r.count)) errors.push(`${where}.roster.count must be a number`);
      if (r.weights_as_of != null && !DAY.test(r.weights_as_of)) errors.push(`${where}.roster.weights_as_of must be YYYY-MM-DD`);
    }
  }
}

function validateIndexBlock(block, where, errors, sectorIds, { nullableIndex = false } = {}) {
  if (!block || typeof block !== 'object') return errors.push(`${where} must be an object`);
  for (const k of ['last', 'prev_close', 'change', 'change_pct']) {
    const v = block.index?.[k];
    if (nullableIndex ? !nullableNum(v) : !isNum(v)) errors.push(`${where}.index.${k} must be a number`);
  }
  for (const k of ['up', 'down', 'flat']) if (!isNum(block.breadth?.[k])) errors.push(`${where}.breadth.${k} must be a number`);
  if (!isNum(block.turnover_hkd)) errors.push(`${where}.turnover_hkd must be a number`);
  if (!Array.isArray(block.constituents)) errors.push(`${where}.constituents must be an array`);
  else block.constituents.forEach((r, i) => checkStock(r, `${where}.constituents[${i}]`, errors, sectorIds));
  validateExtras(block, where, errors);
}

/** Shape check for the document served by /movers/data/latest. */
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

  const lists = ['hsi', 'hk'];
  if (d.hstech != null) {
    validateIndexBlock(d.hstech, 'hstech', errors, sectorIds, { nullableIndex: true });
    lists.push('hstech');
  }
  if (hsi && typeof hsi === 'object') validateExtras(hsi, 'hsi', errors);
  if (d.returns != null) {
    if (typeof d.returns !== 'object' || Array.isArray(d.returns)) errors.push('returns must be an object');
    else for (const k of ['d5', 'm1', 'ytd']) {
      if (d.returns[k] != null && !DAY.test(d.returns[k])) errors.push(`returns.${k} must be YYYY-MM-DD or null`);
    }
  }
  for (const u of lists) {
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

// ------------------------------------------------------- constituents table

/**
 * Sortable columns of the constituents table. `get` reads the raw value; null and non-finite values are
 * "unavailable" and always sort last, in both directions.
 */
export const MEMBER_COLUMNS = [
  { id: 'weight', label: '權重', unit: '%', get: (m) => m.weight_pct, first: 'desc' },
  { id: 'd1', label: '1日', get: (m) => m.change_pct, first: 'desc' },
  { id: 'd5', label: '5日', get: (m) => m.ret_5d, first: 'desc' },
  { id: 'm1', label: '1個月', get: (m) => m.ret_1m, first: 'desc' },
  { id: 'ytd', label: '年初至今', get: (m) => m.ret_ytd, first: 'desc' },
  { id: 'last', label: '現價', get: (m) => m.last, first: 'desc' },
  { id: 'cap', label: '總市值', get: (m) => m.market_cap_hkd, first: 'desc' },
];
export const DEFAULT_MEMBER_SORT = { key: 'weight', dir: 'desc' };
const columnOf = (key) => MEMBER_COLUMNS.find((c) => c.id === key);

/**
 * Stable numeric sort. Ties keep the official roster order (the order of `members`), in both directions;
 * unavailable values come last in both directions. Returns a new array.
 */
export function sortMembers(members, { key, dir } = DEFAULT_MEMBER_SORT) {
  const col = columnOf(key) || columnOf(DEFAULT_MEMBER_SORT.key);
  const sign = dir === 'asc' ? 1 : -1;
  return members
    .map((m, i) => ({ m, i, v: col.get(m) }))
    .sort((a, b) => {
      const an = isNum(a.v);
      const bn = isNum(b.v);
      if (an !== bn) return an ? -1 : 1;
      if (an && a.v !== b.v) return a.v < b.v ? -sign : sign;
      return a.i - b.i;
    })
    .map((x) => x.m);
}

/** Header click: the same column flips direction, a new column starts high to low. */
export function nextSort(current, key) {
  const col = columnOf(key);
  if (!col) return current;
  if (current?.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  return { key, dir: col.first };
}

export const ariaSort = (current, key) => (current?.key === key ? (current.dir === 'asc' ? 'ascending' : 'descending') : 'none');

export function sortAnnouncement(sort) {
  const col = columnOf(sort?.key);
  return col ? `已按${col.label}由${sort.dir === 'asc' ? '低至高' : '高至低'}排序，沒有數據的成分股排在最後` : '';
}

/** "2026-11-16" -> "11-16"; a different year keeps the year ("2025-12-31"). */
export function shortRefDate(day, asOf) {
  if (!DAY.test(day || '')) return '';
  return asOf && day.slice(0, 4) === String(asOf).slice(0, 4) ? day.slice(5) : day;
}

/** Reference dates behind the 5D / 1M / YTD columns, for headers and the footnote. */
export function returnRefs(returns) {
  const asOf = returns?.as_of && DAY.test(returns.as_of) ? returns.as_of : null;
  const pick = (k) => (DAY.test(returns?.[k] || '') ? returns[k] : null);
  const refs = { asOf, d5: pick('d5'), m1: pick('m1'), ytd: pick('ytd') };
  const against = (d) => (d ? `相對 ${d} 收市價` : '歷史資料不足');
  const note = refs.asOf
    ? `5日：${against(refs.d5)}（5 個交易日前）；1個月：${against(refs.m1)}（一個月前或之前最近的交易日）；`
      + `年初至今：${against(refs.ytd)}（上年最後交易日）。以上均為前復權收市價，最新交易日 ${refs.asOf}；1日為現價相對前收市價。`
    : '5日、1個月、年初至今需要歷史收市價，目前尚未提供；1日為現價相對前收市價。';
  return { ...refs, available: Boolean(refs.asOf), note };
}

export function memberStats(members) {
  const list = Array.isArray(members) ? members : [];
  const priced = list.filter((m) => m.available !== false && isNum(m.last)).length;
  return { total: list.length, priced, missing: list.length - priced };
}

/** Text lines for the roster notice under an index view. */
export function rosterNotes(roster, label) {
  if (!roster) return { basis: '', upcoming: '' };
  const up = roster.upcoming && roster.upcoming.effective_from ? roster.upcoming : null;
  const basis = `${label}官方成分股 ${roster.count} 隻；權重由恒生指數公司公佈，`
    + `${roster.weights_as_of ? `截至 ${roster.weights_as_of}` : '日期未註明'}${up ? '（指數檢討前）' : ''}。`;
  let upcoming = '';
  if (up) {
    const added = up.added?.length || 0;
    const removed = up.removed?.length || 0;
    const change = added || removed || up.count !== roster.count
      ? `成分股將由 ${roster.count} 隻調整為 ${up.count} 隻${added ? `（新增 ${added} 隻` : '（'}${removed ? `${added ? '、' : ''}剔除 ${removed} 隻` : ''}）`
      : `成分股名單不變（${up.count} 隻），權重按檢討結果重設`;
    upcoming = `已公佈：${up.effective_from} 起${change}。尚未生效，目前仍按現行名單與權重顯示。`;
  }
  return { basis, upcoming };
}
