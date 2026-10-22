// Archive binding. Workers KV is the default. An R2 bucket still works:
// KV  → get(key, 'arrayBuffer') and list().keys[].name
// R2  → get(key).arrayBuffer() and list().objects[].key
// Keys are v1/1m/YYYY.bin either way. This module does not cache.

const KEY_RE = /^v1\/1m\/(\d{4})\.bin$/;

export function openArchive(binding) {
  if (!binding || typeof binding.get !== 'function' || typeof binding.list !== 'function') return null;
  const kind = typeof binding.head === 'function' ? 'r2' : 'kv';
  return {
    kind,
    listYears: () => listYears(binding),
    getBytes: (key) => getBytes(binding, kind, key),
  };
}

function toUint8(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

async function getBytes(binding, kind, key) {
  if (kind === 'r2') {
    const obj = await binding.get(key);
    if (!obj || typeof obj.arrayBuffer !== 'function') return null;
    return toUint8(await obj.arrayBuffer());
  }
  const value = await binding.get(key, 'arrayBuffer');
  if (value == null) return null;
  // A stand-in that still returns an R2 body (get ignores the type) keeps working.
  if (typeof value.arrayBuffer === 'function') return toUint8(await value.arrayBuffer());
  return toUint8(value);
}

async function listYears(binding) {
  const years = [];
  let cursor;
  for (;;) {
    const page = await binding.list({ prefix: 'v1/1m/', cursor, limit: 1000 });
    const rows = page.objects || page.keys || [];
    for (const row of rows) {
      const key = row.key || row.name;
      const match = KEY_RE.exec(key || '');
      if (match) years.push(Number(match[1]));
    }
    const more = page.truncated === true || page.list_complete === false;
    if (!more) break;
    cursor = page.cursor;
    if (!cursor) break;
  }
  years.sort((a, b) => a - b);
  return years;
}
