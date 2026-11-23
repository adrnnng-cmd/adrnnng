import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const SHOT_DIR = process.env.HOME_SHOT_DIR || '';

// Every door thumbnail is grey until the card is hovered, then shows its colours. A thumbnail drawn only in greys
// cannot change on hover, however correct the CSS is, so the colour has to exist in the picture itself.

test('the Movers thumbnail is a static heat-map picture: no text, no script, colours from the Movers palette', () => {
  const home = read('assets/js/home.js');
  const src = /src: '(\/assets\/img\/doors\/[^']+\.svg)'/.exec(home)?.[1];
  assert.ok(src, 'home.js names the Movers thumbnail');
  const svg = read(src.slice(1));
  assert.doesNotMatch(svg, /<text|<script|<style|<image|https?:\/\/(?!www\.w3\.org)/);
  const colours = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
  assert.ok(colours.length >= 7, 'the seven tiles keep their fills');
  const spread = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return Math.max(...v) - Math.min(...v); };
  const coloured = colours.filter((c) => spread(c) >= 40);
  assert.ok(coloured.length >= 5, `most tiles must carry colour, got ${coloured.join(' ')}`);
  const greens = coloured.filter((c) => parseInt(c.slice(3, 5), 16) > parseInt(c.slice(1, 3), 16));
  const reds = coloured.filter((c) => parseInt(c.slice(1, 3), 16) > parseInt(c.slice(3, 5), 16));
  assert.ok(greens.length >= 2 && reds.length >= 2, 'a diverging up/down picture, like the heat map');
});

// The coloured picture has its own filename, so a browser that cached the grey one under the old URL does not
// reuse it. That old URL still has to answer: a home.js cached for the zone's four hours still requests it.
const ORIGINAL_MOVERS_SVG = '58480ae4ec8b3ffbfa37e30842232ee18f5bdc1a217dfb72a4e0c0328d394419';

test('new home.js uses the coloured filename; the original movers.svg bytes stay for a warm older module', () => {
  const home = read('assets/js/home.js');
  assert.match(home, /src: '\/assets\/img\/doors\/movers-heat\.svg'/);
  assert.doesNotMatch(home, /doors\/movers\.svg/, 'the new module does not ask for the old URL');
  const kept = readFileSync(join(root, 'assets/img/doors/movers.svg'));
  assert.equal(createHash('sha256').update(kept).digest('hex'), ORIGINAL_MOVERS_SVG);
});

// ------------------------------------------------------------------ real browser

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

async function chromePath() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { await stat(p); return p; } catch { /* next */ }
  }
  return '';
}

function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
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

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(t) {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required for the hover check. Set CHROME_PATH.');
  const server = await serve();
  const profile = await mkdtemp(join(tmpdir(), 'home-door-hover-'));
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

  async function open(path, { width, height, mobile = false, reducedMotion = false }) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(base + path)}`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = cdp(ws);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (reducedMotion) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
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
    const close = async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
    };
    return { send, evaluate, waitFor, close };
  }
  return { open };
}

// How colourful a region of what Chrome actually painted is: mean of max(r,g,b) - min(r,g,b) over its pixels.
const CHROMA = `async (dataUrl) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
  return sum / (d.length / 4);
}`;

async function paintedChroma(tab, rect) {
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 } });
  return tab.evaluate(`(${CHROMA})('data:image/png;base64,${data}')`);
}

const DOOR_STATE = `(() => [...document.querySelectorAll('#tools .door')].map((a) => {
  const img = a.querySelector('.door-photo img');
  const ir = img ? img.getBoundingClientRect() : null;
  const cs = img ? getComputedStyle(img) : null;
  return {
    href: a.getAttribute('href'),
    loaded: !!img && img.complete && img.naturalWidth > 0,
    filter: cs && cs.filter, transition: cs && cs.transitionProperty + ' ' + cs.transitionDuration + ' ' + cs.transitionTimingFunction,
    rect: ir && { x: ir.left + scrollX, y: ir.top + scrollY, w: ir.width, h: ir.height },
    card: (() => { const r = a.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })(),
    center: (() => { const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) }; })(),
    reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}))()`;

async function hover(tab, point) {
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 3, y: point.y + 3 });
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await settle(450);
}

async function runViewport(t, name, viewport) {
  const { open } = await launch(t);
  const tab = await open('/', viewport);
  await tab.waitFor(`document.querySelectorAll('#tools .door').length === 4 && [...document.querySelectorAll('#tools .door-photo img')].every((i) => i.complete)`, 'four doors with their pictures');
  await settle(300);
  const doors = await tab.evaluate(DOOR_STATE);
  assert.deepEqual(doors.map((d) => d.href), ['/backtest/', '/movers/', '/politician-tracker/', '/news/']);
  const report = [];
  for (let i = 0; i < doors.length; i++) {
    const door = doors[i];
    if (!door.loaded) { report.push({ href: door.href, skipped: 'picture did not load' }); continue; }
    await tab.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile || false });
    await tab.evaluate(`document.querySelectorAll('#tools .door')[${i}].scrollIntoView({ block: 'center' })`);
    await settle(500);
    const live = (await tab.evaluate(DOOR_STATE))[i];
    const clip = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });
    await hover(tab, { x: 2, y: 2 });
    const before = await paintedChroma(tab, clip(live.rect));
    const filterBefore = (await tab.evaluate(DOOR_STATE))[i].filter;
    if (SHOT_DIR) await shotRect(tab, live.card, `door-${live.href.replace(/\//g, '')}-${name}-rest`);
    await hover(tab, (await tab.evaluate(DOOR_STATE))[i].center);
    const during = await paintedChroma(tab, clip(live.rect));
    const filterDuring = (await tab.evaluate(DOOR_STATE))[i].filter;
    if (SHOT_DIR) await shotRect(tab, live.card, `door-${live.href.replace(/\//g, '')}-${name}-hover`);
    await hover(tab, { x: 2, y: 2 });
    const after = await paintedChroma(tab, clip(live.rect));
    report.push({ href: door.href, filterBefore, filterDuring, before, during, after, transition: live.transition, reduce: live.reduce });
  }
  await tab.close();
  return report;
}

async function shotRect(tab, card, name) {
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png', clip: { x: card.x, y: card.y, width: card.w, height: card.h, scale: 1 } });
  await writeFile(join(SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
}

function assertAllDoorsFollowTheSameRule(report, label) {
  const used = report.filter((r) => !r.skipped);
  assert.ok(used.some((r) => r.href === '/movers/'), `${label}: the Movers thumbnail loaded`);
  assert.ok(used.length >= 3, `${label}: at least three of the four pictures loaded: ${JSON.stringify(report)}`);
  for (const r of used) {
    const want = `${label} ${r.href}: ${JSON.stringify(r)}`;
    assert.equal(r.filterBefore, 'grayscale(1)', want);
    assert.equal(r.filterDuring, 'none', want);
    assert.ok(r.before < 3, `at rest the picture is grey (painted chroma ${r.before}) ${want}`);
    assert.ok(r.during > 12, `on hover the picture shows colour (painted chroma ${r.during}) ${want}`);
    assert.ok(r.after < 3, `after the pointer leaves it is grey again ${want}`);
  }
  const transitions = new Set(used.map((r) => r.transition));
  assert.equal(transitions.size, 1, `every door uses the same transition: ${[...transitions].join(' | ')}`);
}

test('at 1280 every door picture goes from grey to colour on hover and back, with one shared transition', { timeout: 120000 }, async (t) => {
  const report = await runViewport(t, 'desktop', { width: 1280, height: 900 });
  if (SHOT_DIR) await writeFile(join(SHOT_DIR, 'hover-report-desktop.json'), JSON.stringify(report, null, 2));
  assertAllDoorsFollowTheSameRule(report, 'desktop');
});

test('at 375 (touch viewport) the same rule holds when the pointer is over a card', { timeout: 120000 }, async (t) => {
  const report = await runViewport(t, 'phone', { width: 375, height: 812, mobile: true });
  if (SHOT_DIR) await writeFile(join(SHOT_DIR, 'hover-report-phone.json'), JSON.stringify(report, null, 2));
  assertAllDoorsFollowTheSameRule(report, 'phone');
});

test('keyboard focus and reduced motion treat every door alike (focus ring on each, no colour change on focus, one transition)', { timeout: 120000 }, async (t) => {
  const { open } = await launch(t);
  const tab = await open('/', { width: 1280, height: 900, reducedMotion: true });
  await tab.waitFor(`document.querySelectorAll('#tools .door').length === 4 && [...document.querySelectorAll('#tools .door-photo img')].every((i) => i.complete)`, 'four doors');
  await tab.evaluate(`document.querySelector('#tools').scrollIntoView(); document.activeElement.blur(); document.body.focus(); true`);
  const seen = [];
  for (let n = 0; n < 80 && seen.length < 4; n++) {
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const now = await tab.evaluate(`(() => { const a = document.activeElement; if (!a || !a.matches('#tools .door')) return null; const i = a.querySelector('.door-photo img'); const o = getComputedStyle(a); return { href: a.getAttribute('href'), focusVisible: a.matches(':focus-visible'), outline: o.outlineStyle + ' ' + o.outlineWidth, filter: getComputedStyle(i).filter, transition: getComputedStyle(i).transitionDuration, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }; })()`);
    if (now && !seen.some((s) => s.href === now.href)) seen.push(now);
  }
  assert.deepEqual(seen.map((s) => s.href), ['/backtest/', '/movers/', '/politician-tracker/', '/news/'], 'Tab reaches each door in order');
  for (const s of seen) {
    assert.ok(s.focusVisible, JSON.stringify(s));
    assert.ok(!/^none /.test(s.outline) && !/ 0px$/.test(s.outline), `a visible focus ring: ${JSON.stringify(s)}`);
    assert.ok(s.reduce, 'reduced motion is emulated');
  }
  for (const key of ['filter', 'transition', 'outline']) {
    assert.equal(new Set(seen.map((s) => s[key])).size, 1, `${key} differs between doors: ${JSON.stringify(seen)}`);
  }
  if (SHOT_DIR) await writeFile(join(SHOT_DIR, 'focus-reduced-motion-report.json'), JSON.stringify(seen, null, 2));
});
