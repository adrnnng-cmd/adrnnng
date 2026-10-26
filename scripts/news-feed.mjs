// RSS for Morning Report editions present in a site directory.
// Items come only from /news/YYYYMMDD/index.html. Titles and descriptions are
// read from that page. pubDate is set only when the page already has a timestamp.
// The edition date in the path is written as dc:date. Nothing is invented.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARCHIVE_DESCRIPTION } from './home-preview.mjs';
import { SITE_ORIGIN, articlePublishedTime, isPublishTime, metaContent } from './seo-meta.mjs';

export const FEED_PATH = 'news/feed.xml';
export const FEED_URL = `${SITE_ORIGIN}/news/feed.xml`;

function xmlEscape(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&apos;',
    '"': '&quot;',
  })[c]);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;|&#x27;/gi, "'");
}

function tidy(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function editionIso(compact) {
  if (!/^\d{8}$/.test(compact)) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return tidy(m?.[1] || '');
}

function pageDescription(html) {
  return tidy(metaContent(html, 'name', 'description') || metaContent(html, 'property', 'og:description'));
}

function rfc822(iso) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toUTCString();
}

export function collectFeedItems(siteDir) {
  const news = join(siteDir, 'news');
  if (!existsSync(news)) return [];
  const items = [];
  for (const name of readdirSync(news)) {
    const iso = editionIso(name);
    if (!iso) continue;
    const file = join(news, name, 'index.html');
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    const title = pageTitle(html) || `Morning Report ${iso}`;
    const published = articlePublishedTime(html);
    items.push({
      ymd: name,
      iso,
      title,
      description: pageDescription(html),
      link: `${SITE_ORIGIN}/news/${name}/`,
      published: isPublishTime(published) ? published : '',
    });
  }
  items.sort((a, b) => (a.ymd < b.ymd ? 1 : a.ymd > b.ymd ? -1 : 0));
  return items;
}

export function renderFeed(items) {
  const dated = items.map((item) => ({ ...item, pubDate: item.published.includes('T') ? rfc822(item.published) : '' }));
  const last = dated.find((item) => item.pubDate);
  const body = dated.map((item) => {
    const bits = [
      '    <item>',
      `      <title>${xmlEscape(item.title)}</title>`,
      `      <link>${xmlEscape(item.link)}</link>`,
      `      <guid isPermaLink="true">${xmlEscape(item.link)}</guid>`,
      `      <dc:date>${item.iso}</dc:date>`,
    ];
    if (item.pubDate) bits.push(`      <pubDate>${item.pubDate}</pubDate>`);
    if (item.description) bits.push(`      <description>${xmlEscape(item.description)}</description>`);
    bits.push('    </item>');
    return bits.join('\n');
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>ADRRR Morning Report</title>
    <link>${SITE_ORIGIN}/news/</link>
    <description>${xmlEscape(ARCHIVE_DESCRIPTION)}</description>
    <language>zh-Hant</language>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>
${last ? `    <lastBuildDate>${last.pubDate}</lastBuildDate>\n` : ''}${body ? `${body}\n` : ''}  </channel>
</rss>
`;
}

export function writeNewsFeed(siteDir) {
  const news = join(siteDir, 'news');
  const hasArchive = existsSync(join(news, 'index.html'));
  const items = collectFeedItems(siteDir);
  if (!hasArchive && items.length === 0) return { written: false, items: 0 };
  mkdirSync(news, { recursive: true });
  writeFileSync(join(siteDir, FEED_PATH), renderFeed(items));
  return { written: true, items: items.length };
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = flag(process.argv.slice(2), '--site');
  if (!site) {
    console.error('usage: node scripts/news-feed.mjs --site <dir>');
    process.exit(2);
  }
  const result = writeNewsFeed(site);
  if (!result.written) console.log('news feed: no news/ tree; left feed unwritten');
  else console.log(`news feed: ${result.items} item(s) → ${FEED_PATH}`);
}
