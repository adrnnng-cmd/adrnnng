import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { doorsInner, footerInner, headerInner } from '../../assets/js/chrome-html.js';
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
  assert.ok(hrefs(part(html, HEADER)).includes('/news/'), 'the header Morning Report link');
  assert.match(part(html, HEADER), /<a class="logo" href="\/"/);
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
  for (const file of ['index.html', 'movers/index.html', 'backtest/index.html', '404.html', 'thanks/index.html']) {
    const html = read(file);
    const chrome = [part(html, HEADER), part(html, FOOTER), part(html, DOORS)].join('\n');
    assert.doesNotMatch(chrome, /hk-movers|localhost|127\.0\.0\.1|pages\.dev|workers\.dev|demo|preview|https?:\/\/(?!buttondown)/i, file);
    for (const href of hrefs(chrome)) assert.match(href, /^\/(?:[a-z-]+\/)?$/, `${file}: ${href}`);
  }
});

test('shared pages carry the whole footer and the primary nav as links in their own source', () => {
  for (const file of ['movers/index.html', 'backtest/index.html', '404.html', 'thanks/index.html']) {
    const html = withoutScripts(read(file));
    const footer = hrefs(part(html, FOOTER));
    const header = hrefs(part(html, HEADER));
    for (const href of CANONICAL) assert.ok(footer.includes(href), `${file} footer -> ${href}`);
    for (const href of ['/', '/backtest/', '/movers/', '/politician-tracker/', '/news/']) assert.ok(header.includes(href), `${file} header -> ${href}`);
  }
  const movers = part(read('movers/index.html'), HEADER);
  assert.match(movers, /<a href="\/movers\/" aria-current="page">Movers<\/a>/);
  assert.doesNotMatch(movers, /aria-current="page">(Backtest|Politician)/);
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
    const movers = join(tmp, 'movers/index.html');
    writeFileSync(movers, readFileSync(movers, 'utf8').replace(/<footer[\s\S]*?<\/footer>/, '<footer data-site-footer></footer>'));
    assert.deepEqual(staleFiles(tmp), ['movers/index.html']);
    assert.match(staticChromeError(tmp), /stale in movers\/index\.html/);
    assert.deepEqual(writeAll(tmp), ['movers/index.html']);
    assert.deepEqual(writeAll(tmp), [], 'second run changes nothing');
    assert.equal(readFileSync(movers, 'utf8'), read('movers/index.html'));
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
    assert.match(readFileSync(join(tmp, 'index.html'), 'utf8'), /<a class="box" href="\/news\/">Morning Brief<\/a>/, 'the registry title flows into the static header');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('npm run new-tool leaves the new section in every static header, footer and the home cards', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'static-chrome-'));
  try {
    const files = [...pages(root), 'assets/tools.json', 'scripts/new-tool.mjs', 'scripts/static-chrome.mjs', 'assets/js/chrome-html.js', 'assets/js/latest.js',
      'scripts/templates/tool/app.js', 'scripts/templates/tool/style.css', 'package.json'];
    for (const f of files) {
      if (!existsSync(join(root, f))) continue;
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      cpSync(join(root, f), join(tmp, f));
    }
    const out = execFileSync(process.execPath, ['scripts/new-tool.mjs', 'fx-lab', 'FX Lab', '--summary', 'Currency pairs.'], { cwd: tmp, encoding: 'utf8' });
    assert.match(out, /static links added to/);
    for (const file of ['index.html', 'movers/index.html', '404.html']) {
      const html = readFileSync(join(tmp, file), 'utf8');
      assert.ok(hrefs(part(html, FOOTER)).includes('/fx-lab/'), `${file} footer`);
    }
    const home = readFileSync(join(tmp, 'index.html'), 'utf8');
    assert.ok(hrefs(part(home, HEADER)).length >= 1);
    assert.deepEqual(staleFiles(tmp), []);
    const created = readFileSync(join(tmp, 'fx-lab/index.html'), 'utf8');
    assert.ok(hrefs(part(created, HEADER)).includes('/fx-lab/'), 'the new page has the static header too');
    assert.ok(hrefs(part(created, FOOTER)).includes('/fx-lab/'));
    assert.match(part(created, HEADER), /aria-current="page"/, 'it also marks itself as the current page');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the browser module and the generator draw the same markup from one function', () => {
  const home = read('index.html');
  assert.equal(part(home, FOOTER).trim(), footerInner(registry).replace(/^/gm, '    ').trim());
  assert.equal(part(home, HEADER).trim(), headerInner(registry, { path: '/', home: true }).replace(/^/gm, '    ').trim());
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
