import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ARCHIVE_DESCRIPTION,
  HOME_H1,
  HOME_TITLE,
  applyHomePreview,
  buildPreview,
  crawlerDek,
  parseEdition,
  patchNewsArchive,
  serpHookFromTitle,
  syncSite,
} from '../home-preview.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFile(join(root, rel), 'utf8');

const EDITION = `<html lang="zh-Hant-HK"><head>
<title>測試鉤子｜10月26日港股美股盤前早報 — ADRRR</title>
</head><body>
<section class="edition"><div class="kicker">每日簡報<span class="sep">/</span>Daily Briefing<span class="sep">/</span>2026年10月26日（一）</div>
<h1>晨報摘要｜2026年10月26日（一）</h1></section>
<p class="mw-intro"><b>早晨。</b>標普500 (S&amp;P 500) 收市。</p>
<article class="lead" id="s1"><h2>Lead headline for the fixture edition</h2><p class="body">body fallback</p></article>
<h3>第一則要聞長標題用來通過長度過濾條件</h3>
<h3>板塊表現Sector Performance</h3>
<h3>第二則要聞同樣需要超過十六個字元以上</h3>
<table class="mkt"><tr><td class="n">標普500 S&amp;P 500<span class="sub">10/23</span></td><td class="v"><span class="v">7,623.68</span><span class="dl" hidden>(D)</span></td><td class="c down"><span class="c down">▼0.52%</span></td></tr></table>
</body></html>`;

const HOME_SHELL = `<p class="kicker" id="report-kicker">晨報摘要 <span class="sep">/</span> Morning Report</p>
<h1 id="report-lead"><a href="/news/">港股美股盤前早報</a></h1>
<p class="dek" id="report-dek"></p>
<ol class="front-list" id="report-stories"></ol>
<p class="read"><a id="report-link" href="/news/">Read the report <span class="arrow">→</span></a></p>
<table class="mkt" id="report-markets"></table>`;

test('serp_hook comes from the locked title template and is empty when the hook is absent', () => {
  assert.equal(serpHookFromTitle('測試鉤子｜10月26日港股美股盤前早報 — ADRRR', '20261026'), '測試鉤子');
  assert.equal(serpHookFromTitle('10月26日港股美股盤前早報 — ADRRR', '20261026'), '');
  assert.equal(serpHookFromTitle('測試鉤子｜10月25日港股美股盤前早報 — ADRRR', '20261026'), '');
  assert.equal(serpHookFromTitle('測試鉤子｜10月26日港股美股盤前早報 — ADRRR', '20261025'), '');
});

test('edition parse keeps the lead, drops hidden market text, and skips section headings', () => {
  const parsed = parseEdition(EDITION);
  assert.equal(parsed.lead, 'Lead headline for the fixture edition');
  assert.match(parsed.dek, /^早晨。標普500 \(S&P 500\)/);
  assert.equal(parsed.kicker, '每日簡報/Daily Briefing/2026年10月26日（一）');
  assert.deepEqual(parsed.stories, [
    '第一則要聞長標題用來通過長度過濾條件',
    '第二則要聞同樣需要超過十六個字元以上',
  ]);
  assert.deepEqual(parsed.markets, [
    { name: '標普500', value: '7,623.68', change: '▼0.52%', dir: 'down' },
  ]);
});

test('digest serp_hook wins, including an explicit empty string', async () => {
  const site = await mkdtemp(join(tmpdir(), 'adrnnng-home-'));
  const digest = await mkdtemp(join(tmpdir(), 'adrnnng-digest-'));
  await mkdir(join(site, 'news', '20261026'), { recursive: true });
  await writeFile(join(site, 'news', '20261026', 'index.html'), EDITION);
  await writeFile(join(site, 'index.html'), HOME_SHELL);
  await writeFile(join(digest, '2026-10-26.json'), JSON.stringify({ serp_hook: 'digest hook' }));

  const withDigest = buildPreview({
    siteDir: site,
    ymd: '20261026',
    html: EDITION,
    digestDir: digest,
  });
  assert.equal(withDigest.serp_hook, 'digest hook');
  assert.equal(withDigest.href, '/news/20261026/');
  assert.match(crawlerDek(withDigest), /^digest hook /);
  assert.match(crawlerDek(withDigest), /Lead headline for the fixture edition/);

  await writeFile(join(digest, '2026-10-26.json'), JSON.stringify({ edition: { serp_hook: '' } }));
  const empty = buildPreview({ siteDir: site, ymd: '20261026', html: EDITION, digestDir: digest });
  assert.equal(empty.serp_hook, '');

  const fromTitle = buildPreview({ siteDir: site, ymd: '20261026', html: EDITION });
  assert.equal(fromTitle.serp_hook, '測試鉤子');

  const before = await readFile(join(site, 'news', '20261026', 'index.html'));
  const synced = syncSite(site, { digestDir: digest });
  assert.equal(synced.preview.serp_hook, '');
  const after = await readFile(join(site, 'news', '20261026', 'index.html'));
  assert.equal(after.equals(before), true);
  const home = await readFile(join(site, 'index.html'), 'utf8');
  assert.match(home, new RegExp(`<h1 id="report-lead"><a href="/news/20261026/">${HOME_H1}</a></h1>`));
  assert.match(home, /id="report-link" href="\/news\/20261026\/"/);
  assert.match(home, /Lead headline for the fixture edition/);
  assert.match(home, /標普500/);
  const preview = JSON.parse(await readFile(join(site, 'assets/news-preview.json'), 'utf8'));
  assert.equal(preview.serp_hook, '');
  assert.equal(preview.lead, 'Lead headline for the fixture edition');
});

test('archive patch aligns the title, adds the description, and is idempotent', () => {
  const raw = '<html><head><title>晨報摘要 · 往期 Archive</title><meta property="og:title" content="港股美股盤前早報 往期｜HK &amp; US Stocks Morning Report Archive — ADRRR"></head><body><footer class="foot"></footer></body></html>';
  const once = patchNewsArchive(raw);
  const twice = patchNewsArchive(once);
  assert.equal(twice, once);
  assert.match(once, /<title>港股美股盤前早報 往期｜HK &amp; US Stocks Morning Report Archive — ADRRR<\/title>/);
  assert.match(once, new RegExp(`name="description" content="${ARCHIVE_DESCRIPTION}"`));
  assert.match(once, /embed-subscribe\/adrrr/);
  assert.match(once, /\/assets\/css\/newsletter\.css/);
  assert.doesNotMatch(once, /晨報摘要 · 往期 Archive/);
});

test('applyHomePreview refuses an index shell without the cover markers', () => {
  assert.throws(() => applyHomePreview('<h1>no markers</h1>', { href: '/news/20261026/' }), /missing #report-kicker/);
});

test('committed home, backtest, and redirects are crawlable', async () => {
  const home = await read('index.html');
  const backtest = await read('backtest/index.html');
  const redirects = await read('_redirects');
  assert.match(home, /<html lang="zh-Hant-HK">/);
  assert.match(home, new RegExp(`<title>${HOME_TITLE}</title>`));
  assert.match(home, /每日港美股晨報，爭取每朝 9 點前更新。ADRRR News Lab by Adrian Ng — 訂閱電郵，追蹤盤前重點、政治人物持股與回測工具。/);
  assert.match(home, /<h1 id="report-lead"><a href="\/news\/\d{8}\/">港股美股盤前早報<\/a><\/h1>/);
  const dek = /<p class="dek" id="report-dek">([^<]+)<\/p>/.exec(home);
  assert.ok(dek && [...dek[1]].length > 40, 'static dek');
  assert.match(home, /<ol class="front-list" id="report-stories">[\s\S]*<li>/);
  assert.match(home, /id="newsletter"/);
  assert.doesNotMatch(home, /Today's Morning Report/);
  assert.match(backtest, /<h1 id="run-title">TD Sequential backtest<\/h1>/);
  assert.match(backtest, /Backtest Setup 9 and Countdown 13 on daily price history/);
  assert.doesNotMatch(backtest, /Loading prices/);
  assert.match(redirects, /^https:\/\/www\.adrnnng\.com\/\* https:\/\/adrnnng\.com\/:splat 301$/m);
  assert.match(redirects, /^http:\/\/www\.adrnnng\.com\/\* https:\/\/adrnnng\.com\/:splat 301$/m);
  assert.match(redirects, /^\/backtesting\/\* \/backtest\/:splat 301$/m);
  assert.match(redirects, /^\/backtesting \/backtest\/ 301$/m);
});
