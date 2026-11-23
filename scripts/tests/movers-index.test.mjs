import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_MEMBER_SORT, MEMBER_COLUMNS, ariaSort, memberStats, nextSort, reconcileSelection, returnRefs, rosterNotes,
  shortRefDate, sortAnnouncement, sortMembers, validateSnapshot,
} from '../../movers/lib.js';
import { onRequest as latestNew } from '../../functions/movers/data/latest.js';
import { onRequest as latestOld } from '../../functions/hk-movers/data/latest.js';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const sample = JSON.parse(read('movers/data/sample.json'));
const clone = () => JSON.parse(JSON.stringify(sample));

const member = (code, extra = {}) => ({
  code, name: `股${code}`, weight_pct: 1, available: true, last: 10, prev_close: 10, change_pct: 0, ret_5d: 0, ret_1m: 0, ret_ytd: 0,
  market_cap_hkd: 1e9, ...extra,
});
const codes = (list) => list.map((m) => m.code);

// -------------------------------------------------------------------- sorting

test('sortMembers: numeric, both directions, nulls always last, ties keep the official order', () => {
  const list = [
    member('00001', { ret_5d: 2.5 }),
    member('00002', { ret_5d: null }),
    member('00003', { ret_5d: -1 }),
    member('00004', { ret_5d: 2.5 }),
    member('00005', { ret_5d: 10 }),
    member('00006', { available: false, ret_5d: null }),
    member('00007', { ret_5d: 0 }),
  ];
  assert.deepEqual(codes(sortMembers(list, { key: 'd5', dir: 'desc' })), ['00005', '00001', '00004', '00007', '00003', '00002', '00006']);
  assert.deepEqual(codes(sortMembers(list, { key: 'd5', dir: 'asc' })), ['00003', '00007', '00001', '00004', '00005', '00002', '00006'],
    'ties 00001/00004 stay in roster order when ascending too; nulls stay last');
  assert.deepEqual(codes(list), ['00001', '00002', '00003', '00004', '00005', '00006', '00007'], 'input is not mutated');
});

test('sortMembers is numeric, not lexical, and ignores NaN and Infinity as unavailable', () => {
  const list = [member('00001', { market_cap_hkd: 9e9 }), member('00002', { market_cap_hkd: 10e9 }), member('00003', { market_cap_hkd: NaN }),
    member('00004', { market_cap_hkd: Infinity }), member('00005', { market_cap_hkd: 100e9 })];
  assert.deepEqual(codes(sortMembers(list, { key: 'cap', dir: 'desc' })), ['00005', '00002', '00001', '00003', '00004']);
  assert.deepEqual(codes(sortMembers(list, { key: 'cap', dir: 'asc' })), ['00001', '00002', '00005', '00003', '00004']);
});

test('every table column sorts the value it shows', () => {
  const a = member('00001', { weight_pct: 5, change_pct: 1, ret_5d: 2, ret_1m: 3, ret_ytd: 4, last: 50, market_cap_hkd: 7e9 });
  const b = member('00002', { weight_pct: 6, change_pct: 0.5, ret_5d: 1, ret_1m: 9, ret_ytd: 1, last: 5, market_cap_hkd: 9e9 });
  const want = { weight: ['00002', '00001'], d1: ['00001', '00002'], d5: ['00001', '00002'], m1: ['00002', '00001'], ytd: ['00001', '00002'], last: ['00001', '00002'], cap: ['00002', '00001'] };
  assert.deepEqual(MEMBER_COLUMNS.map((c) => c.id), Object.keys(want));
  for (const [key, order] of Object.entries(want)) {
    assert.deepEqual(codes(sortMembers([a, b], { key, dir: 'desc' })), order, key);
    assert.deepEqual(codes(sortMembers([a, b], { key, dir: 'asc' })), [...order].reverse(), `${key} asc`);
  }
  assert.deepEqual(codes(sortMembers([a, b], { key: 'nope', dir: 'desc' })), ['00002', '00001'], 'unknown key falls back to weight');
});

test('header clicks: same column flips, a new column starts high to low, aria-sort follows', () => {
  let sort = DEFAULT_MEMBER_SORT;
  assert.deepEqual(sort, { key: 'weight', dir: 'desc' });
  sort = nextSort(sort, 'weight');
  assert.deepEqual(sort, { key: 'weight', dir: 'asc' });
  sort = nextSort(sort, 'weight');
  assert.deepEqual(sort, { key: 'weight', dir: 'desc' });
  sort = nextSort(sort, 'd5');
  assert.deepEqual(sort, { key: 'd5', dir: 'desc' });
  sort = nextSort(sort, 'd5');
  assert.equal(ariaSort(sort, 'd5'), 'ascending');
  assert.equal(ariaSort(sort, 'weight'), 'none');
  assert.equal(ariaSort({ key: 'cap', dir: 'desc' }, 'cap'), 'descending');
  assert.deepEqual(nextSort(sort, 'unknown'), sort);
  assert.match(sortAnnouncement({ key: 'ytd', dir: 'asc' }), /年初至今.*由低至高.*最後/);
  assert.match(sortAnnouncement({ key: 'ytd', dir: 'desc' }), /由高至低/);
});

// ------------------------------------------------------- reference labels, notes

test('returnRefs labels the three reference dates and says so when history is missing', () => {
  const refs = returnRefs({ basis: 'adjusted_close', as_of: '2026-11-20', d5: '2026-11-13', m1: '2026-10-20', ytd: '2025-12-31' });
  assert.equal(refs.available, true);
  assert.match(refs.note, /5日：相對 2026-11-13 收市價/);
  assert.match(refs.note, /1個月：相對 2026-10-20 收市價/);
  assert.match(refs.note, /年初至今：相對 2025-12-31 收市價/);
  assert.match(refs.note, /前復權收市價/);
  assert.match(refs.note, /最新交易日 2026-11-20/);
  assert.equal(shortRefDate('2026-11-13', '2026-11-20'), '11-13');
  assert.equal(shortRefDate('2025-12-31', '2026-11-20'), '2025-12-31');
  assert.equal(shortRefDate('garbage', '2026-11-20'), '');

  const none = returnRefs(undefined);
  assert.equal(none.available, false);
  assert.match(none.note, /尚未提供/);
  const partial = returnRefs({ as_of: '2026-11-20', d5: '2026-11-13', m1: null, ytd: 'bad' });
  assert.match(partial.note, /1個月：歷史資料不足/);
  assert.match(partial.note, /年初至今：歷史資料不足/);
});

test('rosterNotes: the announced roster is described as not yet in effect', () => {
  const tech = rosterNotes(sample.hstech.roster, '恒生科技指數');
  assert.match(tech.basis, /30 隻/);
  assert.match(tech.basis, /截至 2026-11-18（指數檢討前）/);
  assert.match(tech.upcoming, /2026-12-07/);
  assert.match(tech.upcoming, /由 30 隻調整為 50 隻（新增 20 隻）/);
  assert.match(tech.upcoming, /尚未生效/);
  const hsi = rosterNotes(sample.hsi.roster, '恒生指數');
  assert.match(hsi.upcoming, /名單不變（95 隻）/);
  assert.deepEqual(rosterNotes(null, 'x'), { basis: '', upcoming: '' });
  assert.equal(rosterNotes({ ...sample.hsi.roster, upcoming: null }, 'x').upcoming, '');
});

test('memberStats counts unavailable members without dropping them', () => {
  const list = [member('00001'), member('00002', { available: false, last: null }), member('00003', { last: null })];
  assert.deepEqual(memberStats(list), { total: 3, priced: 1, missing: 2 });
  assert.deepEqual(memberStats(undefined), { total: 0, priced: 0, missing: 0 });
});

// --------------------------------------------------------------- the sample

test('sample: official rosters, every member present, current weights only', () => {
  assert.equal(validateSnapshot(sample).ok, true, validateSnapshot(sample).errors.join('; '));
  assert.equal(sample.hsi.members.length, 95);
  assert.equal(sample.hstech.members.length, 30);
  assert.equal(sample.hstech.roster.upcoming.count, 50);
  assert.equal(new Set(sample.hsi.members.map((m) => m.code)).size, 95);
  for (const key of ['hsi', 'hstech']) {
    const total = sample[key].members.reduce((t, m) => t + m.weight_pct, 0);
    assert.ok(Math.abs(total - 100) < 0.35, `${key} weights sum to about 100, got ${total}`);
    const sorted = [...sample[key].members].sort((a, b) => b.weight_pct - a.weight_pct);
    assert.deepEqual(codes(sample[key].members), codes(sorted), `${key} members are in official weight order`);
  }
  assert.equal(sample.hsi.members[0].code, '00005', 'HSBC is the largest current HSI weight');
  assert.equal(sample.hsi.members[0].weight_pct, 7.37);
  assert.equal(sample.hstech.members.some((m) => m.code === '09678'), false, 'announced HSTECH additions are not in the current roster');
  assert.equal(sample.hstech.roster.upcoming.added.includes('09678'), true);
});

test('sample: the unavailable HSTECH member is listed, null-valued, and absent from the ranked universe', () => {
  const missing = sample.hstech.members.filter((m) => m.available === false);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].code, '01698');
  assert.ok(MEMBER_COLUMNS.every((c) => c.id === 'weight' || c.get(missing[0]) === null));
  assert.equal(sample.hstech.constituents.some((r) => r.code === '01698'), false);
  assert.equal(sample.hstech.constituents.length, 29);
  assert.equal(sample.hstech.breadth.up + sample.hstech.breadth.down + sample.hstech.breadth.flat, 29);
});

test('sample: HSTECH movers come from the HSTECH universe and are never padded', () => {
  const rows = new Set(sample.hstech.constituents.map((r) => r.code));
  for (const side of ['gainers', 'losers']) {
    const list = sample.movers.hstech[side];
    assert.ok(list.length <= 10);
    assert.ok(list.every((r) => rows.has(r.code)), side);
    assert.ok(list.every((r) => (side === 'gainers' ? r.change_pct > 0 : r.change_pct < 0)), side);
  }
  assert.ok(sample.movers.hstech.losers.length < 10, 'only a few HSTECH members fall, so the list is short rather than padded');
});

test('sample: the index universes ignore the HK-market filters', () => {
  for (const key of ['hsi', 'hstech']) {
    const memberCodes = new Set(sample[key].members.map((m) => m.code));
    assert.ok(sample[key].constituents.every((r) => memberCodes.has(r.code)), `${key}: every ranked row is in the full table`);
  }
  const app = read('movers/app.js');
  assert.doesNotMatch(app, /qualifies/, 'the page never re-applies the HK filters to an index view');
  assert.equal(sample.hk_market.filters.min_turnover_hkd, 10_000_000);
  assert.equal(sample.hk_market.filters.min_market_cap_hkd, 1_000_000_000);
});

// ----------------------------------------------------------------- validation

test('validation: hstech and the extras are optional and checked when present', () => {
  const old = clone();
  delete old.hstech;
  delete old.returns;
  delete old.movers.hstech;
  delete old.hsi.members;
  delete old.hsi.roster;
  assert.equal(validateSnapshot(old).ok, true, 'a document from an older collector still validates');

  let d = clone();
  delete d.movers.hstech;
  assert.equal(validateSnapshot(d).ok, false, 'an hstech block needs its mover lists');

  d = clone();
  d.hstech.index.last = null;
  d.hstech.index.change_pct = null;
  assert.equal(validateSnapshot(d).ok, true, 'a missing HSTECH index quote is allowed');
  d = clone();
  d.hsi.index.last = null;
  assert.equal(validateSnapshot(d).ok, false, 'the HSI index quote stays mandatory');

  d = clone();
  d.hstech.members[0].weight_pct = '7.3';
  assert.equal(validateSnapshot(d).ok, false);
  d = clone();
  d.hstech.members[0].ret_5d = NaN;
  assert.equal(validateSnapshot(d).ok, false);
  d = clone();
  d.hstech.members[0].code = '700';
  assert.equal(validateSnapshot(d).ok, false);
  d = clone();
  d.returns.d5 = 'last friday';
  assert.equal(validateSnapshot(d).ok, false);
  d = clone();
  d.hstech.roster.weights_as_of = '18/11/2026';
  assert.equal(validateSnapshot(d).ok, false);
  d = clone();
  d.hstech.members[1].ret_ytd = null;
  assert.equal(validateSnapshot(d).ok, true, 'null returns are valid');
});

test('reconcileSelection is per view', () => {
  const data = { macro_sectors: [{ id: 'tech' }], hsi: { constituents: [{ code: '00700' }] }, hstech: { constituents: [{ code: '09988' }] } };
  assert.deepEqual(reconcileSelection({ sector: 'tech', selected: '09988' }, data, 'hstech'), { sector: 'tech', selected: '09988' });
  assert.deepEqual(reconcileSelection({ sector: 'tech', selected: '09988' }, data, 'hsi'), { sector: 'tech', selected: null });
  assert.deepEqual(reconcileSelection({ sector: 'tech', selected: '00700' }, data, 'hk'), { sector: 'tech', selected: null });
  assert.deepEqual(reconcileSelection({ selected: '09988' }, { macro_sectors: [], hsi: data.hsi }, 'hstech'), { sector: null, selected: null });
});

// ------------------------------------------------------- URLs, redirects, feed

test('redirects: the old page goes to /movers/ once, nothing loops, the data function stays live', () => {
  const rules = read('_redirects').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
  const hk = rules.filter(([from]) => from.startsWith('/hk-movers'));
  assert.deepEqual(hk, [['/hk-movers', '/movers/', '301'], ['/hk-movers/', '/movers/', '301'], ['/hk-movers/data/sample.json', '/movers/data/sample.json', '301']]);
  const sources = new Set(rules.map(([from]) => from));
  for (const [, to] of hk) assert.equal(sources.has(to), false, `${to} must not itself redirect`);
  assert.equal(rules.some(([from]) => from === '/movers' || from === '/movers/'), false, 'the canonical URL is never a redirect source');
  assert.equal(rules.some(([from]) => from.startsWith('/hk-movers/data/latest')), false, 'the live feed is not redirected');
  assert.equal(rules.some(([from]) => /\*/.test(from) && from.startsWith('/hk-movers')), false, 'no splat that could capture the feed');
  const routes = JSON.parse(read('_routes.json'));
  assert.ok(routes.include.includes('/movers/data/latest') && routes.include.includes('/hk-movers/data/latest'));
});

test('canonical /movers/ everywhere users or crawlers look; the old URL only in the redirect and compat files', () => {
  const page = read('movers/index.html');
  assert.match(page, /<link rel="canonical" href="https:\/\/news-chart\.com\/movers\/">/);
  assert.match(page, /property="og:url" content="https:\/\/news-chart\.com\/movers\/"/);
  assert.match(read('sitemap-pages.xml'), /<loc>https:\/\/news-chart\.com\/movers\/<\/loc>/);
  assert.doesNotMatch(read('sitemap-pages.xml'), /hk-movers/);
  assert.doesNotMatch(read('llms.txt'), /hk-movers/);
  assert.doesNotMatch(read('assets/tools.json'), /hk-movers/);
  assert.doesNotMatch(read('assets/js/home.js'), /hk-movers/);
  assert.doesNotMatch(page, /hk-movers/);
  for (const file of ['movers/app.js', 'movers/lib.js', 'movers/poll.js', 'movers/movers.css']) assert.doesNotMatch(read(file), /\/hk-movers\//, file);
});

test('both feed URLs serve the same document from the same KV key', async () => {
  const doc = clone();
  const kv = { get: async (key) => (key === 'hk-movers:latest.json' ? JSON.stringify(doc) : null) };
  const ctx = (path) => ({ request: new Request(`https://news-chart.com${path}`), env: { HK_MOVERS: kv } });
  const [a, b] = await Promise.all([latestNew(ctx('/movers/data/latest')), latestOld(ctx('/hk-movers/data/latest'))]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(await a.json(), doc);
  assert.deepEqual(await b.json(), doc);
  assert.equal(a.headers.get('x-hk-movers-source'), 'kv:HK_MOVERS');
  assert.equal(b.headers.get('x-hk-movers-source'), 'kv:HK_MOVERS');
});

test('both feed URLs fall back to the same demo file when KV is empty', async () => {
  const bad = async (path) => latestOld({
    request: new Request(`https://news-chart.com${path}`),
    env: {
      ASSETS: {
        async fetch(url) {
          assert.equal(new URL(url).pathname, '/movers/data/sample.json');
          return new Response(JSON.stringify(sample), { status: 200 });
        },
      },
    },
  });
  const res = await bad('/hk-movers/data/latest');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-hk-movers-source'), 'demo');
  assert.equal((await res.json()).data_source, 'demo');
});
