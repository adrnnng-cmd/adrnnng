// The landing page's boot module is cached by browsers for hours (Pages default for /assets/js), while
// /assets/tools.json is cached for five minutes and index.html always revalidates. Version the boot URL in
// index.html with a hash of the module graph, so a page served after a release asks for a URL no browser has
// cached and so cannot pair an old home.js with a new registry.
//
//   node scripts/home-assets.mjs           rewrite index.html in place
//   node scripts/home-assets.mjs --check   exit 1 when index.html is stale (npm run check does this too)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOOT = '/assets/js/home.js';
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const BOOT_TAG_RE = /(<script\b[^>]*\bsrc=")\/assets\/js\/home\.js(?:\?v=[0-9a-f]+)?(")/;

function graph(root, entry, seen = new Map()) {
  if (seen.has(entry)) return seen;
  const abs = join(root, entry);
  if (!existsSync(abs)) return seen;
  const src = readFileSync(abs, 'utf8');
  seen.set(entry, src);
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = (m[1] || m[2] || '').split('?')[0];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const next = spec.startsWith('/') ? spec : join(dirname(entry), spec).replace(/\\/g, '/');
    graph(root, next.startsWith('/') ? next : `/${next}`, seen);
  }
  return seen;
}

export function bootVersion(root) {
  const modules = graph(root, BOOT);
  const hash = createHash('sha256');
  for (const path of [...modules.keys()].sort()) hash.update(`${path}\0${modules.get(path)}\0`);
  return hash.digest('hex').slice(0, 10);
}

export function bootTag(html) {
  const m = BOOT_TAG_RE.exec(html);
  return m ? /\?v=([0-9a-f]+)/.exec(m[0])?.[1] || '' : null;
}

export function stampedHtml(html, version) {
  if (!BOOT_TAG_RE.test(html)) throw new Error('index.html has no home.js module tag');
  return html.replace(BOOT_TAG_RE, `$1${BOOT}?v=${version}$2`);
}

export function bootStampError(root) {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const have = bootTag(html);
  const want = bootVersion(root);
  if (have === null) return 'index.html must load /assets/js/home.js';
  if (have !== want) {
    return `index.html loads home.js with ${have ? `?v=${have}` : 'no version'}, want ?v=${want}; run node scripts/home-assets.mjs`;
  }
  return '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) {
    const problem = bootStampError(root);
    if (problem) {
      console.error(problem);
      process.exit(1);
    }
    console.log(`home.js boot version ${bootVersion(root)} is current`);
  } else {
    const file = join(root, 'index.html');
    const next = stampedHtml(readFileSync(file, 'utf8'), bootVersion(root));
    writeFileSync(file, next);
    console.log(`index.html now loads ${BOOT}?v=${bootVersion(root)}`);
  }
}
