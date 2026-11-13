import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

async function chromePath() {
  for (const path of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean)) {
    try {
      await stat(path);
      return path;
    } catch { /* next */ }
  }
  return '';
}

function serve() {
  const types = { '.svg': 'image/svg+xml', '.html': 'text/html' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
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

function decodePng(buffer) {
  const buf = Buffer.from(buffer);
  let offset = 8;
  let width = 0;
  let height = 0;
  let color = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      color = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported PNG color ${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = [];
  let pos = 0;
  let prev = Buffer.alloc(stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[pos];
    pos += 1;
    const row = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = prev[i];
      const upLeft = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) row[i] = (row[i] + left) & 255;
      else if (filter === 2) row[i] = (row[i] + up) & 255;
      else if (filter === 3) row[i] = (row[i] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[i] = (row[i] + paeth(left, up, upLeft)) & 255;
    }
    prev = row;
    const bits = [];
    for (let x = 0; x < width; x++) bits.push(row[x * channels] >= 180 ? 1 : 0);
    rows.push(bits);
  }
  const bright = rows[0].map((_, x) => rows.reduce((sum, row) => sum + row[x], 0));
  return { w: width, h: height, bright, rows };
}

function runs(columns) {
  const found = [];
  let start = null;
  columns.forEach((value, x) => {
    if (value && start === null) start = x;
    if (!value && start !== null) {
      found.push({ x: start, w: x - start });
      start = null;
    }
  });
  if (start !== null) found.push({ x: start, w: columns.length - start });
  return found;
}

test('NC favicon keeps two stems and an open C at 16 and 32', { timeout: 30000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required to measure the favicon raster. Set CHROME_PATH.');
  const server = await serve();
  const { port } = server.address();
  const profile = await mkdtemp(join(tmpdir(), 'nc-favicon-'));
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let debugPort = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not open a debugging port')), 15000);
    proc.stderr.on('data', (buf) => {
      const match = String(buf).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        debugPort = Number(match[1]);
        clearTimeout(timer);
        resolve();
      }
    });
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
  await ready;
  const url = `http://127.0.0.1:${port}/assets/brand/favicon.svg`;
  for (const size of [16, 32]) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = cdp(ws);
    await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    let readyState = '';
    for (let i = 0; i < 40 && readyState !== 'complete'; i++) {
      const state = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      readyState = state.result.value;
      if (readyState !== 'complete') await new Promise((r) => setTimeout(r, 50));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const sample = decodePng(Buffer.from(shot.data, 'base64'));
    assert.equal(sample.w, size, `${size} screenshot width`);
    assert.equal(sample.h, size, `${size} screenshot height`);
    const minBright = size === 16 ? 4 : 8;
    const minStem = size === 16 ? 2 : 4;
    const left = runs(sample.bright.slice(0, Math.floor(size * 0.55)).map((n) => n >= minBright))
      .filter((run) => run.w >= minStem);
    assert.ok(left.length >= 2, `${size}px N stems ${JSON.stringify(sample.bright)}`);
    const open = sample.rows.some((row) => {
      const ink = row.map((v, x) => (v && x >= Math.floor(size * 0.45) ? x : -1)).filter((x) => x >= 0);
      if (ink.length < 2) return false;
      return ink.slice(1).some((x, i) => x - ink[i] >= (size === 16 ? 2 : 3));
    });
    assert.equal(open, true, `${size}px C opening missing`);
    ws.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  }
});
