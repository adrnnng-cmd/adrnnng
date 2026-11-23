import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { liveDoc } from './movers-fixture.mjs';
import {
  SESSION_HOURS, STALE_AFTER_CLOSED_MIN, isStale, marketStatus, nextScheduledOpen, pollDelayMs, sessionAt,
} from '../../movers/lib.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MON = '2026-11-23';
const at = (hhmm, day = MON) => new Date(`${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}+08:00`);
const doc = (updated, session = 'lunch', extra = {}) => ({ data_source: 'live', market_session: session, updated_at_hkt: `${MON} ${updated}:00`, ...extra });

// ------------------------------------------------------------------ session boundaries on the HKT clock

test('session boundaries: pre-open 09:00, morning 09:30, lunch 12:00-13:00, afternoon 13:00, auction 16:00, closed 16:10', () => {
  const cases = [
    ['00:00', 'closed'], ['08:59:59', 'closed'], ['09:00', 'pre_open'], ['09:29:59', 'pre_open'], ['09:30', 'morning'],
    ['11:59:59', 'morning'], ['12:00', 'lunch'], ['12:30', 'lunch'], ['12:59:59', 'lunch'], ['13:00', 'afternoon'],
    ['15:59:59', 'afternoon'], ['16:00', 'closing_auction'], ['16:09:59', 'closing_auction'], ['16:10', 'closed'], ['23:59:59', 'closed'],
  ];
  for (const [clock, want] of cases) assert.equal(sessionAt(at(clock)), want, clock);
  assert.equal(sessionAt(at('10:00', '2026-11-21')), 'closed', 'Saturday');
  assert.equal(sessionAt(at('10:00', '2026-11-22')), 'closed', 'Sunday');
  assert.deepEqual(Object.keys(SESSION_HOURS), ['pre_open', 'morning', 'lunch', 'afternoon', 'closing_auction']);
});

test('no holiday or half-day table is invented: a calendar weekday follows the weekday schedule', () => {
  assert.equal(sessionAt(at('10:00', '2026-12-25')), 'morning', 'Christmas Day is not modelled');
  assert.equal(sessionAt(at('14:00', '2026-12-24')), 'afternoon', 'a half-day eve is not modelled');
  const lib = readFileSync(join(root, 'movers/lib.js'), 'utf8');
  assert.doesNotMatch(lib, /\b20\d\d-\d\d-\d\d\b.*(holiday|假期)|HOLIDAYS\s*=/i);
  const closed = marketStatus(doc('16:06', 'closing_auction', { updated_at_hkt: '2026-12-24 16:06:00' }), at('17:00', '2026-12-25'));
  assert.match(closed.text, /若今日為公眾假期，屬正常情況/, 'a possible holiday is hedged, not asserted');
  assert.match(closed.text, /未計公眾假期及半日市/);
});

// ------------------------------------------------------------------ the 12:51 report: lunch break

test('12:51 with a 12:04 snapshot is the lunch break, not a stale warning, and keeps its timestamp', () => {
  const s = marketStatus(doc('12:04'), at('12:51'));
  assert.equal(s.state, 'break');
  assert.equal(s.stale, false);
  assert.equal(isStale(doc('12:04'), at('12:51')), false);
  assert.equal(s.badge, '午間休市');
  assert.equal(s.clockSession, 'lunch');
  assert.equal(s.snapshotSession, 'lunch');
  assert.match(s.text, /午間休市（12:00–13:00），13:00 重開/);
  assert.match(s.text, /2026-11-23 12:04（HKT）/);
  assert.match(s.text, /距今 47 分鐘/);
  assert.doesNotMatch(s.text, /快照過時|並非最新資料/);
});

test('lunch break: any snapshot that covers the end of the morning is calm, earlier ones are not', () => {
  for (const clock of ['12:00', '12:00:01', '12:30', '12:59:59']) assert.equal(isStale(doc('11:55'), at(clock)), false, `11:55 at ${clock}`);
  assert.equal(isStale(doc('11:50'), at('12:30')), false, 'ten minutes before the end still covers it');
  assert.equal(isStale(doc('11:49'), at('12:30')), true);
  assert.equal(isStale(doc('10:00', 'morning'), at('12:30')), true, 'a mid-morning snapshot says nothing about the morning close');
  const yesterday = { ...doc('12:04'), updated_at_hkt: '2026-11-20 12:04:00' };
  assert.equal(isStale(yesterday, at('12:30')), true, 'a snapshot from another day is not the morning close');
  const early = marketStatus(doc('11:30', 'morning'), at('12:30'));
  assert.equal(early.badge, '快照過時');
  assert.match(early.text, /午間休市中/);
  assert.match(early.text, /可能缺少上午盤尾段/);
});

test('just before the break the session is still morning and the usual 10 minutes apply', () => {
  assert.equal(isStale(doc('11:45', 'morning'), at('11:59:59')), true);
  assert.equal(isStale(doc('11:50', 'morning'), at('11:59:59')), false);
  assert.equal(marketStatus(doc('11:50', 'morning'), at('11:59:59')).state, 'live');
});

// ------------------------------------------------------------------ 13:00 reopening

test('at 13:00 an old lunch-time snapshot is stale at once and says why; a fresh one is current', () => {
  const old = marketStatus(doc('12:04'), at('13:00'));
  assert.equal(old.state, 'stale');
  assert.equal(old.stale, true);
  assert.equal(old.badge, '快照過時');
  assert.equal(old.clockSession, 'afternoon');
  assert.equal(old.snapshotSession, 'lunch', 'the snapshot still says what it was taken in');
  assert.match(old.text, /現時為下午盤（13:00–16:00）/);
  assert.match(old.text, /2026-11-23 12:04（HKT），距今 56 分鐘/);
  assert.match(old.text, /取自午間休市期間，下午盤已於 13:00 重開，新快照尚未寫入/);
  assert.match(old.text, /目前顯示的並非最新資料/);
  assert.equal(marketStatus(doc('12:59'), at('13:00')).state, 'live');
  assert.equal(marketStatus(doc('13:00', 'afternoon'), at('13:10')).stale, false);
  assert.equal(marketStatus(doc('13:00', 'afternoon'), at('13:10:01')).stale, true, 'ten minutes, then stale');
  assert.equal(isStale(doc('12:04'), at('13:09')), true, 'the lunch-time snapshot never becomes current again');
});

// ------------------------------------------------------------------ close at 16:10 and the closing auction

test('16:00-16:10 closing auction keeps the 10-minute rule; at 16:10 the market is closed, not stale', () => {
  assert.equal(marketStatus(doc('15:58', 'afternoon'), at('16:05')).state, 'live');
  assert.equal(marketStatus(doc('15:58', 'afternoon'), at('16:09')).state, 'stale', 'a 11-minute-old snapshot in the auction is late');
  assert.equal(marketStatus(doc('16:04', 'closing_auction'), at('16:09:59')).state, 'live');
  const stale = marketStatus(doc('12:04'), at('16:05'));
  assert.match(stale.text, /現時為收市競價（16:00–16:10）/);
  assert.match(stale.text, /現時已是收市競價，新快照尚未寫入/);
  const closed = marketStatus(doc('16:06', 'closing_auction'), at('16:10'));
  assert.equal(closed.state, 'closed');
  assert.equal(closed.stale, false);
  assert.equal(closed.badge, '已收市');
  assert.equal(closed.clockSession, 'closed');
  assert.equal(closed.snapshotSession, 'closing_auction');
  assert.match(closed.text, /^已收市。常規交易時段為 09:30–12:00、13:00–16:00（收市競價至 16:10）/);
  assert.match(closed.text, /2026-11-23 16:06（HKT）的最後快照/);
  assert.match(closed.text, /11月24日（星期二）09:00/);
  assert.doesNotMatch(closed.text, /早於 16:10 收市/, 'a snapshot from the auction covers the close');
  assert.equal(isStale(doc('16:06', 'closing_auction'), at('23:00')), false);
});

test('after the close, a snapshot that predates the close is shown as closed with an honest caveat', () => {
  for (const updated of ['12:04', '15:55']) {
    const s = marketStatus(doc(updated, 'afternoon'), at('17:00'));
    assert.equal(s.stale, false, updated);
    assert.equal(s.state, 'closed');
    assert.match(s.text, /這份快照早於 16:10 收市，未必是收市價；若今日為半日市，屬正常情況/);
  }
  assert.doesNotMatch(marketStatus(doc('16:00', 'closing_auction'), at('17:00')).text, /早於 16:10 收市/);
});

// ------------------------------------------------------------------ pre-open, overnight, weekend, long gaps

test('pre-open 09:00-09:30 is an active session: Friday data is stale there, before 09:00 it is the last close', () => {
  const friday = { data_source: 'live', market_session: 'closing_auction', updated_at_hkt: '2026-11-20 16:08:00' };
  assert.equal(marketStatus(friday, at('09:05')).state, 'stale');
  assert.match(marketStatus(friday, at('09:05')).text, /現時為開市前時段（09:00–09:30）/);
  const before = marketStatus(friday, at('08:00'));
  assert.equal(before.state, 'closed');
  assert.equal(before.stale, false);
  assert.match(before.text, /^尚未開市。/);
  assert.match(before.text, /下一個預定開市前時段為 11月23日（星期一）09:00/);
  assert.doesNotMatch(before.text, /今日尚無快照/, 'before the open there is nothing to be missing yet');
});

test('overnight and weekend read as closed with the next scheduled open, never as stale', () => {
  const fri = { data_source: 'live', market_session: 'closing_auction', updated_at_hkt: '2026-11-20 16:08:00' };
  for (const [day, clock, lead, next] of [
    ['2026-11-20', '23:00', /^已收市。/, '11月23日（星期一）09:00'],
    ['2026-11-21', '10:00', /^週末休市。/, '11月23日（星期一）09:00'],
    ['2026-11-22', '20:00', /^週末休市。/, '11月23日（星期一）09:00'],
    ['2026-11-23', '07:30', /^尚未開市。/, '11月23日（星期一）09:00'],
  ]) {
    const s = marketStatus(fri, at(clock, day));
    assert.equal(s.stale, false, `${day} ${clock}`);
    assert.match(s.text, lead, `${day} ${clock}`);
    assert.ok(s.text.includes(next), `${day} ${clock}: ${s.text}`);
    assert.doesNotMatch(s.text, /早於 16:10|今日尚無快照/);
  }
  const night = marketStatus(doc('16:06', 'closing_auction'), at('23:00'));
  assert.match(night.text, /11月24日（星期二）09:00/);
  const friNight = marketStatus({ ...fri }, at('23:00', '2026-11-20'));
  assert.match(friNight.text, /11月23日（星期一）09:00/, 'Friday night points at Monday');
  assert.equal(nextScheduledOpen(at('16:11', '2026-11-20').getTime()).day, '2026-11-23');
  assert.equal(nextScheduledOpen(at('08:59', MON).getTime()).day, MON);
  assert.equal(nextScheduledOpen(at('09:00', MON).getTime()).day, '2026-11-24');
});

test('a weekday with no snapshot of its own is flagged as missing, hedged for a possible holiday', () => {
  const yesterday = { data_source: 'live', market_session: 'closing_auction', updated_at_hkt: '2026-11-23 16:06:00' };
  const s = marketStatus(yesterday, at('17:00', '2026-11-24'));
  assert.equal(s.stale, false);
  assert.match(s.text, /今日尚無快照；若今日為公眾假期，屬正常情況/);
  assert.equal(marketStatus(yesterday, at('10:00', '2026-11-24')).state, 'stale', 'inside a scheduled session it is late');
});

test('a snapshot more than four days old is stale even when the market is closed', () => {
  assert.equal(STALE_AFTER_CLOSED_MIN, 4 * 24 * 60);
  const old = { data_source: 'live', market_session: 'closed', updated_at_hkt: '2026-11-18 16:06:00' };
  const s = marketStatus(old, at('20:00', '2026-11-23'));
  assert.equal(s.stale, true);
  assert.match(s.text, /已超過連續假期的合理間隔/);
  assert.equal(isStale({ ...old, updated_at_hkt: '2026-11-20 16:06:00' }, at('20:00', '2026-11-23')), false);
});

test('demo data and unreadable timestamps are never judged', () => {
  assert.equal(marketStatus({ data_source: 'demo', market_session: 'closed', updated_at_hkt: '2026-11-20 16:10:00' }, at('12:51')), null);
  assert.equal(marketStatus({ data_source: 'live', market_session: 'lunch', updated_at_hkt: 'garbage' }, at('12:51')), null);
  assert.equal(marketStatus(null, at('12:51')), null);
  assert.equal(isStale({ data_source: 'live', updated_at_hkt: '' }, at('13:30')), false);
});

test('polling keeps its pace through the break and slows only when closed', () => {
  assert.equal(pollDelayMs({ now: at('12:30') }), 60_000);
  assert.equal(pollDelayMs({ now: at('13:00') }), 60_000);
  assert.equal(pollDelayMs({ now: at('16:09') }), 60_000);
  assert.equal(pollDelayMs({ now: at('16:10') }), 300_000);
  assert.equal(pollDelayMs({ now: at('12:30'), fails: 2 }), 60_000);
});

// ------------------------------------------------------------------ wall clock, not the viewer's time zone

test('the same instants give the same state under other process time zones', () => {
  const instants = ['2026-11-23T04:51:00Z', '2026-11-23T05:00:00Z', '2026-11-23T08:10:00Z', '2026-11-22T16:00:00Z', '2026-11-20T23:59:00Z'];
  const snaps = [doc('12:04'), doc('16:06', 'closing_auction')];
  const run = (tz) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { marketStatus, sessionAt } from ${JSON.stringify(join(root, 'movers/lib.js'))};
    const out = [];
    for (const iso of ${JSON.stringify(instants)}) for (const d of ${JSON.stringify(snaps)}) {
      const s = marketStatus(d, new Date(iso));
      out.push([iso, sessionAt(new Date(iso)), s.state, s.stale, s.text]);
    }
    console.log(JSON.stringify(out));
  `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
  const local = run('Asia/Hong_Kong');
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata']) assert.deepEqual(run(tz), local, tz);
  assert.equal(local[0][1], 'lunch', '04:51 UTC is 12:51 in Hong Kong');
  assert.equal(local[0][2], 'break');
  assert.equal(local[2][2], 'stale', '05:00 UTC is 13:00 in Hong Kong');
  assert.equal(local[2][1], 'afternoon');
  assert.equal(local[6][1], 'closed', '16:00 UTC on Sunday is Monday 00:00 in Hong Kong, before the open');
});

// ------------------------------------------------------------------ real browser with a controllable clock

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
};

async function chromePath() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try {
      await stat(p);
      return p;
    } catch { /* next */ }
  }
  return '';
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

const START = Date.parse('2026-11-23T12:51:00+08:00');
const CLOCK = `(() => {
  const RealDate = Date;
  const base = ${START};
  const start = RealDate.now();
  window.__skewMs = 0;
  const nowMs = () => base + (RealDate.now() - start) + window.__skewMs;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(nowMs()); else super(...a); }
    static now() { return nowMs(); }
  }
  window.Date = FakeDate;
})()`;

const STATUS = `(() => ({
  updated: document.querySelector('#hkm-updated')?.innerText || '',
  notice: document.querySelector('#hkm-notice')?.innerText || '',
  alerts: document.querySelectorAll('#hkm-notice .hkm-alert').length,
  marketNotice: document.querySelector('#hkm-notice .hkm-market')?.dataset.marketState || '',
  staleNotice: document.querySelector('#hkm-notice .notice-warn')?.dataset.marketState || '',
  clockBadge: document.querySelector('[data-market-clock]')?.dataset.marketClock || '',
  staleBadges: document.querySelectorAll('#hkm-updated .badge-stale').length,
  tab: document.querySelector('[role=tab][aria-selected=true]')?.dataset.view,
  tiles: document.querySelectorAll('.hm-tile').length,
  rows: document.querySelectorAll('.hkm-row').length,
  hsiTab: document.querySelector('#tab-hsi')?.innerText.replace(/\\s+/g, ' ') || '',
  scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  tile: [...document.querySelectorAll('.hkm-stat')].map((el) => el.innerText.replace(/\\s+/g, ' ')).filter((t) => /快照/.test(t)),
}))()`;

test('page shows 午間休市 at 12:51, stale again at 13:00, and 已收市 after 16:10, on all three views', { timeout: 150000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) throw new Error('Chrome is required for the page check. Set CHROME_PATH.');
  const script = { doc: liveDoc({ now: Date.parse('2026-11-23T12:04:00+08:00'), session: 'lunch' }), requests: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/movers/data/latest') {
      script.requests += 1;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify(script.doc));
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const abs = normalize(join(root, rel));
    if (!abs.startsWith(root)) return void res.writeHead(403).end();
    try {
      const body = await readFile(abs);
      res.writeHead(200, { 'content-type': types[extname(abs)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const profile = await mkdtemp(join(tmpdir(), 'hkm-session-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let debugPort = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not open a debugging port')), 15000);
    proc.stderr.on('data', (buf) => {
      const m = String(buf).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        debugPort = Number(m[1]);
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (code) => reject(new Error(`Chrome exited ${code} before the debugging port opened`)));
  });
  t.after(async () => {
    proc.kill('SIGKILL');
    await new Promise((resolve) => (proc.exitCode != null || proc.signalCode != null ? resolve() : proc.once('exit', resolve)));
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await ready;

  const created = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = cdp(ws);
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/movers/` });

  const waitFor = async (predicate, label, ms = 15000) => {
    const until = Date.now() + ms;
    let last = null;
    while (Date.now() < until) {
      last = await evaluate(STATUS);
      if (last && predicate(last)) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${label} never happened; last ${JSON.stringify(last)}`);
  };
  const dir = process.env.HKM_SHOT_DIR;
  const shot = async (name, width) => {
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 800 });
    await new Promise((r) => setTimeout(r, 400));
    const out = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(dir, `${name}.png`), Buffer.from(out.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  };
  const skewTo = (iso) => evaluate(`window.__skewMs += ${Date.parse(iso)} - new Date().getTime()`);
  const refresh = async () => {
    const before = script.requests;
    await evaluate(`document.querySelector('#hkm-refresh').click()`);
    const until = Date.now() + 10000;
    while (script.requests === before && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 400));
  };

  // 12:51: the lunch break, with the 12:04 snapshot still on screen.
  const lunch = await waitFor((s) => s.tiles > 0 && s.notice, 'lunch notice');
  assert.equal(lunch.marketNotice, 'break');
  assert.equal(lunch.staleNotice, '', 'no warning during the break');
  assert.equal(lunch.alerts, 0);
  assert.equal(lunch.staleBadges, 0);
  assert.match(lunch.notice, /午間休市（12:00–13:00），13:00 重開/);
  assert.match(lunch.notice, /2026-11-23 12:04（HKT）/);
  assert.match(lunch.notice, /距今 47 分鐘/);
  assert.doesNotMatch(lunch.notice, /快照過時|立即重試/);
  assert.match(lunch.updated, /快照更新：2026-11-23 12:04（HKT） · 快照時段：午間休市 · 現時：午間休市/);
  assert.doesNotMatch(lunch.updated, /資料已過時/);
  assert.ok(lunch.tile.some((x) => /更新快照（HKT）.*快照時段：午間休市/.test(x)), lunch.tile.join(' | '));
  assert.ok(lunch.scroll);
  await shot('movers-session-1251-lunch-desktop', 1440);
  await shot('movers-session-1251-lunch-mobile', 375);

  // The break notice follows every view; the three views and their data are untouched.
  for (const view of ['hstech', 'hk', 'hsi']) {
    await evaluate(`document.querySelector('#tab-${view}').click()`);
    const s = await waitFor((x) => x.tab === view && x.tiles > 0, `${view} tab`);
    assert.equal(s.marketNotice, 'break', view);
    assert.equal(s.staleNotice, '', view);
  }

  // 13:00:30: the afternoon session has reopened and the 12:04 snapshot is old.
  await skewTo('2026-11-23T13:00:30+08:00');
  const reopened = await waitFor((s) => s.staleNotice === 'stale', 'stale at reopening', 40000);
  assert.equal(reopened.marketNotice, '');
  assert.match(reopened.notice, /快照過時/);
  assert.match(reopened.notice, /現時為下午盤（13:00–16:00）/);
  assert.match(reopened.notice, /2026-11-23 12:04（HKT），距今 56 分鐘/);
  assert.match(reopened.notice, /下午盤已於 13:00 重開，新快照尚未寫入/);
  assert.match(reopened.notice, /目前顯示的並非最新資料/);
  assert.match(reopened.notice, /立即重試|更新中/, 'the retry control is offered (or is already running)');
  assert.match(reopened.updated, /快照時段：午間休市 · 現時：下午盤/);
  assert.equal(reopened.staleBadges, 1);
  assert.equal(reopened.clockBadge, 'afternoon');
  await shot('movers-session-1300-reopened-desktop', 1440);
  await shot('movers-session-1300-reopened-mobile', 375);

  // A new snapshot arrives: current again.
  script.doc = liveDoc({ now: Date.parse('2026-11-23T13:02:00+08:00'), session: 'afternoon' });
  await refresh();
  const live = await waitFor((s) => s.notice === '' && s.staleBadges === 0, 'current again');
  assert.match(live.updated, /2026-11-23 13:02（HKT） · 快照時段：下午盤 · 現時：下午盤/);

  // 16:12: closed. The last snapshot was taken in the closing auction.
  script.doc = liveDoc({ now: Date.parse('2026-11-23T16:06:00+08:00'), session: 'closing_auction' });
  await skewTo('2026-11-23T16:12:00+08:00');
  await refresh();
  const closed = await waitFor((s) => s.marketNotice === 'closed', 'closed notice');
  assert.equal(closed.staleNotice, '');
  assert.equal(closed.staleBadges, 0);
  assert.match(closed.notice, /^已收市\n已收市。/);
  assert.match(closed.notice, /2026-11-23 16:06（HKT）的最後快照/);
  assert.match(closed.notice, /11月24日（星期二）09:00/);
  assert.doesNotMatch(closed.notice, /快照過時|早於 16:10/);
  assert.match(closed.updated, /快照時段：收市競價 · 現時：已收市/);
  await shot('movers-session-1612-closed-desktop', 1440);
  await shot('movers-session-1612-closed-mobile', 375);

  // Weekend: Friday's last snapshot is still the close.
  script.doc = liveDoc({ now: Date.parse('2026-11-27T16:06:00+08:00'), session: 'closing_auction' });
  await skewTo('2026-11-28T10:00:00+08:00');
  await refresh();
  const weekend = await waitFor((s) => /週末休市/.test(s.notice), 'weekend notice');
  assert.equal(weekend.staleBadges, 0);
  assert.equal(weekend.staleNotice, '');
  assert.match(weekend.notice, /11月30日（星期一）09:00/);

  // Monday pre-open with Friday's data is late: the open session warns.
  await skewTo('2026-11-30T09:05:00+08:00');
  const preopen = await waitFor((s) => s.staleNotice === 'stale', 'stale in pre-open', 40000);
  assert.match(preopen.notice, /現時為開市前時段（09:00–09:30）/);
  ws.close();
});
