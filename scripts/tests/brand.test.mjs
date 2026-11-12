import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HOME_TITLE, ARCHIVE_TITLE, ARCHIVE_DESCRIPTION } from '../home-preview.mjs';
import { organizationNode, websiteNode, RSS_TITLE, SITE_ORIGIN, TWITTER_SITE } from '../seo-meta.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const PAGES = ['index.html', 'backtest/index.html', 'politician-tracker/index.html', '404.html', 'thanks/index.html'];

test('current pages use the News Chart wordmark and keep the live host', () => {
  const tools = JSON.parse(read('assets/tools.json'));
  assert.equal(tools.site.name, 'News Chart');
  assert.equal(tools.site.owner, 'Adrian Ng');
  assert.equal(tools.site.url, 'https://adrnnng.com');
  assert.doesNotMatch(tools.site.tagline, /港美股新聞、圖表與市場工具/);

  const home = read('index.html');
  assert.match(home, /<title>港股美股盤前早報｜News Chart<\/title>/);
  assert.match(home, /property="og:site_name" content="News Chart"/);
  assert.match(home, /property="og:title" content="港股美股盤前早報｜News Chart"/);
  assert.match(home, /name="twitter:title" content="港股美股盤前早報｜News Chart"/);
  assert.match(home, /News Chart by Adrian Ng/);
  assert.match(home, /rel="canonical" href="https:\/\/adrnnng\.com\/"/);
  assert.match(home, /property="og:url" content="https:\/\/adrnnng\.com\/"/);
  assert.match(home, /name="twitter:site" content="@adrnnng"/);
  assert.match(home, /id="adrnnng-site"/);
  assert.match(home, /"name":"News Chart"/);
  assert.match(home, /"url":"https:\/\/adrnnng\.com\/"/);
  assert.match(home, /aria-label="News Chart home"/);
  assert.match(home, /<span class="en">News Chart<\/span>/);
  assert.match(home, /title="News Chart Morning Report"/);
  assert.match(home, /embed-subscribe\/adrrr/);
  assert.match(home, /https:\/\/buttondown\.com\/adrrr/);
  assert.match(home, /伊朗臨決斷/);
  assert.doesNotMatch(home, /港美股新聞、圖表與市場工具/);
  assert.doesNotMatch(home, /adrrr-wordmark/);
  assert.doesNotMatch(home, /news-chart\.com|newsandchart\.com/);

  const backtest = read('backtest/index.html');
  assert.match(backtest, /<title>Backtest · News Chart<\/title>/);
  assert.match(backtest, /property="og:site_name" content="News Chart"/);
  assert.match(backtest, /rel="canonical" href="https:\/\/adrnnng\.com\/backtest\/"/);
  assert.match(backtest, /property="og:url" content="https:\/\/adrnnng\.com\/backtest\/"/);
  assert.match(backtest, /<span class="en">News Chart<\/span>/);

  const tracker = read('politician-tracker/index.html');
  assert.match(tracker, /<title>Politician Tracker · 政治人物持股動向 — News Chart<\/title>/);
  assert.match(tracker, /property="og:site_name" content="News Chart"/);
  assert.match(tracker, /rel="canonical" href="https:\/\/adrnnng\.com\/politician-tracker\/"/);
  assert.match(tracker, /property="og:url" content="https:\/\/adrnnng\.com\/politician-tracker\/"/);
  assert.match(tracker, /<span class="en">News Chart<\/span>/);
  assert.match(tracker, /Adrian(?:&#x27;|')s Watchlist/);
  assert.doesNotMatch(tracker, /adrrr-wordmark/);

  const missing = read('404.html');
  assert.match(missing, /<title>Page not found · News Chart<\/title>/);
  assert.match(missing, /That address is not a page on News Chart/);
  assert.match(missing, /<span class="en">News Chart<\/span>/);

  const thanks = read('thanks/index.html');
  assert.match(thanks, /<title>訂閱成功 · News Chart<\/title>/);
  assert.match(thanks, /<p class="kicker">News Chart<\/p>/);
  assert.match(thanks, /href="https:\/\/x\.com\/adrnnng"/);
  assert.match(thanks, /跟住 @adrnnng/);

  for (const rel of PAGES) {
    const html = read(rel);
    assert.doesNotMatch(html, /ADRRR/, rel);
    assert.doesNotMatch(html, /港美股新聞、圖表與市場工具/, rel);
  }
});

test('shared chrome reads the registry name and does not draw the old wordmark', () => {
  const site = read('assets/js/site.js');
  const home = read('assets/js/home.js');
  const card = read('assets/js/newsletter.js');
  assert.match(site, /<span class="en">\$\{esc\(reg\.site\.name\)\}<\/span>/);
  assert.match(site, /reg\.site\.owner/);
  assert.doesNotMatch(site, /adrrr-wordmark/);
  assert.match(home, /reg\?\.site\?\.name/);
  assert.match(card, /eyebrow: 'News Chart · NEWSLETTER'/);
  assert.match(card, /body: 'News Chart — 隔夜美股、港股盤前、經濟數據與異動股，5 分鐘掌握開市前重點。'/);
  assert.match(card, /embed-subscribe\/adrrr/);
  assert.match(read('scripts/templates/tool/index.html'), /__TITLE__ · News Chart/);
  assert.match(read('llms.txt'), /^# News Chart/m);
  assert.match(read('llms.txt'), /Adrian Ng/);
  assert.match(read('llms.txt'), /https:\/\/adrnnng\.com/);
});

test('domain files, price data, and News Analyst stampers stay on the old contract', () => {
  assert.match(read('robots.txt'), /Sitemap: https:\/\/adrnnng\.com\/sitemap\.xml/);
  assert.match(read('sitemap.xml'), /https:\/\/adrnnng\.com\/sitemap-pages\.xml/);
  assert.match(read('sitemap-pages.xml'), /https:\/\/adrnnng\.com\/backtest\//);
  assert.match(read('_redirects'), /https:\/\/www\.adrnnng\.com\/\* https:\/\/adrnnng\.com\/:splat 301/);
  assert.doesNotMatch(read('_redirects'), /news-chart\.com|newsandchart\.com/);

  const prices = read('backtest/data/prices/2800.HK.csv');
  assert.match(prices, /^date,open,high,low,close,volume,dividend,split/);
  assert.doesNotMatch(prices, /News Chart|ADRRR/);
  assert.doesNotMatch(read('politician-tracker/data.json'), /News Chart/);

  assert.equal(HOME_TITLE, '港股美股盤前早報｜ADRRR News Lab');
  assert.match(ARCHIVE_TITLE, /— ADRRR$/);
  assert.match(ARCHIVE_DESCRIPTION, /^ADRRR /);
  assert.equal(RSS_TITLE, 'ADRRR Morning Report');
  assert.equal(SITE_ORIGIN, 'https://adrnnng.com');
  assert.equal(TWITTER_SITE, '@adrnnng');
  assert.equal(organizationNode().name, 'ADRRR');
  assert.equal(websiteNode().name, 'ADRRR');
  assert.match(organizationNode().url, /^https:\/\/adrnnng\.com\//);
  assert.match(read('scripts/news-feed.mjs'), /<title>ADRRR Morning Report<\/title>/);
  assert.match(read('scripts/sitemap.mjs'), /<news:name>ADRRR Morning Report<\/news:name>/);
  assert.match(read('scripts/home-preview.mjs'), /ADRRR_DIGEST_DIR/);
  assert.match(read('scripts/assemble-deploy.sh'), /--project-name adrnnng/);
  assert.match(read('assets/brand/adrrr-wordmark.svg'), /aria-label="ADRRR"/);
  assert.match(read('assets/brand/adrrr-wordmark-white.svg'), /aria-label="ADRRR"/);
});
