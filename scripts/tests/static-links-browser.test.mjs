import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PUBLIC_LINKS } from '../../assets/js/chrome-html.js';

// Real Chrome against the committed files: with scripting off (what a crawler without JS sees), with scripting on
// (no duplicate, no disappearing link, no overflow, same layout), and with browser caches from before this change.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OLD = join(root, 'scripts/tests/fixtures/pre-static');
const SHOT_DIR = process.env.STATIC_SHOT_DIR || '';
const CANONICAL = ['/backtest/', '/movers/', '/politician-tracker/', '/news/'];
const PUBLIC = PUBLIC_LINKS.map((link) => link.href);
const FOOTER = [...CANONICAL, ...PUBLIC, '/about/'];

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function chromePath() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { await stat(p); return p; } catch { /* next */ }
  }
  return '';
}

/**
 * `state` says which generation of each file the server hands out. JavaScript is served with the four-hour max-age
 * the zone applies, so a module that a visitor already holds is not asked for again.
 */
function serve(state, requests) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    const send = (body, path, cache) => {
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': cache });
      res.end(body);
    };
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(await readFile(state.html === 'old' ? join(OLD, 'index.html') : join(root, 'index.html')), 'x.html', 'no-cache');
      }
      if (url.pathname === '/assets/tools.json') {
        const reg = JSON.parse(await readFile(join(root, 'assets/tools.json'), 'utf8'));
        if (state.registry === 'extra') {
          reg.tools.splice(3, 0, { id: 'fx-lab', title: 'FX Lab', href: '/fx-lab/', status: 'beta', nav: true, summary: 'Currency pairs.', category: 'Tools' });
        }
        return send(JSON.stringify(reg), 'x.json', 'no-cache');
      }
      if (url.pathname === '/assets/js/site.js' && state.site === 'old') return send(await readFile(join(OLD, 'site.js')), 'x.js', 'public, max-age=14400');
      if (url.pathname === '/assets/js/home.js' && state.home === 'old') return send(await readFile(join(OLD, 'home.js')), 'x.js', 'public, max-age=14400');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const abs = normalize(join(root, rel));
      if (!abs.startsWith(root)) return void res.writeHead(403).end();
      const cache = rel.startsWith('/assets/js/') ? 'public, max-age=14400' : 'no-cache';
      return send(await readFile(abs), abs, cache);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function cdp(ws, onEvent) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) onEvent?.(msg);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function launch(t, state = { html: 'new', site: 'new', home: 'new', registry: 'current' }) {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required for the static-link check. Set CHROME_PATH.');
  const requests = [];
  const server = await serve(state, requests);
  const profile = await mkdtemp(join(tmpdir(), 'static-links-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let debugPort = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not open a debugging port')), 15000);
    proc.stderr.on('data', (buf) => {
      const m = String(buf).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { debugPort = Number(m[1]); clearTimeout(timer); resolve(); }
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited ${code} before the debugging port opened`)));
  });
  t.after(async () => {
    proc.kill('SIGKILL');
    await new Promise((resolve) => (proc.exitCode != null || proc.signalCode != null ? resolve() : proc.once('exit', resolve)));
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await ready;
  if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A fresh tab in the same profile, so the HTTP cache carries over between visits. */
  async function tab({ path = '/', width = 1280, height = 900, mobile = false, noScript = false, watch = false, ignoreCache = false } = {}) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const errors = [];
    const send = cdp(ws, (msg) => {
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/Failed to load resource/.test(msg.params.entry.text)) errors.push(msg.params.entry.text);
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (noScript) await send('Emulation.setScriptExecutionDisabled', { value: true });
    if (watch) {
      // Records, from the first parsed byte, every time one of the chrome links is removed from the page, and the
      // largest number of copies of each link that ever existed at once.
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        window.__removed = []; window.__max = {};
        const sel = '#tools a.door, [data-site-header] a, [data-site-footer] a';
        const count = () => {
          const seen = {};
          for (const a of document.querySelectorAll(sel)) { const k = (a.closest('[data-site-header]') ? 'h:' : a.closest('[data-site-footer]') ? 'f:' : 'd:') + a.getAttribute('href'); seen[k] = (seen[k] || 0) + 1; }
          for (const [k, n] of Object.entries(seen)) window.__max[k] = Math.max(window.__max[k] || 0, n);
        };
        new MutationObserver((recs) => {
          for (const r of recs) for (const n of r.removedNodes) {
            if (n.nodeType !== 1) continue;
            const hit = n.matches?.(sel) ? [n] : [...(n.querySelectorAll?.(sel) || [])];
            for (const a of hit) window.__removed.push(a.getAttribute('href'));
          }
          count();
        }).observe(document, { childList: true, subtree: true });
      })();` });
    }
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    const waitFor = async (expression, label, ms = 15000) => {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end) {
        last = await evaluate(expression);
        if (last) return last;
        await settle(100);
      }
      throw new Error(`${label} never happened; last ${JSON.stringify(last)}`);
    };
    const mark = requests.length;
    if (ignoreCache) await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.navigate', { url: base + path });
    const close = async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
    };
    const shot = async (name, { full = false } = {}) => {
      if (!SHOT_DIR) return;
      const clip = full ? await send('Page.getLayoutMetrics').then((m) => ({ x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 3200), scale: 1 })) : undefined;
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, clip });
      await writeFile(join(SHOT_DIR, name), Buffer.from(data, 'base64'));
    };
    return { send, evaluate, waitFor, close, shot, errors, requests: () => requests.slice(mark), base };
  }
  return { tab, state, requests, base };
}

const SNAPSHOT = `(() => {
  const hrefs = (sel) => [...document.querySelectorAll(sel)].map((a) => a.getAttribute('href'));
  const doors = [...document.querySelectorAll('#tools a.door')];
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  return {
    doors: hrefs('#tools a.door'),
    header: hrefs('[data-site-header] a'),
    footer: hrefs('[data-site-footer] a'),
    toggles: document.querySelectorAll('[data-site-header] .nav-toggle').length,
    boxes: document.querySelectorAll('[data-site-header] a.box').length,
    names: doors.map((a) => a.querySelector('h2')?.firstChild?.textContent.trim()),
    bodies: doors.map((a) => a.querySelectorAll('[data-door-body]').length),
    xs: [...new Set(doors.map((a) => rect(a).x))].length,
    rects: doors.map(rect),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    masthead: rect(document.querySelector('[data-site-header]')),
    footerRect: rect(document.querySelector('[data-site-footer]')),
    date: document.querySelector('[data-site-header] .d')?.textContent || '',
  };
})()`;

const hydrated = `document.querySelector('[data-site-header] .d')?.textContent.includes('HKT') && document.querySelectorAll('#tools .door-photo img').length === 4 && [...document.querySelectorAll('#tools .door-photo img')].every((i) => i.complete) && document.querySelector('[data-site-footer] .row')`;

const dupes = (list) => list.filter((h, i) => list.indexOf(h) !== i);

test('scripting off: the home page shows and follows real links to all four sections, desktop and phone', { timeout: 120000 }, async (t) => {
  const { tab, base } = await launch(t);
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 375, height: 812, mobile: true }]]) {
    const page = await tab({ ...vp, noScript: true });
    await page.waitFor(`document.readyState === 'complete'`, 'load');
    await settle(800);
    assert.equal(await page.evaluate(`typeof window.__x + String(document.querySelector('[data-site-header] .d')?.textContent)`), 'undefined', 'no script ran');
    const s = await page.evaluate(SNAPSHOT);
    assert.deepEqual(s.doors, CANONICAL, name);
    assert.deepEqual(s.footer, FOOTER, name);
    assert.ok(s.header.includes('/news/') && s.header.includes('/'), name);
    assert.equal(s.overflow, 0, `${name}: no horizontal scroll`);
    assert.equal(s.xs, name === 'desktop' ? 2 : 1, `${name}: two columns on desktop, one on phone`);
    assert.ok(s.rects.every((r) => r.w > 150 && r.h > 100), 'every card has a real size');
    await page.shot(`nojs-${name}.png`);
    // A visible, clickable card: take the Movers one and follow it with a real click.
    await page.evaluate(`document.documentElement.style.scrollBehavior = 'auto'; document.querySelector('#tools a.door[href="/movers/"]').scrollIntoView({ block: 'center' }); true`);
    await settle(500);
    const pt = await page.evaluate(`(() => { const r = document.querySelector('#tools a.door[href="/movers/"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 30 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await page.waitFor(`location.pathname === '/movers/' && document.readyState === 'complete'`, `${name}: Movers opens`);
    const next = await page.evaluate(SNAPSHOT.replace("doors: hrefs('#tools a.door'),", "doors: [],"));
    assert.deepEqual(next.footer, [], `${name}: /movers/ keeps the live empty footer with scripting off`);
    await page.close();
  }
  const res = await fetch(`${base}/`);
  const raw = await res.text();
  for (const href of CANONICAL) assert.ok(raw.includes(`href="${href}"`), `the served bytes contain ${href}`);
});

test('scripting on: links stay where they are, none is duplicated or removed, layout and Menu are unchanged', { timeout: 120000 }, async (t) => {
  const { tab } = await launch(t);
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 375, height: 812, mobile: true }]]) {
    // The same page with scripting off is the baseline for where things sit before the script runs.
    const bare = await tab({ ...vp, noScript: true });
    await bare.waitFor(`document.readyState === 'complete'`, 'load');
    await settle(500);
    const before = await bare.evaluate(SNAPSHOT);
    await bare.close();

    const page = await tab({ ...vp, watch: true });
    await page.waitFor(hydrated, `${name}: hydrated`);
    await settle(600);
    const s = await page.evaluate(SNAPSHOT);
    assert.deepEqual(s.doors, CANONICAL, name);
    assert.deepEqual(s.footer, FOOTER, name);
    assert.deepEqual(dupes(s.header), [], `${name}: no duplicate header link`);
    assert.equal(s.toggles, 1, 'one Menu button');
    assert.equal(s.boxes, 1, 'one Morning Report box');
    assert.deepEqual(s.names, ['Backtest', 'Movers', 'Politician Tracker', 'Morning Report']);
    assert.deepEqual(s.bodies, [1, 1, 1, 1], 'one body per card');
    assert.equal(s.overflow, 0, `${name}: no horizontal scroll`);
    assert.equal(s.xs, name === 'desktop' ? 2 : 1, `${name}: columns`);
    assert.match(s.date, /HKT/);
    const removed = await page.evaluate('window.__removed');
    assert.deepEqual(removed.filter((h) => CANONICAL.includes(h) && !h.startsWith('#')).sort(), [], `${name}: no card or chrome link was ever removed from the page`);
    const maxes = await page.evaluate('window.__max');
    for (const [key, n] of Object.entries(maxes)) assert.equal(n, 1, `${name}: ${key} existed ${n} times at once`);
    assert.equal(s.masthead.h, before.masthead.h, `${name}: masthead height does not move`);
    assert.ok(s.rects.every((r, i) => Math.abs(r.h - before.rects[i].h) <= 16), `${name}: card heights stay within 16px of the no-script layout`);
    assert.deepEqual(s.rects.map((r) => [r.x, r.w]), before.rects.map((r) => [r.x, r.w]), `${name}: cards keep their columns and widths`);
    assert.deepEqual(page.errors, [], `${name}: no script error`);
    await page.shot(`js-${name}.png`);

    if (name === 'phone') {
      const closed = await page.evaluate(`getComputedStyle(document.querySelector('[data-site-header] .mast-r')).display`);
      assert.equal(closed, 'none', 'Menu starts closed on a phone');
      await page.evaluate(`document.querySelector('[data-site-header] .nav-toggle').click(); true`);
      const open = await page.evaluate(`({ d: getComputedStyle(document.querySelector('[data-site-header] .mast-r')).display, x: document.querySelector('.nav-toggle').getAttribute('aria-expanded') })`);
      assert.notEqual(open.d, 'none', 'Menu opens');
      assert.equal(open.x, 'true');
      await page.shot('js-phone-menu-open.png');
      await page.evaluate(`document.querySelector('[data-site-header] .nav-toggle').click(); true`);
      assert.equal(await page.evaluate(`document.querySelector('.nav-toggle').getAttribute('aria-expanded')`), 'false');
    } else {
      const show = await page.evaluate(`({ nav: getComputedStyle(document.querySelector('[data-site-header] .mast-r')).display, tog: getComputedStyle(document.querySelector('.nav-toggle')).display })`);
      assert.notEqual(show.nav, 'none');
      assert.equal(show.tog, 'none', 'no hamburger on desktop');
    }
    await page.close();
  }
});

test('an empty shared shell still receives the same scripted header and footer, with the current page marked', { timeout: 120000 }, async (t) => {
  const { tab } = await launch(t);
  const page = await tab({ path: '/backtest/', width: 390, height: 844, mobile: true });
  await page.waitFor(`document.querySelector('[data-site-header] .d')?.textContent.includes('HKT')`, 'header hydrated');
  await settle(500);
  const s = await page.evaluate(`({ header: [...document.querySelectorAll('[data-site-header] a')].map((a) => a.getAttribute('href')), footer: [...document.querySelectorAll('[data-site-footer] .row a')].map((a) => a.getAttribute('href')), current: [...document.querySelectorAll('[aria-current="page"]')].map((a) => a.getAttribute('href')), toggles: document.querySelectorAll('.nav-toggle').length })`);
  assert.deepEqual(dupes(s.header), []);
  assert.deepEqual(s.footer, CANONICAL);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('[data-site-footer] .fine a')].map((a) => a.getAttribute('href'))`), ['/about/']);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('[data-site-footer] .site-links a')].map((a) => a.textContent + '>' + a.getAttribute('href') + '>' + a.getAttribute('target') + '>' + a.getAttribute('rel'))`), PUBLIC_LINKS.map((link) => `${link.label}>${link.href}>_blank>noopener noreferrer`));
  assert.deepEqual(s.current, ['/backtest/']);
  assert.equal(s.toggles, 1);
  await page.close();
});

test('caches from before the change: old script + new HTML, new script + old HTML, a registry with an extra tool', { timeout: 180000 }, async (t) => {
  const state = { html: 'old', site: 'old', home: 'old', registry: 'current' };
  const { tab, requests } = await launch(t, state);
  const visit = async (extra = {}) => {
    const page = await tab({ watch: true, ...extra });
    await page.waitFor(`document.querySelectorAll('#tools .door').length === 4 && document.querySelector('[data-site-header] .d')?.textContent.includes('HKT') && document.querySelectorAll('#tools .door-photo img').length === 4`, 'rendered');
    await settle(900);
    const s = await page.evaluate(SNAPSHOT);
    const max = await page.evaluate('window.__max');
    const errors = page.errors;
    const used = page.requests();
    await page.close();
    return { s, max, errors, used };
  };

  // 1. The release before this one: empty header/footer/doors in the HTML, old scripts. They are now in the HTTP cache.
  const v1 = await visit();
  assert.deepEqual(v1.s.doors, CANONICAL);
  assert.ok(v1.used.includes('/assets/js/site.js') && v1.used.some((u) => u.startsWith('/assets/js/home.js')), 'old modules fetched and cached');

  // 2. Release: new HTML (with static links and a new home.js URL) while the browser still holds the old site.js.
  state.html = 'new';
  state.site = 'new';
  state.home = 'new';
  const v2 = await visit();
  assert.ok(!v2.used.includes('/assets/js/site.js'), 'the warm old site.js really was reused');
  assert.deepEqual(v2.s.doors, CANONICAL);
  assert.deepEqual(v2.s.footer, CANONICAL);
  assert.deepEqual(dupes(v2.s.header), []);
  assert.equal(v2.s.toggles, 1);
  assert.deepEqual(v2.errors, []);
  for (const [k, n] of Object.entries(v2.max)) assert.equal(n, 1, `${k} existed ${n} times`);

  // 3. A later visit: everything new and cached together.
  const v3 = await visit();
  assert.deepEqual(v3.s.doors, CANONICAL);
  assert.deepEqual(v3.errors, []);

  // 4. New scripts, but a stale HTML copy with empty regions (an intermediary or a deploy in progress).
  state.html = 'old';
  const v4 = await visit();
  assert.deepEqual(v4.s.doors, CANONICAL, 'doors are rebuilt by the script when the HTML has none');
  assert.deepEqual(v4.s.footer, CANONICAL);
  assert.ok(v4.s.header.includes('/news/'));
  assert.equal(v4.s.toggles, 1);
  assert.deepEqual(dupes(v4.s.header), []);
  assert.deepEqual(v4.errors, []);

  // 5. HTML and registry disagree (a tool was added to the registry before the HTML was regenerated): the script
  // rebuilds the regions from the registry instead of leaving a link out, and still draws each link once.
  state.html = 'new';
  state.registry = 'extra';
  const v5 = await visit();
  assert.ok(v5.s.footer.includes('/fx-lab/'), 'the registry tool is added to the footer');
  assert.deepEqual(dupes(v5.s.header), []);
  assert.deepEqual(dupes(v5.s.footer), []);
  assert.deepEqual(v5.s.doors, CANONICAL, 'the four sections are the cover doors');
  assert.equal(v5.s.toggles, 1);
  assert.ok(requests.length > 0);
});

test('reload and Back keep one copy of every link', { timeout: 120000 }, async (t) => {
  const { tab } = await launch(t);
  const page = await tab({ watch: false });
  await page.waitFor(hydrated, 'hydrated');
  const check = async (label) => {
    await page.waitFor(hydrated, `${label}: hydrated`);
    await settle(500);
    const s = await page.evaluate(SNAPSHOT);
    assert.deepEqual(s.doors, CANONICAL, label);
    assert.deepEqual(s.footer, FOOTER, label);
    assert.deepEqual(dupes(s.header), [], label);
    assert.equal(s.toggles, 1, label);
    assert.equal(s.overflow, 0, label);
  };
  await check('first load');
  await page.send('Page.reload', { ignoreCache: false });
  await check('after reload');
  await page.send('Page.reload', { ignoreCache: true });
  await check('after hard reload');
  await page.evaluate(`document.querySelector('#tools a.door[href="/movers/"]').click(); true`);
  await page.waitFor(`location.pathname === '/movers/' && document.readyState === 'complete'`, 'Movers opened');
  await page.evaluate('history.back(); true');
  await page.waitFor(`location.pathname === '/'`, 'back on home');
  await check('after Back');
  await page.close();
});

test('keyboard: Tab reaches the static header link, then each card, with a visible focus ring, scripting on or off', { timeout: 120000 }, async (t) => {
  const { tab } = await launch(t);
  for (const noScript of [true, false]) {
    const page = await tab({ noScript });
    await page.waitFor(noScript ? `document.readyState === 'complete'` : hydrated, 'ready');
    await settle(400);
    const seen = [];
    for (let n = 0; n < 60 && seen.filter((x) => x.door).length < 4; n++) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const a = await page.evaluate(`(() => { const e = document.activeElement; if (!e || e.tagName !== 'A') return null; const o = getComputedStyle(e); return { href: e.getAttribute('href'), door: e.matches('#tools .door'), visible: e.matches(':focus-visible'), ring: o.outlineStyle + ' ' + o.outlineWidth }; })()`);
      if (a && !seen.some((s) => s.href === a.href && s.door === a.door)) seen.push(a);
    }
    const doors = seen.filter((s) => s.door);
    assert.deepEqual(doors.map((d) => d.href), CANONICAL, `scripting ${noScript ? 'off' : 'on'}: cards in order`);
    for (const d of doors) assert.ok(d.visible && !/^none |^ ?0px| 0px$/.test(d.ring), `focus ring: ${JSON.stringify(d)}`);
    assert.ok(seen.some((s) => !s.door && s.href === '/news/'), 'the header Morning Report link takes focus');
    await page.close();
  }
});

test('preview screenshots: the home page before and after, with scripting off and on', { timeout: 180000, skip: !SHOT_DIR }, async (t) => {
  const state = { html: 'old', site: 'old', home: 'old', registry: 'current' };
  const { tab } = await launch(t, state);
  for (const gen of ['before', 'after']) {
    if (gen === 'after') Object.assign(state, { html: 'new', site: 'new', home: 'new' });
    for (const noScript of [true, false]) {
      for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 375, height: 812, mobile: true }]]) {
        const page = await tab({ ...vp, noScript, ignoreCache: true });
        await page.waitFor(noScript ? `document.readyState === 'complete'` : hydrated, 'ready');
        await settle(800);
        await page.shot(`${gen}-${noScript ? 'nojs' : 'js'}-${name}-fold.png`);
        await page.shot(`${gen}-${noScript ? 'nojs' : 'js'}-${name}-full.png`, { full: true });
        const links = await page.evaluate(`[...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => ${JSON.stringify(CANONICAL)}.includes(h)).length`);
        await writeFile(join(SHOT_DIR, `${gen}-${noScript ? 'nojs' : 'js'}-${name}.links.txt`), `${links} links to the four canonical paths in the rendered page\n`);
        await page.close();
      }
    }
  }
});
