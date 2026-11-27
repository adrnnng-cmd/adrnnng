// Site-wide canonical redirect for news-chart.com.
//
// Newsletter links (Buttondown) append utm_* query parameters. Google indexed
// those URLs as the canonical and left the clean path as a duplicate. When the
// request host is exactly news-chart.com and the query contains a tracking
// parameter, respond 301 to the same path with only those parameters removed.
// Functional keys (tf, view, demo, strategy, …) stay, in their original order
// and encoding. Other hosts are unchanged: www and the adrnnng.com migration
// are zone redirects in front of Pages, and *.pages.dev must not be sent to
// the apex.
//
// Pages does not apply _redirects on a path a Function handles. _routes.json
// therefore excludes /latest (merged at upload), /backtesting, /hsi-lab, and
// the /hk-movers page aliases so those rules still run. This file mirrors the
// www.adrnnng.com → https://adrnnng.com rules for every other path, because
// those rules are host-wide and cannot be excluded by path. It does not send
// any host to news-chart.com.

const APEX_HOST = 'news-chart.com';

// Exact ad and email click ids. utm_* is matched by prefix, not listed here.
// Unknown keys are kept: backtest and movers read tf, view, demo, strategy, and
// other functional parameters from the query string.
export const TRACKING_EXACT = new Set([
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'gad_source',
  'gad_campaignid',
  'srsltid',
  'fbclid',
  'fb_action_ids',
  'fb_action_types',
  'fb_source',
  'fb_ref',
  'msclkid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'yclid',
  'epik',
  'sccid',
  'irclickid',
  'rdt_cid',
]);

function decodeKey(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

export function isTrackingKey(key) {
  const name = String(key).toLowerCase();
  return name.startsWith('utm_') || TRACKING_EXACT.has(name);
}

// Returns the query to keep. `stripped` is true only when a tracking parameter
// was removed. Kept parameters are copied raw so encoding and order survive.
export function stripTrackingSearch(search) {
  const body = search.startsWith('?') ? search.slice(1) : search;
  if (!body) return { search: '', stripped: false };
  const kept = [];
  let stripped = false;
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeKey(eq === -1 ? part : part.slice(0, eq));
    if (isTrackingKey(key)) stripped = true;
    else kept.push(part);
  }
  if (!stripped) return { search: search.startsWith('?') ? `?${body}` : body, stripped: false };
  return { search: kept.length ? `?${kept.join('&')}` : '', stripped: true };
}

export function redirectLocation(input) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }
  // Same destination as the www.adrnnng.com lines in _redirects. Query included,
  // because a splat rule with no destination query keeps the incoming query.
  if (url.hostname === 'www.adrnnng.com') {
    return `https://adrnnng.com${url.pathname}${url.search}`;
  }
  if (url.hostname !== APEX_HOST) return null;
  const { search, stripped } = stripTrackingSearch(url.search);
  if (!stripped) return null;
  return `${url.origin}${url.pathname}${search}`;
}

export async function onRequest(context) {
  const location = redirectLocation(context.request.url);
  if (!location) return context.next();
  return new Response(null, {
    status: 301,
    headers: {
      Location: location,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
