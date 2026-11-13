import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LONG = '輝達董事會罷免黃仁勳；股價收跌，盤中一度重挫約百分之十四並更換臨時執行長人選';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      await stat(path);
      return path;
    } catch { /* next */ }
  }
  return '';
}

function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = normalize(join(root, rel));
    if (!abs.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(abs);
      res.writeHead(200, { 'content-type': types[extname(abs)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
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

const PROBE = `(() => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const tape = document.querySelector('.tape-in');
  const chips = document.querySelector('#sc-chips');
  const titles = [...document.querySelectorAll('.door-photo b')].map((el) => ({
    sw: el.scrollWidth,
    cw: el.clientWidth,
    right: el.getBoundingClientRect().right,
  }));
  const box = (el) => el && {
    right: el.getBoundingClientRect().right,
    sw: el.scrollWidth,
    cw: el.clientWidth,
  };
  return {
    scroll: doc.scrollWidth,
    client: vw,
    tape: box(tape),
    chips: box(chips),
    doors: document.querySelectorAll('.door').length,
    chipCount: document.querySelectorAll('#sc-chips button').length,
    titles,
  };
})()`;

test('home has no document overflow at phone widths', { timeout: 60000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) {
    throw new Error('Chrome is required to measure document scrollWidth. Set CHROME_PATH.');
  }
  const server = await serve();
  const { port } = server.address();
  const profile = await mkdtemp(join(tmpdir(), 'home-overflow-'));
  const proc = spawn(chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let debugPort = 0;
  const debugReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not open a debugging port')), 15000);
    proc.stderr.on('data', (buf) => {
      const match = String(buf).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        debugPort = Number(match[1]);
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited ${code} before the debugging port opened`)));
  });
  t.after(async () => {
    proc.kill('SIGKILL');
    await new Promise((resolve) => {
      if (proc.exitCode != null || proc.signalCode != null) resolve();
      else proc.once('exit', resolve);
    });
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await debugReady;

  const home = `http://127.0.0.1:${port}/`;
  for (const width of [320, 375, 390, 1280]) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(home)}`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = cdp(ws);
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 800 });
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    let sample = null;
    for (let i = 0; i < 40; i++) {
      const result = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
      sample = result.result.value;
      if (sample && sample.doors >= 3 && sample.chipCount >= 6 && sample.tape) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(sample.doors >= 3 && sample.chipCount >= 6, true, `${width} did not render home chrome`);

    await send('Runtime.evaluate', {
      expression: `(() => {
        const titles = [...document.querySelectorAll('.door-photo b')];
        if (titles[1]) titles[1].textContent = 'Representative Very Long Politician Name';
        if (titles[2]) titles[2].textContent = ${JSON.stringify(LONG)};
        document.body.classList.remove('has-story-hero');
      })()`,
    });
    const openRail = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value;
    assert.ok(openRail.scroll <= openRail.client, `${width} chart rail scroll ${openRail.scroll} client ${openRail.client}`);
    assert.ok(openRail.tape.right <= openRail.client + 1, `${width} tape box escapes the viewport`);
    assert.ok(openRail.tape.sw > openRail.tape.cw, `${width} tape lost its own horizontal scroll`);
    assert.ok(openRail.chips.right <= openRail.client + 1, `${width} chips escape the viewport`);
    if (width <= 390) assert.ok(openRail.chips.sw > openRail.chips.cw, `${width} chips should scroll inside the card`);

    await send('Runtime.evaluate', { expression: `document.body.classList.add('has-story-hero')` });
    const hero = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value;
    assert.ok(hero.scroll <= hero.client, `${width} story hero scroll ${hero.scroll} client ${hero.client}`);
    const wideTitle = hero.titles.at(-1);
    assert.ok(wideTitle.cw <= hero.client, `${width} door title box is wider than the viewport`);
    assert.ok(wideTitle.sw > wideTitle.cw, `${width} long door title was not clipped`);
    ws.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  }
});
