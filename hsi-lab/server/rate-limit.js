// Per-isolate sliding window. Cloudflare may run many isolates, so this is a
// basic brake on one instance, not a global quota.

export function createLimiter({ limit = 30, windowMs = 60_000, maxKeys = 2000 } = {}) {
  const hits = new Map();
  return {
    check(key, now = Date.now()) {
      const id = key || 'unknown';
      const prev = (hits.get(id) || []).filter((t) => now - t < windowMs);
      if (prev.length >= limit) {
        hits.set(id, prev);
        const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - prev[0])) / 1000));
        return { ok: false, retryAfterSec };
      }
      prev.push(now);
      hits.set(id, prev);
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return { ok: true, retryAfterSec: 0 };
    },
  };
}

export const limiter = createLimiter();

export function clientKey(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}
