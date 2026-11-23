import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const registry = JSON.parse(read('assets/tools.json'));
const SHOT_DIR = process.env.HOME_SHOT_DIR || '';

// ------------------------------------------------------------------ registry and copy

test('registry names the page Movers and keeps its URL, order and other functions', () => {
  const live = registry.tools.filter((t) => t.href);
  assert.deepEqual(live.map((t) => t.id), ['backtest', 'movers', 'politician-tracker', 'news']);
  assert.deepEqual(live.map((t) => t.href), ['/backtest/', '/movers/', '/politician-tracker/', '/news/']);
  assert.deepEqual(live.map((t) => t.title), ['Backtest', 'Movers', 'Politician Tracker', 'Morning Report']);
  const movers = registry.tools.find((t) => t.id === 'movers');
  assert.equal(movers.category, 'Markets');
  assert.equal(registry.site.name, 'News Chart');
});

test('home door order is Backtest, Movers, Politician Tracker, Morning Report and the Movers door has no data fetch', () => {
  const js = read('assets/js/chrome-html.js');
  assert.match(js, /const DOORS = \[\s*\{ id: 'backtest' \},\s*\{ id: 'movers', legacy: \['hk-movers'\] \},\s*\{ id: 'politician-tracker' \},\s*\{ id: 'news' \},\s*\];/);
  const block = js.slice(js.indexOf("t.id === 'movers') {"), js.indexOf("t.id === 'news') {"));
  assert.match(block, /HSI · 升跌榜 · 板塊熱力圖/);
  assert.match(block, /約 5–6 分鐘更新快照/);
  assert.doesNotMatch(block, /fetch|getJson|latest|\/data\//, 'the Movers door must not load quote data');
  assert.doesNotMatch(block, /即時|串流|LIVE|live/i, 'the Movers door must not claim live data');
  assert.match(js, /id === 'movers' \? '港股異動'/);
  const home = read('assets/js/home.js');
  assert.doesNotMatch(home, /fetch\([^)]*movers/i, 'home.js does not fetch Movers data');
});

test('Movers thumbnail is a static grid with no text or numbers (its colours are checked in home-door-hover.test.mjs)', () => {
  const src = /src: '(\/assets\/img\/doors\/[^']+\.svg)'/.exec(read('assets/js/chrome-html.js'))?.[1];
  const svg = read(src.slice(1));
  assert.doesNotMatch(svg, /<text|<script|https?:\/\/(?!www\.w3\.org)/);
});

test('subpage heading is Movers with the 港股異動與板塊熱力圖 subtitle; URL and canonical unchanged', () => {
  const html = read('movers/index.html');
  assert.match(html, /<h1>Movers<\/h1>\s*<p class="subtitle">港股異動與板塊熱力圖<\/p>/);
  assert.match(html, /<title>Movers｜港股異動與板塊熱力圖 · News Chart<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/news-chart\.com\/movers\/"/);
  assert.match(html, /"name":"Movers","item":"https:\/\/news-chart\.com\/movers\/"/);
  assert.match(html, /HSI 恒生指數/);
});

test('hero, wordmark, favicon and newsletter markup on the home page are untouched', () => {
  const html = read('index.html');
  assert.match(html, /id="story-hero"/);
  assert.match(html, /class="cover wrap"/);
  assert.match(html, /news-chart-white\.svg" alt="News Chart"/);
  assert.match(html, /favicon\.svg\?v=nc-2026-11-13/);
  assert.match(html, /id="newsletter"/);
  assert.ok(html.indexOf('class="nl-strip') < html.indexOf('id="tools"'));
  assert.ok(html.indexOf('id="tools"') < html.indexOf('id="newsletter"'));
});

test('the doors grid is two columns on desktop and one on narrow screens, same DOM order', () => {
  const css = read('assets/css/home.css');
  assert.match(css, /\.doors \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 960px\) \{[\s\S]*?\.doors \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.doesNotMatch(css, /\.doors \{[^}]*\border:\s*1px solid/);
});

// ------------------------------------------------------------------ real browser layout

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

async function chromePath() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try {
      await stat(p);
      return p;
    } catch { /* next */ }
  }
  return '';
}

function serve(requests) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = normalize(join(root, rel));
    if (!abs.startsWith(root)) return void res.writeHead(403).end();
    try {
      const body = await readFile(abs);
      res.writeHead(200, { 'content-type': types[extname(abs)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

const DOORS = `(() => [...document.querySelectorAll('#tools .door')].map((a) => {
  const r = a.getBoundingClientRect();
  const photo = a.querySelector('.door-photo');
  const clipped = [...a.querySelectorAll('.door-photo b, .door-photo span, h2, h2 .zh, .ey, .go')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className || el.tagName);
  return {
    href: a.getAttribute('href'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: r.right,
    ey: a.querySelector('.ey')?.textContent.trim(), h2: a.querySelector('h2')?.firstChild?.textContent.trim(), zh: a.querySelector('h2 .zh')?.textContent.trim(),
    title: a.querySelector('.door-photo b')?.textContent.trim(), sub: a.querySelector('.door-photo span')?.textContent.trim(),
    go: a.querySelector('.go')?.textContent.trim(), img: !!photo?.querySelector('img'), clipped,
    bg: getComputedStyle(a).backgroundColor, badge: !!a.querySelector('.badge, .tag, .pill'),
  };
}))()`;

test('home doors lay out 2x2 at 1280 and one column at 390 with no overflow, clipping or live claim', { timeout: 120000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required for the layout check. Set CHROME_PATH.');
  const requests = [];
  const server = await serve(requests);
  const { port } = server.address();
  const profile = await mkdtemp(join(tmpdir(), 'home-movers-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let debugPort = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not open a debugging port')), 15000);
    proc.stderr.on('data', (buf) => {
      const m = String(buf).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        debugPort = Number(m[1]);
        clearTimeout(timer);
        resolve();
      }
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

  async function open(url, width, height, mobile) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = cdp(ws);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    const close = async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
    };
    return { send, evaluate, close };
  }
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  async function shot(tab, name, clipSel) {
    if (!SHOT_DIR) return;
    const params = { format: 'png', captureBeyondViewport: true };
    if (clipSel === 'top') {
      params.captureBeyondViewport = false;
    } else if (clipSel) {
      const box = await tab.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(clipSel)}).getBoundingClientRect(); return { x: 0, y: r.top + scrollY - 24, width: innerWidth, height: r.height + 48 }; })()`);
      params.clip = { ...box, scale: 1 };
    }
    const { data } = await tab.send('Page.captureScreenshot', params);
    await writeFile(join(SHOT_DIR, name), Buffer.from(data, 'base64'));
  }

  for (const [width, height, mobile] of [[1280, 900, false], [390, 844, true], [320, 700, true]]) {
    const tab = await open(`http://127.0.0.1:${port}/`, width, height, mobile);
    let doors = [];
    for (let i = 0; i < 40; i++) {
      doors = await tab.evaluate(DOORS);
      if (doors.length === 4 && doors.every((d) => d.title)) break;
      await settle(250);
    }
    const label = `${width}px`;
    assert.deepEqual(doors.map((d) => d.href), ['/backtest/', '/movers/', '/politician-tracker/', '/news/'], label);
    const movers = doors[1];
    assert.equal(movers.ey, 'Markets', label);
    assert.equal(movers.h2, 'Movers', label);
    assert.equal(movers.zh, '港股異動', label);
    assert.equal(movers.title, 'HSI · 升跌榜 · 板塊熱力圖', label);
    assert.equal(movers.sub, '約 5–6 分鐘更新快照', label);
    assert.equal(movers.go, 'Open →', label);
    assert.ok(movers.img, `${label} Movers thumbnail`);
    for (const d of doors) {
      assert.deepEqual(d.clipped, [], `${label} ${d.href} has clipped text`);
      assert.ok(d.right <= width + 0.5, `${label} ${d.href} escapes the viewport`);
      assert.equal(d.bg, 'rgba(0, 0, 0, 0)', `${label} ${d.href} has a coloured card background`);
      assert.equal(d.badge, false, `${label} ${d.href} has a badge`);
    }
    const sizes = await tab.evaluate(`({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })`);
    assert.ok(sizes.scroll <= sizes.client, `${label} horizontal overflow ${sizes.scroll} > ${sizes.client}`);

    if (width >= 1000) {
      const [a, b, c, d] = doors;
      assert.equal(a.y, b.y, 'row 1 aligns');
      assert.equal(c.y, d.y, 'row 2 aligns');
      assert.ok(c.y > a.y + 100, 'second row sits below the first');
      assert.equal(a.x, c.x, 'left column aligns');
      assert.ok(b.x > a.x + 300 && b.x === d.x, 'right column aligns');
      assert.ok(Math.abs(a.w - b.w) <= 30 && Math.abs(c.w - d.w) <= 30, 'columns are balanced');
      assert.equal(a.h, b.h, 'row 1 equal height');
      assert.equal(c.h, d.h, 'row 2 equal height');
      const rules = await tab.evaluate(`(() => { const el = document.querySelector('#tools'); const cs = getComputedStyle(el); const first = getComputedStyle(el.children[0]); const third = getComputedStyle(el.children[2]); return { top: cs.borderTopWidth + ' ' + cs.borderTopColor, cols: cs.gridTemplateColumns.split(' ').length, dividerRight: first.borderRightWidth, dividerTop: third.borderTopWidth }; })()`);
      assert.match(rules.top, /^3px rgb\(0, 0, 0\)$/);
      assert.equal(rules.cols, 2);
      assert.equal(rules.dividerRight, '1px');
      assert.equal(rules.dividerTop, '1px');
      await shot(tab, 'home-1280-doors.png', '#tools');
      await shot(tab, 'home-1280-full.png');
    } else {
      for (let i = 1; i < doors.length; i++) {
        assert.equal(doors[i].x, doors[0].x, `${label} single column`);
        assert.ok(doors[i].y >= doors[i - 1].y + doors[i - 1].h - 1, `${label} doors stack in DOM order`);
      }
      if (width === 390) {
        await shot(tab, 'home-390-doors.png', '#tools');
        await shot(tab, 'home-390-full.png');
      }
    }

    if (width !== 320) {
      const focused = [];
      await tab.evaluate(`document.body.focus()`);
      for (let i = 0; i < 80 && focused.length < 4; i++) {
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        const hit = await tab.evaluate(`(() => { const a = document.activeElement; return a?.classList.contains('door') ? { href: a.getAttribute('href'), outline: getComputedStyle(a).outlineStyle, ow: getComputedStyle(a).outlineWidth } : null; })()`);
        if (hit) focused.push(hit);
      }
      assert.deepEqual(focused.map((f) => f.href), ['/backtest/', '/movers/', '/politician-tracker/', '/news/'], `${label} Tab order`);
      for (const f of focused) {
        assert.notEqual(f.outline, 'none', `${label} ${f.href} has no focus outline`);
        assert.equal(f.ow, '2px', `${label} ${f.href} focus ring width`);
      }
      if (width === 1280) await shot(tab, 'home-1280-movers-focus.png', '#tools');
    }
    await tab.close();
  }

  assert.ok(!requests.some((p) => p.startsWith('/movers/data')), 'the home page must not request HK Movers data');

  const sub = await open(`http://127.0.0.1:${port}/movers/`, 1280, 900, false);
  let head = null;
  for (let i = 0; i < 40; i++) {
    head = await sub.evaluate(`({ h1: document.querySelector('h1')?.textContent, sub: document.querySelector('.page-head .subtitle')?.textContent, footer: [...document.querySelectorAll('.site-footer .row span:last-child a')].map((a) => a.textContent + '>' + a.getAttribute('href')), nav: [...document.querySelectorAll('.mast-r a')].map((a) => a.textContent + '>' + a.getAttribute('href')), tiles: document.querySelectorAll('.hm-tile').length })`);
    if (head.footer.length && head.tiles) break;
    await settle(250);
  }
  assert.equal(head.h1, 'Movers');
  assert.equal(head.sub, '港股異動與板塊熱力圖');
  assert.deepEqual(head.footer, ['Backtest>/backtest/', 'Movers>/movers/', 'Politician Tracker>/politician-tracker/', 'Morning Report>/news/']);
  assert.ok(head.nav.includes('Movers>/movers/') && !head.nav.some((n) => n.startsWith('港股異動')));
  await shot(sub, 'movers-subpage-1280.png', 'top');
  await sub.close();

  const mob = await open(`http://127.0.0.1:${port}/movers/`, 390, 844, true);
  let menu = null;
  for (let i = 0; i < 40; i++) {
    menu = await mob.evaluate(`({ toggle: !!document.querySelector('.nav-toggle'), tiles: document.querySelectorAll('.hm-tile').length, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })`);
    if (menu.toggle && menu.tiles) break;
    await settle(250);
  }
  assert.ok(menu.scroll <= menu.client, 'subpage has no horizontal overflow at 390');
  await mob.evaluate(`document.querySelector('.nav-toggle').click()`);
  const links = await mob.evaluate(`[...document.querySelectorAll('.mast-r a')].map((a) => a.textContent.trim() + '>' + a.getAttribute('href') + '>' + (getComputedStyle(a).display !== 'none'))`);
  assert.ok(links.includes('Movers>/movers/>true'), links.join(' | '));
  await settle(300);
  await shot(mob, 'movers-subpage-390-menu.png', 'top');
  await mob.close();
});
