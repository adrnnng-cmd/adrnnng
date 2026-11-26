// Writes the homepage header, footer and four door cards into index.html as real links.
//
// The top menu itself is headerInner() in assets/js/chrome-html.js (TOP_NAV). /movers/, /about/ and
// /backtest/ commit that same header by hand; their footers stay empty shells that site.js fills.
// /thanks/, 404 and the tool template stay empty shells. The Politician Tracker renderer emits the same
// header. /news/ is not in this repo.
//
//   node scripts/static-chrome.mjs           rewrite index.html in place
//   node scripts/static-chrome.mjs --check   exit 1 when index.html is stale (npm run check does this too)
//
// Only the contents of <header data-site-header>, <footer data-site-footer> and <nav id="tools"> on index.html
// are touched, so the Morning Report cover that scripts/home-preview.mjs rewrites at assemble time is not.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { doorsInner, footerInner, headerInner } from '../assets/js/chrome-html.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Homepage only. Other shared-chrome HTML stays byte-identical to live main.
const APPROVED = ['index.html'];

const HEADER_RE = /(<header\b[^>]*\bdata-site-header\b[^>]*>)([\s\S]*?)(<\/header>)/;
const FOOTER_RE = /(<footer\b[^>]*\bdata-site-footer\b[^>]*>)([\s\S]*?)(<\/footer>)/;
const DOORS_RE = /(<nav\b[^>]*\bid="tools"[^>]*>)([\s\S]*?)(<\/nav>)/;

export function pages(root = ROOT) {
  return APPROVED.filter((file) => existsSync(join(root, file)));
}

/** The path the browser will report for this file, so the current page gets aria-current. */
export function urlPath(file) {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html') && !file.startsWith('scripts/')) return `/${file.slice(0, -'index.html'.length)}`;
  return '';
}

const indent = (text, n) => text.split('\n').map((l) => ' '.repeat(n) + l).join('\n');

function withClass(openTag, cls) {
  if (/\bclass="/.test(openTag)) {
    return openTag.replace(/\bclass="([^"]*)"/, (m, v) => (v.split(/\s+/).includes(cls) ? m : `class="${v} ${cls}"`));
  }
  return openTag.replace(/^<(\w+)/, `<$1 class="${cls}"`);
}

export function stamped(html, file, reg) {
  let out = html;
  out = out.replace(HEADER_RE, (m, open, _inner, close) => {
    const home = /\bdata-mast="home"/.test(open);
    return `${withClass(open, 'mast')}\n${indent(headerInner(reg, { path: urlPath(file), home }), 4)}\n  ${close}`;
  });
  out = out.replace(FOOTER_RE, (m, open, _inner, close) => `${withClass(open, 'site-footer')}\n${indent(footerInner(reg), 4)}\n  ${close}`);
  if (file === 'index.html') out = out.replace(DOORS_RE, (m, open, _inner, close) => `${open}\n      ${doorsInner(reg)}\n    ${close}`);
  return out;
}

export function plan(root = ROOT) {
  const reg = JSON.parse(readFileSync(join(root, 'assets/tools.json'), 'utf8'));
  return pages(root).map((file) => {
    const html = readFileSync(join(root, file), 'utf8');
    const next = stamped(html, file, reg);
    return { file, html, next, changed: next !== html };
  });
}

export function staleFiles(root = ROOT) {
  return plan(root).filter((p) => p.changed).map((p) => p.file);
}

export function writeAll(root = ROOT) {
  const changed = plan(root).filter((p) => p.changed);
  for (const p of changed) writeFileSync(join(root, p.file), p.next);
  return changed.map((p) => p.file);
}

const CANONICAL = ['/backtest/', '/movers/', '/politician-tracker/', '/news/'];

/** What a reader of view-source or a crawler without JavaScript must find. '' when everything is in place. */
export function staticChromeError(root = ROOT) {
  const stale = staleFiles(root);
  if (stale.length) return `static header/footer/doors are stale in ${stale.join(', ')}; run node scripts/static-chrome.mjs`;
  const missing = [];
  for (const file of pages(root)) {
    const html = readFileSync(join(root, file), 'utf8');
    const footer = FOOTER_RE.exec(html)?.[2];
    if (footer === undefined) continue;
    for (const href of CANONICAL) if (!footer.includes(`href="${href}"`)) missing.push(`${file} footer -> ${href}`);
    if (!footer.includes('href="/about/"')) missing.push(`${file} footer -> /about/`);
  }
  const home = readFileSync(join(root, 'index.html'), 'utf8');
  const doors = DOORS_RE.exec(home)?.[2] || '';
  for (const href of CANONICAL) if (!doors.includes(`href="${href}"`)) missing.push(`index.html doors -> ${href}`);
  return missing.length ? `missing static links: ${missing.join('; ')}` : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const err = staticChromeError();
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log('static header, footer and doors are current');
  } else {
    const changed = writeAll();
    console.log(changed.length ? `rewrote ${changed.join(', ')}` : 'already current');
  }
}
