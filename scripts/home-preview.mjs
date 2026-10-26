// Publish-time home lead. assemble-deploy.sh runs this after news/ is copied in.
// It rewrites assets/news-preview.json and the static cover in index.html from the
// newest /news/YYYYMMDD/ edition, and patches /news/index.html (archive meta,
// title aligned with og:title, static newsletter card).
//
// Daily edition <title> / og:title / twitter:title / JSON-LD headline are owned by
// News Analyst (digest serp_hook → day page). This script only reads them.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newsletterCardHtml } from '../assets/js/newsletter.js';

export const HOME_H1 = '港股美股盤前早報';
export const HOME_TITLE = '港股美股盤前早報｜ADRRR News Lab';
export const ARCHIVE_TITLE = '港股美股盤前早報 往期｜HK & US Stocks Morning Report Archive — ADRRR';
export const ARCHIVE_DESCRIPTION = 'ADRRR 港股美股晨報往期全文。每朝 9 點前更新；訂閱 Newsletter 收最新盤前摘要。';

const HOOK_TITLE = /^(.+?)｜(\d{1,2})月(\d{1,2})日港股美股盤前早報 — ADRRR$/;

export function tidy(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function decodeEntities(s) {
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

function escText(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function escAttr(s) {
  return escText(s).replace(/"/g, '&quot;');
}

function visibleText(fragment) {
  const noHidden = String(fragment).replace(/<([a-zA-Z0-9]+)\b[^>]*\shidden\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  return tidy(decodeEntities(noHidden.replace(/<[^>]+>/g, '')));
}

function leadingText(fragment) {
  const m = /^([^<]*)/.exec(String(fragment));
  return tidy(decodeEntities(m?.[1] || ''));
}

function clipDek(s, max = 320) {
  const t = tidy(s);
  if ([...t].length <= max) return t;
  const cut = [...t].slice(0, max).join('');
  const punct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return punct >= 40 ? cut.slice(0, punct + 1) : cut;
}

function elements(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
  for (const m of html.matchAll(re)) out.push({ attrs: m[1], inner: m[2] });
  return out;
}

function classHas(attrs, name) {
  return new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${name}\\b`).test(attrs);
}

function editionIso(compact) {
  if (!/^\d{8}$/.test(compact)) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function findLatestEdition(siteDir) {
  const news = join(siteDir, 'news');
  if (!existsSync(news)) return null;
  let best = null;
  for (const name of readdirSync(news)) {
    if (!editionIso(name)) continue;
    const file = join(news, name, 'index.html');
    if (!existsSync(file)) continue;
    if (!best || name > best.ymd) best = { ymd: name, file };
  }
  return best;
}

export function pageTitleText(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return tidy(visibleText(m?.[1] || ''));
}

export function serpHookFromTitle(title, ymd) {
  const m = HOOK_TITLE.exec(tidy(title));
  if (!m || !/^\d{8}$/.test(ymd || '')) return '';
  if (Number(m[2]) !== Number(ymd.slice(4, 6)) || Number(m[3]) !== Number(ymd.slice(6, 8))) return '';
  return m[1].trim();
}

function findSerpHook(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  if (Object.prototype.hasOwnProperty.call(data, 'serp_hook')) {
    return typeof data.serp_hook === 'string' ? data.serp_hook.trim() : '';
  }
  for (const value of Object.values(data)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (Object.prototype.hasOwnProperty.call(value, 'serp_hook')) {
      return typeof value.serp_hook === 'string' ? value.serp_hook.trim() : '';
    }
  }
  return undefined;
}

function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function readSerpHookFromDigest(digestDir, ymd) {
  if (!digestDir || !/^\d{8}$/.test(ymd)) return undefined;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  for (const name of [`${iso}.json`, `${ymd}.json`]) {
    const found = findSerpHook(readJson(join(digestDir, name)));
    if (found !== undefined) return found;
  }
  return undefined;
}

function metaTags(html) {
  return html.match(/<meta\b[^>]*>/gi) || [];
}

function tagAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m ? decodeEntities(m[1]) : '';
}

function metaByName(html, name) {
  for (const tag of metaTags(html)) {
    if (tagAttr(tag, 'name') === name && /\bcontent\s*=/.test(tag)) return tagAttr(tag, 'content');
  }
  return undefined;
}

function metaByProperty(html, prop) {
  for (const tag of metaTags(html)) {
    if (tagAttr(tag, 'property') === prop && /\bcontent\s*=/.test(tag)) return tagAttr(tag, 'content');
  }
  return '';
}

export function resolveSerpHook({ digestDir, siteDir, ymd, html }) {
  const fromDigest = readSerpHookFromDigest(digestDir, ymd);
  if (fromDigest !== undefined) return fromDigest;
  const latest = findSerpHook(readJson(join(siteDir, 'news', 'latest.json')));
  if (latest !== undefined) return latest;
  const editionDir = join(siteDir, 'news', ymd);
  if (existsSync(editionDir)) {
    for (const name of readdirSync(editionDir).filter((n) => n.endsWith('.json')).sort()) {
      const found = findSerpHook(readJson(join(editionDir, name)));
      if (found !== undefined) return found;
    }
  }
  const meta = metaByName(html, 'serp_hook');
  if (meta !== undefined) return meta.trim();
  return serpHookFromTitle(pageTitleText(html), ymd);
}

function sectionInner(html, className) {
  const re = new RegExp(`<section\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</section>`, 'i');
  return re.exec(html)?.[1] || '';
}

export function parseEdition(html) {
  const edition = sectionInner(html, 'edition');
  const kicker = visibleText(/<div\b[^>]*class=["'][^"']*\bkicker\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(edition)?.[1] || '');
  const editionTitle = visibleText(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(edition)?.[1] || '');
  const leadStart = html.search(/<article\b[^>]*class=["'][^"']*\blead\b/);
  const leadHtml = leadStart >= 0 ? html.slice(leadStart) : '';
  const lead = visibleText(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(leadHtml)?.[1] || '');
  const intro = /<p\b[^>]*class=["'][^"']*\bmw-intro\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(html);
  const leadBody = /<p\b[^>]*class=["'][^"']*\bbody\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(leadHtml);
  const dek = clipDek(visibleText(intro?.[1] || leadBody?.[1] || ''));
  const stories = elements(html, 'h3')
    .map((el) => visibleText(el.inner))
    .filter((t) => t.length > 16 && !/Sector|Performance|板塊表現|強弱|Indicators/.test(t))
    .slice(0, 3);
  const table = /<table\b[^>]*class=["'][^"']*\bmkt\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i.exec(html);
  const markets = [];
  for (const tr of table ? elements(table[1], 'tr') : []) {
    const tds = elements(tr.inner, 'td');
    const n = tds.find((td) => classHas(td.attrs, 'n'));
    const v = tds.find((td) => classHas(td.attrs, 'v'));
    const c = tds.find((td) => classHas(td.attrs, 'c'));
    const value = v ? visibleText(v.inner) : '';
    if (!value) continue;
    const dir = c && /\bdown\b/.test(c.attrs) ? 'down' : c && /\bup\b/.test(c.attrs) ? 'up' : 'flat';
    markets.push({
      name: leadingText(n?.inner || '').split(/\s+/)[0] || '',
      value,
      change: c ? visibleText(c.inner) : '',
      dir,
    });
    if (markets.length === 6) break;
  }
  return { kicker, editionTitle, lead, dek, stories, markets };
}

export function crawlerDek(preview) {
  const bits = [];
  const hook = tidy(preview.serp_hook);
  const lead = tidy(preview.lead);
  const dek = tidy(preview.dek);
  if (hook) bits.push(hook);
  if (lead && lead !== hook) bits.push(lead);
  if (dek) bits.push(dek);
  return tidy(bits.join(' '));
}

export function buildPreview({ siteDir, ymd, html, digestDir }) {
  const parsed = parseEdition(html);
  return {
    href: `/news/${ymd}/`,
    edition: parsed.editionTitle,
    kicker: parsed.kicker,
    lead: parsed.lead,
    dek: parsed.dek,
    serp_hook: resolveSerpHook({ digestDir, siteDir, ymd, html }),
    stories: parsed.stories,
    markets: parsed.markets,
  };
}

function mustReplace(html, re, replacement, label) {
  if (!re.test(html)) throw new Error(`index.html missing ${label}`);
  return html.replace(re, replacement);
}

export function applyHomePreview(html, preview) {
  const href = preview.href || '/news/';
  const kicker = preview.kicker || '晨報摘要 / Morning Report';
  const kickerHtml = kicker.split(/\s*\/\s*/).filter(Boolean).map(escText).join(' <span class="sep">/</span> ');
  const stories = (preview.stories || [])
    .map((s, i) => `<li><span class="n">${String(i + 1).padStart(2, '0')}</span><span>${escText(s)}</span></li>`)
    .join('\n          ');
  const markets = (preview.markets || [])
    .map((m) => `<tr><td class="n">${escText(m.name)}</td><td class="v">${escText(m.value)}</td><td class="c ${escText(m.dir || 'flat')}">${escText(m.change)}</td></tr>`)
    .join('\n          ');
  let out = html;
  out = mustReplace(out, /<p class="kicker" id="report-kicker">[\s\S]*?<\/p>/, `<p class="kicker" id="report-kicker">${kickerHtml}</p>`, '#report-kicker');
  out = mustReplace(
    out,
    /<h1 id="report-lead">[\s\S]*?<\/h1>/,
    `<h1 id="report-lead"><a href="${escAttr(href)}">${escText(HOME_H1)}</a></h1>`,
    '#report-lead',
  );
  out = mustReplace(
    out,
    /<p class="dek" id="report-dek">[\s\S]*?<\/p>/,
    `<p class="dek" id="report-dek">${escText(crawlerDek(preview))}</p>`,
    '#report-dek',
  );
  out = mustReplace(
    out,
    /<ol class="front-list" id="report-stories">[\s\S]*?<\/ol>/,
    `<ol class="front-list" id="report-stories">\n          ${stories}\n        </ol>`,
    '#report-stories',
  );
  out = mustReplace(
    out,
    /<a id="report-link" href="[^"]*">/,
    `<a id="report-link" href="${escAttr(href)}">`,
    '#report-link',
  );
  out = mustReplace(
    out,
    /<table class="mkt" id="report-markets">[\s\S]*?<\/table>/,
    `<table class="mkt" id="report-markets">\n          ${markets}\n        </table>`,
    '#report-markets',
  );
  return out;
}

function upsertMeta(html, { kind, key, content }) {
  const attr = kind === 'property' ? 'property' : 'name';
  const tag = `<meta ${attr}="${key}" content="${escAttr(content)}">`;
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  if (re.test(html)) return html.replace(re, tag);
  if (/<\/title>/i.test(html)) return html.replace(/<\/title>/i, `</title>\n${tag}`);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  return `${tag}\n${html}`;
}

function setTitle(html, title) {
  const tag = `<title>${escText(title)}</title>`;
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, tag);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  return `${tag}\n${html}`;
}

export function patchNewsArchive(html) {
  const og = metaByProperty(html, 'og:title');
  const title = og.includes('港股美股') ? og : ARCHIVE_TITLE;
  let out = setTitle(html, title);
  out = upsertMeta(out, { kind: 'property', key: 'og:title', content: title });
  out = upsertMeta(out, { kind: 'name', key: 'twitter:title', content: title });
  out = upsertMeta(out, { kind: 'name', key: 'description', content: ARCHIVE_DESCRIPTION });
  if (!/embed-subscribe\/adrrr/.test(out)) {
    const card = newsletterCardHtml();
    if (/<footer\b/i.test(out)) out = out.replace(/<footer\b/i, `${card}\n<footer`);
    else if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${card}\n</body>`);
    else out += `\n${card}\n`;
  }
  if ((out.includes('id="newsletter"') || out.includes('embed-subscribe/adrrr')) && !out.includes('/assets/css/newsletter.css')) {
    const link = '<link rel="stylesheet" href="/assets/css/newsletter.css">';
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${link}`);
    else out = `<head>${link}</head>\n${out}`;
  }
  return out;
}

export function syncSite(siteDir, { digestDir } = {}) {
  const latest = findLatestEdition(siteDir);
  if (!latest) return { updated: false, preview: null };
  const before = readFileSync(latest.file);
  const html = before.toString('utf8');
  const preview = buildPreview({ siteDir, ymd: latest.ymd, html, digestDir });
  mkdirSync(join(siteDir, 'assets'), { recursive: true });
  writeFileSync(join(siteDir, 'assets', 'news-preview.json'), `${JSON.stringify(preview, null, 2)}\n`);
  const indexPath = join(siteDir, 'index.html');
  if (existsSync(indexPath)) {
    writeFileSync(indexPath, applyHomePreview(readFileSync(indexPath, 'utf8'), preview));
  }
  const archivePath = join(siteDir, 'news', 'index.html');
  if (existsSync(archivePath)) {
    writeFileSync(archivePath, patchNewsArchive(readFileSync(archivePath, 'utf8')));
  }
  const after = readFileSync(latest.file);
  if (!after.equals(before)) throw new Error(`edition HTML was modified: ${latest.file}`);
  return { updated: true, preview };
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const site = flag(args, '--site');
  if (!site) {
    console.error('usage: node scripts/home-preview.mjs --site <dir> [--digest <dir>]');
    process.exit(2);
  }
  const digest = flag(args, '--digest') || process.env.ADRRR_DIGEST_DIR || '';
  const result = syncSite(site, { digestDir: digest || undefined });
  if (!result.updated) {
    console.log('home preview: no /news/YYYYMMDD/ edition; left the committed cover in place');
  } else {
    const hook = result.preview.serp_hook ? `${result.preview.serp_hook.length} chars` : 'empty';
    console.log(`home preview: ${result.preview.href} serp_hook=${hook} stories=${result.preview.stories.length}`);
  }
}
