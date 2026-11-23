// Content-addressed URLs for the landing page and /movers/ module graphs.
//
// The production zone serves /assets and /movers scripts and stylesheets with a four-hour browser cache whatever the
// origin says, and it expires each file on its own clock. A browser can therefore hold an old lib.js next to a new
// app.js and fail to link (the page then sits on 資料載入中… even after a reload). HTML always revalidates, so every
// local script, stylesheet and import below carries ?v=<hash of that file as stamped>: a changed file gets a new URL,
// and a changed dependency changes every URL above it, so no cached copy can pair with the wrong neighbour.
//
//   node scripts/asset-versions.mjs           rewrite the HTML pages and modules in place
//   node scripts/asset-versions.mjs --check   exit 1 when anything is stale (npm run check does this too)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGES = ['index.html', 'movers/index.html'];

const SPECIFIER_RE = /((?:^|\n)\s*import\s+|\bfrom\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g;
const SCRIPT_TAG_RE = /(<script\b[^>]*\bsrc=")(\/[^"?#]+\.js)(?:\?v=[0-9a-f]+)?(")/g;
const STYLE_TAG_RE = /(<link\b[^>]*\brel="stylesheet"[^>]*\bhref=")(\/[^"?#]+\.css)(?:\?v=[0-9a-f]+)?(")/g;

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10);

function localDependency(spec, fromPath) {
  const bare = spec.split('?')[0].split('#')[0];
  if (!bare.startsWith('./') && !bare.startsWith('../') && !bare.startsWith('/')) return null;
  const path = bare.startsWith('/') ? bare : posix.join(posix.dirname(fromPath), bare);
  return path.endsWith('.js') ? path : null;
}

/** Stamped source and version of one file, dependencies first. Throws on an import cycle. */
function build(root, path, memo, stack = []) {
  if (memo.has(path)) return memo.get(path);
  if (stack.includes(path)) throw new Error(`import cycle: ${[...stack, path].join(' -> ')}`);
  const file = join(root, path);
  if (!existsSync(file)) throw new Error(`${path} does not exist`);
  const source = readFileSync(file, 'utf8');
  let out = source;
  if (path.endsWith('.js')) {
    out = source.replace(SPECIFIER_RE, (whole, lead, quote, spec) => {
      const dep = localDependency(spec, path);
      if (!dep || !existsSync(join(root, dep))) return whole;
      const { version } = build(root, dep, memo, [...stack, path]);
      return `${lead}${quote}${spec.split('?')[0]}?v=${version}${quote}`;
    });
  } else if (/@import/.test(source)) {
    throw new Error(`${path}: @import hides a dependency from the version; link the stylesheet from the page instead`);
  }
  const entry = { source: out, version: hash(out), changed: out !== source };
  memo.set(path, entry);
  return entry;
}

/** Stamped HTML for one page, and every file its scripts and stylesheets reach. */
function stampPage(root, page, memo) {
  const html = readFileSync(join(root, page), 'utf8');
  const next = html
    .replace(SCRIPT_TAG_RE, (_, a, path, b) => `${a}${path}?v=${build(root, path, memo).version}${b}`)
    .replace(STYLE_TAG_RE, (_, a, path, b) => `${a}${path}?v=${build(root, path, memo).version}${b}`);
  return next;
}

/** Versions by path for every file reachable from the pages, plus the stamped text of each file and page. */
export function plan(root) {
  const memo = new Map();
  const pages = Object.fromEntries(PAGES.map((page) => [page, stampPage(root, page, memo)]));
  const files = Object.fromEntries([...memo].map(([path, e]) => [path, e.source]));
  const versions = Object.fromEntries([...memo].map(([path, e]) => [path, e.version]));
  return { pages, files, versions };
}

/** Problems between the tree on disk and what the stamp would write; empty when current. */
export function staleStamps(root) {
  const { pages, files } = plan(root);
  const problems = [];
  for (const [path, text] of Object.entries({ ...files, ...pages })) {
    const abs = join(root, path.replace(/^\//, ''));
    if (readFileSync(abs, 'utf8') !== text) problems.push(path.replace(/^\//, ''));
  }
  return problems;
}

export function stampTree(root) {
  const { pages, files } = plan(root);
  const written = [];
  for (const [path, text] of Object.entries({ ...files, ...pages })) {
    const abs = join(root, path.replace(/^\//, ''));
    if (readFileSync(abs, 'utf8') !== text) {
      writeFileSync(abs, text);
      written.push(path.replace(/^\//, ''));
    }
  }
  return written;
}

export function stampError(root) {
  const stale = staleStamps(root);
  return stale.length ? `asset version stamps are stale in ${stale.join(', ')}; run node scripts/asset-versions.mjs` : '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) {
    const problem = stampError(root);
    if (problem) {
      console.error(problem);
      process.exit(1);
    }
    console.log('asset version stamps are current');
  } else {
    const written = stampTree(root);
    console.log(written.length ? `stamped ${written.join(', ')}` : 'already current');
  }
}
