// Read private year objects from the HSI_BARS binding. Returns bar records
// for the engine. Nothing in here is sent to the client.
//
// Decoded years stay in isolate memory so a repeat run does not read KV again.
// The free plan allows 100,000 reads a day. A replaced object is picked up
// after ARCHIVE_CACHE_MS, or sooner when the isolate recycles.

import { decodeYear, objectKey } from '../engine/archive.js';
import { ValidationError } from '../engine/validate.js';
import { openArchive } from './store.js';

export class ArchiveUnconfigured extends Error {
  constructor() {
    super('Bar archive is not configured.');
    this.name = 'ArchiveUnconfigured';
    this.status = 503;
  }
}

export class ArchiveEmpty extends Error {
  constructor() {
    super('Bar archive is empty.');
    this.name = 'ArchiveEmpty';
    this.status = 503;
  }
}

export const ARCHIVE_CACHE_MS = 10 * 60 * 1000;

const decoded = new Map();
let index = null;
let indexAt = 0;

export function resetArchiveCache() {
  decoded.clear();
  index = null;
  indexAt = 0;
}

function fresh(at, now) {
  return now - at < ARCHIVE_CACHE_MS;
}

async function availableYears(store, now) {
  if (index && fresh(indexAt, now)) return index;
  index = await store.listYears();
  indexAt = now;
  return index;
}

async function yearBars(store, year, now) {
  const key = objectKey(year);
  const hit = decoded.get(key);
  if (hit && fresh(hit.at, now)) return hit.bars;
  const bytes = await store.getBytes(key);
  if (!bytes) {
    decoded.set(key, { bars: null, at: now });
    return null;
  }
  const bars = decodeYear(bytes);
  decoded.set(key, { bars, at: now });
  return bars;
}

export async function loadBars(binding, spec, now = Date.now()) {
  const store = openArchive(binding);
  if (!store) throw new ArchiveUnconfigured();
  const years = await availableYears(store, now);
  if (!years.length) throw new ArchiveEmpty();
  let fromY = years[0];
  let toY = years[years.length - 1];
  if (spec.from) {
    fromY = Number(spec.from.slice(0, 4)) - 1;
    toY = Number(spec.to.slice(0, 4));
  }
  if (toY - fromY > 15) throw new ValidationError('Date range is limited to 10 years.');
  const available = new Set(years);
  const bars = [];
  for (let year = fromY; year <= toY; year++) {
    if (!available.has(year)) continue;
    const chunk = await yearBars(store, year, now);
    // A spread of ~237k bars throws RangeError. Append one bar at a time.
    if (chunk) {
      for (let i = 0; i < chunk.length; i++) bars.push(chunk[i]);
    }
  }
  return bars;
}
