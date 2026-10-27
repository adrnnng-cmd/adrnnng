import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { applyHeaders, indexingHeaderErrors, parseHeaders } from '../headers.mjs';
import { buildPayload, postIndexNow, selectPingUrls, urlsForChangedPaths } from '../indexnow.mjs';
import { buildSitemaps, extractLocs, isNoindexHtml, repoRoot } from '../sitemap.mjs';

const exec = promisify(execFile);
const root = repoRoot();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'adrnnng-seo-'));
  const files = {
    'index.html': '<html><head><title>Home</title></head><body></body></html>',
    '404.html': '<html><head><meta name="robots" content="noindex"></head></html>',
    'backtest/index.html': '<html><head><title>Backtest</title></head></html>',
    'politician-tracker/index.html': '<html><head><title>Tracker</title></head></html>',
    'politician-tracker/members/P000197/index.html': '<html><head><title>Nancy Pelosi</title></head></html>',
    'politician-tracker/img/note.html': '<html><head><title>skip portrait dir</title></head></html>',
    'hsi-lab/index.html': '<html><head><title>Strategy Lab</title></head></html>',
    'api/index.html': '<html><head><title>API</title></head></html>',
    'draft/index.html': '<html><head><meta content="noindex,nofollow" name="robots"><title>Draft</title></head></html>',
    'news/index.html': '<html><head><meta name="robots" content="noindex"><title>Archive</title></head></html>',
    'news/20261020/index.html': '<html><head><title>Older &amp; still listed</title></head></html>',
    'news/20261021/index.html': '<html><head><meta name="robots" content="noindex"><title>Yesterday</title></head></html>',
    'news/20261022/index.html': '<html><head><title>Today\'s Report</title><h1>Ignored</h1></head></html>',
    'news/img/20261022/index.html': '<html><head><title>photo</title></head></html>',
    'news/latest.json': '{}',
    'news/not-a-date/index.html': '<html><head><title>Not an edition</title></head></html>',
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body);
    await utimes(abs, new Date('2026-10-22T00:00:00Z'), new Date('2026-10-22T00:00:00Z'));
  }
  return dir;
}

test('sitemap index lists pages, member pages, hsi-lab, and news fragments', async () => {
  const dir = await fixture();
  try {
    const built = buildSitemaps(dir, { now: '2026-10-22' });
    const locs = (name) => extractLocs(built.files[name]);
    assert.deepEqual(locs('sitemap.xml'), [
      'https://adrnnng.com/sitemap-pages.xml',
      'https://adrnnng.com/sitemap-news.xml',
      'https://adrnnng.com/news-sitemap.xml',
    ]);
    assert.deepEqual(locs('sitemap-pages.xml'), [
      'https://adrnnng.com/',
      'https://adrnnng.com/backtest/',
      'https://adrnnng.com/hsi-lab/',
      'https://adrnnng.com/news/',
      'https://adrnnng.com/news/not-a-date/',
      'https://adrnnng.com/politician-tracker/',
      'https://adrnnng.com/politician-tracker/members/P000197/',
    ]);
    assert.deepEqual(locs('sitemap-news.xml'), [
      'https://adrnnng.com/news/20261020/',
      'https://adrnnng.com/news/20261021/',
      'https://adrnnng.com/news/20261022/',
    ]);
    assert.deepEqual(locs('news-sitemap.xml'), [
      'https://adrnnng.com/news/20261021/',
      'https://adrnnng.com/news/20261022/',
    ]);
    assert.match(built.files['news-sitemap.xml'], /xmlns:news="http:\/\/www.google.com\/schemas\/sitemap-news\/0.9"/);
    assert.match(built.files['news-sitemap.xml'], /<news:language>zh-Hant<\/news:language>/);
    assert.doesNotMatch(built.files['news-sitemap.xml'], /<news:language>en<\/news:language>/);
    assert.match(built.files['news-sitemap.xml'], /<news:title>Today&apos;s Report<\/news:title>/);
    assert.match(built.files['news-sitemap.xml'], /<news:title>Yesterday<\/news:title>/);
    assert.match(built.files['sitemap-news.xml'], /<lastmod>2026-10-20<\/lastmod>/);
    assert.doesNotMatch(built.files['sitemap-pages.xml'], /\/api\//);
    assert.doesNotMatch(built.files['sitemap-pages.xml'], /draft/);
    assert.equal(isNoindexHtml('<meta content="noindex" name="robots">'), true);
    assert.equal(isNoindexHtml('<meta name="robots" content="index,follow">'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('news fragment is omitted when every edition is older than yesterday', async () => {
  const dir = await fixture();
  try {
    const built = buildSitemaps(dir, { now: '2026-11-01' });
    assert.equal(built.files['news-sitemap.xml'], undefined);
    assert.deepEqual(extractLocs(built.files['sitemap.xml']), [
      'https://adrnnng.com/sitemap-pages.xml',
      'https://adrnnng.com/sitemap-news.xml',
    ]);
    assert.equal(built.recent.length, 0);
    assert.equal(built.news.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assemble-deploy writes the sitemap from the merged news tree', async () => {
  const news = await mkdtemp(join(tmpdir(), 'adrnnng-news-'));
  const out = await mkdtemp(join(tmpdir(), 'adrnnng-out-'));
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).replaceAll('-', '');
  try {
    await mkdir(join(news, today), { recursive: true });
    await writeFile(join(news, 'index.html'), '<html><head><title>Archive</title></head></html>');
    await writeFile(join(news, today, 'index.html'), `<html><head><title>Edition ${today}</title></head></html>`);
    await exec('bash', ['scripts/assemble-deploy.sh', out, '--news', news], { cwd: root });
    const index = await readFile(join(out, 'sitemap.xml'), 'utf8');
    const pages = await readFile(join(out, 'sitemap-pages.xml'), 'utf8');
    const editions = await readFile(join(out, 'sitemap-news.xml'), 'utf8');
    const recent = await readFile(join(out, 'news-sitemap.xml'), 'utf8');
    assert.match(index, /sitemap-pages\.xml/);
    assert.match(index, /sitemap-news\.xml/);
    assert.match(index, /news-sitemap\.xml/);
    assert.match(pages, /https:\/\/adrnnng\.com\/news\//);
    assert.match(pages, /https:\/\/adrnnng\.com\/backtest\//);
    assert.match(pages, /https:\/\/adrnnng\.com\/politician-tracker\//);
    assert.match(editions, new RegExp(`/news/${today}/`));
    assert.match(recent, new RegExp(`<news:title>Edition ${today}</news:title>`));
    assert.match(recent, /<news:language>zh-Hant<\/news:language>/);
    assert.doesNotMatch(recent, /<news:language>en<\/news:language>/);
    assert.match(await readFile(join(out, '404.html'), 'utf8'), /noindex/);
    const editionHtml = await readFile(join(out, 'news', today, 'index.html'), 'utf8');
    assert.match(editionHtml, new RegExp(`<title>Edition ${today}</title>`));
    assert.match(editionHtml, /property="og:locale" content="zh_HK"/);
    assert.match(editionHtml, /name="twitter:site" content="@adrnnng"/);
    assert.match(editionHtml, /id="adrnnng-site"/);
    assert.match(editionHtml, /"@type":"WebSite"/);
    assert.doesNotMatch(editionHtml, /SearchAction|FAQPage|article:published_time/);
    const homeBlock = /<loc>https:\/\/adrnnng\.com\/<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/.exec(pages);
    assert.equal(homeBlock?.[1], `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`);
    const feed = await readFile(join(out, 'news/feed.xml'), 'utf8');
    assert.equal((feed.match(/<item>/g) || []).length, 1);
    assert.match(feed, new RegExp(`<title>Edition ${today}</title>`));
    assert.match(feed, new RegExp(`<dc:date>${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}</dc:date>`));
    assert.doesNotMatch(feed, /<pubDate>/);
    const preview = JSON.parse(await readFile(join(out, 'assets/news-preview.json'), 'utf8'));
    assert.equal(preview.href, `/news/${today}/`);
    assert.equal(preview.serp_hook, '');
    assert.equal(typeof preview.serp_hook, 'string');
    const home = await readFile(join(out, 'index.html'), 'utf8');
    assert.match(home, new RegExp(`href="/news/${today}/"`));
    assert.match(home, /港股美股盤前早報/);
    const archive = await readFile(join(out, 'news/index.html'), 'utf8');
    assert.match(archive, /name="description" content="ADRRR 港股美股晨報往期全文。每朝 9 點前更新；訂閱 Newsletter 收最新盤前摘要。"/);
    assert.match(archive, /<title>[^<]*港股美股[^<]*<\/title>/);
    assert.match(archive, /embed-subscribe\/adrrr/);
  } finally {
    await rm(news, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('changed paths become public URLs and IndexNow submits the new ones', async () => {
  assert.deepEqual(urlsForChangedPaths([
    'politician-tracker/data.json',
    'news/20261022/index.html',
    'hsi-lab/app.js',
    'README.md',
    'assets/css/theme.css',
  ]), [
    'https://adrnnng.com/hsi-lab/',
    'https://adrnnng.com/news/',
    'https://adrnnng.com/news/20261022/',
    'https://adrnnng.com/politician-tracker/',
  ]);
  const policy = urlsForChangedPaths(['robots.txt']);
  assert.ok(policy.includes('https://adrnnng.com/backtest/'));
  assert.ok(policy.includes('https://adrnnng.com/news/'));
  assert.ok(!policy.includes('https://adrnnng.com/hsi-lab/'));

  const current = [
    'https://adrnnng.com/',
    'https://adrnnng.com/backtest/',
    'https://adrnnng.com/news/20261022/',
  ];
  assert.deepEqual(selectPingUrls({
    siteLocs: current,
    newsLocs: ['https://adrnnng.com/news/20261022/'],
    previous: ['https://adrnnng.com/', 'https://adrnnng.com/backtest/'],
    pathUrls: ['https://adrnnng.com/politician-tracker/'],
  }), [
    'https://adrnnng.com/news/20261022/',
    'https://adrnnng.com/politician-tracker/',
  ]);
  assert.deepEqual(selectPingUrls({ siteLocs: current, previous: null, pathUrls: [] }), current);

  const payload = buildPayload({ key: 'abc12345', urlList: ['https://adrnnng.com/'] });
  assert.equal(payload.host, 'adrnnng.com');
  assert.equal(payload.keyLocation, 'https://adrnnng.com/abc12345.txt');
  assert.deepEqual(payload.urlList, ['https://adrnnng.com/']);

  const calls = [];
  const ok = await postIndexNow(payload, {
    retries: 1,
    delayMs: 1,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (calls.length === 1) return { status: 503, text: async () => 'busy' };
      return { status: 202, text: async () => '' };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 202);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.indexnow.org/indexnow');
});

test('committed indexing files allow public pages and keep /api private', async () => {
  const robots = await readFile(join(root, 'robots.txt'), 'utf8');
  const groups = [];
  let current = null;
  for (const line of robots.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^user-agent:/i.test(t)) {
      current = { agent: t.split(':').slice(1).join(':').trim(), rules: [] };
      groups.push(current);
    } else if (/^sitemap:/i.test(t)) {
      assert.equal(t, 'Sitemap: https://adrnnng.com/sitemap.xml');
    } else if (current) current.rules.push(t);
  }
  for (const agent of ['*', 'Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'ClaudeBot']) {
    const group = groups.find((g) => g.agent === agent);
    assert.ok(group, agent);
    assert.deepEqual(group.rules, ['Allow: /', 'Disallow: /api/']);
  }
  assert.equal(groups.some((g) => g.rules.includes('Disallow: /')), false);

  const headers = await readFile(join(root, '_headers'), 'utf8');
  assert.deepEqual(indexingHeaderErrors(headers, { keyFile: 'ae5543efbf2a5168fc9df6644b06bc38.txt' }), []);
  assert.equal(parseHeaders(headers).some((r) => r.path === '/*'), false);
  for (const path of ['/politician-tracker/data.json', '/news/latest.json', '/assets/tools.json', '/api/health']) {
    assert.equal(applyHeaders(headers, path).get('x-robots-tag'), 'noindex, nofollow', path);
  }
  for (const path of ['/', '/politician-tracker/', '/politician-tracker/index.html', '/news/', '/news/20261022/', '/backtest/', '/robots.txt']) {
    assert.equal(applyHeaders(headers, path).get('x-robots-tag'), null, path);
  }
  assert.equal(applyHeaders(headers, '/assets/tools.json').get('cache-control'), 'public, max-age=300');
  assert.equal(applyHeaders(headers, '/news/feed.xml').get('content-type'), 'application/rss+xml; charset=utf-8');

  const llms = await readFile(join(root, 'llms.txt'), 'utf8');
  for (const needle of ['Backtest', 'Politician Tracker', 'Morning Report', '/hsi-lab/', 'https://adrnnng.com/news/', '/news/feed.xml', 'no site search']) {
    assert.ok(llms.includes(needle), needle);
  }

  const key = await readFile(join(root, 'ae5543efbf2a5168fc9df6644b06bc38.txt'));
  assert.ok(key.equals(Buffer.from('ae5543efbf2a5168fc9df6644b06bc38')) || key.equals(Buffer.from('ae5543efbf2a5168fc9df6644b06bc38\n')));
});

test('a JSON noindex rule above its detach glob is removed, and a second X-Robots-Tag joins', () => {
  const above = `
/politician-tracker/data.json
  ! X-Robots-Tag
  X-Robots-Tag: noindex, nofollow
/politician-tracker/*
  ! X-Robots-Tag
`;
  assert.equal(applyHeaders(above, '/politician-tracker/data.json').get('x-robots-tag'), null);
  assert.equal(applyHeaders(above, '/politician-tracker/index.html').get('x-robots-tag'), null);

  const below = `
/politician-tracker/*
  ! X-Robots-Tag
/politician-tracker/data.json
  ! X-Robots-Tag
  X-Robots-Tag: noindex, nofollow
`;
  assert.equal(applyHeaders(below, '/politician-tracker/data.json').get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(applyHeaders(below, '/politician-tracker/').get('x-robots-tag'), null);
  assert.equal(applyHeaders(below, '/politician-tracker/members/P000197/').get('x-robots-tag'), null);

  const joined = `
/*
  X-Robots-Tag: noindex
/static/*
  X-Robots-Tag: nosnippet
`;
  assert.equal(applyHeaders(joined, '/static/app.js').get('x-robots-tag'), 'noindex, nosnippet');

  const replaced = `
/*
  X-Robots-Tag: noindex
/static/data.json
  ! X-Robots-Tag
  X-Robots-Tag: noindex, nofollow
`;
  assert.equal(applyHeaders(replaced, '/static/data.json').get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(applyHeaders(replaced, '/static/index.html').get('x-robots-tag'), 'noindex');
});
