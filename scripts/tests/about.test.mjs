import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyHeaders } from '../headers.mjs';
import { buildSitemaps, extractLocs, isNoindexHtml } from '../sitemap.mjs';
import { publicLinkAnchors } from '../../assets/js/chrome-html.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// The owner-approved About body. Paragraph breaks are allowed; wording is not.
const APPROVED_BODY =
  '在資訊充斥、雜音不斷的時代，News Chart 希望為香港投資者與交易者提供優質、清晰的財經資訊。我們將新聞、圖表與實用工具集中於一個容易使用的平台，讓讀者更方便掌握市場，把時間留給分析與判斷。'
  + '本站由 ADRRR 編寫，公開提供港股與美股盤前晨報、港股異動觀察及策略回測，內容免費閱覽，亦可免費訂閱電子報。'
  + '晨報整理公開報道與市場數據，爭取每朝 9 點前更新；部分圖表及指標由本站自行計算，並會說明來源與算法，並非官方數字。'
  + '內容屬研究與參考用途，不構成針對個人的投資建議。';

function bodyParagraphs(html) {
  const article = /<article class="about-body"[^>]*>([\s\S]*?)<\/article>/.exec(html);
  assert.ok(article, 'about-body article is in the static HTML');
  return [...article[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
}

test('About body in static source is exactly the approved text', () => {
  const html = read('about/index.html');
  assert.equal(bodyParagraphs(html).join(''), APPROVED_BODY);
  assert.doesNotMatch(html, /更正|corrections?/i);
});

test('About links line follows the approved body and uses the shared footer anchors', () => {
  const html = read('about/index.html');
  const between = html.slice(html.indexOf('</article>'), html.indexOf('</main>'));
  assert.equal(between.replace(/\s+/g, ' ').trim(), `</article> <p class="about-links">${publicLinkAnchors()}</p>`);
  const article = /<article class="about-body"[^>]*>([\s\S]*?)<\/article>/.exec(html);
  assert.doesNotMatch(article[1], /buttondown|youtube|substack/i);
});

test('About page metadata, canonical and brand', () => {
  const html = read('about/index.html');
  assert.match(html, /<html lang="zh-Hant-HK">/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/news-chart\.com\/about\/">/);
  assert.match(html, /property="og:url" content="https:\/\/news-chart\.com\/about\/"/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.equal(isNoindexHtml(html), false);
  assert.doesNotMatch(html, /noindex/i);
  assert.match(html, /<h1>關於 News Chart<\/h1>/);
  assert.match(html, /ADRRR/);
  assert.match(html, /alt="News Chart"/);
  assert.match(html, /data-newsletter="off"/);
  assert.doesNotMatch(html, /<form\b|mailto:|@[a-z0-9-]+\.[a-z]{2,}/i);
  assert.equal((html.match(/<script type="module"/g) || []).length, 1);
});

test('About is in the page sitemap and every other URL is unchanged', () => {
  const locs = extractLocs(read('sitemap-pages.xml'));
  assert.deepEqual(locs, [
    'https://news-chart.com/',
    'https://news-chart.com/about/',
    'https://news-chart.com/backtest/',
    'https://news-chart.com/politician-tracker/',
    'https://news-chart.com/movers/',
  ]);
  const built = extractLocs(buildSitemaps(root).files['sitemap-pages.xml']);
  assert.ok(built.includes('https://news-chart.com/about/'));
});

test('public-HTML header rules keep /about/ indexable under a prepended noindex', () => {
  const text = `/*\n  X-Robots-Tag: noindex, nofollow\n${read('_headers')}`;
  for (const path of ['/about', '/about/', '/about/index.html']) {
    assert.equal(applyHeaders(text, path).get('x-robots-tag'), null, path);
  }
});

test('footer renderer adds exactly one real About anchor and leaves the tool links alone', () => {
  const src = read('assets/js/site.js');
  assert.equal((src.match(/href="\/about\/"/g) || []).length, 1);
  assert.doesNotMatch(read('assets/tools.json'), /about/i);
});

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

async function chromePath() {
  for (const path of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/local/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { await stat(path); return path; } catch { /* next */ }
  }
  return '';
}

function serve() {
  const server = createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = normalize(join(root, rel));
    try {
      res.writeHead(200, { 'content-type': types[extname(abs)] || 'application/octet-stream' });
      res.end(await readFile(abs));
    } catch { res.writeHead(404).end(); }
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
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
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
  const r = (el) => el && el.getBoundingClientRect();
  const look = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return { color: s.color, deco: s.textDecorationLine, offset: s.textUnderlineOffset };
  };
  return {
    scroll: doc.scrollWidth, client: doc.clientWidth,
    h1: document.querySelector('h1')?.textContent,
    logoAlt: document.querySelector('.mast .mark')?.alt,
    bodyRight: Math.max(...[...document.querySelectorAll('.about-body p')].map((p) => r(p).right)),
    linksRight: r(document.querySelector('.about-links'))?.right ?? 0,
    aboutLinks: [...document.querySelectorAll('.about-links a')].map((a) => a.textContent + '>' + a.getAttribute('href')),
    footerPublic: [...document.querySelectorAll('.site-footer .site-links a')].map((a) => a.textContent + '>' + a.getAttribute('href')),
    aboutLook: look(document.querySelector('.about-links a')),
    footerPublicLook: look(document.querySelector('.site-footer .site-links a')),
    footerNavLook: look(document.querySelector('.site-footer .row a')),
    footerAboutLook: look(document.querySelector('.site-footer .fine a')),
    footerLinks: [...document.querySelectorAll('.site-footer .row span:last-child a')].map((a) => a.textContent + '>' + a.getAttribute('href')),
    aboutAnchors: [...document.querySelectorAll('.site-footer a[href="/about/"]')].map((a) => a.textContent),
    navLinks: [...document.querySelectorAll('.mast-r a')].map((a) => a.textContent + '>' + a.getAttribute('href')),
    newsletter: !!document.getElementById('newsletter'),
    forms: document.querySelectorAll('form').length,
  };
})()`;

test('About renders at phone and desktop widths without overflow, with the footer entry', { timeout: 90000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required. Set CHROME_PATH.');
  const server = await serve();
  const { port } = server.address();
  const profile = await mkdtemp(join(tmpdir(), 'about-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let debugPort = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no debugging port')), 15000);
    proc.stderr.on('data', (buf) => {
      const m = String(buf).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { debugPort = Number(m[1]); clearTimeout(timer); resolve(); }
    });
  });
  t.after(async () => {
    proc.kill('SIGKILL');
    await new Promise((resolve) => (proc.exitCode != null || proc.signalCode != null ? resolve() : proc.once('exit', resolve)));
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await ready;

  for (const width of [320, 375, 390, 768, 1280]) {
    const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/about/`)}`, { method: 'PUT' });
    const target = await created.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const send = cdp(ws);
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 800 });
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
    let s = null;
    for (let i = 0; i < 40; i++) {
      s = (await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value;
      if (s?.aboutAnchors.length && s?.footerPublic.length === 3 && s?.aboutLinks.length === 3) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.deepEqual(s.aboutAnchors, ['About'], `${width} footer About anchor`);
    assert.equal(s.h1, '關於 News Chart');
    assert.equal(s.logoAlt, 'News Chart');
    assert.ok(s.scroll <= s.client, `${width} scroll ${s.scroll} client ${s.client}`);
    assert.ok(s.bodyRight <= s.client, `${width} body text escapes viewport`);
    assert.ok(s.linksRight <= s.client, `${width} links line escapes viewport`);
    const publicLine = ['Newsletter>https://buttondown.com/news-chart', 'YouTube>https://www.youtube.com/@news-chart', 'Substack>https://newschart.substack.com/'];
    const linkLook = { color: 'rgb(26, 63, 209)', deco: 'underline', offset: '3px' };
    assert.deepEqual(s.aboutLinks, publicLine, `${width} About links line`);
    assert.deepEqual(s.footerPublic, publicLine, `${width} footer public links`);
    assert.deepEqual(s.aboutLook, linkLook, `${width} About public links look like links`);
    assert.deepEqual(s.footerPublicLook, linkLook, `${width} footer public links look like links`);
    assert.equal(s.footerNavLook.color, 'rgb(51, 51, 51)', `${width} section nav keeps its color`);
    assert.equal(s.footerNavLook.deco, 'none', `${width} section nav is not underlined at rest`);
    assert.equal(s.footerAboutLook.color, 'rgb(51, 51, 51)', `${width} footer About keeps its color`);
    assert.equal(s.footerAboutLook.deco, 'none', `${width} footer About is not underlined at rest`);
    assert.deepEqual(s.footerLinks, ['Backtest>/backtest/', 'Movers>/movers/', 'Politician Tracker>/politician-tracker/', 'Morning Report>/news/']);
    assert.ok(!s.navLinks.some((l) => l.includes('/about/')), 'no About in top nav');
    assert.equal(s.newsletter, false);
    assert.equal(s.forms, 0);
    ws.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  }
});
