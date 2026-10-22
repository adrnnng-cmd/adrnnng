// Ping IndexNow with the URLs this publish changed.
//
//   node scripts/ping-indexnow.mjs --paths changed.txt
//   node scripts/ping-indexnow.mjs --site <deploy_dir> [--previous url-list.txt]
//   node scripts/ping-indexnow.mjs --site <deploy_dir> --print-urls
//   node scripts/ping-indexnow.mjs --paths changed.txt --dry-run
//
// Run --site after `wrangler pages deploy`, when the key file is already live.
// --previous is the URL list saved from the prior publish (--print-urls).
// The first publish (no previous list) submits every URL in the sitemap.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './sitemap.mjs';
import {
  buildPayload,
  findIndexNowKey,
  locsFromSite,
  postIndexNow,
  readUrlList,
  selectPingUrls,
  urlsForChangedPaths,
} from './indexnow.mjs';

const args = process.argv.slice(2);
function flag(name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const dryRun = args.includes('--dry-run');
const printUrls = args.includes('--print-urls');
const site = flag('--site') ? resolve(flag('--site')) : '';
const pathsFile = flag('--paths');
const previousFile = flag('--previous');
const retries = Number(flag('--retries', '0'));
const delayMs = Number(flag('--retry-delay-ms', '0'));

const pathUrls = pathsFile ? urlsForChangedPaths(readFileSync(pathsFile, 'utf8').split(/\r?\n/)) : [];
let siteLocs = null;
let newsLocs = [];
if (site) {
  const locs = locsFromSite(site);
  siteLocs = [...new Set([...locs.all, ...locs.recent])];
  newsLocs = locs.recent;
}
const previous = previousFile ? readUrlList(readFileSync(previousFile, 'utf8')) : null;
const urlList = selectPingUrls({ siteLocs, newsLocs, previous: previousFile ? previous : null, pathUrls });

if (printUrls) {
  const listed = (siteLocs || pathUrls).slice().sort();
  process.stdout.write(`${listed.join('\n')}${listed.length ? '\n' : ''}`);
  process.exit(0);
}
if (!urlList.length) {
  console.log('indexnow: no changed urls');
  process.exit(0);
}

const keyDir = site || repoRoot();
const found = findIndexNowKey(keyDir);
if (!found) {
  console.error(`indexnow: key file missing in ${keyDir} (expected <key>.txt containing the key)`);
  process.exit(1);
}
const payload = buildPayload({ key: found.key, urlList });
if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}
const result = await postIndexNow(payload, { retries, delayMs });
if (!result.ok) {
  console.error(`indexnow: HTTP ${result.status} ${result.body.slice(0, 300)}`);
  process.exit(1);
}
console.log(`indexnow: submitted ${urlList.length} url(s), HTTP ${result.status}`);
