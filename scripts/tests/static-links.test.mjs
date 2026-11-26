import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { doorsInner, footerInner, headerInner, PUBLIC_LINKS, publicLinkAnchors, TOP_NAV } from '../../assets/js/chrome-html.js';
import { pages, plan, staleFiles, staticChromeError, writeAll } from '../static-chrome.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const registry = JSON.parse(read('assets/tools.json'));
const CANONICAL = ['/backtest/', '/movers/', '/politician-tracker/', '/news/'];

/** What view-source shows: the HTML as committed, with every script removed, so only real markup is counted. */
function withoutScripts(html) {
  return html.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
}
const hrefs = (html) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
const part = (html, re) => re.exec(html)?.[2] ?? '';
const HEADER = /(<header\b[^>]*data-site-header[^>]*>)([\s\S]*?)(<\/header>)/;
const FOOTER = /(<footer\b[^>]*data-site-footer[^>]*>)([\s\S]*?)(<\/footer>)/;
const DOORS = /(<nav\b[^>]*id="tools"[^>]*>)([\s\S]*?)(<\/nav>)/;

test('home page source carries real links to /backtest/, /movers/, /politician-tracker/ and /news/ without any script', () => {
  const html = withoutScripts(read('index.html'));
  const doors = part(html, DOORS);
  for (const href of CANONICAL) {
    assert.match(doors, new RegExp(`<a class="door" data-door="[a-z-]+" href="${href}">`), `door card links ${href}`);
    assert.ok(hrefs(part(html, FOOTER)).includes(href), `footer links ${href}`);
  }
  assert.deepEqual(hrefs(doors), CANONICAL, 'one card per section, in the cover order');
  assert.deepEqual(TOP_NAV.map((item) => item.href), ['/news/', '/movers/', '/politician-tracker/', '/backtest/']);
  assert.deepEqual(TOP_NAV.map((item) => item.label), ['晨報', '港股異動', '政治人物持股動向', '策略回測']);
  const header = part(html, HEADER);
  assert.deepEqual(hrefs(header).filter((href) => href !== '/'), TOP_NAV.map((item) => item.href), 'top menu order');
  for (const item of TOP_NAV) assert.match(header, new RegExp(`<a href="${item.href}">${item.label}</a>`));
  assert.match(header, /<a class="logo" href="\/" aria-label="News Chart home"><img class="mark" src="\/assets\/brand\/news-chart-white\.svg"/);
  assert.match(header, /<button class="nav-toggle" aria-label="Menu" aria-expanded="false"><span><\/span><\/button>/);
  assert.doesNotMatch(header, /class="box"|target="_blank"|Morning Report|港股異動與板塊熱力圖/);
  assert.match(headerInner(registry, { path: '/news/20261126/' }), /<a href="\/news\/" aria-current="page">晨報<\/a>/);
  assert.match(headerInner(registry, { path: '/movers/' }), /<a href="\/movers\/" aria-current="page">港股異動<\/a>/);
  assert.doesNotMatch(headerInner(registry, { path: '/' }), /aria-current/);
});

test('every door card has its visible name and a description in the source, not only links', () => {
  const doors = part(read('index.html'), DOORS);
  for (const name of ['Backtest', 'Movers', 'Politician Tracker', 'Morning Report']) assert.ok(doors.includes(`>${name}`), name);
  assert.match(doors, /港股異動/);
  assert.match(doors, /約 5–6 分鐘更新快照/);
  assert.match(doors, /TD Sequential 9 \/ 13/);
  assert.equal((doors.match(/<span class="go">Open →<\/span>/g) || []).length, 4);
  assert.equal((doors.match(/<a class="door"/g) || []).length, 4, 'no extra or hidden cards');
  assert.doesNotMatch(doors, /\bhidden\b|display:\s*none|aria-hidden|visually-hidden|sr-only/, 'no hidden link block');
});

test('links are the canonical production paths: relative, no preview host, no legacy /hk-movers/', () => {
  const html = read('index.html');
  const chrome = [part(html, HEADER), part(html, FOOTER), part(html, DOORS)].join('\n');
  const publicHrefs = new Set(PUBLIC_LINKS.map((link) => link.href));
  const internal = chrome.replace(publicLinkAnchors(), '');
  assert.doesNotMatch(internal, /hk-movers|localhost|127\.0\.0\.1|pages\.dev|workers\.dev|demo|preview|https?:\/\/(?!buttondown)/i);
  for (const href of hrefs(chrome)) {
    if (publicHrefs.has(href)) continue;
    assert.match(href, /^\/(?:[a-z-]+\/)?$/, href);
  }
  assert.match(part(html, FOOTER), new RegExp(publicLinkAnchors().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(PUBLIC_LINKS.map((link) => link.label), ['Newsletter', 'YouTube', 'Substack']);
});

test('pages outside the homepage stay the live empty chrome shells', () => {
  for (const file of ['movers/index.html', 'backtest/index.html', '404.html', 'thanks/index.html', 'scripts/templates/tool/index.html']) {
    assert.match(read(file), /<footer data-site-footer><\/footer>/, file);
    assert.doesNotMatch(part(read(file), FOOTER), /href="\/backtest\/"/, `${file} footer is not rewritten`);
  }
  const about = read('about/index.html');
  assert.match(about, /<link rel="canonical" href="https:\/\/news-chart.com\/about\/">/);
  assert.match(about, /<footer data-site-footer>\s*<div class="wrap"><div class="fine"><a href="\/about\/">About<\/a><\/div><\/div>\s*<\/footer>/);
  assert.doesNotMatch(part(about, FOOTER), /href="\/backtest\/"/);
});

test('the Morning Report cover rewritten at assemble time is outside the generated regions', () => {
  const home = read('index.html');
  const cover = /<p class="kicker" id="report-kicker">[\s\S]*?<\/table>/.exec(home)?.[0];
  assert.ok(cover);
  for (const re of [HEADER, FOOTER, DOORS]) assert.ok(!cover.includes(part(home, re).trim().slice(0, 60)), 'cover and chrome do not overlap');
  assert.ok(home.indexOf('id="report-kicker"') < home.indexOf('id="tools"'));
});

test('committed pages are exactly what the generator writes; a stale page is reported and repaired', () => {
  assert.deepEqual(staleFiles(root), []);
  assert.equal(staticChromeError(root), '');
  const tmp = mkdtempSync(join(tmpdir(), 'static-chrome-'));
  try {
    for (const f of [...pages(root), 'assets/tools.json']) {
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      cpSync(join(root, f), join(tmp, f));
    }
    assert.deepEqual(pages(tmp), ['index.html']);
    const homeShell = join(tmp, 'index.html');
    writeFileSync(homeShell, readFileSync(homeShell, 'utf8').replace(/<footer[\s\S]*?<\/footer>/, '<footer data-site-footer></footer>'));
    assert.deepEqual(staleFiles(tmp), ['index.html']);
    assert.match(staticChromeError(tmp), /stale in index\.html/);
    assert.deepEqual(writeAll(tmp), ['index.html']);
    assert.deepEqual(writeAll(tmp), [], 'second run changes nothing');
    assert.equal(readFileSync(homeShell, 'utf8'), read('index.html'));
    const index = join(tmp, 'index.html');
    writeFileSync(index, readFileSync(index, 'utf8').replace(/<nav\b[^>]*id="tools"[\s\S]*?<\/nav>/, '<nav class="doors wrap" id="tools" aria-label="Sections"></nav>'));
    assert.deepEqual(staleFiles(tmp), ['index.html']);
    writeAll(tmp);
    assert.equal(readFileSync(index, 'utf8'), read('index.html'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the generator keeps everything outside the three regions byte for byte', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'static-chrome-'));
  try {
    for (const f of [...pages(root), 'assets/tools.json']) {
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      cpSync(join(root, f), join(tmp, f));
    }
    const edited = registry.tools.map((t) => (t.id === 'news' ? { ...t, title: 'Morning Brief' } : t));
    writeFileSync(join(tmp, 'assets/tools.json'), JSON.stringify({ ...registry, tools: edited }));
    writeAll(tmp);
    const strip = (html) => html.replace(HEADER, '$1$3').replace(FOOTER, '$1$3').replace(DOORS, '$1$3');
    for (const p of plan(tmp)) assert.equal(strip(readFileSync(join(tmp, p.file), 'utf8')), strip(read(p.file)), p.file);
    const stamped = readFileSync(join(tmp, 'index.html'), 'utf8');
    assert.match(part(stamped, HEADER), /<a href="\/news\/">晨報<\/a>/, 'the top menu label stays the shared contract');
    assert.doesNotMatch(part(stamped, HEADER), /Morning Brief|class="box"/);
    assert.match(part(stamped, FOOTER), />Morning Brief</, 'the registry title still flows into the footer');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('npm run new-tool leaves the new section in every static header, footer and the home cards', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'static-chrome-'));
  try {
    const files = [...pages(root), 'assets/tools.json', 'scripts/new-tool.mjs', 'scripts/static-chrome.mjs', 'assets/js/chrome-html.js', 'assets/js/latest.js',
      'scripts/templates/tool/index.html', 'scripts/templates/tool/app.js', 'scripts/templates/tool/style.css', 'movers/index.html', 'package.json'];
    for (const f of files) {
      if (!existsSync(join(root, f))) continue;
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      cpSync(join(root, f), join(tmp, f));
    }
    const out = execFileSync(process.execPath, ['scripts/new-tool.mjs', 'fx-lab', 'FX Lab', '--summary', 'Currency pairs.'], { cwd: tmp, encoding: 'utf8' });
    assert.match(out, /static links added to/);
    const home = readFileSync(join(tmp, 'index.html'), 'utf8');
    assert.ok(hrefs(part(home, FOOTER)).includes('/fx-lab/'), 'homepage footer');
    assert.equal(readFileSync(join(tmp, 'movers/index.html'), 'utf8'), read('movers/index.html'), 'movers is not rewritten');
    assert.deepEqual(staleFiles(tmp), []);
    const created = readFileSync(join(tmp, 'fx-lab/index.html'), 'utf8');
    assert.match(created, /<footer data-site-footer><\/footer>/, 'the new page keeps the template shell');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the browser module and the generator draw the same markup from one function', () => {
  const home = read('index.html');
  const norm = (text) => text.replace(/^/gm, '    ').trim();
  assert.equal(part(home, FOOTER).trim(), footerInner(registry).replace(/^/gm, '    ').trim());
  assert.equal(part(home, HEADER).trim(), norm(headerInner(registry, { path: '/' })));
  assert.equal(part(read('movers/index.html'), HEADER).trim(), norm(headerInner(registry, { path: '/movers/' })));
  assert.equal(part(read('about/index.html'), HEADER).trim(), norm(headerInner(registry, { path: '/about/' })));
  assert.equal(part(read('backtest/index.html'), HEADER).trim(), norm(headerInner(registry, { path: '/backtest/' })));
  assert.equal(part(home, DOORS).trim(), doorsInner(registry).trim());
  const site = read('assets/js/site.js');
  const homeJs = read('assets/js/home.js');
  assert.match(site, /from '\.\/chrome-html\.js'/);
  assert.match(homeJs, /from '\.\/chrome-html\.js'/);
  assert.doesNotMatch(site.replace(/^\/\/.*$/gm, ''), /<footer|class="mast-r"/, 'site.js no longer owns a second copy of the markup');
});

test('new section checks run in npm run check', () => {
  assert.match(read('scripts/check-site.mjs'), /staticChromeError/);
  assert.match(JSON.parse(read('package.json')).scripts['static-chrome'], /static-chrome\.mjs/);
});

// -------------------------------------------------------- the assemble step does not undo it

const EDITION = `<html lang="zh-Hant-HK"><head><title>測試鉤子｜10月26日港股美股盤前早報 — ADRRR</title></head><body>
<section class="edition"><div class="kicker">每日簡報<span class="sep">/</span>Daily Briefing<span class="sep">/</span>2026年10月26日（一）</div>
<h1>晨報摘要｜2026年10月26日（一）</h1></section>
<p class="mw-intro"><b>早晨。</b>標普500 (S&amp;P 500) 收市。</p>
<article class="lead" id="s1"><h2>Lead headline for the fixture edition</h2><p class="body">body fallback</p></article>
<h3>第一則要聞長標題用來通過長度過濾條件</h3>
<table class="mkt"><tr><td class="n">標普500 S&amp;P 500<span class="sub">10/23</span></td><td class="v"><span class="v">7,623.68</span></td><td class="c down"><span class="c down">▼0.52%</span></td></tr></table>
</body></html>`;

test('home-preview, seo-meta, news-feed and the sitemap step keep the static links and the canonical Movers URL', () => {
  const site = mkdtempSync(join(tmpdir(), 'static-assemble-'));
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
      .filter((f) => !/^(\.github\/|scripts\/|backtest\/tests\/|package\.json$|.*\.md$)/.test(f));
    for (const f of tracked) {
      if (!existsSync(join(root, f))) continue;
      mkdirSync(dirname(join(site, f)), { recursive: true });
      cpSync(join(root, f), join(site, f));
    }
    mkdirSync(join(site, 'news/20261026'), { recursive: true });
    writeFileSync(join(site, 'news/20261026/index.html'), EDITION);
    for (const script of ['home-preview.mjs', 'seo-meta.mjs', 'news-feed.mjs', 'build-sitemap.mjs']) {
      execFileSync(process.execPath, [join(root, 'scripts', script), '--site', site], { encoding: 'utf8', stdio: 'pipe' });
    }
    const before = read('index.html');
    const after = readFileSync(join(site, 'index.html'), 'utf8');
    for (const re of [HEADER, FOOTER, DOORS]) assert.equal(part(after, re), part(before, re), 'region untouched by the assemble steps');
    assert.deepEqual(hrefs(part(withoutScripts(after), DOORS)), CANONICAL);
    assert.match(after, /<h1 id="report-lead"><a href="\/news\/20261026\/">/, 'the cover itself is still refreshed');
    for (const file of ['movers/index.html', 'backtest/index.html', '404.html']) {
      assert.equal(part(readFileSync(join(site, file), 'utf8'), FOOTER), part(read(file), FOOTER), file);
    }
    assert.match(readFileSync(join(site, 'sitemap-pages.xml'), 'utf8'), /https:\/\/news-chart\.com\/movers\//);
    assert.doesNotMatch(after, /hk-movers/);
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
});
