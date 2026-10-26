import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSitemaps } from '../sitemap.mjs';
import { collectFeedItems, renderFeed, writeNewsFeed } from '../news-feed.mjs';
import { LOGO, articlePublishedTime, siteGraph, stampHtml } from '../seo-meta.mjs';

const root = new URL('../..', import.meta.url).pathname;

test('site graph is Organization and WebSite, with no search and no FAQ', () => {
  const graph = siteGraph();
  const types = graph['@graph'].map((node) => node['@type']);
  assert.deepEqual(types, ['Organization', 'WebSite']);
  assert.equal(graph['@graph'][0].logo.url, LOGO.url);
  assert.equal(graph['@graph'][0].logo.width, 180);
  assert.equal(JSON.stringify(graph).includes('SearchAction'), false);
  assert.equal(JSON.stringify(graph).includes('FAQPage'), false);
  assert.equal(graph['@graph'][1].potentialAction, undefined);
});

test('edition stamp adds publisher.logo and published_time without touching the title or headline', () => {
  const raw = `<html><head><title>測試鉤子｜10月26日港股美股盤前早報 — ADRRR</title>
<meta property="og:title" content="測試鉤子｜10月26日港股美股盤前早報 — ADRRR">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"測試鉤子｜10月26日港股美股盤前早報 — ADRRR","description":"既有摘要","datePublished":"2026-10-26T08:15:00+08:00","dateModified":"2026-10-26T08:15:00+08:00","publisher":{"@type":"Organization","name":"ADRRR"},"author":{"@type":"Organization","name":"ADRRR News Lab"}}</script>
</head><body><section class="edition"><h1>晨報摘要｜2026年10月26日（一）</h1></section></body></html>`;
  const once = stampHtml(raw, { kind: 'edition', ymd: '20261026' });
  const twice = stampHtml(once, { kind: 'edition', ymd: '20261026' });
  assert.equal(twice, once);
  assert.match(once, /<title>測試鉤子｜10月26日港股美股盤前早報 — ADRRR<\/title>/);
  assert.match(once, /property="og:title" content="測試鉤子｜10月26日港股美股盤前早報 — ADRRR"/);
  assert.match(once, /property="og:locale" content="zh_HK"/);
  assert.match(once, /name="twitter:site" content="@adrnnng"/);
  assert.match(once, /property="article:published_time" content="2026-10-26T08:15:00\+08:00"/);
  assert.equal(articlePublishedTime(once), '2026-10-26T08:15:00+08:00');
  const body = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(once)[1];
  const article = JSON.parse(body);
  assert.equal(article.headline, '測試鉤子｜10月26日港股美股盤前早報 — ADRRR');
  assert.equal(article.description, '既有摘要');
  assert.equal(article.datePublished, '2026-10-26T08:15:00+08:00');
  assert.equal(article.dateModified, '2026-10-26T08:15:00+08:00');
  assert.equal(article.author.name, 'ADRRR News Lab');
  assert.equal(article.publisher.name, 'ADRRR');
  assert.equal(article.publisher.logo.url, LOGO.url);
  assert.equal(article.publisher.logo.width, 180);
  assert.equal(article.publisher.logo.height, 180);
  assert.match(once, /"name":"晨報摘要｜2026年10月26日（一）"/);
  assert.match(once, /https:\/\/adrnnng\.com\/news\/20261026\//);
  assert.doesNotMatch(once, /SearchAction|FAQPage/);
});

test('an edition without a timestamp does not get an invented published_time or NewsArticle', () => {
  const raw = '<html><head><title>晨報摘要 2026-10-07</title><meta name="description" content="晨報摘要｜2026年10月7日（三）"></head></html>';
  const out = stampHtml(raw, { kind: 'edition', ymd: '20261007' });
  assert.match(out, /<title>晨報摘要 2026-10-07<\/title>/);
  assert.equal(articlePublishedTime(out), '');
  assert.doesNotMatch(out, /article:published_time/);
  assert.doesNotMatch(out, /"@type":"NewsArticle"/);
  assert.match(out, /"@type":"Organization"/);
  assert.match(out, /"name":"晨報摘要 2026-10-07"/);
});

test('an existing article:published_time is kept', () => {
  const raw = `<html><head><title>T</title>
<meta property="article:published_time" content="2026-10-26T01:02:03+08:00">
<script type="application/ld+json">{"@type":"NewsArticle","headline":"T","datePublished":"2026-10-26T08:15:00+08:00","publisher":{"@type":"Organization","name":"ADRRR"}}</script>
</head></html>`;
  const out = stampHtml(raw, { kind: 'edition', ymd: '20261026' });
  assert.equal(articlePublishedTime(out), '2026-10-26T01:02:03+08:00');
  assert.match(out, /article:published_time" content="2026-10-26T01:02:03\+08:00"/);
  assert.doesNotMatch(out, /article:published_time" content="2026-10-26T08:15:00/);
});

test('feed items are the editions on disk and pubDate follows a real timestamp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adrnnng-feed-'));
  await mkdir(join(dir, 'news', '20261026'), { recursive: true });
  await mkdir(join(dir, 'news', '20261007'), { recursive: true });
  await mkdir(join(dir, 'news', 'not-a-date'), { recursive: true });
  await writeFile(join(dir, 'news/index.html'), '<html><head><title>Archive</title></head></html>');
  await writeFile(join(dir, 'news/20261026/index.html'), `<html><head><title>真實標題</title>
<meta name="description" content="真實摘要">
<script type="application/ld+json">{"@type":"NewsArticle","headline":"真實標題","datePublished":"2026-10-26T08:15:00+08:00"}</script>
</head></html>`);
  await writeFile(join(dir, 'news/20261007/index.html'), '<html><head><title>晨報摘要 2026-10-07</title></head></html>');
  await writeFile(join(dir, 'news/not-a-date/index.html'), '<html><head><title>Not an edition</title></head></html>');
  const items = collectFeedItems(dir);
  assert.deepEqual(items.map((item) => item.ymd), ['20261026', '20261007']);
  assert.equal(items[0].title, '真實標題');
  assert.equal(items[0].description, '真實摘要');
  assert.equal(items[0].published, '2026-10-26T08:15:00+08:00');
  assert.equal(items[1].published, '');
  const xml = renderFeed(items);
  assert.equal((xml.match(/<item>/g) || []).length, 2);
  assert.match(xml, /<title>真實標題<\/title>/);
  assert.match(xml, /<description>真實摘要<\/description>/);
  assert.match(xml, /<pubDate>Mon, 26 Oct 2026 00:15:00 GMT<\/pubDate>/);
  assert.match(xml, /<dc:date>2026-10-07<\/dc:date>/);
  assert.doesNotMatch(xml, /Not an edition/);
  assert.doesNotMatch(xml, /伊朗|invented|SearchAction|FAQPage/);
  const written = writeNewsFeed(dir);
  assert.equal(written.items, 2);
  assert.match(await readFile(join(dir, 'news/feed.xml'), 'utf8'), /真實標題/);
});

test('preview edition date bumps home and /news/ lastmod only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adrnnng-lastmod-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await mkdir(join(dir, 'backtest'), { recursive: true });
  await mkdir(join(dir, 'news'), { recursive: true });
  const old = new Date('2026-10-22T00:00:00Z');
  for (const [rel, body] of [
    ['index.html', '<html><head><title>Home</title></head></html>'],
    ['backtest/index.html', '<html><head><title>Backtest</title></head></html>'],
    ['news/index.html', '<html><head><title>Archive</title></head></html>'],
  ]) {
    const abs = join(dir, rel);
    await writeFile(abs, body);
    await utimes(abs, old, old);
  }
  await writeFile(join(dir, 'assets/news-preview.json'), JSON.stringify({ href: '/news/20261026/' }));
  const bumped = buildSitemaps(dir, { now: '2026-10-26' });
  const lastmod = (loc) => bumped.pages.find((page) => page.loc === loc)?.lastmod;
  assert.equal(lastmod('https://adrnnng.com/'), '2026-10-26');
  assert.equal(lastmod('https://adrnnng.com/news/'), '2026-10-26');
  assert.equal(lastmod('https://adrnnng.com/backtest/'), '2026-10-22');

  await writeFile(join(dir, 'assets/news-preview.json'), JSON.stringify({ href: '/news/20261020/' }));
  const older = buildSitemaps(dir, { now: '2026-10-26' });
  assert.equal(older.pages.find((page) => page.loc === 'https://adrnnng.com/')?.lastmod, '2026-10-22');
});

test('news titles cannot put forbidden XML characters into the sitemap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adrnnng-xml-'));
  await mkdir(join(dir, 'news', '20261022'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<html><head><title>Home</title></head></html>');
  await writeFile(join(dir, 'news/20261022/index.html'), '<html><head><title>Bad\u0001Title</title></head></html>');
  const built = buildSitemaps(dir, { now: '2026-10-22' });
  assert.match(built.files['news-sitemap.xml'], /BadTitle/);
  assert.doesNotMatch(built.files['news-sitemap.xml'], /\u0001/);
});

test('committed key pages carry the site graph, locale, twitter site, and root favicon', async () => {
  for (const rel of ['index.html', 'backtest/index.html', 'politician-tracker/index.html']) {
    const html = await readFile(join(root, rel), 'utf8');
    assert.match(html, /property="og:locale" content="zh_HK"/, rel);
    assert.match(html, /name="twitter:site" content="@adrnnng"/, rel);
    assert.match(html, /id="adrnnng-site"/, rel);
    assert.match(html, /"@type":"Organization"/, rel);
    assert.match(html, /"@type":"WebSite"/, rel);
    assert.doesNotMatch(html, /SearchAction|FAQPage/, rel);
  }
  const home = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(home, /application\/rss\+xml/);
  assert.match(home, /https:\/\/adrnnng\.com\/news\/feed\.xml/);
  const icon = await readFile(join(root, 'favicon.ico'));
  const brand = await readFile(join(root, 'assets/brand/favicon.ico'));
  assert.ok(icon.equals(brand));
  assert.ok(icon.length > 100);
});
