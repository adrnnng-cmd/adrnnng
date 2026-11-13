import assert from 'node:assert/strict';
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
  const types = { '.svg': 'image/svg+xml', '.html': 'text/html', '.png': 'image/png', '.ico': 'image/x-icon' };
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runs(columns, on) {
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
  return found.filter(on);
}

test('NC favicon keeps two stems and an open C at 16 and 32', { timeout: 30000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required to measure the favicon raster. Set CHROME_PATH.');
  const server = await serve();
  const { port } = server.address();
  const dir = await mkdtemp(join(tmpdir(), 'nc-favicon-'));
  t.after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const measure = async (size) => {
    const file = join(dir, `${size}.png`);
    const proc = spawn(chrome, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      `--window-size=${size},${size}`,
      `--screenshot=${file}`,
      `http://127.0.0.1:${port}/assets/brand/favicon.svg`,
    ], { stdio: 'ignore' });
    const started = Date.now();
    while (Date.now() - started < 8000) {
      try {
        const info = await stat(file);
        if (info.size > 50) break;
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    proc.kill('SIGKILL');
    const py = `
import json
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('L')
w, h = im.size
px = im.load()
bright = [sum(1 for y in range(h) if px[x, y] >= 180) for x in range(w)]
rows = []
for y in range(h):
    rows.append([1 if px[x, y] >= 180 else 0 for x in range(w)])
print(json.dumps({'w': w, 'h': h, 'bright': bright, 'rows': rows}))
`;
    const out = spawn('python3', ['-c', py], { encoding: 'utf8' });
    let text = '';
    for await (const chunk of out.stdout) text += chunk;
    const code = await new Promise((resolve) => out.on('close', resolve));
    if (code !== 0) throw new Error(`pixel read failed for ${size}`);
    return JSON.parse(text);
  };

  for (const size of [16, 32]) {
    const sample = await measure(size);
    assert.equal(sample.w, size, `${size} raster width`);
    assert.equal(sample.h, size, `${size} raster height`);
    const minBright = size === 16 ? 4 : 8;
    const minStem = size === 16 ? 2 : 4;
    const stem = sample.bright.map((n) => n >= minBright);
    const left = runs(stem.slice(0, Math.floor(size * 0.55)), (run) => run.w >= minStem);
    assert.ok(left.length >= 2, `${size}px N stems ${JSON.stringify(sample.bright)}`);
    const open = sample.rows.some((row) => {
      const ink = row.map((v, x) => (v && x >= Math.floor(size * 0.45) ? x : -1)).filter((x) => x >= 0);
      if (ink.length < 2) return false;
      return ink.at(-1) - ink[0] >= (size === 16 ? 3 : 6) && ink.slice(1).some((x, i) => x - ink[i] >= (size === 16 ? 2 : 3));
    });
    assert.equal(open, true, `${size}px C opening missing`);
  }
});
