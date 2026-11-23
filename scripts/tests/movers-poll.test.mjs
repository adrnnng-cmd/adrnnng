import assert from 'node:assert/strict';
import test from 'node:test';
import { createRefresher } from '../../movers/poll.js';
import { POLL_MS, reconcileSelection } from '../../movers/lib.js';

const T0 = Date.parse('2026-11-20T10:00:00+08:00');
const doc = (stamp, extra = {}) => ({ data_source: 'live', updated_at_hkt: stamp, ...extra });

/** A fake clock plus a load() the test settles by hand, so overlap and ordering are observable. */
function harness({ current = doc('2026-11-20 09:55:00') } = {}) {
  const clock = { t: T0 };
  const pending = [];
  const shown = { doc: current };
  const events = { data: [], status: [] };
  const refresher = createRefresher({
    now: () => clock.t,
    load: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    getCurrent: () => shown.doc,
    onData: (d, info) => {
      shown.doc = d;
      events.data.push({ d, info });
    },
    onStatus: (s) => events.status.push(s),
  });
  const settle = async (i, how, value) => {
    pending[i][how](value);
    await new Promise((r) => setImmediate(r));
  };
  return { clock, pending, shown, events, refresher, settle };
}

test('requests never overlap: ticks, manual clicks and focus events join the running fetch', async () => {
  const h = harness();
  const first = h.refresher.refresh();
  assert.equal(h.pending.length, 1);
  assert.equal(h.refresher.refresh(), first, 'a second call joins the same promise');
  h.clock.t += 120_000;
  assert.equal(h.refresher.tick({ visible: true }), null, 'tick does not start another fetch');
  assert.equal(h.refresher.recover({ visible: true }), first, 'recover joins too');
  assert.equal(h.pending.length, 1);
  assert.equal(h.refresher.status().inFlight, true);
  await h.settle(0, 'resolve', { data: doc('2026-11-20 10:00:00'), fellBack: false });
  await first;
  assert.equal(h.refresher.status().inFlight, false);
  assert.equal(h.pending.length, 1);
  h.refresher.refresh();
  assert.equal(h.pending.length, 2, 'a new fetch can start once the previous one has finished');
});

test('polling cadence: 60 s while trading, 5 min when idle, hidden tabs never poll', async () => {
  const h = harness();
  h.refresher.seed();
  assert.equal(h.refresher.due(), false);
  h.clock.t += 59_000;
  assert.equal(h.refresher.tick({ visible: true }), null);
  h.clock.t += 2_000;
  assert.equal(h.refresher.due(), true);
  assert.equal(h.refresher.tick({ visible: false }), null, 'hidden: no request');
  assert.equal(h.pending.length, 0);
  const p = h.refresher.tick({ visible: true });
  assert.ok(p);
  assert.equal(h.pending.length, 1);
  await h.settle(0, 'resolve', { data: doc('2026-11-20 10:01:00'), fellBack: false });
  await p;

  const night = harness();
  night.clock.t = Date.parse('2026-11-20T20:00:00+08:00');
  night.refresher.seed();
  night.clock.t += 200_000;
  assert.equal(night.refresher.due(), false, 'idle cadence is 5 minutes');
  night.clock.t += 101_000;
  assert.equal(night.refresher.due(), true);
});

test('visibility, focus and online recovery fetch at once but are rate limited', async () => {
  const h = harness();
  h.refresher.seed();
  h.clock.t += POLL_MS.minGap - 1;
  assert.equal(h.refresher.recover({ visible: true }), null, 'a fetch ran moments ago');
  h.clock.t += 2;
  const p = h.refresher.recover({ visible: true });
  assert.ok(p, 'recovery fetches long before the next 60 s tick');
  assert.equal(h.refresher.recover({ visible: false }), p, 'while a fetch runs, recover just returns it');
  await h.settle(0, 'resolve', { data: doc('2026-11-20 10:00:00'), fellBack: false });
  await p;
  const hidden = harness();
  assert.equal(hidden.refresher.recover({ visible: false }), null);
  assert.equal(hidden.pending.length, 0);
});

test('a newer snapshot updates the page and resets the failure count', async () => {
  const h = harness();
  const p = h.refresher.refresh();
  await h.settle(0, 'resolve', { data: doc('2026-11-20 10:00:00'), fellBack: false });
  await p;
  assert.equal(h.events.data.length, 1);
  assert.equal(h.events.data[0].info.changed, true);
  assert.equal(h.shown.doc.updated_at_hkt, '2026-11-20 10:00:00', 'the new update time is what the page shows');
  const s = h.refresher.status();
  assert.equal(s.fails, 0);
  assert.equal(s.lastCheckedAt, T0);
  assert.equal(s.lastSuccessAt, T0);
});

test('an unchanged snapshot is accepted without asking for a re-render', async () => {
  const h = harness({ current: doc('2026-11-20 10:00:00') });
  const p = h.refresher.refresh();
  await h.settle(0, 'resolve', { data: doc('2026-11-20 10:00:00'), fellBack: false });
  await p;
  assert.equal(h.events.data.length, 1);
  assert.equal(h.events.data[0].info.changed, false);
  assert.equal(h.refresher.status().fails, 0);
});

test('a transient error keeps the previous valid data and reports the failure', async () => {
  const h = harness({ current: doc('2026-11-20 09:55:00') });
  const before = h.shown.doc;
  const p = h.refresher.refresh();
  await h.settle(0, 'reject', new Error('HTTP 502'));
  await p;
  assert.equal(h.shown.doc, before, 'the on-screen snapshot is untouched');
  assert.equal(h.events.data.length, 0);
  const s = h.refresher.status();
  assert.equal(s.fails, 1);
  assert.match(s.lastError.message, /502/);
  assert.equal(s.inFlight, false);
  assert.equal(h.events.status.at(-1).fails, 1, 'the page is told so it can show the retry state');
  assert.equal(s.lastSuccessAt, 0);
});

test('failures back off, a success clears them, and recovery bypasses the backoff', async () => {
  const h = harness();
  const delays = [];
  for (let i = 0; i < 3; i++) {
    const p = h.refresher.refresh();
    await h.settle(i, 'reject', new Error('offline'));
    await p;
    const failedAt = h.clock.t;
    delays.push(failedAt);
    h.clock.t += POLL_MS.retryBase * 2 ** i - 1;
    assert.equal(h.refresher.due(), false, `retry ${i + 1} waits ${POLL_MS.retryBase * 2 ** i} ms`);
    h.clock.t += 2;
    assert.equal(h.refresher.due(), true);
  }
  assert.equal(h.refresher.status().fails, 3);
  h.clock.t += 1000;
  const r = h.refresher.recover({ visible: true });
  assert.ok(r, 'focus recovery retries immediately');
  await h.settle(3, 'resolve', { data: doc('2026-11-20 10:10:00'), fellBack: false });
  await r;
  assert.equal(h.refresher.status().fails, 0);
  assert.equal(h.refresher.status().lastError, null);
});

test('live data is never replaced by demo data or an older edge-cached snapshot', async () => {
  const h = harness({ current: doc('2026-11-20 10:00:00') });
  let p = h.refresher.refresh();
  await h.settle(0, 'resolve', { data: { data_source: 'demo', updated_at_hkt: '2026-11-20 16:10:00' }, fellBack: true });
  await p;
  assert.equal(h.shown.doc.data_source, 'live');
  assert.equal(h.refresher.status().fails, 1, 'a demo answer counts as a failed refresh');

  p = h.refresher.refresh();
  await h.settle(1, 'resolve', { data: doc('2026-11-20 09:30:00'), fellBack: false });
  await p;
  assert.equal(h.shown.doc.updated_at_hkt, '2026-11-20 10:00:00', 'older snapshot ignored');
  assert.equal(h.events.data.length, 0);
  assert.equal(h.refresher.status().fails, 0, 'an old cache hit is not an outage');
});

test('user choices survive a refresh: only a vanished sector or stock is cleared', () => {
  const state = { view: 'hk', sector: 'finance', selected: '00005', sort: 'turnover', weight: { hsi: 'impact', hk: 'market_cap' } };
  const next = { macro_sectors: [{ id: 'finance' }, { id: 'tech' }], hsi: { constituents: [{ code: '00005' }, { code: '00700' }] } };
  const kept = { ...state, ...reconcileSelection(state, next) };
  assert.deepEqual(kept, state, 'view, sort, weight, sector and stock are all preserved');
  const dropped = { ...state, ...reconcileSelection(state, { macro_sectors: [{ id: 'tech' }], hsi: { constituents: [{ code: '00700' }] } }) };
  assert.equal(dropped.sector, null);
  assert.equal(dropped.selected, null);
  assert.equal(dropped.view, 'hk');
  assert.equal(dropped.sort, 'turnover');
  assert.deepEqual(dropped.weight, state.weight);
});

test('app wiring: one interval, visibility/focus/online recovery, strict refresh loader', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../../movers/app.js', import.meta.url), 'utf8');
  assert.match(app, /createRefresher\(/);
  assert.match(app, /setInterval\(pageTick, TICK_MS\)/);
  assert.match(app, /addEventListener\('visibilitychange', pageRecover\)/);
  assert.match(app, /addEventListener\('focus', pageRecover\)/);
  assert.match(app, /addEventListener\('online', pageRecover\)/);
  assert.match(app, /loadData\(\{ strict: true \}\)/);
  assert.match(app, /cache: 'no-store'/);
  assert.match(app, /AbortController/);
  assert.match(app, /reconcileSelection\(state, doc\)/);
  assert.equal((app.match(/setInterval\(/g) || []).length, 1, 'a single timer');
});
