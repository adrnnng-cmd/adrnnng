import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { liveDoc } from './movers-fixture.mjs';

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

// A plain static server: like `python3 -m http.server`, so /movers/data/latest is a 404
// and the page has to fall back to the demo document, exactly as the offline preview does.
function serve({ latest } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (latest && url.pathname === '/movers/data/latest') return void latest(req, res);
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
    return r.width > 0 && r.right > doc.clientWidth + 1 && !el.closest('.hkm-map, .tape, .hkm-members-wrap');
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
    sb: q('.hkm-sb').length,
    sbBar: document.querySelector('.hkm-sb-bar')?.getAttribute('aria-label') || '',
    sbLegend: document.querySelector('.hkm-sb-leg')?.innerText || '',
    sbSegs: [...q('.hkm-sb-bar span')].map((el) => el.innerText),
    headUp: document.querySelector('.hkm-list-h.is-up') ? getComputedStyle(document.querySelector('.hkm-list-h.is-up')).backgroundColor : '',
    headDown: document.querySelector('.hkm-list-h.is-down') ? getComputedStyle(document.querySelector('.hkm-list-h.is-down')).backgroundColor : '',
    headText: document.querySelector('.hkm-list-h.is-up') ? getComputedStyle(document.querySelector('.hkm-list-h.is-up')).color : '',
    notes: [...q('.hkm-note')].map((el) => el.innerText),
    updated: document.querySelector('#hkm-updated')?.innerText || '',
  };
})()`;

/** Starts headless Chrome and returns its debugging port. Cleanup is registered on `t`. */
async function startChrome(t, server) {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required for the layout check. Set CHROME_PATH.');
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
  return debugPort;
}

async function openTab(debugPort, url) {
  const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = cdp(ws);
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const close = async () => {
    ws.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  };
  return { send, evaluate, close };
}

test('HK Movers renders both views without horizontal overflow at phone and desktop widths', { timeout: 120000 }, async (t) => {
  const server = await serve();
  const { port } = server.address();
  const debugPort = await startChrome(t, server);

  for (const width of [320, 375, 390, 768, 1440]) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/movers/`)}`, { method: 'PUT' });
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
    assert.equal(hsi.sb, 1, 'breadth bar renders once');
    assert.match(hsi.sbBar, /上升 \d+ 隻（[\d.]+%）.*平盤 \d+ 隻.*下跌 \d+ 隻.*共 95 隻/);
    assert.deepEqual(hsi.sbSegs.length, 3);
    assert.equal(hsi.headUp, 'rgb(0, 130, 89)');
    assert.equal(hsi.headDown, 'rgb(165, 0, 52)');
    assert.equal(hsi.headText, 'rgb(255, 255, 255)');
    assert.match(hsi.updated, /快照更新/);
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

// ------------------------------------------------------------ index views and the constituents table

const TABLE = `(() => {
  const q = (s) => [...document.querySelectorAll(s)];
  const wrap = document.querySelector('.hkm-members-wrap');
  const th = (id) => document.querySelector('[data-msort="' + id + '"]')?.closest('th');
  const stock = document.querySelector('.hkm-members-table tbody th.m-stock');
  const wr = wrap?.getBoundingClientRect();
  return {
    tab: document.querySelector('[role=tab][aria-selected=true]')?.dataset.view,
    tabs: q('[role=tab]').map((b) => b.dataset.view),
    tabText: q('[role=tab]').map((b) => b.innerText.replace(/\\s+/g, ' ')),
    codes: q('.hkm-members-table tbody th.m-stock .code').map((el) => el.innerText),
    rows: q('.hkm-members-table tbody tr').length,
    naRows: q('.hkm-members-table tbody tr.is-na').map((tr) => tr.innerText.replace(/\\s+/g, ' ')),
    heads: q('.hkm-members-table thead th').map((el) => el.innerText.replace(/\\s+/g, ' ')),
    ariaSort: Object.fromEntries(['weight', 'd1', 'd5', 'm1', 'ytd', 'last', 'cap'].map((id) => [id, th(id)?.getAttribute('aria-sort')])),
    sortButtons: q('[data-msort]').length,
    btnH: Math.min(...q('[data-msort]').map((b) => b.getBoundingClientRect().height)),
    btnTag: q('[data-msort]').every((b) => b.tagName === 'BUTTON' && b.type === 'button'),
    active: document.activeElement?.dataset?.fk || '',
    live: document.querySelector('#hkm-live')?.innerText || '',
    firstRow: document.querySelector('.hkm-members-table tbody tr')?.innerText.replace(/\\s+/g, ' ') || '',
    wrapScrollable: wrap ? wrap.scrollWidth > wrap.clientWidth : null,
    wrapLeft: wr?.left, stockLeft: stock?.getBoundingClientRect().left,
    scrollOk: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    members: !!document.querySelector('.hkm-members'),
    roster: document.querySelector('.hkm-roster')?.innerText.replace(/\\s+/g, ' ') || '',
    refnote: document.querySelector('.hkm-refnote')?.innerText || '',
    aux: document.querySelector('.hkm-members .aux')?.innerText || '',
    heads2: q('.hkm-list-h').map((el) => el.innerText.replace(/\\s+/g, ' ')),
    notes: q('.hkm-note:not(.hkm-refnote)').map((el) => el.innerText),
    criteria: document.querySelector('.hkm-criteria')?.innerText.replace(/\\s+/g, ' ') || '',
    stats: document.querySelector('.hkm-stats')?.innerText.replace(/\\s+/g, ' ') || '',
    url: location.search,
    tiles: q('.hm-tile').length,
    text: document.documentElement.innerText,
  };
})()`;

test('HSI and HSTECH views: full constituents table, sorting, accessibility, layout', { timeout: 180000 }, async (t) => {
  const { readFileSync } = await import('node:fs');
  const { sortMembers, nextSort, DEFAULT_MEMBER_SORT } = await import('../../movers/lib.js');
  const sample = JSON.parse(readFileSync(join(root, 'movers/data/sample.json'), 'utf8'));
  const server = await serve();
  const { port } = server.address();
  const debugPort = await startChrome(t, server);
  const shotDir = process.env.HKM_SHOT_DIR;
  const { writeFile, mkdir } = await import('node:fs/promises');

  for (const width of [375, 1440]) {
    const tab = await openTab(debugPort, 'about:blank');
    const { send, evaluate } = tab;
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 800 });
    const waitFor = async (predicate, label, ms = 12000) => {
      const until = Date.now() + ms;
      let last = null;
      while (Date.now() < until) {
        last = await evaluate(TABLE);
        if (last && predicate(last)) return last;
        await new Promise((r) => setTimeout(r, 120));
      }
      throw new Error(`${width}px: ${label} never happened; last ${JSON.stringify({ ...last, text: undefined })}`);
    };
    const go = async (path) => {
      await send('Page.navigate', { url: `http://127.0.0.1:${port}${path}` });
      return waitFor((s) => s.tiles > 0 || s.members, `load ${path}`);
    };
    const shotEl = async (selector, name) => {
      if (!shotDir) return;
      await new Promise((r) => setTimeout(r, 300));
      const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
      const out = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: Math.max(box.y - 8, 0), width, height: Math.ceil(box.h + 16), scale: 1 } });
      await mkdir(shotDir, { recursive: true });
      await writeFile(join(shotDir, `${name}.png`), Buffer.from(out.data, 'base64'));
    };
    const shotPage = async (name) => {
      if (!shotDir) return;
      await new Promise((r) => setTimeout(r, 400));
      const metrics = await send('Page.getLayoutMetrics');
      const h = Math.ceil(metrics.cssContentSize?.height || metrics.contentSize.height);
      const out = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
      await mkdir(shotDir, { recursive: true });
      await writeFile(join(shotDir, `${name}.png`), Buffer.from(out.data, 'base64'));
    };
    const label = width < 800 ? `mobile-${width}` : `desktop-${width}`;

    for (const [view, key, total, priced] of [['hsi', 'hsi', 95, 95], ['hstech', 'hstech', 30, 29]]) {
      const members = sample[key].members;
      const s0 = await go(view === 'hsi' ? '/movers/' : '/movers/?view=hstech');
      assert.equal(s0.tab, view);
      assert.deepEqual(s0.tabs, ['hsi', 'hk', 'hstech'], 'three views in order');
      assert.match(s0.tabText.join('|'), /HSI 恒生指數 95 隻成分股\|HK 港股全市場.*\|HSTECH 恒生科技指數 30 隻成分股/);
      assert.equal(s0.rows, total, `${view}: every official member has a row`);
      assert.equal(s0.sortButtons, 7);
      assert.ok(s0.btnTag, 'headers are real buttons');
      assert.ok(s0.btnH >= 32, `sort buttons are tappable (${s0.btnH}px)`);
      assert.deepEqual(s0.ariaSort, { weight: 'descending', d1: 'none', d5: 'none', m1: 'none', ytd: 'none', last: 'none', cap: 'none' });
      assert.deepEqual(s0.codes, sortMembers(members, DEFAULT_MEMBER_SORT).map((m) => m.code), 'default order is official weight, high to low');
      assert.match(s0.heads.join('|'), /5日 對比 11-13.*1個月 對比 10-20.*年初至今 對比 2025-12-31/);
      assert.match(s0.refnote, /前復權收市價/);
      assert.match(s0.aux, new RegExp(`共 ${total} 隻官方成分股 · ${priced} 隻有報價`));
      assert.match(s0.roster, /不套用成交額／市值篩選/);
      assert.match(s0.roster, /截至 2026-11-18/);
      assert.match(s0.roster, /已公佈 · 未生效/);
      assert.match(s0.roster, /尚未生效，目前仍按現行名單與權重顯示/);
      if (view === 'hstech') {
        assert.match(s0.roster, /由 30 隻調整為 50 隻（新增 20 隻）/);
        assert.equal(s0.naRows.length, 1);
        assert.match(s0.naRows[0], /騰訊音樂-SW 01698暫無報價 0\.08% — — — — — —/);
        assert.equal(s0.codes.at(-1), '01698', 'the member without a quote sorts last by weight too');
        assert.ok(s0.heads2.some((h) => /跌幅榜.*實際 5 隻/.test(h)), s0.heads2.join('|'));
        assert.ok(s0.notes.some((n) => /恒生科技指數成分股共 29 隻，只有 5 隻下跌.*不以上升股補位/.test(n)), s0.notes.join('|'));
        assert.match(s0.stats, /恒生科技指數成分股 29 隻合計/);
      } else {
        assert.match(s0.roster, /名單不變（95 隻）/);
        assert.equal(s0.codes[0], '00005');
        assert.match(s0.firstRow, /匯豐控股 00005 7\.37%/);
      }
      assert.ok(s0.scrollOk, `${label} ${view}: no page-level horizontal overflow`);
      if (width < 800) assert.equal(s0.wrapScrollable, true, 'phone: the table scrolls inside its own region');
      await shotPage(`${label}-${view}`);
      await shotEl('.hkm-members', `${label}-${view}-table`);

      // every column, both directions: DOM order == the library order, aria-sort follows, unavailable last, focus stays.
      let sort = { ...DEFAULT_MEMBER_SORT };
      for (const col of ['d5', 'm1', 'ytd', 'd1', 'last', 'cap', 'weight']) {
        for (let i = 0; i < 2; i++) {
          sort = nextSort(sort, col);
          await evaluate(`(() => { const b = document.querySelector('[data-msort="${col}"]'); b.focus(); b.click(); return true; })()`);
          const want = sortMembers(members, sort).map((m) => m.code);
          const got = await waitFor((s) => s.ariaSort[col] === (sort.dir === 'asc' ? 'ascending' : 'descending'), `${view} ${col} ${sort.dir}`);
          assert.deepEqual(got.codes, want, `${view} ${col} ${sort.dir}`);
          assert.equal(Object.values(got.ariaSort).filter((v) => v !== 'none').length, 1, 'exactly one sorted column');
          assert.equal(got.active, `msort-${col}`, 'keyboard focus stays on the header button');
          assert.match(got.live, sort.dir === 'asc' ? /由低至高/ : /由高至低/);
          assert.equal(got.rows, total, 'sorting never drops a member');
          if (view === 'hstech' && col !== 'weight') assert.equal(got.codes.at(-1), '01698', `${col} ${sort.dir}: unavailable member stays last`);
          assert.ok(got.scrollOk);
        }
      }
      // d5 ascending then descending screenshots
      await evaluate(`document.querySelector('[data-msort="d5"]').click(); true`);
      await waitFor((s) => s.ariaSort.d5 === 'descending', 'd5 desc');
      await shotEl('.hkm-members', `${label}-${view}-table-sorted-5d-desc`);
      await evaluate(`document.querySelector('[data-msort="d5"]').click(); true`);
      await waitFor((s) => s.ariaSort.d5 === 'ascending', 'd5 asc');
      await shotEl('.hkm-members', `${label}-${view}-table-sorted-5d-asc`);

      if (width < 800) {
        await evaluate(`document.querySelector('.hkm-members-wrap').scrollLeft = 260; true`);
        await new Promise((r) => setTimeout(r, 150));
        const sticky = await evaluate(TABLE);
        assert.ok(Math.abs(sticky.stockLeft - sticky.wrapLeft) <= 1.5, `stock column stays pinned while scrolled (${sticky.stockLeft} vs ${sticky.wrapLeft})`);
        await shotEl('.hkm-members', `${label}-${view}-table-scrolled`);
      }
    }

    // the sort state of a view survives a tab round trip, and HK has no constituents table.
    await go('/movers/?view=hstech');
    await evaluate(`document.querySelector('[data-msort="ytd"]').click(); document.querySelector('[data-view=hk]').click(); true`);
    const hk = await waitFor((s) => s.tab === 'hk' && s.criteria.includes('篩選條件'), 'HK view');
    assert.equal(hk.members, false, 'the whole-market view has no constituents table');
    assert.match(hk.criteria, /成交額 ≥ HK\$1,000 萬.*總市值 > HK\$10 億/);
    assert.match(hk.url, /view=hk/);
    await evaluate(`document.querySelector('[data-view=hstech]').click(); true`);
    const back = await waitFor((s) => s.tab === 'hstech' && s.members, 'back to HSTECH');
    assert.equal(back.ariaSort.ytd, 'descending', 'sort choice is kept per view');
    assert.match(back.url, /view=hstech/);
    await evaluate(`document.querySelector('[data-view=hsi]').click(); true`);
    const hsi = await waitFor((s) => s.tab === 'hsi' && s.members, 'HSI view');
    assert.doesNotMatch(hsi.url, /view=/);
    assert.equal(hsi.ariaSort.weight, 'descending', 'the HSI table keeps its own sort');
    await shotPage(`${label}-hk-view`);

    // keyboard: arrow keys walk the three tabs in order and wrap.
    await evaluate(`document.querySelector('#tab-hsi').focus(); true`);
    for (const next of ['hk', 'hstech', 'hsi']) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await waitFor((s) => s.tab === next, `arrow to ${next}`);
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await waitFor((s) => s.tab === 'hstech', 'arrow left wraps');
    assert.doesNotMatch((await evaluate(TABLE)).text, /\bfutu\b|富途|moomoo|\byahoo\b|雅虎/i);
    await tab.close();
  }
});

// ------------------------------------------------------------ live refresh in a real browser

const BASE = Date.parse('2026-11-20T14:00:00+08:00');
const CLOCK = `(() => {
  const RealDate = Date;
  const base = ${BASE};
  const start = RealDate.now();
  window.__skewMs = 0;
  const nowMs = () => base + (RealDate.now() - start) + window.__skewMs;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(nowMs()); else super(...a); }
    static now() { return nowMs(); }
  }
  window.Date = FakeDate;
})()`;

const SNAP = `(() => {
  const q = (s) => [...document.querySelectorAll(s)];
  const pressed = (s) => q(s).filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.sort || b.dataset.sector || b.dataset.code);
  return {
    updated: document.querySelector('#hkm-updated')?.innerText || '',
    notice: document.querySelector('#hkm-notice')?.innerText || '',
    sbBar: document.querySelector('.hkm-sb-bar')?.getAttribute('aria-label') || '',
    sbSegs: q('.hkm-sb-bar span').map((el) => el.innerText),
    sbColors: q('.hkm-sb-bar span').map((el) => getComputedStyle(el).color),
    upRows: q('.hkm-list[data-dir=up] .hkm-row').length,
    downRows: q('.hkm-list[data-dir=down] .hkm-row').length,
    upHead: document.querySelector('.hkm-list-h.is-up')?.innerText.replace(/\\s+/g, ' ') || '',
    downHead: document.querySelector('.hkm-list-h.is-down')?.innerText.replace(/\\s+/g, ' ') || '',
    notes: q('.hkm-note').map((el) => el.innerText),
    upCodes: q('.hkm-list[data-dir=up] .hkm-row .code').map((el) => el.innerText),
    sort: pressed('[data-sort]'), sector: pressed('.hkm-chip[data-sector]'), tile: pressed('.hm-tile[data-code]'),
    detailOpen: !!document.querySelector('[data-clear-stock]'),
    newsTimes: q('a.news .news-m').map((el) => (el.innerText.match(/\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}/) || [''])[0]),
    newsEmpty: q('.news-empty').map((el) => el.innerText),
    tab: document.querySelector('[role=tab][aria-selected=true]')?.dataset.view,
    scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    skew: window.__skewMs,
    fakeNow: new Date().getTime(),
    text: document.documentElement.innerText,
  };
})()`;

test('live page polls, recovers on focus, never overlaps, keeps state, and flags stale or failed refreshes', { timeout: 120000 }, async (t) => {
  const script = { mode: 'ok', doc: liveDoc({ now: BASE - 30_000 }), requests: 0, active: 0, maxActive: 0 };
  const server = await serve({
    latest: async (_req, res) => {
      script.requests += 1;
      script.active += 1;
      script.maxActive = Math.max(script.maxActive, script.active);
      await new Promise((r) => setTimeout(r, 250));
      script.active -= 1;
      if (script.mode === 'fail') return void res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"down"}');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(script.doc));
    },
  });
  const { port } = server.address();
  const debugPort = await startChrome(t, server);
  const tab = await openTab(debugPort, 'about:blank');
  const { send, evaluate } = tab;
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/movers/` });

  const waitFor = async (predicate, label, ms = 12000) => {
    const until = Date.now() + ms;
    let last = null;
    while (Date.now() < until) {
      last = await evaluate(SNAP);
      if (last && predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`${label} never happened; last ${JSON.stringify({ ...last, text: undefined })}`);
  };
  const skew = (ms) => evaluate(`window.__skewMs += ${ms}`);
  const shot = async (name, { width, height = 900, full = true } = {}) => {
    const dir = process.env.HKM_SHOT_DIR;
    if (!dir) return;
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 800 });
    await new Promise((r) => setTimeout(r, 400));
    const metrics = await send('Page.getLayoutMetrics');
    const h = Math.ceil(metrics.cssContentSize?.height || metrics.contentSize.height);
    const out = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, clip: full ? { x: 0, y: 0, width, height: h, scale: 1 } : undefined });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), Buffer.from(out.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  };

  // 1. first load: HSI has only 5 gainers, and the page says so instead of padding the list.
  const first = await waitFor((s) => s.upRows > 0 && s.downRows > 0, 'first render');
  assert.match(first.updated, /快照更新：2026-11-20 13:59（HKT）/);
  assert.doesNotMatch(first.updated + first.notice, /已過時|更新失敗|示範/);
  assert.deepEqual(first.sbSegs, ['5', '1', '89']);
  assert.deepEqual(first.sbColors, Array(3).fill('rgb(255, 255, 255)'), 'every count is white on its segment, including the flat one');
  assert.match(first.sbBar, /上升 5 隻（5\.3%）.*平盤 1 隻（1\.1%）.*下跌 89 隻（93\.7%）.*共 95 隻/);
  assert.equal(first.upRows, 5);
  assert.equal(first.downRows, 10);
  assert.match(first.upHead, /升幅榜.*實際 5 隻 · 最多 10 隻/);
  assert.match(first.downHead, /跌幅榜 Top 10/);
  assert.ok(first.notes.some((n) => /恒生指數成分股共 95 隻，只有 5 隻上升（89 隻下跌、1 隻持平），不足 10 隻.*不以下跌股補位/.test(n)), first.notes.join('|'));
  assert.ok(first.scroll);
  assert.ok(first.newsEmpty.length >= 1 && first.newsEmpty.every((x) => x === '暫無近3日相關新聞'), 'old headlines show the 3-day empty state');
  for (const stamp of first.newsTimes) {
    const ageH = (first.fakeNow - Date.parse(`${stamp.replace(' ', 'T')}:00+08:00`)) / 3600e3;
    assert.ok(ageH >= 0 && ageH <= 72, `${stamp} is ${ageH.toFixed(1)}h old`);
  }
  await shot('desktop-1440-hsi', { width: 1440 });
  await shot('mobile-375-hsi', { width: 375, height: 812 });

  // 2. the user picks things; a background refresh must not undo them.
  await evaluate(`document.querySelector('[data-sort=turnover]').click()`);
  await evaluate(`document.querySelector('.hkm-chip[data-sector]').click()`);
  await evaluate(`document.querySelector('.hm-tile[data-code]:not(.is-dim)').click()`);
  const chosen = await waitFor((s) => s.sort[0] === 'turnover' && s.sector.length === 1 && s.detailOpen, 'user selections');
  const picked = { sector: chosen.sector[0], tile: chosen.tile[0] };

  // 3. focus after the 10 s guard: one new fetch, the page shows the new update time and keeps the selections.
  const next = liveDoc({ now: BASE + 70_000 - 10_000, hsi: { up: 6, down: 88, flat: 1 } });
  script.doc = next;
  const before = script.requests;
  await skew(70_000);
  await evaluate(`window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); true`);
  const refreshed = await waitFor((s) => s.updated.includes('快照更新：2026-11-20 14:01'), 'refreshed update time');
  assert.equal(script.requests - before, 1, 'three recovery events caused exactly one request');
  assert.equal(script.maxActive, 1, 'requests never overlapped');
  assert.deepEqual(refreshed.sbSegs.length, 3);
  assert.equal(refreshed.sbSegs[0], '6', 'the new counts are on screen');
  assert.deepEqual(refreshed.sort, ['turnover']);
  assert.deepEqual(refreshed.sector, [picked.sector]);
  assert.equal(refreshed.detailOpen, true);
  assert.equal(refreshed.tab, 'hsi');
  assert.doesNotMatch(refreshed.updated + refreshed.notice, /已過時|更新失敗/);

  // 4. a transient failure keeps the last good data and says so prominently.
  script.mode = 'fail';
  await skew(70_000);
  await evaluate(`window.dispatchEvent(new Event('focus')); true`);
  const failed = await waitFor((s) => /更新失敗/.test(s.notice), 'failure notice');
  assert.match(failed.updated, /快照更新：2026-11-20 14:01（HKT）/, 'previous snapshot time stays');
  assert.match(failed.notice, /舊快照/);
  assert.match(failed.notice, /並非最新資料/);
  assert.match(failed.updated, /更新失敗/);
  assert.doesNotMatch(failed.updated, /資料已過時/, 'a single failed refresh on a 2-minute-old snapshot is not called stale');
  assert.doesNotMatch(failed.notice, /快照過時/, 'not yet beyond 10 minutes');
  assert.equal(failed.upRows > 0, true, 'the data is still on screen');
  assert.deepEqual(failed.sort, ['turnover']);
  assert.deepEqual(failed.sector, [picked.sector]);

  // 5. beyond 10 minutes at the open the snapshot is flagged stale as well.
  await skew(620_000);
  await evaluate(`window.dispatchEvent(new Event('focus')); true`);
  const stale = await waitFor((s) => /快照過時/.test(s.notice) && /更新失敗/.test(s.notice), 'stale + failure notices');
  assert.match(stale.notice, /距今 1[0-9] 分鐘/);
  assert.match(stale.updated, /資料已過時/);
  assert.doesNotMatch(stale.text, /即時串流報價|即時更新/);
  await shot('desktop-1440-stale-error', { width: 1440, full: false });

  // 6. the retry button recovers.
  script.mode = 'ok';
  script.doc = liveDoc({ now: BASE + 70_000 + 70_000 + 620_000 - 5_000, hsi: { up: 8, down: 86, flat: 1 } });
  await evaluate(`document.querySelector('#hkm-notice [data-refresh]').click(); true`);
  const healthy = await waitFor((s) => !/更新失敗|快照過時/.test(s.notice) && s.sbSegs[0] === '8', 'recovery');
  assert.doesNotMatch(healthy.updated, /已過時/);
  assert.deepEqual(healthy.sort, ['turnover']);
  assert.equal(script.maxActive, 1, 'still never overlapped');

  // 7. HK view: the same honesty for the whole-market lists.
  await evaluate(`document.querySelector('[data-view=hk]').click(); true`);
  const hk = await waitFor((s) => s.tab === 'hk' && s.upRows > 0, 'HK view');
  assert.equal(hk.upRows, 7);
  assert.equal(hk.downRows, 10);
  assert.match(hk.upHead, /升幅榜.*實際 7 隻 · 最多 10 隻/);
  assert.ok(hk.notes.some((n) => /合資格股票共 \d+ 隻，只有 7 隻上升.*不以下跌股補位/.test(n)), hk.notes.join('|'));
  await shot('desktop-1440-hk', { width: 1440 });
  await shot('mobile-375-hk', { width: 375, height: 812 });
  assert.ok((await evaluate(SNAP)).scroll);
  await tab.close();
});
