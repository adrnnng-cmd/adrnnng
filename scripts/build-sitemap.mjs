// Write sitemap.xml (an index) plus page and news fragments for one site directory.
//   node scripts/build-sitemap.mjs --site <dir> [--base https://adrnnng.com] [--now YYYY-MM-DD] [--check]

import { resolve } from 'node:path';
import { repoRoot, sitemapDrift, writeSitemaps } from './sitemap.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

const site = resolve(flag('--site', repoRoot()));
const opts = { base: flag('--base', 'https://adrnnng.com'), now: flag('--now', '') || undefined };

if (check) {
  const problems = sitemapDrift(site, opts);
  if (problems.length) {
    console.error(problems.map((p) => `  ✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`sitemap check passed (${site})`);
} else {
  const built = writeSitemaps(site, opts);
  const names = Object.keys(built.files).join(', ');
  console.log(`wrote ${names} (${built.pages.length} pages, ${built.news.length} news, ${built.recent.length} in the news sitemap)`);
}
