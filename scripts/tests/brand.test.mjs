import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { HOME_TITLE, ARCHIVE_TITLE, ARCHIVE_DESCRIPTION, HOME_DESCRIPTION } from '../home-preview.mjs';
import { organizationNode, websiteNode, RSS_TITLE, SITE_ORIGIN, TWITTER_SITE, PRODUCT_NAME, AUTHOR_NAME } from '../seo-meta.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const PAGES = ['index.html', 'backtest/index.html', 'politician-tracker/index.html', '404.html', 'thanks/index.html'];

test('current pages use the News Chart wordmark and keep the live host', () => {
  const tools = JSON.parse(read('assets/tools.json'));
  assert.equal(tools.site.name, 'News Chart');
  assert.equal(tools.site.owner, 'ADRRR');
  assert.equal(tools.site.url, 'https://news-chart.com');
  assert.doesNotMatch(tools.site.tagline, /港美股新聞、圖表與市場工具/);

  const home = read('index.html');
  assert.match(home, /<title>港股美股盤前早報｜News Chart<\/title>/);
  assert.match(home, /property="og:site_name" content="News Chart"/);
  assert.match(home, /property="og:title" content="港股美股盤前早報｜News Chart"/);
  assert.match(home, /name="twitter:title" content="港股美股盤前早報｜News Chart"/);
  assert.match(home, /News Chart by ADRRR/);
  assert.match(home, /rel="canonical" href="https:\/\/news-chart\.com\/"/);
  assert.match(home, /property="og:url" content="https:\/\/news-chart\.com\/"/);
  assert.match(home, /name="twitter:site" content="@adrnnng"/);
  assert.match(home, /id="adrnnng-site"/);
  assert.match(home, /"name":"News Chart"/);
  assert.match(home, /"url":"https:\/\/news-chart\.com\/"/);
  assert.match(home, /"name":"ADRRR"/);
  assert.match(home, /aria-label="News Chart home"/);
  assert.match(home, /src="\/assets\/brand\/news-chart-white\.svg"/);
  assert.match(home, /title="News Chart Morning Report"/);
  assert.match(home, /embed-subscribe\/adrrr/);
  assert.match(home, /https:\/\/buttondown\.com\/adrrr/);
  assert.match(home, /伊朗臨決斷/);
  assert.doesNotMatch(home, /港美股新聞、圖表與市場工具/);
  assert.doesNotMatch(home, /adrrr-wordmark/);
  assert.match(home, /news-chart\.com/);

  const backtest = read('backtest/index.html');
  assert.match(backtest, /<title>Backtest · News Chart<\/title>/);
  assert.match(backtest, /property="og:site_name" content="News Chart"/);
  assert.match(backtest, /rel="canonical" href="https:\/\/news-chart\.com\/backtest\/"/);
  assert.match(backtest, /property="og:url" content="https:\/\/news-chart\.com\/backtest\/"/);
  assert.match(backtest, /src="\/assets\/brand\/news-chart-white\.svg"/);

  const tracker = read('politician-tracker/index.html');
  assert.match(tracker, /<title>Politician Tracker · 政治人物持股動向 — News Chart<\/title>/);
  assert.match(tracker, /property="og:site_name" content="News Chart"/);
  assert.match(tracker, /rel="canonical" href="https:\/\/news-chart\.com\/politician-tracker\/"/);
  assert.match(tracker, /property="og:url" content="https:\/\/news-chart\.com\/politician-tracker\/"/);
  assert.match(tracker, /src="\/assets\/brand\/news-chart-white\.svg"/);
  assert.match(tracker, /Adrian(?:&#x27;|')s Watchlist/);
  assert.doesNotMatch(tracker, /adrrr-wordmark/);

  const missing = read('404.html');
  assert.match(missing, /<title>Page not found · News Chart<\/title>/);
  assert.match(missing, /That address is not a page on News Chart/);
  assert.match(missing, /src="\/assets\/brand\/news-chart-white\.svg"/);

  const thanks = read('thanks/index.html');
  assert.match(thanks, /<title>訂閱成功 · News Chart<\/title>/);
  assert.match(thanks, /<p class="kicker">News Chart<\/p>/);
  assert.match(thanks, /href="https:\/\/x\.com\/adrnnng"/);
  assert.match(thanks, /跟住 @adrnnng/);

  for (const rel of PAGES) {
    const html = read(rel);
    assert.match(html, /News Chart/, rel);
    assert.doesNotMatch(html, /ADRRR News Lab/, rel);
    assert.doesNotMatch(html, /港美股新聞、圖表與市場工具/, rel);
  }
});

test('shared chrome reads the registry name and does not draw the old wordmark', () => {
  const site = read('assets/js/site.js');
  const home = read('assets/js/home.js');
  const card = read('assets/js/newsletter.js');
  assert.match(site, /news-chart-white\.svg/);
  assert.match(site, /reg\.site\.owner/);
  assert.doesNotMatch(site, /adrrr-wordmark/);
  assert.match(home, /reg\?\.site\?\.name/);
  assert.match(card, /eyebrow: 'News Chart · NEWSLETTER'/);
  assert.match(card, /body: 'News Chart — 隔夜美股、港股盤前、經濟數據與異動股，5 分鐘掌握開市前重點。'/);
  assert.match(card, /embed-subscribe\/adrrr/);
  assert.match(read('scripts/templates/tool/index.html'), /__TITLE__ · News Chart/);
  assert.match(read('llms.txt'), /^# News Chart/m);
  assert.match(read('llms.txt'), /ADRRR/);
  assert.match(read('llms.txt'), /https:\/\/news-chart\.com/);
});

test('domain files, price data, and News Analyst stampers stay on the old contract', () => {
  assert.match(read('robots.txt'), /Sitemap: https:\/\/news-chart\.com\/sitemap\.xml/);
  assert.match(read('sitemap.xml'), /https:\/\/news-chart\.com\/sitemap-pages\.xml/);
  assert.match(read('sitemap-pages.xml'), /https:\/\/news-chart\.com\/backtest\//);
  assert.match(read('_redirects'), /https:\/\/www\.adrnnng\.com\/\* https:\/\/adrnnng\.com\/:splat 301/);
  const redirectRules = read('_redirects').split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.ok(!redirectRules.some((line) => line.includes('news-chart.com')));

  const prices = read('backtest/data/prices/2800.HK.csv');
  assert.match(prices, /^date,open,high,low,close,volume,dividend,split/);
  assert.doesNotMatch(prices, /News Chart|ADRRR/);
  assert.doesNotMatch(read('politician-tracker/data.json'), /News Chart/);

  assert.equal(PRODUCT_NAME, 'News Chart');
  assert.equal(HOME_TITLE, '港股美股盤前早報｜News Chart');
  assert.equal(HOME_DESCRIPTION, '每日港美股晨報，爭取每朝 9 點前更新。News Chart by ADRRR — 訂閱電郵，追蹤盤前重點、政治人物持股與回測工具。');
  assert.match(ARCHIVE_TITLE, /— News Chart$/);
  assert.match(ARCHIVE_DESCRIPTION, /^News Chart /);
  assert.equal(RSS_TITLE, 'News Chart Morning Report');
  assert.equal(AUTHOR_NAME, 'ADRRR');
  assert.equal(SITE_ORIGIN, 'https://news-chart.com');
  assert.equal(TWITTER_SITE, '@adrnnng');
  assert.equal(organizationNode().name, 'News Chart');
  assert.equal(websiteNode().name, 'News Chart');
  assert.equal(websiteNode().author.name, 'ADRRR');
  assert.equal(organizationNode().url, 'https://news-chart.com/');
  assert.match(websiteNode().url, /^https:\/\/news-chart\.com\//);
  assert.match(read('scripts/seo-meta.mjs'), /export const SITE_ORIGIN = 'https:\/\/news-chart\.com';/);
  assert.match(read('scripts/sitemap.mjs'), /base = SITE_ORIGIN/);
  assert.match(read('scripts/indexnow.mjs'), /const HOST = new URL\(SITE_ORIGIN\)\.host;/);
  assert.match(read('scripts/news-feed.mjs'), /\$\{xmlEscape\(RSS_TITLE\)\}/);
  assert.match(read('scripts/news-feed.mjs'), /\$\{SITE_ORIGIN\}\/news\//);
  assert.match(read('scripts/home-preview.mjs'), /ADRRR_DIGEST_DIR/);
  assert.match(read('scripts/assemble-deploy.sh'), /--project-name adrnnng/);

  const root = new URL('../..', import.meta.url);
  const retired = `adrrr-${'wordmark'}`;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name.startsWith(retired)) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (name.endsWith('.test.mjs') || name.startsWith('test_')) continue;
      if (!/\.(html|js|mjs|py|css|json|xml|txt|sh|md)$/.test(name)) continue;
      const text = readFileSync(abs, 'utf8');
      if (text.includes(retired)) hits.push(abs);
    }
  };
  walk(root.pathname);
  assert.deepEqual(hits, []);
  const black = readFileSync(new URL('../../assets/brand/news-chart.svg', import.meta.url));
  const white = readFileSync(new URL('../../assets/brand/news-chart-white.svg', import.meta.url));
  assert.equal(createHash('sha256').update(black).digest('hex'), '951ac3f727a9dead25aa93da20c22164526c7cd02a4c3e197c3311162d6114de');
  assert.equal(createHash('sha256').update(white).digest('hex'), '92971e763695a5bf08c2545f6f20b267eb46774570b0c2abcf735d5d44a7c022');
  assert.match(black.toString('utf8'), /viewBox="0.0 -36.0 10503.0 1548.0"/);
  assert.match(white.toString('utf8'), /fill="#fff"/);
  assert.equal(createHash('sha256').update(readFileSync(new URL('../../assets/brand/og-image.png', import.meta.url))).digest('hex'), '3ed90ba291fd2061ffecdbf99dc6e5d52705850400bd67a37ec3f89ddc30ebd9');
  assert.equal(createHash('sha256').update(readFileSync(new URL('../../assets/brand/og-image.svg', import.meta.url))).digest('hex'), 'a64fe45ca0db5b6cfd4d497e2ad26e0539be363ba69ff83b07d32ddd8a2d3ec5');
  assert.equal(createHash('sha256').update(readFileSync(new URL('../../assets/brand/apple-touch-icon.png', import.meta.url))).digest('hex'), '1b286c897a1ba91a801af6e24fdf216c0188d477efc0dc22f66f76e92dabe28e');
  const favicon = read('assets/brand/favicon.svg');
  const markPaths = [...white.toString('utf8').matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  const iconPaths = [...favicon.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(iconPaths, [markPaths[0], markPaths[4]]);
  assert.equal(favicon.includes('aria-label="NC"'), true);
  assert.doesNotMatch(favicon, /港美股新聞/);
  const iconHref = '/assets/brand/favicon.svg?v=nc-2026-11-13';
  const icoHref = '/assets/brand/favicon.ico?v=nc-2026-11-13';
  for (const rel of [
    'index.html',
    '404.html',
    'thanks/index.html',
    'backtest/index.html',
    'politician-tracker/index.html',
    'scripts/templates/tool/index.html',
    '.github/politician-tracker/tracker/render.py',
  ]) {
    const html = read(rel);
    assert.equal(html.includes(iconHref), true, rel);
    assert.equal(html.includes(icoHref), true, rel);
    assert.equal(html.includes('href="/assets/brand/favicon.svg"'), false, rel);
    assert.equal(html.includes('href="/assets/brand/favicon.ico"'), false, rel);
  }
  for (const rel of ['index.html', '404.html', 'thanks/index.html', 'backtest/index.html', 'scripts/templates/tool/index.html']) {
    assert.match(read(rel), /rel="apple-touch-icon" href="\/assets\/brand\/apple-touch-icon\.png"/);
  }
  const rootIcon = readFileSync(new URL('../../favicon.ico', import.meta.url));
  const brandIcon = readFileSync(new URL('../../assets/brand/favicon.ico', import.meta.url));
  assert.ok(rootIcon.equals(brandIcon));
  assert.ok(rootIcon.length > 100);
});
