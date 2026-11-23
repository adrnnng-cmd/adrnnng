import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { liveDoc } from './movers-fixture.mjs';
import { plan, stampError } from '../asset-versions.mjs';
import { serveSite, startBrowser, types } from './browser-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY = join(root, 'scripts/tests/fixtures/movers-legacy');
const MODULES = /^\/movers\/(app\.js|lib\.js|poll\.js|movers\.css|index\.html)$/;
const SHOT_DIR = process.env.HKM_SHOT_DIR || '';

// ------------------------------------------------------------------ source contract

test('every local script, stylesheet and import of /movers/ and the landing page carries the hash of what it loads', () => {
  assert.equal(stampError(root), '');
  const { versions } = plan(root);
  const html = readFileSync(join(root, 'movers/index.html'), 'utf8');
  for (const path of ['/assets/js/site.js', '/movers/app.js', '/assets/css/theme.css', '/movers/movers.css', '/assets/css/newsletter.css']) {
    assert.ok(html.includes(`"${path}?v=${versions[path]}"`), `${path} is stamped in movers/index.html`);
  }
  const app = readFileSync(join(root, 'movers/app.js'), 'utf8');
  const poll = readFileSync(join(root, 'movers/poll.js'), 'utf8');
  assert.ok(app.includes(`from './lib.js?v=${versions['/movers/lib.js']}'`));
  assert.ok(app.includes(`from './poll.js?v=${versions['/movers/poll.js']}'`));
  assert.ok(poll.includes(`from './lib.js?v=${versions['/movers/lib.js']}'`), 'poll.js and app.js share one lib.js URL, so one module instance');
  assert.notEqual(versions['/movers/app.js'], versions['/movers/lib.js']);
});

test('a change to lib.js moves the URL of lib.js, poll.js and app.js, so no cached neighbour can be paired with it', async (t) => {
  const { cp, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const copy = await mkdtemp(join(tmpdir(), 'movers-graph-'));
  t.after(() => rm(copy, { recursive: true, force: true }));
  for (const dir of ['assets', 'backtest/strategies', 'movers']) await cp(join(root, dir), join(copy, dir), { recursive: true });
  for (const page of ['index.html', 'movers/index.html']) await cp(join(root, page), join(copy, page));
  const before = plan(copy).versions;
  await writeFile(join(copy, 'movers/lib.js'), `${readFileSync(join(copy, 'movers/lib.js'), 'utf8')}\n// edit`);
  const after = plan(copy).versions;
  for (const path of ['/movers/lib.js', '/movers/poll.js', '/movers/app.js']) assert.notEqual(after[path], before[path], path);
  assert.equal(after['/assets/js/site.js'], before['/assets/js/site.js'], 'unrelated modules keep their URL');
  assert.equal(after['/movers/movers.css'], before['/movers/movers.css']);
});

test('movers/index.html carries a classic-script guard that does not depend on the module graph', () => {
  const html = readFileSync(join(root, 'movers/index.html'), 'utf8');
  const guard = html.indexOf('<script>\n');
  assert.ok(guard > 0 && guard < html.indexOf('type="module"'), 'the guard comes before the modules');
  assert.match(html, /dataset\.hkmBoot === 'ready'/);
  assert.match(readFileSync(join(root, 'movers/app.js'), 'utf8'), /dataset\.hkmBoot = 'ready'/);
});

// ------------------------------------------------------------------ real browser with the zone's four-hour cache

const PAGE = `(() => {
  const q = (s) => document.querySelector(s);
  const all = (s) => [...document.querySelectorAll(s)];
  return {
    boot: document.documentElement.dataset.hkmBoot || '',
    loading: !!q('#hkm-body .hkm-loading'),
    loadingText: q('#hkm-body .hkm-loading')?.innerText || '',
    error: q('#hkm-body .hkm-error')?.innerText.replace(/\\s+/g, ' ') || '',
    retry: !!q('[data-retry]'),
    tiles: all('.hm-tile').length,
    rows: all('.hkm-row').length,
    demo: !!q('#hkm-updated .badge-sample'),
    updated: q('#hkm-updated')?.innerText || '',
    notice: q('#hkm-notice')?.innerText.replace(/\\s+/g, ' ') || '',
    clock: q('[data-market-clock]')?.dataset.marketClock || '',
    tab: q('[role=tab][aria-selected=true]')?.dataset.view || '',
    index: q('.hkm-stat .v')?.innerText || '',
    members: all('.hkm-members-table tbody tr').length,
    toggle: q('[data-members-toggle]')?.getAttribute('aria-expanded') || '',
    scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  };
})()`;

const SKEW = `(() => {
  const R = Date;
  window.__skewMs = 0;
  class F extends R {
    constructor(...a) { if (a.length === 0) super(R.now() + window.__skewMs); else super(...a); }
    static now() { return R.now() + window.__skewMs; }
  }
  window.Date = F;
})()`;

async function rig(t, { tree = 'legacy', latest = 'ok' } = {}) {
  const log = [];
  const state = { tree, latest, sample: 'ok', noCache: new Set(), delay: 0, doc: liveDoc({ now: Date.now() - 60_000, session: 'afternoon' }), hits: 0 };
  const server = await serveSite({
    root: () => root,
    log,
    cache: (url) => (state.noCache.has(url.pathname) ? 'no-cache' : null),
    handle: async (url, _req, res) => {
      if (url.pathname === '/movers/data/latest') {
        state.hits += 1;
        if (state.latest === 'hang') return true;
        if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
        if (state.latest === 'fail') return void res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"down"}') || true;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(state.doc));
        return true;
      }
      if (url.pathname === '/movers/data/sample.json' && state.sample === 'fail') {
        return void res.writeHead(503).end() || true;
      }
      if (MODULES.test(url.pathname) || url.pathname === '/movers/') {
        const name = url.pathname === '/movers/' ? 'index.html' : url.pathname.slice('/movers/'.length);
        if (state.tree === 'legacy') {
          res.writeHead(200, { 'content-type': types[name.slice(name.lastIndexOf('.'))], 'cache-control': name === 'index.html' || state.noCache.has(url.pathname) ? 'no-cache' : 'public, max-age=14400' });
          res.end(await readFile(join(LEGACY, 'movers', name)));
          return true;
        }
        if (state.tree === 'unversioned') {
          const text = (await readFile(join(root, 'movers', name), 'utf8')).replace(/\?v=[0-9a-f]{10}/g, '');
          res.writeHead(200, { 'content-type': types[name.slice(name.lastIndexOf('.'))], 'cache-control': name === 'index.html' || state.noCache.has(url.pathname) ? 'no-cache' : 'public, max-age=14400' });
          res.end(text);
          return true;
        }
      }
      return false;
    },
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const browser = await startBrowser(t);
  return { state, log, url: `http://127.0.0.1:${server.address().port}/movers/`, ...browser };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(tab, name) {
  if (!SHOT_DIR) return;
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(SHOT_DIR, { recursive: true });
  const out = await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(SHOT_DIR, `${name}.png`), Buffer.from(out.data, 'base64'));
}

test('cold cache: the first valid snapshot appears by itself, then all three views work with mouse and with touch', { timeout: 90000 }, async (t) => {
  const r = await rig(t, { tree: 'current' });
  const tab = await r.open(r.url, { script: SKEW });
  const first = await tab.waitFor(`(() => { const p = ${PAGE}; return p.tiles >= 90 && p.rows > 0 ? p : null; })()`, 'first snapshot without any interaction');
  assert.equal(first.boot, 'ready');
  assert.equal(first.demo, false, 'live data, not the demo fallback');
  assert.equal(first.loading, false);
  assert.equal(first.tab, 'hsi');
  assert.match(first.index, /22,833\.46/);
  assert.deepEqual(tab.errors, []);
  const versioned = r.log.filter((p) => /\.(js|css)\?v=[0-9a-f]{10}$/.test(p));
  assert.ok(versioned.some((p) => p.startsWith('/movers/app.js?v=')) && versioned.some((p) => p.startsWith('/movers/lib.js?v=')) && versioned.some((p) => p.startsWith('/movers/poll.js?v=')) && versioned.some((p) => p.startsWith('/movers/movers.css?v=')), versioned.join(' '));
  assert.ok(!r.log.some((p) => /^\/movers\/(app|lib|poll)\.js$/.test(p)), 'no unversioned module request');
  await shot(tab, 'movers-firstload-cold-desktop');

  for (const view of ['hstech', 'hk', 'hsi']) {
    await tab.click(`#tab-${view}`);
    const s = await tab.waitFor(`(() => { const p = ${PAGE}; return p.tab === '${view}' && p.tiles > 0 && p.rows > 0 ? p : null; })()`, `${view} view by mouse`);
    assert.equal(s.demo, false);
  }
  await tab.click('#tab-hstech');
  const members = await tab.waitFor(`(() => { const p = ${PAGE}; return p.tab === 'hstech' && p.members > 0 ? p : null; })()`, 'HSTECH table');
  assert.equal(members.members, 10, 'the table still starts collapsed to ten rows');
  await tab.click('[data-members-toggle]');
  const expanded = await tab.waitFor(`(() => { const p = ${PAGE}; return p.toggle === 'true' ? p : null; })()`, 'expand by mouse');
  assert.ok(expanded.members > 10);
  await tab.close();

  const phone = await r.open(r.url, { width: 375, height: 812, mobile: true, touch: true, script: SKEW });
  await phone.waitFor(`(() => { const p = ${PAGE}; return p.tiles >= 90 ? p : null; })()`, 'phone first snapshot');
  for (const view of ['hstech', 'hk', 'hsi']) {
    await phone.tap(`#tab-${view}`);
    await phone.waitFor(`(() => { const p = ${PAGE}; return p.tab === '${view}' && p.tiles > 0 ? p : null; })()`, `${view} view by touch`);
  }
  await phone.tap('#tab-hstech');
  await phone.waitFor(`(() => { const p = ${PAGE}; return p.tab === 'hstech' && p.members === 10 ? p : null; })()`, 'phone table');
  await phone.tap('[data-members-toggle]');
  const open = await phone.waitFor(`(() => { const p = ${PAGE}; return p.toggle === 'true' ? p : null; })()`, 'expand by touch');
  assert.ok(open.members > 10 && open.scroll);
  await shot(phone, 'movers-firstload-cold-mobile');
  assert.deepEqual(phone.errors, []);
});

test('warm old modules (cached four hours) then a release: new HTML pulls a whole new graph, also after normal reloads', { timeout: 90000 }, async (t) => {
  const r = await rig(t, { tree: 'legacy' });
  const before = await r.open(r.url, { script: SKEW });
  const old = await before.waitFor(`(() => { const p = ${PAGE}; return p.tiles >= 90 ? p : null; })()`, 'old page renders');
  assert.equal(old.clock, '', 'the old page has no market-clock badge');
  await before.close();
  assert.ok(r.log.includes('/movers/lib.js') && r.log.includes('/movers/app.js'));

  r.state.tree = 'current';
  r.log.length = 0;
  const tab = await r.open(r.url, { script: SKEW });
  const fresh = await tab.waitFor(`(() => { const p = ${PAGE}; return p.tiles >= 90 && p.clock ? p : null; })()`, 'new page over warm old modules');
  assert.equal(fresh.boot, 'ready');
  assert.deepEqual(tab.errors, []);
  assert.ok(!r.log.some((p) => /^\/movers\/(app|lib|poll)\.js$/.test(p)), 'the warm unversioned modules are not used');
  assert.ok(r.log.some((p) => p.startsWith('/movers/lib.js?v=')));
  for (let i = 1; i <= 2; i++) {
    await tab.reload();
    const again = await tab.waitFor(`(() => { const p = ${PAGE}; return p.tiles >= 90 && p.clock ? p : null; })()`, `normal reload ${i}`);
    assert.equal(again.boot, 'ready');
  }
  assert.deepEqual(tab.errors, []);
});

test('control: modules without version stamps next to a half-expired cache cannot link; the guard says so instead of spinning', { timeout: 90000 }, async (t) => {
  const r = await rig(t, { tree: 'legacy' });
  r.state.noCache.add('/movers/app.js');
  const before = await r.open(r.url, { script: SKEW });
  await before.waitFor(`(() => { const p = ${PAGE}; return p.tiles >= 90 ? p : null; })()`, 'old page renders');
  await before.close();

  r.state.tree = 'unversioned';
  const tab = await r.open(r.url, { script: SKEW });
  const broken = await tab.waitFor(`(() => { const p = ${PAGE}; return p.error ? p : null; })()`, 'guard message', 20000).catch(async (e) => {
    throw new Error(`${e.message}; page now ${JSON.stringify(await tab.evaluate(PAGE))}; log ${r.log.filter((p) => /movers\//.test(p)).join(' ')}`);
  });
  assert.equal(broken.boot, '');
  assert.equal(broken.tiles, 0);
  assert.equal(broken.loading, false, 'no endless spinner');
  assert.match(broken.error, /頁面程式未能載入/);
  assert.match(broken.error, /舊版檔案/);
  assert.match(broken.error, /重新載入/);
  assert.ok(tab.errors.some((e) => /does not provide an export named 'marketStatus'/.test(e)), tab.errors.join(' | '));
  assert.match(broken.updated, /頁面程式未能載入/);
  await shot(tab, 'movers-guard-module-failure');
  await tab.close();

  r.state.tree = 'current';
  const healed = await r.open(r.url, { script: SKEW });
  const ok = await healed.waitFor(`(() => { const p = ${PAGE}; return p.tiles >= 90 ? p : null; })()`, 'the release heals it');
  assert.equal(ok.boot, 'ready');
});

test('slow, hung and failing first loads end in the demo fallback or a retry, say so, and recover to live data by themselves', { timeout: 150000 }, async (t) => {
  const r = await rig(t, { tree: 'current', latest: 'hang' });
  const tab = await r.open(r.url, { script: SKEW });
  const slow = await tab.waitFor(`(() => { const p = ${PAGE}; return p.loadingText.includes('網絡較慢') ? p : null; })()`, 'slow-load wording', 9000);
  assert.match(slow.loadingText, /最長約 20 秒/);
  const demo = await tab.waitFor(`(() => { const p = ${PAGE}; return p.tiles > 0 ? p : null; })()`, 'demo fallback after the live request times out', 16000);
  assert.equal(demo.demo, true, 'labelled as demo data');
  assert.match(demo.index, /23,192\.34/, 'the demo document, not the live one');

  r.state.latest = 'ok';
  await tab.evaluate('window.__skewMs += 31000');
  const live = await tab.waitFor(`(() => { const p = ${PAGE}; return p.tiles > 0 && !p.demo ? p : null; })()`, 'automatic return to live data', 40000);
  assert.match(live.index, /22,833\.46/);
  assert.equal(live.demo, false);
  await tab.close();

  r.state.latest = 'fail';
  r.state.sample = 'fail';
  const down = await r.open(r.url, { script: SKEW });
  const err = await down.waitFor(`(() => { const p = ${PAGE}; return p.error ? p : null; })()`, 'error panel when nothing loads', 30000);
  assert.equal(err.loading, false);
  assert.equal(err.retry, true);
  assert.match(err.error, /暫時無法載入港股異動資料/);
  r.state.latest = 'ok';
  r.state.sample = 'ok';
  await down.click('[data-retry]');
  const back = await down.waitFor(`(() => { const p = ${PAGE}; return p.tiles >= 90 && !p.demo ? p : null; })()`, 'manual retry recovers', 20000);
  assert.equal(back.error, '');

  r.state.latest = 'fail';
  const again = await r.open(r.url, { script: SKEW });
  const fell = await again.waitFor(`(() => { const p = ${PAGE}; return p.tiles > 0 ? p : null; })()`, 'demo after a 503', 20000);
  assert.equal(fell.demo, true);
  r.state.latest = 'ok';
  await again.evaluate('window.__skewMs += 31000');
  await again.waitFor(`(() => { const p = ${PAGE}; return p.tiles > 0 && !p.demo ? p : null; })()`, 'live after the 503 clears', 40000);
});
