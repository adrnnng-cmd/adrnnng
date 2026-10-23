// Public read of one stored SuperTrend drawing from the Pages KV binding HSI_BARS.
// GET /backtest/data/hsi/v1/results/5m-10/ov/5-10-clock-0930-reenter.json.gz
// The KV key is the same path under v1/results/. The body is the stored gzip.

const SLUG = /^(1|5)m-(10|11|12|13|14)$/;
const FILE = /^(1|5)-(10|11|12|13|14)-(flip|clock|firstFlip)-(na|0915|0930)-(flat|reenter|reverse)\.json\.gz$/;

export function hsiOverlayKey(slug, file) {
  const name = Array.isArray(slug) ? slug[slug.length - 1] : String(slug ?? '');
  const leaf = Array.isArray(file) ? file[file.length - 1] : String(file ?? '');
  if (!SLUG.test(name) || !FILE.test(leaf)) return null;
  if (name.includes('..') || leaf.includes('..')) return null;
  return `v1/results/${name}/ov/${leaf}`;
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

export async function serveHsiOverlay({ method, slug, file, kv }) {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed.', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
  }
  const key = hsiOverlayKey(slug, file);
  if (!key) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!kv || typeof kv.get !== 'function') {
    return new Response('HSI bars are not configured.', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  const body = await readObject(kv, key, 300);
  if (body == null) {
    return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const headers = {
    'Content-Type': 'application/gzip',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
}

export function onRequest(context) {
  return serveHsiOverlay({
    method: context.request.method,
    slug: context.params?.slug,
    file: context.params?.file,
    kv: context.env?.HSI_BARS,
  });
}
