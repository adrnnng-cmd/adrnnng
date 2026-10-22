// Lookup-only lab. One KV read returns the gzip daily bundle for an entry
// ATR. The date window is sliced here. Parsed bundles stay in isolate memory.

import { ArchiveError } from '../engine/archive.js';
import { decodeBundle, scoreStored } from '../engine/results.js';
import { ARCHIVE_CACHE_MS, ArchiveUnconfigured } from './load-bars.js';
import { openArchive } from './store.js';

export class ResultMissing extends Error {
  constructor() {
    super('That result is not in the archive.');
    this.name = 'ResultMissing';
    this.status = 404;
  }
}

const parsed = new Map();
const MAX_CACHED = 8;

export function resetLookupCache() {
  parsed.clear();
}

function fresh(at, now) {
  return now - at < ARCHIVE_CACHE_MS;
}

async function bundleFor(binding, key, now) {
  const hit = parsed.get(key);
  if (hit && fresh(hit.at, now)) return hit.bundle;
  const store = openArchive(binding);
  if (!store) throw new ArchiveUnconfigured();
  const bytes = await store.getBytes(key);
  if (!bytes) throw new ResultMissing();
  let bundle;
  try {
    bundle = await decodeBundle(bytes);
  } catch (err) {
    if (err instanceof ArchiveError || err?.name === 'ArchiveError') throw err;
    throw new ArchiveError();
  }
  if (parsed.size >= MAX_CACHED) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [cachedKey, hit] of parsed) {
      if (hit.at < oldestAt) {
        oldestAt = hit.at;
        oldestKey = cachedKey;
      }
    }
    if (oldestKey) parsed.delete(oldestKey);
  }
  parsed.set(key, { bundle, at: now });
  return bundle;
}

export async function lookupResult(binding, spec, now = Date.now()) {
  if (!openArchive(binding)) throw new ArchiveUnconfigured();
  const bundle = await bundleFor(binding, spec.key, now);
  const scored = scoreStored(bundle, spec);
  if (!scored) throw new ResultMissing();
  return scored;
}
