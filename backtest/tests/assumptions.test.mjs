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
  assert.match(equity.line, /Not a live order/);
  assert.match(equity.cost, /Commission 5 bps and slippage 5 bps on each side/);
  assert.match(equity.session, /Not in force/);
  assert.match(equity.session, /Clock state fills at the clock bar’s open/);
  assert.match(equity.session, /Any flip fills at the next bar’s open/);
  assert.match(equity.session, /First flip after the clock/);
  assert.match(equity.session, /flat exits on the opposite flip/);
  assert.match(equity.session, /re-enter takes a later flip/);
  assert.match(equity.session, /reverse takes the new side/);
  assert.match(equity.session, /Flatten exits at that bar’s close/);

  const daily = deskAssumptions({ mode: 'hsi-daily' });
  assert.match(daily.cost, /index points for one unit/);
  assert.match(daily.cost, /Point cost is off/);
  assert.match(daily.data, /minute tape is not loaded/);
  assert.match(daily.session, /Not in force/);

  const matrix = deskAssumptions({ mode: 'matrix', costPoints: 6, confirm: 'none', flattenEod: true });
  assert.match(matrix.session, /In force on this run/);
  assert.match(matrix.cost, /Round-trip cost is 6 index points/);
  assert.match(matrix.cost, /8 points on a 1-minute exit and 6 on a 5-minute exit/);
  assert.match(matrix.data, /does not replay the minute tape/);
  assert.doesNotMatch(matrix.data, /Daily agrees/);

  const blocked = deskAssumptions({ mode: 'matrix', costPoints: 0, confirm: 'daily', flattenEod: false });
  assert.match(blocked.data, /not in the stored matrix/);
  assert.match(blocked.cost, /0 is price movement only/);
});

test('the page shows assumptions, session rules, and a readable chart scale', () => {
  const html = readFileSync(join(root, 'backtest/index.html'), 'utf8');
  assert.match(html, /id="assumptions"/);
  assert.match(html, /id="assumptions-cost"/);
  assert.match(html, /id="assumptions-session"/);
  assert.match(html, /Clock state fills at the clock bar’s open/);
  assert.match(html, /After the flip/);
  assert.match(html, /8 points on a 1-minute exit and 6 on a 5-minute exit/);
  assert.match(html, /does not replay the minute tape/);
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
  assert.match(hint, /Point cost is once per closed trade/);
});
