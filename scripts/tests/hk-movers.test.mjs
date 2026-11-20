import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  ageMinutes, arrow, breadth, esc, fmtHkd, fmtPct, fmtPrice, heatColor, impactOf, isStale, layoutGroups,
  qualifies, rankStocks, safeUrl, squarify, tone, validateSnapshot, weightedChange,
} from '../../hk-movers/lib.js';
import { KV_KEY, onRequest, pickBinding, serveLatest } from '../../functions/hk-movers/data/latest.js';
import { PUBLIC_DETACH, JSON_NOINDEX, indexingHeaderErrors } from '../headers.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const sample = JSON.parse(read('hk-movers/data/sample.json'));

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

test('staleness: live sessions go stale after 30 minutes, demo never', () => {
  const doc = { data_source: 'live', market_session: 'morning', updated_at_hkt: '2026-11-20 10:00:00' };
  const at = (hhmm) => new Date(`2026-11-20T${hhmm}:00+08:00`);
  assert.equal(Math.round(ageMinutes(doc.updated_at_hkt, at('10:20'))), 20);
  assert.equal(isStale(doc, at('10:20')), false);
  assert.equal(isStale(doc, at('10:45')), true);
  assert.equal(isStale({ ...doc, market_session: 'closed' }, at('23:00')), false);
  assert.equal(isStale({ ...doc, data_source: 'demo' }, at('23:00')), false);
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
  assert.deepEqual(Object.keys(schema.properties.hsi.properties).sort(), ['breadth', 'constituents', 'index', 'turnover_hkd']);
  assert.deepEqual(schema.$defs.stock.required.sort(), ['change_pct', 'code', 'industry', 'last', 'market_cap_hkd', 'name', 'sector', 'turnover_hkd']);
});

// --------------------------------------------------------------- public copy

const PUBLIC_FILES = ['hk-movers/index.html', 'hk-movers/app.js', 'hk-movers/lib.js', 'hk-movers/hk-movers.css', 'hk-movers/data/sample.json', 'functions/hk-movers/data/latest.js'];

test('public HK Movers files name no quote vendor', () => {
  for (const file of PUBLIC_FILES) {
    assert.doesNotMatch(read(file), /\bfutu\b|富途|\byahoo\b|雅虎/i, file);
  }
  assert.doesNotMatch(read('assets/tools.json'), /\bfutu\b|富途|\byahoo\b/i);
});

test('page copy is Traditional Chinese: no simplified-only characters', () => {
  const simplified = /[价涨额汇资业医药网专这们两东车银证债险类盘场营续]/;
  for (const file of ['hk-movers/index.html', 'hk-movers/app.js', 'hk-movers/data/sample.json']) {
    const hit = read(file).match(simplified);
    assert.equal(hit, null, `${file} has ${hit}`);
  }
});

test('page markup carries the shared chrome, brand mark, author and required labels', () => {
  const html = read('hk-movers/index.html');
  assert.match(html, /<title>港股異動與板塊熱力圖 · News Chart<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/news-chart\.com\/hk-movers\/"/);
  assert.match(html, /property="og:url" content="https:\/\/news-chart\.com\/hk-movers\/"/);
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
  const app = read('hk-movers/app.js');
  assert.match(app, /target="_blank" rel="noopener noreferrer"/);
  assert.match(app, /暫無相關新聞/);
  assert.match(app, /safeUrl\(item\.url\)/);
  assert.match(app, /升幅榜 Top 10/);
  assert.match(app, /跌幅榜 Top 10/);
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
    assert.equal(new URL(url).pathname, '/hk-movers/data/sample.json');
    return new Response(JSON.stringify(sample), { status: 200 });
  },
});
const LIVE = JSON.stringify({ ...sample, data_source: 'live', updated_at_hkt: '2026-11-20 11:00:00' });
const URL_ = 'https://news-chart.com/hk-movers/data/latest';

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
  assert.deepEqual(routes.include, ['/backtest/data/hsi/*', '/hk-movers/data/latest']);
});

test('registry, sitemap, headers and llms.txt know the page', () => {
  const reg = JSON.parse(read('assets/tools.json'));
  const tool = reg.tools.find((t) => t.id === 'hk-movers');
  assert.equal(tool.href, '/hk-movers/');
  assert.equal(tool.chrome, 'shared');
  assert.equal(tool.nav, true);
  assert.equal(tool.owner, 'repo');
  assert.match(read('sitemap-pages.xml'), /<loc>https:\/\/news-chart\.com\/hk-movers\/<\/loc>/);
  assert.match(read('llms.txt'), /hk-movers/);
  for (const path of ['/hk-movers', '/hk-movers/', '/hk-movers/*']) assert.ok(PUBLIC_DETACH.includes(path), path);
  for (const path of ['/hk-movers/data/latest', '/hk-movers/data/sample.json']) assert.ok(JSON_NOINDEX.includes(path), path);
  assert.deepEqual(indexingHeaderErrors(read('_headers')), []);
});

test('every file the page ships stays plain static: no build step, no external scripts', () => {
  const files = readdirSync(new URL('../../hk-movers/', import.meta.url), { recursive: true });
  assert.ok(files.includes('index.html') && files.includes('app.js') && files.includes('lib.js'));
  assert.doesNotMatch(read('hk-movers/index.html'), /<script[^>]+src="https?:/);
});
