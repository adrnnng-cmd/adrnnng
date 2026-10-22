// IndexNow submission. The key file is public: https://www.indexnow.org/documentation
// posts { host, key, keyLocation, urlList } to https://api.indexnow.org/indexnow.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractLocs } from './sitemap.mjs';

const HOST = 'adrnnng.com';
const BASE = `https://${HOST}`;
const POLICY_FILES = new Set(['robots.txt', '_headers']);
const SECTION_URLS = [`${BASE}/`, `${BASE}/backtest/`, `${BASE}/politician-tracker/`, `${BASE}/news/`, `${BASE}/robots.txt`, `${BASE}/sitemap.xml`, `${BASE}/llms.txt`];

export function findIndexNowKey(siteDir) {
  let names = [];
  try {
    names = readdirSync(siteDir).filter((n) => /^[a-f0-9]{8,128}\.txt$/.test(n));
  } catch {
    return null;
  }
  const hits = [];
  for (const name of names) {
    const key = name.slice(0, -4);
    const body = readFileSync(join(siteDir, name), 'utf8').trim();
    if (body === key) hits.push({ key, file: name });
  }
  return hits.length === 1 ? hits[0] : null;
}

export function urlsForChangedPaths(paths) {
  const urls = new Set();
  const list = [...paths].map((p) => String(p).trim().replaceAll('\\', '/')).filter(Boolean);
  if (list.some((p) => POLICY_FILES.has(p))) {
    for (const url of SECTION_URLS) urls.add(url);
  }
  for (const p of list) {
    if (p.startsWith('.github/') || p.startsWith('scripts/') || p.includes('/tests/') || p.endsWith('.md') || p === 'package.json' || p === '.gitignore') continue;
    if (p === 'index.html') urls.add(`${BASE}/`);
    else if (p === 'robots.txt' || p === 'llms.txt' || p === 'sitemap.xml' || p.startsWith('sitemap-') || p === 'news-sitemap.xml') urls.add(`${BASE}/${p}`);
    else if (/^[a-f0-9]{8,128}\.txt$/.test(p)) urls.add(`${BASE}/${p}`);
    else if (/^news\/(\d{8})\//.test(p)) {
      urls.add(`${BASE}/${p.match(/^(news\/\d{8}\/)/)[1]}`);
      urls.add(`${BASE}/news/`);
    } else if (p.startsWith('news/')) urls.add(`${BASE}/news/`);
    else if (p.startsWith('backtest/')) urls.add(`${BASE}/backtest/`);
    else if (p.startsWith('politician-tracker/')) urls.add(`${BASE}/politician-tracker/`);
    else if (p.startsWith('hsi-lab/')) urls.add(`${BASE}/hsi-lab/`);
    else if (p.endsWith('/index.html')) urls.add(`${BASE}/${p.slice(0, -'index.html'.length)}`);
    else if (p.endsWith('.html') && p !== '404.html') urls.add(`${BASE}/${p.slice(0, -'.html'.length)}`);
  }
  return [...urls].sort();
}

export function readUrlList(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function locsFromSite(siteDir) {
  const names = ['sitemap-pages.xml', 'sitemap-news.xml', 'news-sitemap.xml'];
  const all = [];
  const recent = [];
  for (const name of names) {
    let xml = '';
    try {
      xml = readFileSync(join(siteDir, name), 'utf8');
    } catch {
      continue;
    }
    const locs = extractLocs(xml);
    if (name === 'news-sitemap.xml') recent.push(...locs);
    else all.push(...locs);
  }
  return { all, recent };
}

/** URLs to submit for one publish. Without a previous list, submit the whole sitemap. */
export function selectPingUrls({ siteLocs = null, newsLocs = [], previous = null, pathUrls = [] }) {
  const urls = new Set(pathUrls);
  if (!previous) {
    for (const u of siteLocs || []) urls.add(u);
  } else {
    const seen = new Set(previous);
    for (const u of siteLocs || []) if (!seen.has(u)) urls.add(u);
    for (const u of newsLocs) urls.add(u);
  }
  return [...urls].filter((u) => u.startsWith(`${BASE}/`)).sort();
}

export function buildPayload({ key, urlList }) {
  return {
    host: HOST,
    key,
    keyLocation: `${BASE}/${key}.txt`,
    urlList,
  };
}

export async function postIndexNow(payload, {
  fetchImpl = globalThis.fetch,
  endpoint = 'https://api.indexnow.org/indexnow',
  retries = 0,
  delayMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let last = { ok: false, status: 0, body: '' };
  const attempts = Math.max(0, retries) + 1;
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && delayMs) await sleep(delayMs);
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      last = { ok: false, status: 0, body: String(err?.message || err) };
      continue;
    }
    const body = await res.text();
    if (res.status === 200 || res.status === 202) return { ok: true, status: res.status, body };
    last = { ok: false, status: res.status, body };
    const retryable = res.status === 403 || res.status === 422 || res.status === 429 || res.status >= 500;
    if (!retryable) break;
  }
  return last;
}
