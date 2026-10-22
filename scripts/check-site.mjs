// node scripts/check-site.mjs
// Structural checks for the static site: tool registry, page wiring, local links and imports,
// reserved paths owned by other publishers, and the backtest price manifest. Exit 1 on errors.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexingHeaderErrors } from './headers.mjs';
import { findIndexNowKey } from './indexnow.mjs';
import { sitemapDrift } from './sitemap.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', 'scripts']);
const STATUSES = new Set(['live', 'new', 'beta', 'soon']);
const OWNERS = new Set(['repo', 'news-analyst']);
const errors = [];
const notes = [];
const err = (m) => errors.push(m);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p);
const files = walk(ROOT);

// ---- registry
const reg = JSON.parse(readFileSync(join(ROOT, 'assets/tools.json'), 'utf8'));
const ids = new Set();
const reserved = [];
for (const t of reg.tools) {
  const where = `tools.json "${t.id}"`;
  if (!/^[a-z0-9-]+$/.test(t.id || '')) err(`${where}: id must be kebab-case`);
  if (ids.has(t.id)) err(`${where}: duplicate id`);
  ids.add(t.id);
  for (const k of ['title', 'summary', 'status', 'owner', 'chrome']) if (!t[k]) err(`${where}: missing "${k}"`);
  if (!STATUSES.has(t.status)) err(`${where}: status must be one of ${[...STATUSES]}`);
  if (!OWNERS.has(t.owner)) err(`${where}: owner must be one of ${[...OWNERS]}`);
  if (t.href === null || t.href === undefined) {
    if (t.status !== 'soon') err(`${where}: only "soon" tools may have no href`);
    continue;
  }
  if (!/^\/[a-z0-9-]+\/$/.test(t.href)) err(`${where}: href must look like "/slug/"`);
  const dir = t.href.slice(1, -1);
  if (t.owner === 'news-analyst') {
    reserved.push(dir + '/');
    continue;
  }
  const page = join(ROOT, dir, 'index.html');
  if (!existsSync(page)) {
    err(`${where}: ${dir}/index.html does not exist`);
    continue;
  }
  if (t.chrome === 'shared') {
    const html = readFileSync(page, 'utf8');
    for (const needle of ['/assets/css/theme.css', '/assets/js/site.js', 'data-site-header', 'data-site-footer']) {
      if (!html.includes(needle)) err(`${dir}/index.html: shared-chrome tool must include ${needle}`);
    }
  }
}
notes.push(`${reg.tools.length} tools registered (${reg.tools.filter((t) => t.href).length} with pages)`);

// A root 404.html is what stops Cloudflare Pages from serving index.html with 200 for unknown paths.
const notFound = join(ROOT, '404.html');
if (!existsSync(notFound)) err('404.html missing at the site root; Pages would serve index.html with status 200');
else {
  const html = readFileSync(notFound, 'utf8');
  for (const needle of ['/assets/css/theme.css', '/assets/js/site.js', 'data-site-header', 'data-site-footer']) {
    if (!html.includes(needle)) err(`404.html must include ${needle}`);
  }
  for (const href of ['href="/"', 'href="/backtest/"', 'href="/politician-tracker/"', 'href="/news/"']) {
    if (!html.includes(href)) err(`404.html must link ${href}`);
  }
}

// ---- reserved paths: published by someone else, must not exist in the repo
for (const r of reserved) {
  const clash = files.filter((f) => rel(f).startsWith(r));
  if (clash.length) err(`${r} is published by the News Analyst; remove from repo: ${clash.slice(0, 3).map(rel).join(', ')}`);
}
notes.push(`reserved for external publishers: ${reserved.join(', ') || 'none'}`);

// ---- local links in HTML and imports in JS
const isReserved = (p) => reserved.some((r) => p.replace(/^\//, '').startsWith(r) || p === '/' + r.slice(0, -1));
function resolvesLocal(urlPath, fromFile) {
  const clean = urlPath.split('#')[0].split('?')[0];
  if (!clean) return true;
  const abs = clean.startsWith('/') ? join(ROOT, clean) : join(dirname(fromFile), clean);
  if (clean.startsWith('/') && isReserved(clean)) return true;
  if (existsSync(abs) && statSync(abs).isFile()) return true;
  if (existsSync(join(abs, 'index.html'))) return true;
  return false;
}
let linkCount = 0;
for (const f of files.filter((p) => p.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|data:|#|javascript:|\{)/.test(u) || u.includes('${')) continue;
    linkCount++;
    if (!resolvesLocal(u, f)) err(`${rel(f)}: broken link ${u}`);
  }
}
let importCount = 0;
for (const f of files.filter((p) => /\.m?js$/.test(p) && !p.includes('/vendor/'))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1] || m[2];
    if (spec.startsWith('node:') || !/^[./]/.test(spec)) continue;
    importCount++;
    if (!resolvesLocal(spec, f)) err(`${rel(f)}: unresolved import ${spec}`);
  }
}
notes.push(`${linkCount} local links and ${importCount} module imports resolve`);

// ---- backtest price manifest
const mPath = join(ROOT, 'backtest/data/prices/manifest.json');
if (existsSync(mPath)) {
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  for (const s of m.symbols) {
    const csv = join(ROOT, 'backtest/data/prices', s.file);
    if (!existsSync(csv)) err(`manifest: ${s.symbol} → missing ${s.file}`);
  }
  const stale = m.symbols.filter((s) => s.stale).map((s) => s.symbol);
  notes.push(`price manifest: ${m.symbols.length} symbols, generated ${m.generated_at}${stale.length ? `, stale: ${stale.join(' ')}` : ''}`);
} else err('backtest/data/prices/manifest.json missing');

// ---- search indexing (robots, headers, sitemap, social tags)
const robotsPath = join(ROOT, 'robots.txt');
const robots = existsSync(robotsPath) ? readFileSync(robotsPath, 'utf8') : '';
if (!robots) err('robots.txt missing');
else {
  if (!robots.includes('Sitemap: https://adrnnng.com/sitemap.xml')) err('robots.txt must point at https://adrnnng.com/sitemap.xml');
  if (/^disallow:\s*\/\s*$/im.test(robots)) err('robots.txt must not Disallow: /');
  if (!robots.includes('Disallow: /api/')) err('robots.txt must disallow /api/');
  for (const agent of ['*', 'Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'ClaudeBot']) {
    const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^user-agent:\\s*${escaped}\\s*$`, 'im').test(robots)) err(`robots.txt must name ${agent}`);
  }
}
const key = findIndexNowKey(ROOT);
if (!key) err('IndexNow key file missing at the site root (<hex>.txt whose contents are the key)');
const headerText = existsSync(join(ROOT, '_headers')) ? readFileSync(join(ROOT, '_headers'), 'utf8') : '';
for (const problem of indexingHeaderErrors(headerText, { keyFile: key?.file })) err(problem);
const llmsPath = join(ROOT, 'llms.txt');
if (!existsSync(llmsPath)) err('llms.txt missing');
else {
  const llms = readFileSync(llmsPath, 'utf8');
  for (const needle of ['Backtest', 'Politician Tracker', 'Morning Report', '/hsi-lab/']) {
    if (!llms.includes(needle)) err(`llms.txt must mention ${needle}`);
  }
}
const indexable = [
  ['index.html', 'https://adrnnng.com/'],
  ['backtest/index.html', 'https://adrnnng.com/backtest/'],
  ['politician-tracker/index.html', 'https://adrnnng.com/politician-tracker/'],
];
const titles = [];
for (const [file, canonical] of indexable) {
  const html = readFileSync(join(ROOT, file), 'utf8');
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  titles.push(title);
  if (!title) err(`${file}: missing <title>`);
  if (!/name="description" content="[^"]+"/.test(html)) err(`${file}: missing meta description`);
  if (!html.includes(`rel="canonical" href="${canonical}"`)) err(`${file}: missing canonical ${canonical}`);
  for (const prop of ['og:title', 'og:description', 'og:url', 'og:image']) {
    if (!html.includes(`property="${prop}"`)) err(`${file}: missing ${prop}`);
  }
  for (const name of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
    if (!html.includes(`name="${name}"`)) err(`${file}: missing ${name}`);
  }
  if (/\bnoindex\b/i.test(html)) err(`${file}: must not set noindex`);
}
if (new Set(titles.filter(Boolean)).size !== titles.filter(Boolean).length) err(`page titles must be unique: ${titles.join(' | ')}`);
if (existsSync(notFound) && !/\bnoindex\b/i.test(readFileSync(notFound, 'utf8'))) err('404.html should stay noindex');
for (const problem of sitemapDrift(ROOT)) err(problem);

for (const n of notes) console.log(`  · ${n}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('\nsite check passed');
