// Live-shaped HK Movers documents for browser tests and screenshots. Built from the committed demo
// document, re-timed to "now" and reshaped so ranking and breadth edge cases are easy to produce.

import { readFileSync } from 'node:fs';
import { breadth, tone } from '../../movers/lib.js';

const sample = JSON.parse(readFileSync(new URL('../../movers/data/sample.json', import.meta.url), 'utf8'));

export const hktString = (ms, withSeconds = true) => {
  const iso = new Date(ms + 8 * 3600e3).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, withSeconds ? 19 : 16)}`;
};

/** Give `rows` exactly up / down / flat movers (largest market caps first), keeping prices consistent. */
function reshape(rows, { up, down, flat }) {
  const order = [...rows].sort((a, b) => b.market_cap_hkd - a.market_cap_hkd);
  const pcts = new Map();
  order.forEach((r, i) => {
    if (i < up) pcts.set(r.code, 0.3 + ((i * 37) % 170) / 100);
    else if (i < up + flat) pcts.set(r.code, 0);
    else if (i < up + flat + down) pcts.set(r.code, -(0.2 + ((i * 53) % 290) / 100));
    else pcts.set(r.code, 0);
  });
  return rows.map((r) => {
    const pct = pcts.get(r.code);
    const prev = r.prev_close;
    return {
      ...r, change_pct: Math.round(pct * 100) / 100, last: Math.round(prev * (1 + pct / 100) * 1000) / 1000,
      impact_hkd: Math.round((pct / 100) * r.market_cap_hkd),
    };
  });
}

/** Keep the full constituents table consistent with the (reshaped) priced rows; unavailable members stay unavailable. */
function syncMembers(block) {
  const byCode = new Map(block.constituents.map((r) => [r.code, r]));
  block.members = block.members.map((m) => {
    const r = byCode.get(m.code);
    return r ? { ...m, last: r.last, prev_close: r.prev_close, change_pct: r.change_pct, market_cap_hkd: r.market_cap_hkd } : m;
  });
}

function resectors(doc) {
  const stocks = doc.hk_market.stocks;
  for (const s of doc.macro_sectors) {
    const members = stocks.filter((r) => r.sector === s.id);
    const b = breadth(members);
    const cap = members.reduce((t, r) => t + r.market_cap_hkd, 0);
    s.up = b.up;
    s.down = b.down;
    s.flat = b.flat;
    s.change_pct = cap ? Math.round((members.reduce((t, r) => t + r.change_pct * r.market_cap_hkd, 0) / cap) * 100) / 100 : 0;
    const best = [...members].sort((a, c) => c.change_pct - a.change_pct)[0];
    s.leader = best && best.change_pct > 0 ? { code: best.code, name: best.name, change_pct: best.change_pct } : null;
  }
}

/**
 * @param {object} o
 * @param {number} o.now           epoch ms the snapshot is stamped with
 * @param {object} [o.hsi]         {up, down, flat} for the 95 constituents (default 5 / 89 / 1)
 * @param {object} [o.hk]          {up, down, flat} for the qualified HK stocks (default 7 up, rest down)
 * @param {object} [o.hstech]      {up, down, flat} for the priced HSTECH constituents (default 21 up, 7 down, 1 flat)
 * @param {string} [o.session]
 */
export function liveDoc({ now, hsi = { up: 5, down: 89, flat: 1 }, hk = null, hstech = { up: 21, down: 7, flat: 1 }, session = 'afternoon' }) {
  const doc = JSON.parse(JSON.stringify(sample));
  doc.data_source = 'live';
  delete doc.notice;
  doc.updated_at_hkt = hktString(now);
  doc.market_session = session;

  doc.hsi.constituents = reshape(doc.hsi.constituents, hsi);
  doc.hsi.breadth = breadth(doc.hsi.constituents);
  const idx = doc.hsi.index;
  idx.change_pct = -1.37;
  idx.change = Math.round(idx.prev_close * idx.change_pct) / 100;
  idx.last = Math.round((idx.prev_close + idx.change) * 100) / 100;

  doc.hstech.constituents = reshape(doc.hstech.constituents, hstech);
  doc.hstech.breadth = breadth(doc.hstech.constituents);
  const tech = doc.hstech.index;
  tech.change_pct = 0.84;
  tech.change = Math.round(tech.prev_close * tech.change_pct) / 100;
  tech.last = Math.round((tech.prev_close + tech.change) * 100) / 100;
  for (const key of ['hsi', 'hstech']) syncMembers(doc[key]);

  const n = doc.hk_market.stocks.length;
  const shape = hk || { up: 7, down: n - 8, flat: 1 };
  doc.hk_market.stocks = reshape(doc.hk_market.stocks, shape);
  doc.hk_market.breadth = breadth(doc.hk_market.stocks);
  doc.hk_market.qualified_count = n;
  resectors(doc);

  const rank = (rows, dir) => rows.filter((r) => tone(r.change_pct) === dir)
    .sort((a, b) => (dir === 'up' ? b.change_pct - a.change_pct : a.change_pct - b.change_pct)).slice(0, 10);
  doc.movers = {
    hsi: { gainers: rank(doc.hsi.constituents, 'up'), losers: rank(doc.hsi.constituents, 'down') },
    hk: { gainers: rank(doc.hk_market.stocks, 'up'), losers: rank(doc.hk_market.stocks, 'down') },
    hstech: { gainers: rank(doc.hstech.constituents, 'up'), losers: rank(doc.hstech.constituents, 'down') },
  };

  const listed = [...doc.movers.hsi.gainers, ...doc.movers.hsi.losers, ...doc.movers.hk.gainers, ...doc.movers.hk.losers,
    ...doc.movers.hstech.gainers, ...doc.movers.hstech.losers];
  const news = {};
  listed.forEach((r, i) => {
    const prior = sample.news[r.code];
    if (!prior) return;
    const hoursAgo = [0.4, 1.5, 3, 5, 26, 30, 50, 70, 95, 400][i % 10];
    news[r.code] = { ...prior, published_at_hkt: hktString(now - hoursAgo * 3600e3, false) };
  });
  doc.news = news;
  return doc;
}
