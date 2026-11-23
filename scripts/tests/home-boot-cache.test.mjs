import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { plan, stampError } from '../asset-versions.mjs';
import { indexingHeaderErrors } from '../headers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const LEGACY = join(root, 'scripts/tests/fixtures/home-legacy');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

// ------------------------------------------------------------------ source contract

const homeVersion = (dir = root) => plan(dir).versions['/assets/js/home.js'];

test('index.html loads home.js and site.js at the version of their stamped module graph', () => {
  const html = read('index.html');
  assert.equal(stampError(root), '');
  const v = plan(root).versions;
  assert.match(html, new RegExp(`<script type="module" src="/assets/js/home\\.js\\?v=${v['/assets/js/home.js']}"></script>`));
  assert.match(html, new RegExp(`<script type="module" src="/assets/js/site\\.js\\?v=${v['/assets/js/site.js']}"></script>`));
  const homeJs = read('assets/js/home.js');
  assert.match(homeJs, new RegExp(`from './site\\.js\\?v=${v['/assets/js/site.js']}'`), 'home.js imports the same site.js URL, so one module instance runs');
});

test('every module in the home graph, and only that graph, feeds the home version', async (t) => {
  const copy = await mkdtemp(join(tmpdir(), 'home-graph-'));
  t.after(() => rm(copy, { recursive: true, force: true }));
  for (const dir of ['assets', 'backtest/strategies', 'movers']) await cp(join(root, dir), join(copy, dir), { recursive: true });
  for (const page of ['index.html', 'movers/index.html']) await cp(join(root, page), join(copy, page));
  const base = homeVersion(copy);
  assert.equal(base, homeVersion(root));
  for (const file of ['assets/js/home.js', 'assets/js/site.js', 'assets/js/latest.js', 'assets/js/member-photo.js', 'assets/js/newsletter.js', 'backtest/strategies/td-sequential.js']) {
    const original = await readFile(join(copy, file), 'utf8');
    await writeFile(join(copy, file), `${original}\n// edit`);
    assert.notEqual(homeVersion(copy), base, `${file} must change the home version`);
    await writeFile(join(copy, file), original);
  }
  await writeFile(join(copy, 'assets/js/unrelated.js'), 'export {};');
  assert.equal(homeVersion(copy), base, 'a module outside the graph must not change it');
});

test('_headers revalidates modules and stylesheets on the registry horizon and keeps HTML revalidating', () => {
  const text = read('_headers');
  assert.deepEqual(indexingHeaderErrors(text, { keyFile: undefined }).filter((e) => /cache-control/.test(e)), []);
  const bad = text.replace(/\/assets\/js\/\*\n {2}Cache-Control: [^\n]+\n/, '');
  assert.ok(indexingHeaderErrors(bad).some((e) => /\/assets\/js\/home\.js cache-control/.test(e)));
  const longHtml = `/\n  Cache-Control: public, max-age=14400\n${text}`;
  assert.ok(indexingHeaderErrors(longHtml).some((e) => /must revalidate/.test(e)));
});

// ------------------------------------------------------------------ real browser with a warm HTTP cache

async function chromePath() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try {
      await stat(p);
      return p;
    } catch { /* next */ }
  }
  return '';
}

/**
 * Static server with switches for what a deploy changes. Modules are served with the four-hour max-age Pages
 * applied before this fix; the registry and HTML are always fresh (the registry's own horizon is shorter than
 * the cache, so a revisit asks again).
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
        let html = await readFile(join(root, 'index.html'), 'utf8');
        if (state.html === 'pre-fix') html = html.replace(/\?v=[0-9a-f]{10}/g, '');
        return send(html, 'x.html', 'no-cache');
      }
      if (url.pathname === '/assets/tools.json') {
        return send(await readFile(state.registry === 'legacy' ? join(LEGACY, 'tools.json') : join(root, 'assets/tools.json')), 'x.json', 'no-cache');
      }
      if (url.pathname === '/assets/js/home.js' && !url.search && state.js === 'legacy') {
        return send(await readFile(join(LEGACY, 'home.js')), 'x.js', 'public, max-age=14400');
      }
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

test('warm cached modules and registries from either side of the Movers rename still give four doors', { timeout: 120000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required for the cache check. Set CHROME_PATH.');
  const state = { html: 'pre-fix', registry: 'legacy', js: 'legacy' };
  const requests = [];
  const server = await serve(state, requests);
  const { port } = server.address();
  const profile = await mkdtemp(join(tmpdir(), 'home-boot-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Plain navigation, so the HTTP cache is honoured, in a fresh tab of the same profile. */
  async function visit() {
    const mark = requests.length;
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = cdp(ws);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    let doors = [];
    for (let i = 0; i < 40; i++) {
      doors = await evaluate(`[...document.querySelectorAll('#tools .door')].map((a) => a.getAttribute('href') + '|' + (a.querySelector('h2')?.firstChild?.textContent || '').trim())`);
      if (doors.length) break;
      await settle(200);
    }
    await settle(600);
    doors = await evaluate(`[...document.querySelectorAll('#tools .door')].map((a) => a.getAttribute('href') + '|' + (a.querySelector('h2')?.firstChild?.textContent || '').trim())`);
    ws.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
    return { doors, requests: requests.slice(mark) };
  }

  const FOUR = ['/backtest/|Backtest', '/movers/|Movers', '/politician-tracker/|Politician Tracker', '/news/|Morning Report'];

  // Before the release: old HTML, old module (cached for four hours), old registry.
  const before = await visit();
  assert.deepEqual(before.doors, ['/backtest/|Backtest', '/hk-movers/|Movers', '/politician-tracker/|Politician Tracker', '/news/|Morning Report']);
  assert.ok(before.requests.includes('/assets/js/home.js'), 'the old module was fetched and cached');

  // Release: the registry now says "movers" and the module file is replaced.
  state.registry = 'current';
  state.js = 'current';

  // Control: the pre-fix HTML still asks for the unversioned URL, so the warm old module runs against the new
  // registry and the Movers door is filtered out. This is the reported failure.
  const control = await visit();
  assert.ok(!control.requests.includes('/assets/js/home.js'), 'the warm unversioned module is not refetched');
  assert.deepEqual(control.doors, ['/backtest/|Backtest', '/politician-tracker/|Politician Tracker', '/news/|Morning Report'], 'control reproduces the missing Movers door');

  // Fix: the new HTML names a boot URL no browser has cached.
  state.html = 'fixed';
  const fixed = await visit();
  assert.deepEqual(fixed.doors, FOUR);
  assert.ok(fixed.requests.includes(`/assets/js/home.js?v=${homeVersion()}`), fixed.requests.join(' '));
  assert.ok(!fixed.requests.includes('/assets/js/home.js'), 'the warm old module is bypassed');

  // Revisit: the versioned module and registry are both consistent.
  const again = await visit();
  assert.deepEqual(again.doors, FOUR);

  // Other direction: the new module against a registry still carrying the old id and URL (registry rolled back or
  // an old copy served by an intermediary). It accepts the old id and links the canonical page.
  state.registry = 'legacy';
  const reverse = await visit();
  assert.deepEqual(reverse.doors, FOUR);
});
