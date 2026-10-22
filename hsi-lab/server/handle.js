// POST /api/hsi-lab looks up one precomputed score. GET describes the grid.
// There is no bars route. The JSON body is a grid cell; the tape never leaves KV.

import { ArchiveError } from '../engine/archive.js';
import { LOOKUP_DEFAULTS, publicGrid, validateLookup } from '../engine/grid.js';
import { STRATEGIES } from '../engine/registry.js';
import { ValidationError } from '../engine/validate.js';
import { ArchiveUnconfigured } from './load-bars.js';
import { ResultMissing, lookupResult } from './lookup.js';
import { clientKey, limiter as sharedLimiter } from './rate-limit.js';

const MAX_BODY = 4096;

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'cache-control': 'no-store', ...extra },
  });
}

export function originAllowed(origin) {
  if (!origin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (url.protocol === 'https:' && (host === 'adrnnng.com' || host === 'www.adrnnng.com')) return true;
  if (url.protocol === 'https:' && (host === 'adrnnng.pages.dev' || host.endsWith('.adrnnng.pages.dev'))) return true;
  if (url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) return true;
  return false;
}

function registryBody(now) {
  return {
    strategies: STRATEGIES.map((s) => ({ id: s.id, name: s.name, summary: s.summary })),
    defaults: LOOKUP_DEFAULTS,
    grid: publicGrid(now),
  };
}

export async function handle(request, env, options = {}) {
  const clock = options.clock instanceof Date ? options.clock : new Date();
  if (request.method === 'GET') return json(200, registryBody(clock));
  if (request.method !== 'POST') return json(405, { error: 'Use POST.' }, { allow: 'GET, POST' });
  if (!originAllowed(request.headers.get('origin'))) return json(403, { error: 'This origin is not allowed.' });

  const limiter = options.limiter || sharedLimiter;
  const gate = limiter.check(clientKey(request), options.now);
  if (!gate.ok) {
    return json(429, { error: 'Too many runs. Try again in a minute.' }, { 'retry-after': String(gate.retryAfterSec) });
  }

  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) return json(415, { error: 'Send JSON.' });

  let text;
  try {
    text = await request.text();
  } catch {
    return json(400, { error: 'Could not read the request.' });
  }
  if (text.length > MAX_BODY) return json(413, { error: 'Request is too large.' });

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'Body is not JSON.' });
  }

  try {
    const spec = validateLookup(body, clock);
    const result = await lookupResult(env?.HSI_BARS, spec, options.now);
    return json(200, result);
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ArchiveError || err instanceof ArchiveUnconfigured || err instanceof ResultMissing || err instanceof HttpError) {
      return json(err.status, { error: err.message });
    }
    console.error('hsi-lab', err?.name || 'Error');
    return json(500, { error: 'The run failed.' });
  }
}
