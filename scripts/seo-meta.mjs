// Sitewide SEO chrome for public HTML.
// Organization + WebSite JSON-LD, og:locale, twitter:site, optional breadcrumbs,
// and NewsArticle publisher.logo / article:published_time when the page already
// has a publish time. No SearchAction (the site has no search URL) and no FAQPage.
// Day-page <title>, og:title, twitter:title, and NewsArticle headline are left as
// News Analyst wrote them.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SITE_ORIGIN = 'https://adrnnng.com';
export const ORG_ID = `${SITE_ORIGIN}/#organization`;
export const LOCALE = 'zh_HK';
export const TWITTER_SITE = '@adrnnng';
export const LOGO = {
  '@type': 'ImageObject',
  url: `${SITE_ORIGIN}/assets/brand/apple-touch-icon.png`,
  width: 180,
  height: 180,
};
export const RSS_HREF = `${SITE_ORIGIN}/news/feed.xml`;
export const RSS_TITLE = 'ADRRR Morning Report';

const SECTION_PAGES = [
  { rel: 'backtest/index.html', crumb: 'Backtest', url: `${SITE_ORIGIN}/backtest/` },
  { rel: 'politician-tracker/index.html', crumb: 'Politician Tracker', url: `${SITE_ORIGIN}/politician-tracker/` },
  { rel: 'hsi-lab/index.html', crumb: 'Strategy Lab', url: `${SITE_ORIGIN}/hsi-lab/` },
];

export function organizationNode() {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: 'ADRRR',
    url: `${SITE_ORIGIN}/`,
    logo: LOGO,
  };
}

export function websiteNode() {
  return {
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}/#website`,
    name: 'ADRRR',
    url: `${SITE_ORIGIN}/`,
    inLanguage: 'zh-Hant-HK',
    publisher: { '@id': ORG_ID },
  };
}

export function siteGraph() {
  return {
    '@context': 'https://schema.org',
    '@graph': [organizationNode(), websiteNode()],
  };
}

export function breadcrumbGraph(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

function escAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
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
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function jsonForScript(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function isPublishTime(value) {
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(String(value || ''));
}

function metaTags(html) {
  return html.match(/<meta\b[^>]*>/gi) || [];
}

function tagAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m ? decodeEntities(m[1]) : '';
}

export function metaContent(html, attr, key) {
  for (const tag of metaTags(html)) {
    if (tagAttr(tag, attr) !== key) continue;
    if (!/\bcontent\s*=/.test(tag)) continue;
    return tagAttr(tag, 'content');
  }
  return '';
}

function ensureMeta(html, attr, key, content) {
  if (metaContent(html, attr, key) === content) return html;
  const tag = `<meta ${attr}="${escAttr(key)}" content="${escAttr(content)}">`;
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  if (re.test(html)) return html.replace(re, tag);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  return `${html}\n${tag}`;
}

function ensureRssLink(html) {
  if (html.includes(RSS_HREF) || html.includes('/news/feed.xml')) return html;
  const tag = `<link rel="alternate" type="application/rss+xml" title="${escAttr(RSS_TITLE)}" href="${RSS_HREF}">`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  return `${html}\n${tag}`;
}

function upsertJsonLd(html, id, data) {
  const tag = `<script type="application/ld+json" id="${id}">${jsonForScript(data)}</script>`;
  const re = new RegExp(`<script\\b[^>]*\\bid=["']${id}["'][^>]*>[\\s\\S]*?</script>`, 'i');
  if (re.test(html)) {
    const current = re.exec(html)[0];
    if (current === tag) return html;
    return html.replace(re, tag);
  }
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  return `${html}\n${tag}`;
}

function typesOf(node) {
  return [].concat(node?.['@type'] || []).filter((t) => typeof t === 'string');
}

function isArticle(node) {
  const types = typesOf(node);
  return types.includes('NewsArticle') || types.includes('Article');
}

function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visit(item, fn);
    return;
  }
  fn(node);
  if (node['@graph']) visit(node['@graph'], fn);
}

function ldScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    if (!/type\s*=\s*["']application\/ld\+json["']/i.test(m[1])) continue;
    if (/\bid\s*=\s*["']adrnnng-/.test(m[1])) continue;
    out.push({ attrs: m[1], body: m[2], full: m[0] });
  }
  return out;
}

function findDatePublished(html) {
  for (const script of ldScripts(html)) {
    let data;
    try {
      data = JSON.parse(script.body);
    } catch {
      continue;
    }
    let found = '';
    visit(data, (node) => {
      if (found || !isArticle(node)) return;
      if (typeof node.datePublished === 'string' && isPublishTime(node.datePublished)) found = node.datePublished;
    });
    if (found) return found;
  }
  return '';
}

export function articlePublishedTime(html) {
  const meta = metaContent(html, 'property', 'article:published_time');
  if (isPublishTime(meta)) return meta;
  return findDatePublished(html);
}

function logoReady(publisher) {
  const logo = publisher?.logo;
  return publisher?.['@id'] === ORG_ID
    && logo?.['@type'] === 'ImageObject'
    && logo.url === LOGO.url
    && logo.width === LOGO.width
    && logo.height === LOGO.height;
}

export function patchNewsArticleScripts(html) {
  let out = html;
  for (const script of ldScripts(html)) {
    let data;
    try {
      data = JSON.parse(script.body);
    } catch {
      continue;
    }
    let changed = false;
    visit(data, (node) => {
      if (!isArticle(node)) return;
      const pub = node.publisher && typeof node.publisher === 'object' && !Array.isArray(node.publisher)
        ? { ...node.publisher }
        : { '@type': 'Organization', name: 'ADRRR' };
      pub['@type'] = pub['@type'] || 'Organization';
      if (!pub.name) pub.name = 'ADRRR';
      if (!pub['@id']) pub['@id'] = ORG_ID;
      pub.logo = { ...LOGO };
      if (!logoReady(node.publisher) || JSON.stringify(node.publisher) !== JSON.stringify(pub)) {
        node.publisher = pub;
        changed = true;
      }
    });
    if (!changed) continue;
    const replacement = `<script${script.attrs}>${jsonForScript(data)}</script>`;
    if (!out.includes(script.full)) continue;
    out = out.replace(script.full, replacement);
  }
  return out;
}

function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return tidy(decodeEntities((m?.[1] || '').replace(/<[^>]+>/g, '')));
}

function editionCrumbName(html, ymd) {
  const section = /<section\b[^>]*class=["'][^"']*\bedition\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/i.exec(html);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(section?.[1] || '');
  const fromH1 = tidy(decodeEntities((h1?.[1] || '').replace(/<[^>]+>/g, '')));
  if (fromH1) return fromH1;
  const title = pageTitle(html);
  if (title) return title;
  if (/^\d{8}$/.test(ymd || '')) return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  return 'Morning Report';
}

export function stampHtml(html, { kind = 'home', crumb = '', url = '', ymd = '' } = {}) {
  let out = html;
  out = ensureMeta(out, 'property', 'og:locale', LOCALE);
  out = ensureMeta(out, 'name', 'twitter:site', TWITTER_SITE);
  if (kind === 'home' || kind === 'archive' || kind === 'edition') out = ensureRssLink(out);
  if (kind === 'edition') {
    out = patchNewsArticleScripts(out);
    const published = articlePublishedTime(out);
    if (published) out = ensureMeta(out, 'property', 'article:published_time', published);
    out = upsertJsonLd(out, 'adrnnng-breadcrumb', breadcrumbGraph([
      { name: 'Home', url: `${SITE_ORIGIN}/` },
      { name: 'Morning Report', url: `${SITE_ORIGIN}/news/` },
      { name: editionCrumbName(out, ymd), url: `${SITE_ORIGIN}/news/${ymd}/` },
    ]));
  } else if (kind === 'archive') {
    out = upsertJsonLd(out, 'adrnnng-breadcrumb', breadcrumbGraph([
      { name: 'Home', url: `${SITE_ORIGIN}/` },
      { name: 'Morning Report', url: `${SITE_ORIGIN}/news/` },
    ]));
  } else if (kind === 'section' && crumb && url) {
    out = upsertJsonLd(out, 'adrnnng-breadcrumb', breadcrumbGraph([
      { name: 'Home', url: `${SITE_ORIGIN}/` },
      { name: crumb, url },
    ]));
  }
  out = upsertJsonLd(out, 'adrnnng-site', siteGraph());
  return out;
}

function editionIso(compact) {
  if (!/^\d{8}$/.test(compact)) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return compact;
}

export function stampSite(siteDir) {
  const jobs = [{ rel: 'index.html', opts: { kind: 'home' } }];
  for (const section of SECTION_PAGES) jobs.push({ rel: section.rel, opts: { kind: 'section', crumb: section.crumb, url: section.url } });
  jobs.push({ rel: 'news/index.html', opts: { kind: 'archive' } });
  const news = join(siteDir, 'news');
  if (existsSync(news)) {
    for (const name of readdirSync(news)) {
      if (!editionIso(name)) continue;
      const rel = `news/${name}/index.html`;
      if (!existsSync(join(siteDir, rel))) continue;
      jobs.push({ rel, opts: { kind: 'edition', ymd: name } });
    }
  }
  let stamped = 0;
  for (const job of jobs) {
    const abs = join(siteDir, job.rel);
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, 'utf8');
    const after = stampHtml(before, job.opts);
    if (after !== before) writeFileSync(abs, after);
    stamped += 1;
  }
  const template = join(siteDir, 'scripts/templates/tool/index.html');
  if (existsSync(template)) {
    const before = readFileSync(template, 'utf8');
    const after = stampHtml(before, { kind: 'section' });
    if (after !== before) writeFileSync(template, after);
    stamped += 1;
  }
  return stamped;
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = flag(process.argv.slice(2), '--site');
  if (!site) {
    console.error('usage: node scripts/seo-meta.mjs --site <dir>');
    process.exit(2);
  }
  const n = stampSite(site);
  console.log(`seo meta: stamped ${n} html file(s)`);
}
