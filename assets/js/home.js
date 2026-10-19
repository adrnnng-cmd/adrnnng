import { loadRegistry, icon, esc, revealOnScroll } from './site.js';
import { tdSequential } from '/backtest/strategies/td-sequential.js';

const PRICES = '/backtest/data/prices/';
const STATUS_LABEL = { live: 'Live', new: 'New', beta: 'Beta', soon: 'In the lab' };
const TAPE = ['SPY', 'QQQ', '^GSPC', '^NDX', '^HSI', '2800.HK', '0700.HK', '9988.HK', '3690.HK', 'AAPL', 'NVDA', 'MSFT', 'GOOGL', 'TSLA', 'LLY', 'ORCL', 'GLD', 'TLT', 'BTC-USD', 'ETH-USD'];
const LABEL = { '^GSPC': 'S&P 500', '^NDX': 'Nasdaq 100', '^HSI': 'Hang Seng', 'BTC-USD': 'BTC', 'ETH-USD': 'ETH' };

const fmtPrice = (v) => v.toLocaleString('en-US', { minimumFractionDigits: v >= 1000 ? 0 : 2, maximumFractionDigits: v >= 1000 ? 0 : 2 });
const fmtPct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const getJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${u} HTTP ${r.status}`))));

async function renderTools() {
  const reg = await loadRegistry();
  const grid = document.getElementById('tool-grid');
  const withHref = reg.tools.filter((t) => t.href);
  const featured = new Set(withHref.slice(0, 2).map((t) => t.id));
  const ordered = [...withHref, ...reg.tools.filter((t) => !t.href)];
  grid.innerHTML = ordered
    .map((t) => {
      const tag = t.href ? 'a' : 'div';
      const cls = ['tool-card', 'reveal', featured.has(t.id) ? 'featured' : '', t.href ? '' : 'soon'].join(' ');
      return `<${tag} class="${cls}" ${t.href ? `href="${esc(t.href)}"` : 'aria-disabled="true"'} style="--acc:${esc(t.accent || 'var(--accent)')}" data-tool="${esc(t.id)}">
        <div class="tc-top"><span class="tc-icon">${icon(t.icon, 22)}</span><span class="badge badge-${esc(t.status)}">${STATUS_LABEL[t.status] || esc(t.status)}</span></div>
        <div class="tc-cat">${esc(t.category || '')}</div>
        <h3>${esc(t.title)}${t.zh ? `<span class="zh">${esc(t.zh)}</span>` : ''}</h3>
        <p>${esc(t.summary)}</p>
        ${t.highlights?.length ? `<ul class="tc-hl">${t.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
        ${t.href ? `<span class="tc-go">Open ${esc(t.title)} <span class="arrow">→</span></span>` : ''}
      </${tag}>`;
    })
    .join('');
  grid.addEventListener('pointermove', (e) => {
    const card = e.target.closest('.tool-card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
  document.querySelector('[data-stat="tools"]').textContent = withHref.length;
  revealOnScroll();
}

async function renderTape() {
  const m = await getJson(PRICES + 'manifest.json');
  const by = Object.fromEntries(m.symbols.map((s) => [s.symbol, s]));
  const items = TAPE.map((s) => by[s]).filter(Boolean);
  const asOf = items.map((s) => s.last).sort().at(-1);
  const html =
    items
      .map(
        (s) => `<a class="tape-item" href="/backtest/#symbol=${encodeURIComponent(s.symbol)}"><span class="s">${esc(LABEL[s.symbol] || s.symbol)}</span><span class="p num">${fmtPrice(s.last_close)}</span><span class="num ${s.change_pct >= 0 ? 'up' : 'down'}">${fmtPct(s.change_pct)}</span></a>`,
      )
      .join('') + `<span class="tape-item tape-note">Last close · ${esc(asOf)} · Yahoo Finance</span>`;
  document.getElementById('tape').innerHTML = html + html;
  document.querySelector('[data-stat="tickers"]').textContent = m.symbols.length;
  const first = m.symbols.map((s) => s.first).sort()[0];
  const years = Math.floor((Date.now() - Date.parse(first)) / 31557600000);
  document.querySelector('[data-stat="years"]').textContent = `${years} yrs`;
}

// ---------- Hero: real candles with TD Sequential counts ----------
const SHOW = 90;
let recent = null;
let manifestBy = {};
let current = 'SPY';

async function renderSignalCard() {
  const [r, m] = await Promise.all([getJson(PRICES + 'recent.json'), getJson(PRICES + 'manifest.json')]);
  recent = r;
  manifestBy = Object.fromEntries(m.symbols.map((s) => [s.symbol, s]));
  const chips = document.getElementById('sc-chips');
  const syms = Object.keys(r.symbols);
  chips.innerHTML = syms.map((s) => `<button type="button" data-s="${esc(s)}" aria-pressed="${s === current}">${esc(LABEL[s] || s)}</button>`).join('');
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    current = b.dataset.s;
    chips.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    drawSignal();
  });
  new ResizeObserver(() => drawSignal()).observe(document.getElementById('sc-chart'));
}

function drawSignal() {
  if (!recent) return;
  const el = document.getElementById('sc-chart');
  const rows = recent.symbols[current];
  const bars = rows.map(([time, open, high, low, close]) => ({ time, open, high, low, close }));
  const td = tdSequential(bars);
  const from = Math.max(0, bars.length - SHOW);
  const view = bars.slice(from);
  const meta = manifestBy[current] || {};
  const last = view.at(-1);
  const prev = bars.at(-2);
  document.getElementById('sc-symbol').textContent = LABEL[current] || current;
  document.getElementById('sc-name').textContent = meta.name && !LABEL[current] ? meta.name : '';
  document.getElementById('sc-last').textContent = `${fmtPrice(last.close)}${meta.currency ? ' ' + meta.currency : ''}`;
  const chg = (last.close / prev.close - 1) * 100;
  const chgEl = document.getElementById('sc-chg');
  chgEl.textContent = `${fmtPct(chg)} · ${last.time}`;
  chgEl.className = `num sc-chg ${chg >= 0 ? 'up' : 'down'}`;
  document.getElementById('sc-src').textContent = `Daily bars to ${last.time} · Yahoo Finance`;

  const W = el.clientWidth || 600;
  const H = el.clientHeight || 300;
  const padR = 58;
  const padT = 22;
  const padB = 24;
  const hi = Math.max(...view.map((b) => b.high));
  const lo = Math.min(...view.map((b) => b.low));
  const span = hi - lo || 1;
  const y = (v) => padT + ((hi - v) / span) * (H - padT - padB - 16);
  const step = (W - padR) / view.length;
  const bw = Math.max(1.5, step * 0.62);
  const x = (i) => i * step + step / 2;
  const UP = '#34d399';
  const DN = '#fb7185';
  const parts = [];

  parts.push('<g class="grid axis">');
  for (let k = 0; k <= 4; k++) {
    const v = lo + (span * k) / 4;
    parts.push(`<line x1="0" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${W - padR + 8}" y="${y(v) + 3}">${fmtPrice(v)}</text>`);
  }
  for (let k = 0; k < 4; k++) {
    const i = Math.round((k + 0.5) * (view.length / 4));
    const d = new Date(view[i].time + 'T00:00:00Z');
    parts.push(`<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>`);
  }
  parts.push('</g>');

  view.forEach((b, i) => {
    const c = b.close >= b.open ? UP : DN;
    const top = y(Math.max(b.open, b.close));
    const h = Math.max(1, Math.abs(y(b.open) - y(b.close)));
    parts.push(`<g class="candle" style="animation-delay:${i * 6}ms"><line x1="${x(i)}" x2="${x(i)}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${c}" stroke-opacity=".7"/><rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="1" fill="${c}" fill-opacity="${b.close >= b.open ? 0.9 : 0.85}"/></g>`);
  });

  view.forEach((b, i) => {
    const j = from + i;
    const bs = td.buySetup[j];
    const ss = td.sellSetup[j];
    if (bs > 0 && bs <= 9) {
      const big = bs === 9;
      parts.push(`<text class="mk ${big ? '' : 'mk-count'}" x="${x(i)}" y="${y(b.low) + (big ? 14 : 11)}" fill="${UP}">${bs}</text>`);
    }
    if (ss > 0 && ss <= 9) {
      const big = ss === 9;
      parts.push(`<text class="mk ${big ? '' : 'mk-count'}" x="${x(i)}" y="${y(b.high) - (big ? 6 : 4)}" fill="${DN}">${ss}</text>`);
    }
    if (td.buy13[j]) parts.push(`<text class="mk" x="${x(i)}" y="${y(b.low) + 26}" fill="#22d3ee">13</text>`);
    if (td.sell13[j]) parts.push(`<text class="mk" x="${x(i)}" y="${y(b.high) - 18}" fill="#f472b6">13</text>`);
  });

  const ly = y(last.close);
  parts.push(`<line class="last-line" x1="0" x2="${W - padR}" y1="${ly}" y2="${ly}" stroke="#38bdf8" stroke-opacity=".6"/>`);
  parts.push(`<rect x="${W - padR + 2}" y="${ly - 9}" width="${padR - 4}" height="18" rx="4" fill="#38bdf8"/><text x="${W - padR + 8}" y="${ly + 3.5}" fill="#05070b" style="font:600 10px var(--font-mono)">${fmtPrice(last.close)}</text>`);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${parts.join('')}</svg>`;
}

renderTools().catch((e) => console.warn(e));
renderTape().catch((e) => console.warn(e));
renderSignalCard().catch((e) => {
  console.warn(e);
  document.getElementById('sc-chart').innerHTML = '<p class="muted" style="padding:40px 0;text-align:center">Price data unavailable right now.</p>';
});
