// Shared helpers for the real-browser regression tests: a static server over one or two checkouts with
// per-request overrides and the long module cache the production zone applies, and headless Chrome over CDP.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

export const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

/** The production zone serves /assets and /movers modules and stylesheets with a four-hour browser cache. */
export const ZONE_TTL = 'public, max-age=14400';
const isZoneCached = (path) => /\.(js|css)$/.test(path) && /^\/(assets|movers)\//.test(path);

/**
 * @param {object} o
 * @param {() => string} o.root                    checkout to serve right now (switchable between visits)
 * @param {(url: URL, req, res) => boolean|Promise<boolean>} [o.handle]  return true when the request was answered
 * @param {(url: URL) => string|null} [o.cache]    cache-control override; default is the zone's rule
 * @param {string[]} o.log                          every pathname+search that reached the server
 */
export function serveSite({ root, handle, cache, log }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    log.push(url.pathname + url.search);
    if (handle && await handle(url, req, res)) return;
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const base = root();
    const abs = normalize(join(base, rel));
    if (!abs.startsWith(base)) return void res.writeHead(403).end();
    try {
      const body = await readFile(abs);
      const override = cache ? cache(url) : null;
      const control = override ?? (isZoneCached(url.pathname) ? ZONE_TTL : 'no-cache');
      res.writeHead(200, { 'content-type': types[extname(abs)] || 'application/octet-stream', 'cache-control': control });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export async function chromePath() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try {
      await stat(p);
      return p;
    } catch { /* next */ }
  }
  return '';
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) fn(msg.params);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  send.on = (method, fn) => listeners.set(method, [...(listeners.get(method) || []), fn]);
  return send;
}

/** Starts headless Chrome. Cleanup is registered on `t`. Returns `open(url, opts)`. */
export async function startBrowser(t, extraArgs = []) {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required for the browser check. Set CHROME_PATH.');
  const profile = await mkdtemp(join(tmpdir(), 'hkm-browser-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...extraArgs, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await ready;

  /**
   * Opens a tab and navigates with the HTTP cache honoured (no reload with ignoreCache).
   * `reload()` is a normal user reload. `errors` collects uncaught page errors and console errors.
   */
  async function open(url, { width = 1440, height = 900, mobile = false, script = '', touch = false } = {}) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = cdp(ws);
    const errors = [];
    send.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception'));
    send.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') errors.push(`${p.entry.source}: ${p.entry.text} ${p.entry.url || ''}`); });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    if (script) await send('Page.addScriptToEvaluateOnNewDocument', { source: script });
    await send('Page.navigate', { url });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    const waitFor = async (expression, label, ms = 15000) => {
      const until = Date.now() + ms;
      let last;
      while (Date.now() < until) {
        last = await evaluate(expression);
        if (last && (typeof last !== 'object' || !('__done' in last) || last.__done)) return last;
        await new Promise((r) => setTimeout(r, 120));
      }
      throw new Error(`${label} never happened; last ${JSON.stringify(last)}; page errors ${JSON.stringify(errors)}`);
    };
    const reload = async () => {
      await send('Page.reload', { ignoreCache: false });
      await new Promise((r) => setTimeout(r, 200));
    };
    const center = (selector) => evaluate(`(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      let prev = null;
      for (let i = 0; i < 20; i++) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 120));
        const r = el.getBoundingClientRect();
        const box = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const inView = r.top >= 0 && r.bottom <= innerHeight;
        if (inView && prev && Math.abs(prev.y - box.y) < 0.5 && Math.abs(prev.x - box.x) < 0.5) return box;
        prev = box;
      }
      return { ...prev, offscreen: true };
    })()`);
    const click = async (selector) => {
      const box = await center(selector);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
    };
    const tap = async (selector) => {
      const box = await center(selector);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const close = async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
    };
    return { send, evaluate, waitFor, reload, tap, click, close, errors };
  }
  return { open, debugPort };
}
