import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  ageMinutes, arrow, breadth, esc, fmtHkd, fmtPct, fmtPrice, heatColor, impactOf, isStale, layoutGroups,
  qualifies, rankStocks, safeUrl, squarify, tone, validateSnapshot, weightedChange,
} from '../../movers/lib.js';
import { KV_KEY, onRequest, pickBinding, serveLatest } from '../../functions/movers/data/latest.js';
import { PUBLIC_DETACH, JSON_NOINDEX, indexingHeaderErrors } from '../headers.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const sample = JSON.parse(read('movers/data/sample.json'));

const row = (code, pct, extra = {}) => ({
  code, name: `股${code}`, sector: 'tech', industry: '軟件服務', last: 10, prev_close: 10, change_pct: pct,
  turnover_hkd: 2e7, market_cap_hkd: 2e9, ...extra,
});

test('Chinese-unit money and percent formatting', () => {
  assert.equal(fmtHkd(12_345_678_900), 'HK$123.5 億');
  assert.equal(fmtHkd(1_000_000_000, { digits: 0 }), 'HK$10 億');
  assert.equal(fmtHkd(10_000_000, { digits: 0 }), 'HK$1,000 萬');
  assert.equal(fmtHkd(4_800_000_000_000), 'HK$4.80 萬億');
  assert.equal(fmtHkd(-250_000_000, { sign: true }), '-HK$2.50 億');
  assert.equal(fmtHkd(250_000_000, { sign: true }), '+HK$2.50 億');
  assert.equal(fmtHkd(NaN), '—');
  assert.equal(fmtPct(1.234), '+1.23%');
  assert.equal(fmtPct(-0.5), '-0.50%');
  assert.equal(fmtPct(0.001), '0.00%');
  assert.equal(fmtPrice(0.456), '0.456');
  assert.equal(fmtPrice(1234.5), '1,234.50');
});

test('tone, arrows and breadth treat a rounded zero as flat', () => {
  assert.equal(tone(0.004), 'flat');
  assert.equal(tone(0.02), 'up');
  assert.equal(tone(-0.02), 'down');
  assert.equal(arrow(1), '▲');
  assert.equal(arrow(-1), '▼');
  assert.deepEqual(breadth([row('00001', 1), row('00002', -1), row('00003', 0), row('00004', 0.001)]), { up: 1, down: 1, flat: 2 });
});

test('impact is change % x market cap, and an explicit value wins', () => {
  assert.equal(impactOf(row('00001', 2, { market_cap_hkd: 1e10 })), 2e8);
  assert.equal(impactOf(row('00001', 2, { impact_hkd: 5 })), 5);
});

test('rankStocks orders each side and honours sort and sector', () => {
  const rows = [
    row('00001', 3, { market_cap_hkd: 1e9 + 1, turnover_hkd: 5e7 }),
    row('00002', 5, { market_cap_hkd: 5e9, turnover_hkd: 2e7 }),
    row('00003', 1, { market_cap_hkd: 9e10, turnover_hkd: 9e7, sector: 'finance' }),
    row('00004', -4, { market_cap_hkd: 2e9 }),
    row('00005', -1, { market_cap_hkd: 8e10, turnover_hkd: 8e7, sector: 'finance' }),
    row('00006', 0),
  ];
  const codes = (list) => list.map((r) => r.code);
  assert.deepEqual(codes(rankStocks(rows, { dir: 'up' })), ['00002', '00001', '00003']);
  assert.deepEqual(codes(rankStocks(rows, { dir: 'down' })), ['00004', '00005']);
  assert.deepEqual(codes(rankStocks(rows, { dir: 'up', sort: 'turnover' })), ['00003', '00001', '00002']);
  assert.deepEqual(codes(rankStocks(rows, { dir: 'up', sort: 'market_cap' })), ['00003', '00002', '00001']);
  assert.deepEqual(codes(rankStocks(rows, { dir: 'up', sort: 'impact' })), ['00003', '00002', '00001']);
  assert.deepEqual(codes(rankStocks(rows, { dir: 'down', sort: 'impact' })), ['00005', '00004']);
  assert.deepEqual(codes(rankStocks(rows, { dir: 'up', sector: 'finance' })), ['00003']);
  assert.deepEqual(codes(rankStocks(rows, { dir: 'up', limit: 1 })), ['00002']);
  assert.ok(!codes(rankStocks(rows, { dir: 'up' })).includes('00006'), 'a flat stock is in neither list');
});

test('HK filter is turnover >= 10M and market cap > 1B', () => {
  const f = { min_turnover_hkd: 1e7, min_market_cap_hkd: 1e9 };
  assert.equal(qualifies(row('00001', 1, { turnover_hkd: 1e7, market_cap_hkd: 1e9 + 1 }), f), true);
  assert.equal(qualifies(row('00001', 1, { turnover_hkd: 1e7 - 1, market_cap_hkd: 5e9 }), f), false);
  assert.equal(qualifies(row('00001', 1, { turnover_hkd: 5e7, market_cap_hkd: 1e9 }), f), false);
});

test('weightedChange is cap weighted', () => {
  assert.equal(weightedChange([row('1', 10, { market_cap_hkd: 1 }), row('2', 0, { market_cap_hkd: 3 })]), 2.5);
  assert.equal(weightedChange([]), 0);
});

test('safeUrl allows http(s) only and esc escapes markup', () => {
  assert.equal(safeUrl('https://news-chart.com/news/'), 'https://news-chart.com/news/');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,x'), '');
  assert.equal(safeUrl('//evil.test/x'), '');
  assert.equal(safeUrl(''), '');
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('staleness: trading hours go stale after 10 minutes, demo never', () => {
  const doc = { data_source: 'live', market_session: 'morning', updated_at_hkt: '2026-11-20 10:00:00' };
  const at = (hhmm) => new Date(`2026-11-20T${hhmm}:00+08:00`);
  assert.equal(Math.round(ageMinutes(doc.updated_at_hkt, at('10:20'))), 20);
  assert.equal(isStale(doc, at('10:09')), false);
  assert.equal(isStale(doc, at('10:10')), false, 'exactly 10 minutes is still on time');
  assert.equal(isStale(doc, at('10:11')), true);
  assert.equal(isStale({ ...doc, market_session: 'closed' }, at('23:00')), false);
  assert.equal(isStale({ ...doc, data_source: 'demo' }, at('10:45')), false);
  assert.equal(ageMinutes('bad'), null);
});

test('heat colours are diverging and readable', () => {
  assert.equal(heatColor(0).fg, '#111');
  assert.match(heatColor(8, 4).bg, /^rgb\(/);
  assert.equal(heatColor(8, 4).fg, '#fff');
  assert.notEqual(heatColor(2, 4).bg, heatColor(-2, 4).bg);
  assert.equal(heatColor(4, 4).bg, heatColor(40, 4).bg, 'strength is capped');
});

test('squarify fills the box without overlap', () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((value, i) => ({ key: `k${i}`, value }));
  const W = 600;
  const H = 400;
  const boxes = squarify(items, 0, 0, W, H);
  assert.equal(boxes.length, items.length);
  const total = boxes.reduce((s, b) => s + b.w * b.h, 0);
  assert.ok(Math.abs(total - W * H) < 1e-6);
  for (const b of boxes) {
    assert.ok(b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= W + 1e-6 && b.y + b.h <= H + 1e-6);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(ox <= 1e-6 || oy <= 1e-6, `${a.key} overlaps ${b.key}`);
    }
  }
  assert.deepEqual(squarify([], 0, 0, 10, 10), []);
  assert.deepEqual(squarify([{ key: 'a', value: 0 }], 0, 0, 10, 10), []);
});

test('layoutGroups keeps tiles inside their group and area proportional', () => {
  const groups = [
    { id: 'a', value: 70, items: [{ key: 'a1', value: 40 }, { key: 'a2', value: 30 }] },
    { id: 'b', value: 30, items: [{ key: 'b1', value: 30 }] },
  ];
  const out = layoutGroups(groups, 335, 400);
  assert.equal(out.length, 2);
  for (const g of out) {
    for (const t of g.tiles) {
      assert.ok(t.x >= g.box.x - 1e-6 && t.y >= g.box.y - 1e-6);
      assert.ok(t.x + t.w <= g.box.x + g.box.w + 1e-6 && t.y + t.h <= g.box.y + g.box.h + 1e-6);
    }
  }
  const a = out.find((g) => g.id === 'a').box;
  const b = out.find((g) => g.id === 'b').box;
  assert.ok(Math.abs((a.w * a.h) / (b.w * b.h) - 70 / 30) < 1e-6);
});

// ------------------------------------------------------------ sample document

test('the demo document is valid and clearly marked as a demo', () => {
  const check = validateSnapshot(sample);
  assert.deepEqual(check.errors, []);
  assert.equal(sample.data_source, 'demo');
  assert.match(sample.notice, /示範/);
  assert.equal(sample.market_session, 'closed');
  assert.match(sample.updated_at_hkt, /^2026-11-20 16:10/);
});

test('demo HSI view: about 95 constituents, index summary and breadth add up', () => {
  const rows = sample.hsi.constituents;
  assert.ok(rows.length >= 90 && rows.length <= 100, `${rows.length} constituents`);
  assert.deepEqual(sample.hsi.breadth, breadth(rows));
  assert.equal(sample.hsi.breadth.up + sample.hsi.breadth.down + sample.hsi.breadth.flat, rows.length);
  const idx = sample.hsi.index;
  assert.ok(Math.abs(idx.change - (idx.last - idx.prev_close)) < 0.01);
  assert.ok(Math.abs(idx.change_pct - (idx.last / idx.prev_close - 1) * 100) < 0.01);
  assert.ok(sample.hsi.turnover_hkd > 0);
});

test('demo HK view: 10 to 12 Chinese sectors and every stock passes the filter', () => {
  const { filters, stocks } = sample.hk_market;
  assert.equal(filters.min_turnover_hkd, 10_000_000);
  assert.equal(filters.min_market_cap_hkd, 1_000_000_000);
  assert.ok(stocks.length > 0);
  for (const s of stocks) assert.ok(qualifies(s, filters), `${s.code} fails the filter`);
  assert.equal(sample.hk_market.qualified_count, stocks.length);
  assert.ok(sample.hk_market.universe_count >= stocks.length);
  assert.deepEqual(sample.hk_market.breadth, breadth(stocks));
  const sectors = sample.macro_sectors;
  assert.ok(sectors.length >= 10 && sectors.length <= 12);
  for (const s of sectors) {
    assert.match(s.name, /[\u4e00-\u9fff]/);
    assert.ok(s.industries.length > 0, `${s.id} has industries`);
    assert.ok(s.up + s.down + s.flat > 0);
  }
});

test('published movers equal the ranking the page computes', () => {
  const ids = (list) => list.map((r) => r.code);
  assert.deepEqual(ids(sample.movers.hsi.gainers), ids(rankStocks(sample.hsi.constituents, { dir: 'up' })));
  assert.deepEqual(ids(sample.movers.hsi.losers), ids(rankStocks(sample.hsi.constituents, { dir: 'down' })));
  assert.deepEqual(ids(sample.movers.hk.gainers), ids(rankStocks(sample.hk_market.stocks, { dir: 'up' })));
  assert.deepEqual(ids(sample.movers.hk.losers), ids(rankStocks(sample.hk_market.stocks, { dir: 'down' })));
  for (const list of [sample.movers.hsi.gainers, sample.movers.hsi.losers, sample.movers.hk.gainers, sample.movers.hk.losers]) {
    assert.equal(list.length, 10);
  }
  for (const r of sample.movers.hsi.gainers) {
    const want = (r.change_pct / 100) * r.market_cap_hkd;
    assert.ok(Math.abs(impactOf(r) - want) <= Math.abs(want) * 1e-3 + 1, `${r.code} impact`);
  }
});

test('demo news are Traditional Chinese, safe links, and one row shows the empty state', () => {
  const lists = [sample.movers.hsi.gainers, sample.movers.hsi.losers, sample.movers.hk.gainers, sample.movers.hk.losers];
  let missing = 0;
  for (const r of lists.flat()) {
    const n = sample.news[r.code];
    if (!n) {
      missing++;
      continue;
    }
    assert.match(n.title, /[\u4e00-\u9fff]/, `${r.code} title is Chinese`);
    assert.ok(safeUrl(n.url), `${r.code} url`);
    assert.ok(n.source && n.published_at_hkt, `${r.code} meta`);
  }
  assert.ok(missing >= 1, 'the demo keeps an empty-news row');
  assert.ok(missing <= 4);
});

test('validateSnapshot rejects broken documents', () => {
  const clone = () => JSON.parse(JSON.stringify(sample));
  assert.equal(validateSnapshot(null).ok, false);
  assert.equal(validateSnapshot({}).ok, false);
  let d = clone();
  d.schema_version = 2;
  assert.equal(validateSnapshot(d).ok, false);
  d = clone();
  d.macro_sectors = d.macro_sectors.slice(0, 5);
  assert.match(validateSnapshot(d).errors.join(), /10 to 12/);
  d = clone();
  d.hsi.constituents[0].sector = 'nope';
  assert.match(validateSnapshot(d).errors.join(), /unknown sector/);
  d = clone();
  d.market_session = 'weekend';
  assert.equal(validateSnapshot(d).ok, false);
  d = clone();
  delete d.movers.hk;
  assert.equal(validateSnapshot(d).ok, false);
  d = clone();
  d.hk_market.stocks[0].code = '700';
  assert.equal(validateSnapshot(d).ok, false);
});

test('schema.json lists the keys the document and validator require', () => {
  const schema = JSON.parse(read('scripts/hk-movers/schema.json'));
  for (const key of ['updated_at_hkt', 'market_session', 'hsi', 'hk_market', 'macro_sectors', 'movers']) {
    assert.ok(schema.required.includes(key), key);
    assert.ok(key in sample, key);
  }
  assert.deepEqual(Object.keys(schema.properties.hsi.properties).sort(), ['breadth', 'constituents', 'index', 'members', 'roster', 'turnover_hkd']);
  assert.deepEqual(schema.$defs.stock.required.sort(), ['change_pct', 'code', 'industry', 'last', 'market_cap_hkd', 'name', 'sector', 'turnover_hkd']);
});

// --------------------------------------------------------------- public copy

const PUBLIC_FILES = ['movers/index.html', 'movers/app.js', 'movers/lib.js', 'movers/poll.js', 'movers/movers.css', 'movers/data/sample.json', 'functions/movers/data/latest.js'];

test('public HK Movers files name no quote vendor', () => {
  for (const file of PUBLIC_FILES) {
    assert.doesNotMatch(read(file), /\bfutu\b|富途|\byahoo\b|雅虎/i, file);
  }
  assert.doesNotMatch(read('assets/tools.json'), /\bfutu\b|富途|\byahoo\b/i);
});

test('page copy is Traditional Chinese: no simplified-only characters', () => {
  const simplified = /[价涨额汇资业医药网专这们两东车银证债险类盘场营续]/;
  for (const file of ['movers/index.html', 'movers/app.js', 'movers/data/sample.json']) {
    const hit = read(file).match(simplified);
    assert.equal(hit, null, `${file} has ${hit}`);
  }
});

test('page markup carries the shared chrome, brand mark, author and required labels', () => {
  const html = read('movers/index.html');
  assert.match(html, /<title>Movers｜港股異動與板塊熱力圖 · News Chart<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/news-chart\.com\/movers\/"/);
  assert.match(html, /property="og:url" content="https:\/\/news-chart\.com\/movers\/"/);
  assert.match(html, /src="\/assets\/brand\/news-chart-white\.svg"/);
  assert.match(html, /data-site-header/);
  assert.match(html, /data-site-footer/);
  assert.match(html, /\/assets\/css\/theme\.css/);
  assert.match(html, /\/assets\/js\/site\.js/);
  assert.match(html, /作者：ADRRR/);
  assert.match(html, /HSI 恒生指數/);
  assert.match(html, /HK 港股全市場/);
  assert.match(html, /漲跌幅 × 總市值/);
  assert.match(html, /不是恒生指數官方公佈的貢獻點數/);
  assert.match(html, /HK\$1,000 萬/);
  assert.match(html, /HK\$10 億/);
  assert.match(html, /role="tablist"/);
  assert.doesNotMatch(html, /\bnoindex\b/i);
});

test('app renders the required news link attributes and empty state', () => {
  const app = read('movers/app.js');
  assert.match(app, /target="_blank" rel="noopener noreferrer"/);
  assert.match(app, /NEWS_EMPTY_TEXT/);
  assert.match(app, /safeUrl\(item\.url\)/);
  assert.match(app, /rankSummary/);
});

// ------------------------------------------------------------------ Function

function kvOf(values, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async get(key, options) {
      calls.push({ key, options });
      if (fail) throw new Error('kv down');
      return key in values ? values[key] : null;
    },
  };
}
const assetsOf = () => ({
  async fetch(url) {
    assert.equal(new URL(url).pathname, '/movers/data/sample.json');
    return new Response(JSON.stringify(sample), { status: 200 });
  },
});
const LIVE = JSON.stringify({ ...sample, data_source: 'live', updated_at_hkt: '2026-11-20 11:00:00' });
const URL_ = 'https://news-chart.com/movers/data/latest';

test('Function prefers HK_MOVERS and falls back to HSI_BARS for the same key', async () => {
  assert.equal(KV_KEY, 'hk-movers:latest.json');
  const dedicated = kvOf({ [KV_KEY]: LIVE });
  const shared = kvOf({ [KV_KEY]: '{"schema_version":1,"hsi":{},"hk_market":{},"from":"shared"}' });
  const both = await serveLatest({ method: 'GET', env: { HK_MOVERS: dedicated, HSI_BARS: shared }, requestUrl: URL_ });
  assert.equal(both.headers.get('x-hk-movers-source'), 'kv:HK_MOVERS');
  assert.equal(shared.calls.length, 0);
  assert.equal((await both.json()).data_source, 'live');
  assert.equal(dedicated.calls[0].key, KV_KEY);

  const only = await serveLatest({ method: 'GET', env: { HSI_BARS: shared }, requestUrl: URL_ });
  assert.equal(only.headers.get('x-hk-movers-source'), 'kv:HSI_BARS');
  assert.equal((await only.json()).from, 'shared');
  assert.equal(pickBinding({}), null);
});

test('Function live response headers', async () => {
  const res = await serveLatest({ method: 'GET', env: { HSI_BARS: kvOf({ [KV_KEY]: LIVE }) }, requestUrl: URL_ });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.match(res.headers.get('cache-control'), /max-age=30/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('Function serves the labelled demo when KV has nothing usable', async () => {
  const cases = [
    ['kv-empty', { HSI_BARS: kvOf({}), ASSETS: assetsOf() }],
    ['no-binding', { ASSETS: assetsOf() }],
    ['kv-error', { HSI_BARS: kvOf({}, { fail: true }), ASSETS: assetsOf() }],
    ['kv-invalid', { HSI_BARS: kvOf({ [KV_KEY]: 'not json' }), ASSETS: assetsOf() }],
    ['kv-invalid', { HSI_BARS: kvOf({ [KV_KEY]: '{"hello":1}' }), ASSETS: assetsOf() }],
  ];
  for (const [reason, env] of cases) {
    const res = await serveLatest({ method: 'GET', env, requestUrl: URL_ });
    assert.equal(res.status, 200, reason);
    assert.equal(res.headers.get('x-hk-movers-source'), 'demo', reason);
    assert.equal(res.headers.get('x-hk-movers-reason'), reason);
    assert.equal(res.headers.get('cache-control'), 'no-store', reason);
    assert.equal((await res.json()).data_source, 'demo', reason);
  }
});

test('Function answers 404 JSON without a demo source, 405 for writes, and no body on HEAD', async () => {
  const none = await serveLatest({ method: 'GET', env: { HSI_BARS: kvOf({}) }, requestUrl: URL_ });
  assert.equal(none.status, 404);
  assert.equal((await none.json()).error, 'no_data');
  assert.equal(none.headers.get('cache-control'), 'no-store');

  const post = await serveLatest({ method: 'POST', env: {}, requestUrl: URL_ });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');

  const head = await serveLatest({ method: 'HEAD', env: { HSI_BARS: kvOf({ [KV_KEY]: LIVE }) }, requestUrl: URL_ });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);

  const viaContext = await onRequest({ request: new Request(URL_), env: { HK_MOVERS: kvOf({ [KV_KEY]: LIVE }) } });
  assert.equal(viaContext.status, 200);
});

// -------------------------------------------------------------------- wiring

test('_routes.json sends only the Function path through Functions', () => {
  const routes = JSON.parse(read('_routes.json'));
  assert.deepEqual(routes.include, ['/backtest/data/hsi/*', '/movers/data/latest', '/hk-movers/data/latest']);
});

test('registry, sitemap, headers and llms.txt know the page', () => {
  const reg = JSON.parse(read('assets/tools.json'));
  const tool = reg.tools.find((t) => t.id === 'movers');
  assert.equal(tool.href, '/movers/');
  assert.equal(tool.chrome, 'shared');
  assert.equal(tool.nav, true);
  assert.equal(tool.owner, 'repo');
  assert.match(read('sitemap-pages.xml'), /<loc>https:\/\/news-chart\.com\/movers\/<\/loc>/);
  assert.match(read('llms.txt'), /news-chart\.com\/movers\//);
  for (const path of ['/movers', '/movers/', '/movers/*']) assert.ok(PUBLIC_DETACH.includes(path), path);
  for (const path of ['/movers/data/latest', '/movers/data/sample.json', '/hk-movers/data/latest']) assert.ok(JSON_NOINDEX.includes(path), path);
  assert.deepEqual(indexingHeaderErrors(read('_headers')), []);
});

test('every file the page ships stays plain static: no build step, no external scripts', () => {
  const files = readdirSync(new URL('../../movers/', import.meta.url), { recursive: true });
  assert.ok(files.includes('index.html') && files.includes('app.js') && files.includes('lib.js'));
  assert.doesNotMatch(read('movers/index.html'), /<script[^>]+src="https?:/);
});

// ------------------------------------------------------- freshness, breadth, short lists

import {
  BREADTH_COLORS, NEWS_EMPTY_TEXT, STALE_AFTER_MIN, acceptRefresh, breadthSegments, fmtAge, hktDay, newsFreshness,
  newsReference, parseHktStamp, pollDelayMs, rankSummary, reconcileSelection, sessionAt, usableNews,
} from '../../movers/lib.js';

const NOW = new Date('2026-11-20T16:00:00+08:00');
const hkt = (offsetMs) => {
  const t = new Date(NOW.getTime() + offsetMs + 8 * 3600e3).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
};
const H = 3600e3;
const newsItem = (stamp, extra = {}) => ({ title: '標題', source: '某報', url: 'https://example.com/n', published_at_hkt: stamp, ...extra });

test('news age gate: 0 <= age <= 72 hours, strictly parsed', () => {
  const cases = [
    ['2026-11-20 16:00', true, 'now'],
    ['2026-11-20 09:30', true, 'same day'],
    ['2026-11-17 16:00', true, 'exactly 72h'],
    ['2026-11-17 15:59', false, 'one minute past 72h'],
    ['2026-11-13 10:00', false, 'a week old'],
    ['2026-10-20 10:00', false, 'a month old'],
    ['2026-11-20 16:01', false, 'one minute in the future'],
    ['2026-11-21 09:00', false, 'tomorrow'],
    ['', false, 'empty'],
    [undefined, false, 'missing'],
    ['昨天', false, 'text'],
    ['2026-11-20', false, 'date only'],
    ['2026/11/20 10:00', false, 'wrong separator'],
    ['2026-02-31 10:00', false, 'impossible date'],
    ['2026-11-20 24:30', false, 'impossible time'],
  ];
  for (const [stamp, ok, why] of cases) {
    assert.equal(newsFreshness(newsItem(stamp), NOW).ok, ok, `${why}: ${stamp}`);
    assert.equal(usableNews(newsItem(stamp), NOW) !== null, ok, `${why} via usableNews`);
  }
  assert.equal(newsFreshness(newsItem('2026-11-17 16:00:01'), NOW).ok, true);
  assert.equal(newsFreshness(newsItem('2026-11-17 15:59:59'), NOW).ok, false);
  assert.equal(newsFreshness(newsItem('2026-11-20 16:00:01'), NOW).reason, 'future');
  assert.equal(newsFreshness(newsItem('2026-11-10 10:00'), NOW).reason, 'too_old');
  assert.equal(newsFreshness(newsItem('x'), NOW).reason, 'invalid_time');
  assert.equal(NEWS_EMPTY_TEXT, '暫無近3日相關新聞');
});

test('news gate keeps the same-day flag on the Hong Kong calendar and needs a title and a safe link', () => {
  assert.equal(usableNews(newsItem('2026-11-20 00:05'), NOW).sameDay, true);
  assert.equal(usableNews(newsItem('2026-11-19 23:55'), NOW).sameDay, false);
  assert.equal(usableNews(newsItem('2026-11-20 10:00', { url: 'javascript:alert(1)' }), NOW), null);
  assert.equal(usableNews(newsItem('2026-11-20 10:00', { title: '' }), NOW), null);
  assert.equal(usableNews(null, NOW), null);
  assert.equal(hktDay(Date.parse('2026-11-19T17:00:00Z')), '2026-11-20');
  assert.equal(parseHktStamp('2026-11-20 16:00'), NOW.getTime());
  assert.equal(parseHktStamp('2026-11-20T16:00:30'), NOW.getTime() + 30000);
});

test('cached older news in a live document is excluded by the page gate', () => {
  const doc = { data_source: 'live', updated_at_hkt: '2026-11-20 15:55:00' };
  const cached = { '00700': newsItem(hkt(-80 * H)), '00005': newsItem(hkt(-2 * H)) };
  assert.equal(newsReference(doc, NOW), NOW.getTime(), 'live news are judged against the clock');
  assert.equal(usableNews(cached['00700'], newsReference(doc, NOW)), null);
  assert.ok(usableNews(cached['00005'], newsReference(doc, NOW)));
  const demo = { data_source: 'demo', updated_at_hkt: '2026-11-20 16:10:00' };
  assert.equal(newsReference(demo, new Date('2027-01-01T00:00:00+08:00')), parseHktStamp('2026-11-20 16:10:00'), 'demo news are judged against the demo snapshot time');
});

test('breadth segments: counts, shares and a zero total', () => {
  const b = breadthSegments({ up: 5, down: 89, flat: 1 });
  assert.equal(b.total, 95);
  assert.deepEqual(b.segments.map((x) => [x.key, x.count]), [['up', 5], ['flat', 1], ['down', 89]]);
  assert.ok(Math.abs(b.segments.reduce((t, x) => t + x.pct, 0) - 100) < 1e-9);
  assert.match(b.aria, /上升 5 隻（5\.3%）/);
  assert.match(b.aria, /下跌 89 隻（93\.7%）/);
  assert.match(b.aria, /平盤 1 隻（1\.1%）/);
  const empty = breadthSegments({ up: 0, down: 0, flat: 0 });
  assert.equal(empty.total, 0);
  assert.ok(empty.segments.every((x) => x.pct === 0 && Number.isFinite(x.pct)));
  assert.equal(empty.aria, '暫無升跌家數資料');
  for (const bad of [null, undefined, {}, { up: NaN, down: -3, flat: 'x' }]) {
    const r = breadthSegments(bad);
    assert.equal(r.total, 0);
    assert.ok(r.segments.every((x) => Number.isFinite(x.pct)));
  }
  assert.equal(breadthSegments({ up: 3, down: 0, flat: 0 }).segments[0].pct, 100);
});

test('breadth colours match the morning report and stay readable with white text', () => {
  assert.deepEqual(BREADTH_COLORS, { up: '#008259', flat: '#6b6b6b', down: '#A50034' });
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  for (const hex of Object.values(BREADTH_COLORS)) assert.ok(contrast('#ffffff', hex) >= 4.5, `${hex} on white text`);
  const css = read('movers/movers.css');
  assert.match(css, /\.hkm-list-h\.is-up\s*\{\s*background:\s*#008259/);
  assert.match(css, /\.hkm-list-h\.is-down\s*\{\s*background:\s*#A50034/);
});

const sectorRows = (up, down, flat, sector = 'tech') => [
  ...Array.from({ length: up }, (_, i) => row(`${10000 + i}`.slice(-5), 1 + i, { sector })),
  ...Array.from({ length: down }, (_, i) => row(`${20000 + i}`.slice(-5), -1 - i, { sector })),
  ...Array.from({ length: flat }, (_, i) => row(`${30000 + i}`.slice(-5), 0, { sector })),
];

test('short rankings are labelled with the real count and never padded with the other side', () => {
  const rows = sectorRows(5, 89, 1);
  const up = rankSummary(rows, { dir: 'up', universeLabel: '恒指成分股' });
  assert.equal(up.shown, 5);
  assert.equal(up.matching, 5);
  assert.equal(up.short, true);
  assert.equal(up.title, '升幅榜');
  assert.equal(up.countLabel, '實際 5 隻 · 最多 10 隻');
  assert.match(up.reason, /恒指成分股共 95 隻，只有 5 隻上升（89 隻下跌、1 隻持平），不足 10 隻/);
  assert.match(up.reason, /不以下跌股補位/);
  const list = rankStocks(rows, { dir: 'up' });
  assert.equal(list.length, up.shown);
  assert.ok(list.every((r) => r.change_pct > 0), 'no decliners in the gainers list');

  const down = rankSummary(rows, { dir: 'down', universeLabel: '恒指成分股' });
  assert.equal(down.title, '跌幅榜 Top 10');
  assert.equal(down.countLabel, '');
  assert.match(down.reason, /共 89 隻下跌，只列出前 10 隻/);
  assert.equal(rankStocks(rows, { dir: 'down' }).length, 10);
});

test('ranking summary handles exactly 10, none, a sector scope and an empty universe', () => {
  const ten = rankSummary(sectorRows(10, 4, 0), { dir: 'up' });
  assert.equal(ten.title, '升幅榜 Top 10');
  assert.equal(ten.reason, '');
  assert.equal(ten.short, false);

  const none = rankSummary(sectorRows(0, 12, 3), { dir: 'up', universeLabel: '合資格股票' });
  assert.equal(none.shown, 0);
  assert.match(none.reason, /合資格股票共 15 隻，沒有上升的股票，所以此榜為空；榜單不會以下跌股補位/);
  assert.equal(none.countLabel, '實際 0 隻 · 最多 10 隻');

  const rows = [...sectorRows(7, 1, 0, 'tech'), ...sectorRows(2, 6, 0, 'finance').map((r, i) => ({ ...r, code: `4000${i}` }))];
  const scoped = rankSummary(rows, { dir: 'up', sector: 'finance', sectorLabel: '金融及保險', universeLabel: '合資格股票' });
  assert.equal(scoped.shown, 2);
  assert.match(scoped.reason, /「金融及保險」板塊的合資格股票共 8 隻，只有 2 隻上升（6 隻下跌）/);
  assert.equal(rankStocks(rows, { dir: 'up', sector: 'finance' }).length, 2);

  const empty = rankSummary([], { dir: 'down', universeLabel: '恒指成分股' });
  assert.equal(empty.shown, 0);
  assert.match(empty.reason, /沒有資料/);
  assert.equal(empty.scopeTotal, 0);
});

test('both universes in the sample use the honest headings', () => {
  const hsi = rankSummary(sample.hsi.constituents, { dir: 'up', universeLabel: '恒指成分股' });
  const hk = rankSummary(sample.hk_market.stocks, { dir: 'down', universeLabel: '合資格股票' });
  for (const s of [hsi, hk]) assert.ok(s.shown <= 10 && s.shown === Math.min(s.matching, 10));
  const app = read('movers/app.js');
  assert.match(app, /moversHtml\(rows, [^\n]*view\.members\)/);
  assert.match(read('movers/lib.js'), /members: '恒生指數成分股'/);
  assert.match(app, /'合資格股票'\)\}`;/);
});

test('session clock and polling delays', () => {
  const at = (iso) => new Date(`${iso}+08:00`);
  assert.equal(sessionAt(at('2026-11-20T09:10:00')), 'pre_open');
  assert.equal(sessionAt(at('2026-11-20T10:00:00')), 'morning');
  assert.equal(sessionAt(at('2026-11-20T12:30:00')), 'lunch');
  assert.equal(sessionAt(at('2026-11-20T15:59:59')), 'afternoon');
  assert.equal(sessionAt(at('2026-11-20T16:05:00')), 'closing_auction');
  assert.equal(sessionAt(at('2026-11-20T16:10:00')), 'closed');
  assert.equal(sessionAt(at('2026-11-21T10:00:00')), 'closed', 'Saturday');
  assert.equal(pollDelayMs({ now: at('2026-11-20T10:00:00') }), 60_000);
  assert.equal(pollDelayMs({ now: at('2026-11-20T20:00:00') }), 300_000);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((fails) => pollDelayMs({ now: at('2026-11-20T10:00:00'), fails })), [30000, 60000, 120000, 240000, 300000, 300000]);
});

test('market-open staleness follows the clock, not the snapshot label', () => {
  const at = (iso) => new Date(`${iso}+08:00`);
  assert.equal(STALE_AFTER_MIN.trading, 10);
  const friday = { data_source: 'live', market_session: 'closed', updated_at_hkt: '2026-11-20 16:30:00' };
  assert.equal(isStale(friday, at('2026-11-21T10:00:00')), false, 'weekend: no trading, not late');
  assert.equal(isStale(friday, at('2026-11-23T09:45:00')), true, 'Monday open: Friday snapshot is stale');
  assert.equal(isStale(friday, at('2026-11-23T08:00:00')), false, 'before the open it is still the latest close');
  const live = { data_source: 'live', market_session: 'afternoon', updated_at_hkt: '2026-11-20 14:00:00' };
  assert.equal(isStale(live, at('2026-11-20T14:09:59')), false);
  assert.equal(isStale(live, at('2026-11-20T14:10:01')), true);
  assert.equal(isStale(live, at('2026-11-20T12:30:00')), false, 'lunch break: wider allowance');
  assert.equal(isStale({ ...live, updated_at_hkt: '2026-11-20 11:50:00' }, at('2026-11-20T12:30:00')), true);
  assert.equal(isStale({ ...live, updated_at_hkt: 'garbage' }, at('2026-11-20T14:10:01')), false, 'unreadable time is not guessed');
  assert.equal(fmtAge(0.2), '不足 1 分鐘');
  assert.equal(fmtAge(12), '12 分鐘');
  assert.equal(fmtAge(125), '2 小時 5 分鐘');
  assert.equal(fmtAge(3000), '2 日 2 小時');
  assert.equal(fmtAge(-1), '—');
});

test('refresh acceptance never swaps good live data for demo or an older snapshot', () => {
  const live = (t) => ({ data_source: 'live', updated_at_hkt: t });
  assert.deepEqual(acceptRefresh(null, live('2026-11-20 10:00:00')), { accept: true, changed: true });
  assert.deepEqual(acceptRefresh(live('2026-11-20 10:00:00'), live('2026-11-20 10:06:00')), { accept: true, changed: true });
  assert.deepEqual(acceptRefresh(live('2026-11-20 10:00:00'), live('2026-11-20 10:00:00')), { accept: true, changed: false });
  assert.equal(acceptRefresh(live('2026-11-20 10:00:00'), live('2026-11-20 09:54:00')).kind, 'older');
  const down = acceptRefresh(live('2026-11-20 10:00:00'), { data_source: 'demo', updated_at_hkt: '2026-11-20 16:10:00' });
  assert.equal(down.accept, false);
  assert.equal(down.kind, 'error');
  assert.equal(acceptRefresh({ data_source: 'demo', updated_at_hkt: '2026-11-20 16:10:00' }, live('2026-11-20 10:00:00')).accept, true, 'live replaces demo even with an earlier stamp');
});

test('a refresh keeps the sector and stock only while they still exist', () => {
  const data = { macro_sectors: [{ id: 'tech' }, { id: 'finance' }], hsi: { constituents: [{ code: '00700' }] } };
  assert.deepEqual(reconcileSelection({ sector: 'tech', selected: '00700' }, data), { sector: 'tech', selected: '00700' });
  assert.deepEqual(reconcileSelection({ sector: 'gone', selected: '00005' }, data), { sector: null, selected: null });
  assert.deepEqual(reconcileSelection({}, data), { sector: null, selected: null });
});

test('source: no streaming claims, snapshot wording, honest stale labels', () => {
  const app = read('movers/app.js');
  const html = read('movers/index.html');
  assert.match(app, /快照更新/);
  assert.match(app, /更新失敗/);
  assert.match(app, /快照過時/);
  assert.match(app, /並非最新資料/);
  assert.match(html, /更新快照/);
  assert.match(html, /不是即時串流/);
  assert.match(html, /並非個別股票的報價時間/);
  assert.doesNotMatch(app + html, /即時更新|即時串流報價|LIVE\b/);
});
