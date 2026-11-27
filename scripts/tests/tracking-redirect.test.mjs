import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { onRequest as serveMovers } from '../../functions/movers/data/latest.js';
import {
  TRACKING_EXACT,
  isTrackingKey,
  onRequest,
  redirectLocation,
  stripTrackingSearch,
} from '../../functions/_middleware.js';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const DAY = 'https://news-chart.com/news/20261119/';
const UTM = 'utm_source=adrrr&utm_medium=email&utm_campaign=u6668-u5831-u6458-u8981-1119-u6e2f-u80a1-u7f8e';

function excluded(pathname, rules) {
  return rules.some((rule) => {
    if (rule.endsWith('/*')) return pathname.startsWith(rule.slice(0, -1));
    return pathname === rule;
  });
}

test('utm_* and well-known click ids are tracking; functional keys are not', () => {
  for (const key of TRACKING_EXACT) assert.equal(isTrackingKey(key), true, key);
  assert.equal(isTrackingKey('utm_source'), true);
  assert.equal(isTrackingKey('UTM_Campaign'), true);
  assert.equal(isTrackingKey('utm_custom'), true);
  for (const key of ['tf', 'xtf', 'view', 'demo', 'v', 'strategy', 'symbol', 'recipe', 'clock', 'entry', 'exit', 'session', 'year', 'from', 'to', 'ref', 'p.atr', 'utm', 'my_utm_source', 'xgclid', 'gclid_extra']) {
    assert.equal(isTrackingKey(key), false, key);
  }
});

test('UTM-only day page 301s to the clean path and keeps the trailing slash', () => {
  const dirty = `${DAY}?${UTM}`;
  assert.equal(redirectLocation(dirty), DAY);
  const bare = 'https://news-chart.com/news/20261119';
  assert.equal(redirectLocation(`${bare}?utm_source=adrrr`), bare);
});

test('mixed functional and tracking query keeps the functional params', () => {
  assert.equal(
    redirectLocation('https://news-chart.com/backtest/?tf=30m&utm_source=adrrr'),
    'https://news-chart.com/backtest/?tf=30m',
  );
  assert.equal(
    redirectLocation('https://news-chart.com/backtest/?utm_source=adrrr&tf=30m&utm_medium=email&xtf=5m'),
    'https://news-chart.com/backtest/?tf=30m&xtf=5m',
  );
  const recipe = 'strategy=atr-supertrend&symbol=HSImain&tf=5m&xtf=5m&entry=clock&clock=09%3A30&exit=reenter&recipe=fast-response&session=year&year=all';
  assert.equal(
    redirectLocation(`https://news-chart.com/backtest/?${recipe}&utm_source=adrrr&utm_medium=email`),
    `https://news-chart.com/backtest/?${recipe}`,
  );
  assert.equal(
    redirectLocation('https://news-chart.com/movers/?view=hstech&utm_source=adrrr'),
    'https://news-chart.com/movers/?view=hstech',
  );
  assert.equal(
    redirectLocation('https://news-chart.com/movers/?demo=1&utm_medium=email'),
    'https://news-chart.com/movers/?demo=1',
  );
  assert.equal(
    redirectLocation('https://news-chart.com/assets/js/home.js?v=nc-2026-11-13&utm_source=adrrr'),
    'https://news-chart.com/assets/js/home.js?v=nc-2026-11-13',
  );
  assert.equal(
    redirectLocation('https://news-chart.com/backtest/?q=hello+world&utm_source=x&p.atr=10'),
    'https://news-chart.com/backtest/?q=hello+world&p.atr=10',
  );
  assert.equal(
    redirectLocation('https://news-chart.com/backtest/?utm_source=&tf=30m&tf=5m'),
    'https://news-chart.com/backtest/?tf=30m&tf=5m',
  );
  assert.equal(redirectLocation('https://news-chart.com/news/20261119/?utm_source'), DAY);
});

test('gclid and fbclid are removed; unknown keys stay', () => {
  assert.equal(
    redirectLocation('https://news-chart.com/news/20261119/?gclid=abc&fbclid=def'),
    DAY,
  );
  assert.equal(redirectLocation('https://NEWS-CHART.com/news/20261119/?GCLID=abc'), DAY);
  assert.equal(
    redirectLocation('https://news-chart.com/backtest/?tf=30m&gclid=abc&msclkid=m&ttclid=t'),
    'https://news-chart.com/backtest/?tf=30m',
  );
  assert.equal(
    redirectLocation('https://news-chart.com/news/20261119/?ref=newsletter&utm_source=adrrr'),
    'https://news-chart.com/news/20261119/?ref=newsletter',
  );
  assert.equal(redirectLocation('https://news-chart.com/news/20261119/?xgclid=1'), null);
  assert.equal(redirectLocation('https://news-chart.com/news/20261119/?utm%5Fsource=adrrr'), DAY);
  assert.equal(stripTrackingSearch('?utm%zz=1').stripped, false);
});

test('URLs with no tracking params are unchanged', () => {
  for (const url of [
    DAY,
    'https://news-chart.com/news/20261119',
    'https://news-chart.com/',
    'https://news-chart.com/backtest/?tf=30m',
    'https://news-chart.com/movers/?view=hstech&demo=1',
    'https://news-chart.com/backtest/?tf=',
  ]) {
    assert.equal(redirectLocation(url), null, url);
  }
});

test('homepage and http apex strip tracking without changing host or scheme', () => {
  assert.equal(redirectLocation(`https://news-chart.com/?${UTM}`), 'https://news-chart.com/');
  assert.equal(
    redirectLocation('http://news-chart.com/news/20261119/?utm_source=adrrr'),
    'http://news-chart.com/news/20261119/',
  );
});

test('host scope: only news-chart.com strips, and pages.dev is not sent to the apex', () => {
  const dirty = `/news/20261119/?${UTM}`;
  assert.equal(redirectLocation(`https://adrnnng.pages.dev${dirty}`), null);
  assert.equal(redirectLocation(`https://preview-123.adrnnng.pages.dev${dirty}`), null);
  assert.equal(redirectLocation(`https://foo.pages.dev${dirty}`), null);
  assert.equal(redirectLocation(`https://adrnnng.com${dirty}`), null);
  assert.equal(redirectLocation(`https://newsandchart.com${dirty}`), null);
  assert.equal(redirectLocation(`https://www.news-chart.com${dirty}`), null);
});

test('www.adrnnng.com still 301s to https://adrnnng.com with the same path and query', () => {
  assert.equal(
    redirectLocation(`https://www.adrnnng.com/news/20261119/?${UTM}`),
    `https://adrnnng.com/news/20261119/?${UTM}`,
  );
  assert.equal(
    redirectLocation('http://www.adrnnng.com/backtest/?tf=30m&utm_source=adrrr'),
    'https://adrnnng.com/backtest/?tf=30m&utm_source=adrrr',
  );
  assert.equal(redirectLocation('https://www.adrnnng.com/'), 'https://adrnnng.com/');
});

test('onRequest returns 301 and does not call next when tracking params are present', async () => {
  let called = false;
  const res = await onRequest({
    request: new Request(`${DAY}?${UTM}`),
    next() {
      called = true;
      return new Response('page', { status: 200 });
    },
  });
  assert.equal(called, false);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), DAY);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(await res.text(), '');
});

test('onRequest passes a clean URL through unchanged, including response headers', async () => {
  const sentinel = new Response('page', { status: 200, headers: { 'X-Robots-Tag': 'all', 'Cache-Control': 'public, max-age=0, must-revalidate' } });
  const res = await onRequest({
    request: new Request(DAY),
    next: () => sentinel,
  });
  assert.equal(res, sentinel);
  assert.equal(res.headers.get('x-robots-tag'), 'all');
});

test('preview and migration hosts pass through even with tracking params', async () => {
  const sentinel = new Response('preview', { status: 200 });
  for (const url of [
    `https://adrnnng.pages.dev/news/20261119/?${UTM}`,
    `https://adrnnng.com/news/20261119/?utm_source=adrrr`,
    `https://www.news-chart.com/news/20261119/?utm_source=adrrr`,
  ]) {
    const res = await onRequest({ request: new Request(url), next: () => sentinel });
    assert.equal(res, sentinel, url);
  }
});

test('a clean movers snapshot still reaches the function; a tracking param 301s first', async () => {
  const doc = JSON.stringify({ schema_version: 1, hsi: { index: {} }, hk_market: { ok: true } });
  const env = { HK_MOVERS: { get: async (key) => (key === 'hk-movers:latest.json' ? doc : null) } };
  const clean = new Request('https://news-chart.com/movers/data/latest');
  const passed = await onRequest({
    request: clean,
    env,
    next: () => serveMovers({ request: clean, env }),
  });
  assert.equal(passed.status, 200);
  assert.equal(passed.headers.get('x-robots-tag'), 'noindex, nofollow');

  let called = false;
  const redirected = await onRequest({
    request: new Request('https://news-chart.com/movers/data/latest?utm_source=adrrr'),
    env,
    next() {
      called = true;
      return new Response('should not run');
    },
  });
  assert.equal(called, false);
  assert.equal(redirected.status, 301);
  assert.equal(redirected.headers.get('location'), 'https://news-chart.com/movers/data/latest');
});

test('function routes cover the site and leave _redirects paths alone', () => {
  const routes = JSON.parse(read('_routes.json'));
  assert.equal(routes.version, 1);
  assert.deepEqual(routes.include, ['/*']);
  const rules = read('_redirects').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const pathSources = rules.map((line) => line.split(/\s+/)[0]).filter((source) => source.startsWith('/'));
  for (const source of pathSources) {
    const sample = source.endsWith('/*') ? `${source.slice(0, -1)}extra` : source;
    assert.equal(excluded(sample, routes.exclude), true, source);
  }
  for (const path of ['/latest', '/latest/', '/backtesting', '/backtesting/', '/hsi-lab', '/hsi-lab/', '/hk-movers', '/hk-movers/', '/hk-movers/data/sample.json']) {
    assert.equal(excluded(path, routes.exclude), true, path);
  }
  for (const path of ['/news/20261127/', '/', '/backtest/', '/movers/', '/movers/data/latest', '/hk-movers/data/latest', '/backtest/data/hsi/v1/1m/manifest.json']) {
    assert.equal(excluded(path, routes.exclude), false, path);
  }
  assert.equal(rules.some((line) => line.includes('news-chart.com')), false);
});
