// Cloudflare Pages _headers. Matching rules inherit headers, and a repeated
// header name is joined with a comma. `! Header-Name` detaches one inherited
// from a broader rule. A joined X-Robots-Tag that still contains noindex
// blocks indexing, so public paths detach the header instead of setting
// "index, follow" beside a site-wide noindex.

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

function isApiPath(path) {
  return path === '/api' || path === '/api/' || path === '/api/*';
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
      if (/noindex/i.test(header.value) && !isApiPath(rule.path)) {
        errors.push(`_headers: ${rule.path} sets X-Robots-Tag noindex`);
      }
    }
  }
  for (const path of ['/api', '/api/', '/api/*']) {
    const rule = rules.find((r) => r.path === path);
    const setsNoindex = rule?.headers.some((h) => !h.detach && h.name.toLowerCase() === 'x-robots-tag' && /noindex/i.test(h.value));
    if (!setsNoindex) errors.push(`_headers: ${path} must set X-Robots-Tag: noindex, nofollow`);
  }
  return errors;
}
