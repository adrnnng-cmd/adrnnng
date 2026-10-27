import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES, getStrategy } from '../strategies/index.js';
import { compositionSlots, periodAvailability, supportedTimeframe } from '../composition/slots.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const td = () => getStrategy('td-sequential');
const st = () => getStrategy('atr-supertrend');

test('the strategy select is built from TD Sequential and ATR SuperTrend', () => {
  assert.deepEqual(STRATEGIES.map((s) => s.name), ['TD Sequential', 'ATR SuperTrend']);
  assert.equal(getStrategy('missing').id, 'td-sequential');
});

test('the composition row is in the page for every strategy', () => {
  const html = readFileSync(join(root, 'backtest/index.html'), 'utf8');
  assert.match(html, /id="strategy"/);
  assert.match(html, /id="compose-row"(?![^>]*\bhidden\b)/);
  for (const id of ['entry-rule', 'exit-tf', 'clock', 'exit-rule', 'confirm', 'session-mode', 'year', 'entry-atr', 'exit-atr']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const app = readFileSync(join(root, 'backtest/app.js'), 'utf8');
  assert.match(app, /\$\('compose-row'\)\.hidden = false/);
  assert.doesNotMatch(app, /compose-row'\)\.hidden = !/);
});

test('daily TD Sequential keeps the date session and disables the HSI clock slots', () => {
  const slots = compositionSlots(td(), { symbol: 'SPY', timeframe: '1d', exitTimeframe: '5m', entryRule: 'clock' });
  assert.equal(slots.visible, true);
  assert.equal(slots.matrix, false);
  for (const key of ['entry', 'exitTf', 'clock', 'exitRule', 'confirm', 'flatten', 'cost']) {
    assert.equal(slots[key].enabled, false, key);
    assert.equal(slots[key].hidden, false, key);
    assert.ok(slots[key].reason.length > 8, key);
  }
  assert.equal(slots.session.enabled, true);
  assert.equal(slots.recipe.enabled, true);
  assert.equal(slots.entryAtr.hidden, true);
  assert.equal(slots.exitAtr.hidden, true);
  assert.match(slots.hint, /ATR SuperTrend/);
  assert.match(slots.hint, /By year/);
  assert.equal(periodAvailability(td(), 'HSImain', '5m').block, true);
  assert.match(periodAvailability(td(), 'HSImain', '5m').reason, /ATR SuperTrend/);
  assert.equal(periodAvailability(td(), 'SPY', '1d').disabled, false);
  assert.equal(supportedTimeframe(td(), '5m'), '1d');
});

test('daily ATR SuperTrend edits Entry ATR and leaves the minute slots off', () => {
  const slots = compositionSlots(st(), { symbol: 'SPY', timeframe: '1d', exitTimeframe: '5m', entryRule: 'clock' });
  assert.equal(slots.matrix, false);
  assert.equal(slots.entryAtr.enabled, true);
  assert.equal(slots.entryAtr.hidden, false);
  assert.equal(slots.exitAtr.enabled, false);
  assert.match(slots.exitAtr.reason, /exit timeframe/);
  assert.equal(slots.clock.enabled, false);
  assert.equal(slots.session.enabled, true);
  assert.match(slots.hint, /Entry ATR/);
  const minute = periodAvailability(st(), 'SPY', '1m');
  assert.equal(minute.disabled, true);
  assert.equal(minute.block, false);
  assert.match(minute.reason, /HSI futures/);
  assert.equal(periodAvailability(st(), 'HSImain', '5m').disabled, false);
});

test('HSI minute ATR SuperTrend turns the matrix slots on', () => {
  const same = compositionSlots(st(), { symbol: 'HSImain', timeframe: '5m', exitTimeframe: '5m', entryRule: 'clock' });
  assert.equal(same.matrix, true);
  for (const key of ['entry', 'exitTf', 'clock', 'exitRule', 'confirm', 'flatten', 'cost', 'entryAtr']) {
    assert.equal(same[key].enabled, true, key);
  }
  assert.equal(same.exitAtr.enabled, false);
  assert.match(same.exitAtr.reason, /timeframes match/);
  assert.match(same.confirm.reason, /not in the stored results/);

  const split = compositionSlots(st(), { symbol: 'HSImain', timeframe: '5m', exitTimeframe: '1m', entryRule: 'clock' });
  assert.equal(split.exitAtr.enabled, true);

  const flip = compositionSlots(st(), { symbol: 'HSImain', timeframe: '1m', exitTimeframe: '1m', entryRule: 'flip' });
  assert.equal(flip.clock.enabled, false);
  assert.match(flip.clock.reason, /Any flip/);
  assert.equal(flip.clock.hidden, false);

  const half = compositionSlots(st(), { symbol: 'HSImain', timeframe: '30m', exitTimeframe: '1h', entryRule: 'clock' });
  assert.equal(half.matrix, true);
  assert.equal(half.exitAtr.enabled, true);
  assert.equal(periodAvailability(st(), 'HSImain', '30m').disabled, false);
  assert.equal(periodAvailability(st(), 'HSImain', '1h').block, false);
  assert.equal(periodAvailability(st(), 'SPY', '30m').disabled, true);
  assert.equal(periodAvailability(st(), 'SPY', '1h').block, false);
  assert.equal(periodAvailability(td(), 'HSImain', '30m').block, true);
  assert.equal(periodAvailability(td(), 'SPY', '1h').block, true);
});

test('a future plug-in without a session uses the same disabled row', () => {
  const future = { id: 'next', name: 'Next', params: [], capabilities: { timeframes: ['1d'] } };
  const slots = compositionSlots(future, { symbol: 'AAPL', timeframe: '1d' });
  assert.equal(slots.visible, true);
  assert.equal(slots.entry.enabled, false);
  assert.equal(slots.entryAtr.hidden, true);
  assert.equal(slots.session.enabled, true);
  assert.equal(supportedTimeframe(future, '1w'), '1d');

  const optedIn = {
    id: 'other',
    params: [{ key: 'atrLength' }],
    capabilities: { session: true, timeframes: ['1d', '1m', '5m'] },
  };
  const minute = compositionSlots(optedIn, { symbol: 'HSImain', timeframe: '5m', exitTimeframe: '1m', entryRule: 'clock' });
  assert.equal(minute.matrix, false);
  assert.equal(minute.entry.enabled, false);
  assert.equal(minute.entryAtr.enabled, true);
  assert.equal(minute.exitAtr.enabled, false);
});
