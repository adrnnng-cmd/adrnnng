// Bring-your-own data: a CSV the user picks locally. Nothing is uploaded anywhere; the file is
// read in the browser. Needs date, open, high, low, close columns (volume/dividend optional).

import { parseCsv } from '../engine/bars.js';

export default {
  id: 'csv',
  name: 'Your CSV file',
  kind: 'file',
  description: 'Read a local CSV (date, open, high, low, close[, volume, dividend]) in the browser. Nothing leaves your device.',

  async load(file) {
    const text = await file.text();
    const bars = parseCsv(text);
    if (bars.length < 30) throw new Error(`${file.name}: need at least 30 rows, found ${bars.length}`);
    const symbol = file.name.replace(/\.[^.]+$/, '').toUpperCase().slice(0, 24) || 'CSV';
    return {
      symbol,
      name: file.name,
      currency: '',
      exchange: '',
      bars,
      hasDividends: bars.some((b) => b.dividend > 0),
      source: { name: `Your file: ${file.name}`, note: 'User-supplied data, read locally. Not verified by this site.', asOf: bars[bars.length - 1].time },
      sample: false,
      userSupplied: true,
    };
  },
};
