// Build a sitemap index from the HTML files in a site directory.
// News editions are /news/YYYYMMDD/index.html (the Morning Report layout).
// A future section such as /hsi-lab/ is included when its index.html exists.
// Static member pages are any other HTML page under politician-tracker/.

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['.git', '.github', 'scripts', 'node_modules', 'tests', 'img', 'assets']);
const SITEMAP_FILES = ['sitemap.xml', 'sitemap-pages.xml', 'sitemap-news.xml', 'news-sitemap.xml'];

export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function hongKongToday(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function walkHtml(dir, root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walkHtml(abs, root, out);
    else if (name.endsWith('.html')) {
      out.push({
        rel: relative(root, abs).split('\\').join('/'),
        mtime: st.mtime,
      });
    }
  }
  return out;
}

function robotsMeta(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\bname\s*=\s*["']robots["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (content) return content[1];
  }
  return '';
}

export function isNoindexHtml(html) {
  return /\bnoindex\b/i.test(robotsMeta(html));
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;/gi, "'");
}

export function pageTitle(html, fallback) {
  const titled = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const headed = titled ? null : /<h1[^>]*>([^<]*)<\/h1>/i.exec(html);
  const raw = decodeEntities((titled || headed)?.[1] || '').replace(/\s+/g, ' ').trim();
  return (raw || fallback).slice(0, 200);
}

function editionIso(compact) {
  if (!/^\d{8}$/.test(compact)) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

function xmlEscape(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&apos;',
    '"': '&quot;',
  })[c]);
}

function locOf(base, pathname) {
  return `${base.replace(/\/$/, '')}${pathname}`;
}

function lastmodOf(date) {
  return date.toISOString().slice(0, 10);
}

function urlPath(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel}`;
}

function isNewsFile(rel) {
  return rel === 'news/index.html' || rel.startsWith('news/');
}

// Home and the news archive change when assemble publishes the morning-report preview.
// Their lastmod is at least that edition date, even if the file mtime is still the
// previous UTC day. Other pages keep their own mtime.
export function readPreviewEditionDate(siteDir) {
  const file = join(siteDir, 'assets', 'news-preview.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const href = typeof data.href === 'string' ? data.href : '';
    const m = /^\/news\/(\d{8})\/$/.exec(href);
    if (!m) return null;
    return editionIso(m[1]);
  } catch {
    return null;
  }
}

const PREVIEW_PATHS = new Set(['/', '/news/']);

/**
 * @returns {{ pages: object[], news: object[], recent: object[] }}
 * pages: site sections and static member pages
 * news: every daily edition
 * recent: editions from today or yesterday in Asia/Hong_Kong (Google News window)
 */
export function collectPages(siteDir, { now } = {}) {
  const today = now || hongKongToday();
  const pages = [];
  const news = [];
  for (const file of walkHtml(siteDir, siteDir)) {
    if (file.rel === '404.html') continue;
    if (file.rel === 'api' || file.rel.startsWith('api/')) continue;
    const html = readFileSync(join(siteDir, file.rel), 'utf8');
    const edition = /^news\/(\d{8})\/index\.html$/.exec(file.rel);
    if (edition) {
      const iso = editionIso(edition[1]);
      if (!iso) continue;
      const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86400000);
      news.push({
        locPath: `/news/${edition[1]}/`,
        lastmod: iso,
        title: pageTitle(html, `Morning Report ${iso}`),
        recent: age >= 0 && age <= 1,
      });
      continue;
    }
    // Morning Report markup is owned by the News Analyst. List the pages either way.
    if (!isNewsFile(file.rel) && isNoindexHtml(html)) continue;
    pages.push({ locPath: urlPath(file.rel), lastmod: lastmodOf(file.mtime) });
  }
  const previewDate = readPreviewEditionDate(siteDir);
  if (previewDate) {
    for (const page of pages) {
      if (PREVIEW_PATHS.has(page.locPath) && page.lastmod < previewDate) page.lastmod = previewDate;
    }
  }
  pages.sort((a, b) => (a.locPath === '/' ? -1 : b.locPath === '/' ? 1 : a.locPath.localeCompare(b.locPath)));
  news.sort((a, b) => a.locPath.localeCompare(b.locPath));
  return { pages, news, recent: news.filter((n) => n.recent) };
}

function urlset(urls) {
  const body = urls.map((u) => `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

// Day pages are html lang="zh-Hant-HK". Google News gets the Traditional Chinese tag.
function newsUrlset(urls) {
  const body = urls.map((u) => `  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <news:news>
      <news:publication>
        <news:name>ADRRR Morning Report</news:name>
        <news:language>zh-Hant</news:language>
      </news:publication>
      <news:publication_date>${u.lastmod}</news:publication_date>
      <news:title>${xmlEscape(u.title)}</news:title>
    </news:news>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${body}\n</urlset>\n`;
}

function indexXml(children) {
  const body = children.map((c) => `  <sitemap>\n    <loc>${xmlEscape(c.loc)}</loc>\n    <lastmod>${c.lastmod}</lastmod>\n  </sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

function maxLastmod(urls, fallback) {
  return urls.reduce((max, u) => (u.lastmod > max ? u.lastmod : max), fallback);
}

export function buildSitemaps(siteDir, { base = 'https://adrnnng.com', now } = {}) {
  const today = now || hongKongToday();
  const { pages, news, recent } = collectPages(siteDir, { now: today });
  const pageUrls = pages.map((p) => ({ loc: locOf(base, p.locPath), lastmod: p.lastmod }));
  const newsUrls = news.map((n) => ({ loc: locOf(base, n.locPath), lastmod: n.lastmod, title: n.title }));
  const recentUrls = recent.map((n) => ({ loc: locOf(base, n.locPath), lastmod: n.lastmod, title: n.title }));
  const files = {};
  const children = [];
  if (pageUrls.length) {
    files['sitemap-pages.xml'] = urlset(pageUrls);
    children.push({ loc: locOf(base, '/sitemap-pages.xml'), lastmod: maxLastmod(pageUrls, today) });
  }
  if (newsUrls.length) {
    files['sitemap-news.xml'] = urlset(newsUrls);
    children.push({ loc: locOf(base, '/sitemap-news.xml'), lastmod: maxLastmod(newsUrls, today) });
  }
  if (recentUrls.length) {
    files['news-sitemap.xml'] = newsUrlset(recentUrls);
    children.push({ loc: locOf(base, '/news-sitemap.xml'), lastmod: maxLastmod(recentUrls, today) });
  }
  files['sitemap.xml'] = indexXml(children);
  return { files, pages: pageUrls, news: newsUrls, recent: recentUrls };
}

export function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'"));
}

export function writeSitemaps(siteDir, opts = {}) {
  const built = buildSitemaps(siteDir, opts);
  for (const name of SITEMAP_FILES) {
    const path = join(siteDir, name);
    if (built.files[name]) writeFileSync(path, built.files[name]);
    else if (existsSync(path)) unlinkSync(path);
  }
  return built;
}

export function sitemapDrift(siteDir, opts = {}) {
  const built = buildSitemaps(siteDir, opts);
  const problems = [];
  for (const name of SITEMAP_FILES) {
    const path = join(siteDir, name);
    const expected = built.files[name];
    const exists = existsSync(path);
    if (!expected && exists) problems.push(`${name} is stale and should be removed (npm run sitemap)`);
    if (expected && !exists) problems.push(`${name} is missing (npm run sitemap)`);
    if (!expected || !exists) continue;
    const got = new Set(extractLocs(readFileSync(path, 'utf8')));
    const want = new Set(extractLocs(expected));
    for (const u of want) if (!got.has(u)) problems.push(`${name} missing ${u}`);
    for (const u of got) if (!want.has(u)) problems.push(`${name} unexpected ${u}`);
  }
  return problems;
}
