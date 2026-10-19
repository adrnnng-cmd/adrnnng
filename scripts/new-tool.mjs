// npm run new-tool -- <slug> "<Title>" [--zh "中文"] [--category Research] [--summary "One sentence"]
// Creates /<slug>/{index.html,app.js,style.css} from scripts/templates/tool and registers the
// tool in assets/tools.json (status "beta", shown in the nav and on the landing page).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const zh = flag('zh');
const category = flag('category', 'Tools');
const [slug, title] = args;
const summary = flag('summary') || `${title}: coming together.`;

if (!slug || !title || !/^[a-z0-9-]+$/.test(slug)) {
  console.error('usage: npm run new-tool -- <kebab-slug> "<Title>" [--zh 中文] [--category Research] [--summary "..."]');
  process.exit(1);
}
const RESERVED = new Set(['assets', 'scripts', 'news', 'node_modules']);
if (RESERVED.has(slug) || existsSync(join(ROOT, slug))) {
  console.error(`/${slug}/ already exists or is reserved`);
  process.exit(1);
}

const regPath = join(ROOT, 'assets/tools.json');
const reg = JSON.parse(readFileSync(regPath, 'utf8'));
if (reg.tools.some((t) => t.id === slug)) {
  console.error(`tools.json already has "${slug}"`);
  process.exit(1);
}

const html = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fill = (s) =>
  s
    .replaceAll('__SLUG__', slug)
    .replaceAll('__TITLE__', html(title))
    .replaceAll('__SUMMARY__', html(summary))
    .replaceAll('__CATEGORY__', html(category))
    .replaceAll('__ZH_SPAN__', zh ? `<span class="zh">${html(zh)}</span>` : '');

const tpl = join(ROOT, 'scripts/templates/tool');
mkdirSync(join(ROOT, slug));
for (const f of readdirSync(tpl)) writeFileSync(join(ROOT, slug, f), fill(readFileSync(join(tpl, f), 'utf8')));

const entry = {
  id: slug,
  title,
  ...(zh ? { zh } : {}),
  href: `/${slug}/`,
  status: 'beta',
  category,
  icon: 'tool',
  accent: '#38bdf8',
  summary,
  highlights: [],
  nav: true,
  owner: 'repo',
  chrome: 'shared',
};
const soon = reg.tools.findIndex((t) => !t.href);
reg.tools.splice(soon < 0 ? reg.tools.length : soon, 0, entry);
writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');

console.log(`created /${slug}/ (index.html, app.js, style.css) and registered it in assets/tools.json.
next: build the tool in ${slug}/app.js, then npm run check && npm run serve → http://127.0.0.1:8788/${slug}/`);
