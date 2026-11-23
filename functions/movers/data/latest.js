// Public read of the HK Movers snapshot.
//   GET /movers/data/latest      (canonical)
//   GET /hk-movers/data/latest   (old path, same document; see functions/hk-movers/data/latest.js)
//
// The collector writes one JSON document to the KV key below. The dedicated
// HK_MOVERS binding wins when it exists; until it does, the existing HSI_BARS
// binding serves the same key, so no extra Pages setting is needed.
// With no usable KV value the response is the static demo document, with
// X-HK-Movers-Source: demo and data_source "demo" in the body.

export const KV_KEY = 'hk-movers:latest.json';
export const SAMPLE_PATH = '/movers/data/sample.json';

const LIVE_CACHE = 'public, max-age=30, s-maxage=30';
const JSON_TYPE = 'application/json; charset=utf-8';

export function pickBinding(env) {
  if (env?.HK_MOVERS && typeof env.HK_MOVERS.get === 'function') return { kv: env.HK_MOVERS, name: 'HK_MOVERS' };
  if (env?.HSI_BARS && typeof env.HSI_BARS.get === 'function') return { kv: env.HSI_BARS, name: 'HSI_BARS' };
  return null;
}

function reply(method, body, { status = 200, cache = 'no-store', source, reason } = {}) {
  const headers = {
    'Content-Type': JSON_TYPE,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (source) headers['X-HK-Movers-Source'] = source;
  if (reason) headers['X-HK-Movers-Reason'] = reason;
  return new Response(method === 'HEAD' ? null : body, { status, headers });
}

function looksLikeSnapshot(text) {
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === 'object' && doc.schema_version === 1 && doc.hsi && doc.hk_market;
  } catch {
    return false;
  }
}

async function demo(method, assets, requestUrl, reason) {
  if (assets && typeof assets.fetch === 'function') {
    try {
      const res = await assets.fetch(new URL(SAMPLE_PATH, requestUrl));
      if (res.ok) return reply(method, await res.text(), { source: 'demo', reason });
    } catch {
      /* fall through to 404 */
    }
  }
  return reply(method, JSON.stringify({ error: 'no_data', reason }), { status: 404, reason });
}

export async function serveLatest({ method, env, requestUrl }) {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  }
  const binding = pickBinding(env);
  if (!binding) return demo(method, env?.ASSETS, requestUrl, 'no-binding');
  let text = null;
  try {
    text = await binding.kv.get(KV_KEY, { type: 'text', cacheTtl: 30 });
  } catch {
    return demo(method, env?.ASSETS, requestUrl, 'kv-error');
  }
  if (text == null) return demo(method, env?.ASSETS, requestUrl, 'kv-empty');
  if (!looksLikeSnapshot(text)) return demo(method, env?.ASSETS, requestUrl, 'kv-invalid');
  return reply(method, text, { cache: LIVE_CACHE, source: `kv:${binding.name}` });
}

export function onRequest(context) {
  return serveLatest({ method: context.request.method, env: context.env, requestUrl: context.request.url });
}
