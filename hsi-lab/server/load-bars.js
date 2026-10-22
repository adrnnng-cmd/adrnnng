// Read private year objects from the HSI_BARS binding. Returns bar records
// for the engine. Nothing in here is sent to the client.

import { decodeYear, objectKey } from '../engine/archive.js';
import { ValidationError } from '../engine/validate.js';

export class ArchiveEmpty extends Error {
  constructor() {
    super('Bar archive is empty.');
    this.name = 'ArchiveEmpty';
    this.status = 503;
  }
}

const KEY_RE = /^v1\/1m\/(\d{4})\.bin$/;

export async function listYears(bucket) {
  const years = [];
  let cursor;
  for (;;) {
    const page = await bucket.list({ prefix: 'v1/1m/', cursor, limit: 1000 });
    for (const obj of page.objects || []) {
      const match = KEY_RE.exec(obj.key);
      if (match) years.push(Number(match[1]));
    }
    if (!page.truncated) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  years.sort((a, b) => a - b);
  return years;
}

export async function loadBars(bucket, spec) {
  const years = await listYears(bucket);
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
    const obj = await bucket.get(objectKey(year));
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    bars.push(...decodeYear(bytes));
  }
  return bars;
}
