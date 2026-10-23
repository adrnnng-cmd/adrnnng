// Public read of one HSI futures object from the Pages KV binding HSI_BARS.
// Routes:
//   GET /backtest/data/hsi/v1/1m/manifest.json
//   GET /backtest/data/hsi/v1/1m/YYYY.bin
// Keys in KV match those paths under v1/1m/. The year packs stay out of git.

const MANIFEST = 'manifest.json';
const YEAR_PACK = /^\d{4}\.bin$/;

export function hsiPublicKey(file) {
  const name = Array.isArray(file) ? file[file.length - 1] : String(file ?? '');
  if (name !== MANIFEST && !YEAR_PACK.test(name)) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return `v1/1m/${name}`;
}

function cacheControl(key) {
  return key.endsWith('.json') ? 'public, max-age=300' : 'public, max-age=86400';
}

function contentType(key) {
  return key.endsWith('.json') ? 'application/json' : 'application/octet-stream';
}

async function readObject(kv, key, cacheTtl) {
  const attempts = [
    () => kv.get(key, { type: 'stream', cacheTtl }),
    () => kv.get(key, { type: 'arrayBuffer', cacheTtl }),
    () => kv.get(key, { type: 'stream' }),
    () => kv.get(key, { type: 'arrayBuffer' }),
  ];
  let error;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      error = err;
    }
  }
  throw error;
}

export async function serveHsiBars({ method, file, kv }) {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed.', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
  }
  const key = hsiPublicKey(file);
  if (!key) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!kv || typeof kv.get !== 'function') {
    return new Response('HSI bars are not configured.', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  const cacheTtl = key.endsWith('.json') ? 300 : 86400;
  const body = await readObject(kv, key, cacheTtl);
  if (body == null) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const headers = {
    'Content-Type': contentType(key),
    'Cache-Control': cacheControl(key),
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
}

export function onRequest(context) {
  return serveHsiBars({
    method: context.request.method,
    file: context.params?.file,
    kv: context.env?.HSI_BARS,
  });
}
