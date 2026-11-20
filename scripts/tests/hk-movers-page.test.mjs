import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
};

async function chromePath() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const path of candidates) {
    try {
      await stat(path);
      return path;
    } catch { /* next */ }
  }
  return '';
}

// A plain static server: like `python3 -m http.server`, so /hk-movers/data/latest is a 404
// and the page has to fall back to the demo document, exactly as the offline preview does.
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

const PROBE = `(() => {
  const doc = document.documentElement;
  const q = (s) => document.querySelectorAll(s);
  const wide = [...q('body *')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > doc.clientWidth + 1 && !el.closest('.hkm-map, .tape');
  }).slice(0, 3).map((el) => el.tagName + '.' + el.className);
  return {
    scroll: doc.scrollWidth, client: doc.clientWidth, wide,
    tiles: q('.hm-tile').length, rows: q('.hkm-row').length, news: q('a.news').length, empty: q('.news-empty').length,
    badRel: [...q('a.news')].filter((a) => a.rel !== 'noopener noreferrer' || a.target !== '_blank').length,
    tab: document.querySelector('[role=tab][aria-selected=true]')?.dataset.view,
    notice: document.querySelector('#hkm-notice')?.innerText || '',
    text: doc.innerText,
    mapW: document.querySelector('#hkm-map')?.clientWidth || 0,
    tileOut: [...q('.hm-tile')].filter((t) => { const m = document.querySelector('#hkm-map').getBoundingClientRect(); const r = t.getBoundingClientRect(); return r.right > m.right + 1 || r.bottom > m.bottom + 1 || r.left < m.left - 1; }).length,
    chip: document.querySelector('.hkm-scope')?.innerText || '',
  };
})()`;

test('HK Movers renders both views without horizontal overflow at phone and desktop widths', { timeout: 120000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required for the layout check. Set CHROME_PATH.');
  const server = await serve();
  const { port } = server.address();
  const profile = await mkdtemp(join(tmpdir(), 'hkm-page-'));
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

  for (const width of [320, 375, 390, 768, 1440]) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/hk-movers/`)}`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const send = cdp(ws);
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    const waitFor = async (predicate, label) => {
      let sample = null;
      for (let i = 0; i < 60; i++) {
        sample = await evaluate(PROBE);
        if (sample && predicate(sample)) return sample;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`${width}px: ${label} never appeared`);
    };
    await send('Emulation.setDeviceMetricsOverride', { width, height: 812, deviceScaleFactor: 1, mobile: width < 800 });
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });

    const hsi = await waitFor((s) => s.tiles >= 90 && s.rows === 20, 'HSI heat map and lists');
    assert.equal(hsi.tab, 'hsi');
    assert.ok(hsi.scroll <= hsi.client, `${width} HSI scrollWidth ${hsi.scroll} > ${hsi.client} (${hsi.wide})`);
    assert.deepEqual(hsi.wide, [], `${width} HSI elements escape the viewport`);
    assert.equal(hsi.tileOut, 0, `${width} HSI tiles escape the map`);
    assert.equal(hsi.badRel, 0, 'every news link opens safely');
    assert.ok(hsi.news >= 18, 'news previews render');
    assert.ok(hsi.empty >= 1, 'empty news state renders');
    assert.match(hsi.notice, /示範數據/);
    assert.doesNotMatch(hsi.text, /\bfutu\b|富途|\byahoo\b/i);
    for (const label of ['HSI 恒生指數', 'HK 港股全市場', '升幅榜 Top 10', '跌幅榜 Top 10', '近似影響度', '漲跌幅 × 總市值', '作者：ADRRR']) {
      assert.ok(hsi.text.includes(label), `${width} HSI view shows ${label}`);
    }

    await evaluate(`document.querySelector('#hkm-map [data-sector=finance], .hkm-chip[data-sector=finance]').click()`);
    const filtered = await waitFor((s) => s.chip.includes('金融及保險'), 'sector filter');
    assert.ok(filtered.rows < 20, 'sector filter narrows the lists');
    assert.ok(filtered.scroll <= filtered.client, `${width} filtered scroll`);

    await evaluate(`document.querySelector('#hkm-map [data-code]').click()`);
    const picked = await waitFor((s) => s.text.includes('關閉'), 'stock detail');
    assert.ok(picked.scroll <= picked.client, `${width} detail scroll`);

    await evaluate(`document.querySelector('[data-view=hk]').click()`);
    const hk = await waitFor((s) => s.tab === 'hk' && s.tiles >= 10 && s.tiles <= 12 && s.rows === 20, 'HK sector map and lists');
    assert.ok(hk.scroll <= hk.client, `${width} HK scrollWidth ${hk.scroll} > ${hk.client} (${hk.wide})`);
    assert.deepEqual(hk.wide, [], `${width} HK elements escape the viewport`);
    assert.equal(hk.tileOut, 0, `${width} sector tiles escape the map`);
    assert.equal(hk.badRel, 0);
    for (const label of ['篩選條件', '成交額 ≥ HK$1,000 萬', '總市值 > HK$10 億', '大類板塊熱力圖', '板塊明細', '升幅榜 Top 10', '跌幅榜 Top 10']) {
      assert.ok(hk.text.includes(label), `${width} HK view shows ${label}`);
    }
    assert.doesNotMatch(hk.text, /\bfutu\b|富途|\byahoo\b/i);

    await evaluate(`document.querySelector('#hkm-map [data-sector]').click()`);
    const sector = await waitFor((s) => s.text.includes('細分行業'), 'sector detail');
    assert.ok(sector.scroll <= sector.client, `${width} sector detail scroll ${sector.scroll} > ${sector.client}`);
    assert.deepEqual(sector.wide, [], `${width} sector detail escapes the viewport`);

    ws.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  }
});
