import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deskAssumptions } from '../composition/assumptions.js';
import { compositionSlots } from '../composition/slots.js';
import { getStrategy } from '../strategies/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('assumptions name the cost and the session rules for each book', () => {
  const equity = deskAssumptions({ mode: 'equity', commission: 5, slippage: 5 });
  assert.equal(equity.line, 'Historical fills only. Signal on the close, fill at the next open. Not a live order.');
  assert.equal(equity.cost, 'Commission 5 bps and slippage 5 bps each side. 0 is off.');
  assert.equal(equity.session, 'Not in force on this run.');
  assert.equal(equity.data, 'Daily OHLCV, split-adjusted. Weekly and monthly bars are built from the daily bars.');
  assert.doesNotMatch(equity.session, /Clock|they mean|09:15/);

  const daily = deskAssumptions({ mode: 'hsi-daily' });
  assert.equal(daily.cost, 'Index points for one unit. Basis-point commission is not applied. Point cost is off.');
  assert.equal(daily.session, 'Not in force on this run.');
  assert.equal(daily.data, 'HSI futures daily bars. Weekly and monthly bars are built from the daily bars.');
  assert.doesNotMatch(daily.session, /Clock|they mean/);

  const matrix = deskAssumptions({ mode: 'matrix', costPoints: 6, confirm: 'none', flattenEod: true });
  assert.equal(matrix.cost, 'Round-trip cost is 6 index points, once per closed trade. Default is 8 on a 1-minute exit and 6 on a 5-minute, 30-minute, or 1-hour exit. 0 is price only.');
  assert.match(matrix.session, /09:15–12:00 and 13:00–16:30/);
  assert.match(matrix.session, /Clock fills at the clock open/);
  assert.match(matrix.session, /Any flip fills at the next open/);
  assert.match(matrix.session, /First flip after the clock/);
  assert.match(matrix.session, /flat stays out for the day/);
  assert.match(matrix.session, /re-enter takes the original side/);
  assert.match(matrix.session, /reverse takes the new side/);
  assert.match(matrix.session, /Flatten exits at that bar’s close/);
  assert.doesNotMatch(matrix.session, /they mean|Not in force/);
  assert.equal(matrix.data, 'Stored ATR SuperTrend matrix, factor 2.5, EMA smoothing 2. This page does not replay the minute tape.');
  const coarse = deskAssumptions({ mode: 'matrix', costPoints: 6, entryTimeframe: '30m', exitTimeframe: '30m' });
  assert.equal(coarse.data, matrix.data);
  assert.equal(deskAssumptions({ mode: 'matrix', costPoints: 6, entryTimeframe: '5m', exitTimeframe: '1h' }).data, matrix.data);
  assert.doesNotMatch(coarse.data, /not in the stored matrix/);
  assert.match(coarse.data, /does not replay the minute tape/);

  const blocked = deskAssumptions({ mode: 'matrix', costPoints: 0, confirm: 'daily', flattenEod: false });
  assert.match(blocked.data, /Daily agrees and flatten off are not stored/);
  assert.match(blocked.cost, /0 is price only/);
  assert.equal(deskAssumptions({ mode: 'equity', commission: 2, slippage: 1 }).cost, 'Commission 2 bps and slippage 1 bps each side. 0 is off.');
});

test('the page shows assumptions, session rules, and a readable chart scale', () => {
  const html = readFileSync(join(root, 'backtest/index.html'), 'utf8');
  assert.match(html, /id="assumptions"/);
  assert.match(html, /id="assumptions-cost"/);
  assert.match(html, /id="assumptions-session">Not in force on this run\.</);
  assert.match(html, /id="assumptions-cost">Commission 5 bps and slippage 5 bps each side\. 0 is off\.</);
  assert.match(html, /Clock state fills at the clock bar’s open/);
  assert.match(html, /8 on a 1-minute exit and 6 on a 5-minute, 30-minute, or 1-hour exit/);
  assert.doesNotMatch(html, /\b15m\b/);
  const strip = html.slice(html.indexOf('id="assumptions"'), html.indexOf('id="method"'));
  assert.doesNotMatch(strip, /they mean/);
  assert.doesNotMatch(strip, /Clock state fills/);
  assert.ok(html.indexOf('id="notices"') < html.indexOf('id="assumptions"'));
  assert.ok(html.indexOf('id="assumptions"') < html.indexOf('id="method"'));
  assert.doesNotMatch(html, /BTST/);
  assert.doesNotMatch(html, /plug in here later/);
  assert.doesNotMatch(html, /load in the browser/);
  const newsletter = html.slice(html.indexOf('id="newsletter"'));
  assert.match(newsletter, /每朝 9 點前/);

  const app = readFileSync(join(root, 'backtest/app.js'), 'utf8');
  assert.match(app, /paintAssumptions\(/);
  assert.match(app, /function emptyState/);
  assert.match(app, /No curve\. This combination is not in the stored result\./);

  const charts = readFileSync(join(root, 'backtest/charts.js'), 'utf8');
  assert.match(charts, /fontSize: 12/);

  const hint = compositionSlots(getStrategy('atr-supertrend'), {
    symbol: 'HSImain',
    timeframe: '5m',
    exitTimeframe: '5m',
    entryRule: 'clock',
  }).hint;
  assert.match(hint, /Clock fills at the clock open/);
  assert.match(hint, /once per closed trade/);
  assert.match(hint, /1m, 5m, 30m, and 1h/);
  assert.doesNotMatch(hint, /not stored/);
  const coarseHint = compositionSlots(getStrategy('atr-supertrend'), {
    symbol: 'HSImain',
    timeframe: '30m',
    exitTimeframe: '1h',
    entryRule: 'clock',
  }).hint;
  assert.equal(coarseHint, hint);
});
