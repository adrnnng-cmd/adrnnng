import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'index.html',
  'llms.txt',
  'backtest/index.html',
  'backtest/app.js',
  'backtest/providers/static-csv.js',
  'backtest/providers/hsi-futures.js',
  'backtest/providers/index.js',
  'assets/js/home.js',
  'assets/js/site.js',
  'backtest/data/prices/manifest.json',
];

test('public pages and the price manifest do not name a data vendor', () => {
  const hit = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    if (/\byahoo\b|\bfutu\b/i.test(text)) hit.push(file);
  }
  assert.deepEqual(hit, []);
});
