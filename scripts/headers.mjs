// Cloudflare Pages _headers. Matching rules apply in file order. A repeated
// header name is joined with a comma. `! Header-Name` deletes what earlier
// rules attached; it does not remove a value a later rule sets. A joined
// X-Robots-Tag that still contains noindex blocks indexing, so public HTML
// detaches the header instead of setting "index, follow" beside a site-wide
// noindex. Browser JSON sets noindex only after those detaches.

export const PUBLIC_DETACH = [
  '/',
  '/index.html',
  '/backtest',
  '/backtest/',
  '/backtest/*',
  '/politician-tracker',
  '/politician-tracker/',
  '/politician-tracker/*',
  '/hsi-lab',
  '/hsi-lab/',
  '/hsi-lab/*',
  '/news',
  '/news/',
  '/news/*',
  '/robots.txt',
  '/llms.txt',
  '/sitemap.xml',
  '/sitemap-pages.xml',
  '/sitemap-news.xml',
  '/news-sitemap.xml',
];

// Fetched by the page. noindex must not cover the HTML next to these files.
export const JSON_NOINDEX = [
  '/politician-tracker/data.json',
  '/news/latest.json',
  '/assets/tools.json',
];

const INDEXABLE_SAMPLES = [
  '/',
  '/index.html',
  '/backtest/',
  '/backtest/index.html',
  '/politician-tracker/',
  '/politician-tracker/index.html',
  '/politician-tracker/members/P000197/',
  '/hsi-lab/',
  '/news/',
  '/news/index.html',
  '/news/20261022/',
  '/news/feed.xml',
  '/robots.txt',
  '/llms.txt',
  '/sitemap.xml',
  '/sitemap-pages.xml',
  '/sitemap-news.xml',
  '/news-sitemap.xml',
];

const ESCAPE_REGEX = /[-/\\^$*+?.()|[\]{}]/g;

export function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) {
      cur = { path: line.trim(), headers: [] };
      rules.push(cur);
      continue;
    }
    if (!cur) continue;
    const detach = /^\s+!\s+(\S+)\s*$/.exec(line);
    if (detach) {
      cur.headers.push({ detach: true, name: detach[1], value: '' });
      continue;
    }
    const set = /^\s+([^:]+):\s*(.*?)\s*$/.exec(line);
    if (set) cur.headers.push({ detach: false, name: set[1].trim(), value: set[2] });
  }
  return rules;
}

function ruleMatches(pattern, pathname) {
  const source = `^${pattern.split('*').map((part) => part.replace(ESCAPE_REGEX, '\\$&')).join('(?<splat>.*)')}$`;
  return new RegExp(source).test(pathname);
}

// Same order as Pages' attachHeaders: each match unsets, then sets.
// A name that was set by an earlier rule is appended, which joins with ", ".
// Append after a delete stores only the new value.
export function applyHeaders(text, pathname) {
  const headers = new Headers();
  const setMap = new Set();
  for (const rule of parseHeaders(text)) {
    if (!ruleMatches(rule.path, pathname)) continue;
    for (const header of rule.headers) {
      if (header.detach) headers.delete(header.name);
    }
    for (const header of rule.headers) {
      if (header.detach) continue;
      const key = header.name.toLowerCase();
      if (setMap.has(key)) headers.append(header.name, header.value);
      else {
        headers.set(header.name, header.value);
        setMap.add(key);
      }
    }
  }
  return headers;
}

function isAllowedNoindex(path) {
  return path === '/api' || path === '/api/' || path === '/api/*' || JSON_NOINDEX.includes(path);
}

function robotsTag(text, pathname) {
  return applyHeaders(text, pathname).get('x-robots-tag');
}

function checkResolved(text, errors, label) {
  const samples = INDEXABLE_SAMPLES;
  for (const path of samples) {
    const value = robotsTag(text, path);
    if (value) errors.push(`_headers: ${path} resolves X-Robots-Tag to ${value}${label}`);
  }
  for (const path of JSON_NOINDEX) {
    const value = robotsTag(text, path);
    if (value !== 'noindex, nofollow') {
      errors.push(`_headers: ${path} resolves X-Robots-Tag to ${value || '(absent)'}${label}, want noindex, nofollow`);
    }
  }
  for (const path of ['/api/health']) {
    const value = robotsTag(text, path);
    if (!value || !/noindex/i.test(value)) errors.push(`_headers: ${path} resolves without noindex${label}`);
  }
  const feed = applyHeaders(text, '/news/feed.xml').get('content-type');
  if (feed !== 'application/rss+xml; charset=utf-8') {
    errors.push(`_headers: /news/feed.xml content-type is ${feed || '(absent)'}${label}`);
  }
  const cache = applyHeaders(text, '/assets/tools.json').get('cache-control');
  if (cache !== 'public, max-age=300') {
    errors.push(`_headers: /assets/tools.json cache-control is ${cache || '(absent)'}${label}`);
  }
}

export function indexingHeaderErrors(text, { keyFile } = {}) {
  const rules = parseHeaders(text);
  const errors = [];
  const detached = new Set(
    rules.filter((r) => r.headers.some((h) => h.detach && h.name.toLowerCase() === 'x-robots-tag')).map((r) => r.path),
  );
  for (const path of PUBLIC_DETACH) {
    if (!detached.has(path)) errors.push(`_headers: ${path} must detach X-Robots-Tag so a /* noindex rule cannot stick`);
  }
  if (keyFile && !detached.has(`/${keyFile}`)) {
    errors.push(`_headers: /${keyFile} must detach X-Robots-Tag`);
  }
  for (const rule of rules) {
    for (const header of rule.headers) {
      if (header.detach || header.name.toLowerCase() !== 'x-robots-tag') continue;
      if (/noindex/i.test(header.value) && !isAllowedNoindex(rule.path)) {
        errors.push(`_headers: ${rule.path} sets X-Robots-Tag noindex`);
      }
    }
  }
  for (const path of ['/api', '/api/', '/api/*', ...JSON_NOINDEX]) {
    const rule = rules.find((r) => r.path === path);
    const setsNoindex = rule?.headers.some((h) => !h.detach && h.name.toLowerCase() === 'x-robots-tag' && /noindex/i.test(h.value));
    if (!setsNoindex) errors.push(`_headers: ${path} must set X-Robots-Tag: noindex, nofollow`);
  }
  checkResolved(text, errors, '');
  if (keyFile) {
    const keyPath = `/${keyFile}`;
    const value = robotsTag(text, keyPath);
    if (value) errors.push(`_headers: ${keyPath} resolves X-Robots-Tag to ${value}`);
  }
  // publish.sh used to prepend `/*` + noindex. Detach must still clear HTML,
  // and the JSON rules must still end as a single noindex value.
  const prepended = `/*\n  X-Robots-Tag: noindex, nofollow\n${text}`;
  checkResolved(prepended, errors, ' when /* noindex is prepended');
  if (keyFile) {
    const value = robotsTag(prepended, `/${keyFile}`);
    if (value) errors.push(`_headers: /${keyFile} resolves X-Robots-Tag to ${value} when /* noindex is prepended`);
  }
  return errors;
}
