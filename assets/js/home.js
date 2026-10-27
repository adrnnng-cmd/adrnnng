import { loadRegistry, esc } from './site.js';
import { newsDoorCaption, parseLatest } from './latest.js';
import { memberPhotoImg } from './member-photo.js';
import { tdSequential } from '/backtest/strategies/td-sequential.js';

const PRICES = '/backtest/data/prices/';
const TAPE = ['^GSPC', '^NDX', '^HSI', '2800.HK', '0700.HK', 'AAPL', 'NVDA', 'MSFT', 'TSLA', 'GLD', 'BTC-USD'];
const LABEL = { '^GSPC': 'S&P 500', '^NDX': 'Nasdaq 100', '^HSI': 'Hang Seng', 'BTC-USD': 'BTC', 'ETH-USD': 'ETH' };

const fmtPrice = (v) => v.toLocaleString('en-US', { minimumFractionDigits: v >= 1000 ? 0 : 2, maximumFractionDigits: v >= 1000 ? 0 : 2 });
const fmtPct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const getJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${u} HTTP ${r.status}`))));

function tidy(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseReport(html, href) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lead = tidy(doc.querySelector('.lead h2')?.textContent);
  const dek = tidy(doc.querySelector('.mw-intro')?.textContent) || tidy(doc.querySelector('.lead .body')?.textContent);
  const stories = [...doc.querySelectorAll('h3')]
    .map((el) => tidy(el.textContent))
    .filter((t) => t.length > 16 && !/Sector|Performance|板塊表現|強弱|Indicators/.test(t))
    .slice(0, 3);
  const markets = [...doc.querySelectorAll('table.mkt tr')].slice(0, 6).map((tr) => {
    const raw = tidy(tr.querySelector('td.n')?.childNodes?.[0]?.textContent);
    const changeEl = tr.querySelector('td.c');
    const dir = changeEl?.classList.contains('down') ? 'down' : changeEl?.classList.contains('up') ? 'up' : 'flat';
    return { name: raw.split(/\s+/)[0], value: tidy(tr.querySelector('td.v')?.textContent), change: tidy(changeEl?.textContent), dir };
  }).filter((m) => m.value);
  return { href, kicker: tidy(doc.querySelector('.edition .kicker')?.textContent), lead, dek: dek.slice(0, 320), stories, markets };
}

async function loadReport() {
  try {
    const index = await fetch('/news/').then((r) => (r.ok ? r.text() : Promise.reject()));
    const latest = [...index.matchAll(/href="(\d{8})\//g)].map((m) => m[1]).sort().at(-1);
    if (!latest) throw new Error('no edition');
    const html = await fetch(`/news/${latest}/`).then((r) => (r.ok ? r.text() : Promise.reject()));
    const parsed = parseReport(html, `/news/${latest}/`);
    if (!parsed.lead) throw new Error('unparsed');
    return parsed;
  } catch {
    return getJson('/assets/news-preview.json');
  }
}

let latestRawPromise;
function loadLatestRaw() {
  if (!latestRawPromise) {
    latestRawPromise = fetch('/news/latest.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`/news/latest.json HTTP ${r.status}`))))
      .catch(() => null);
  }
  return latestRawPromise;
}

function loadLatest() {
  return loadLatestRaw().then((data) => (data ? parseLatest(data) : null));
}

function mountHero(story) {
  const img = document.getElementById('story-hero-img');
  img.alt = story.headline;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    img.onload = () => finish(img.naturalWidth > 0);
    img.onerror = () => finish(false);
    img.referrerPolicy = 'no-referrer';
    img.src = story.imageUrl;
    if (img.complete) finish(img.naturalWidth > 0);
  });
}

function applyHero(story) {
  const label = [story.credit, story.sourceName].filter(Boolean).join(' / ') || 'Source';
  const cap = document.getElementById('story-hero-credit');
  cap.innerHTML = story.sourceUrl
    ? `<a href="${esc(story.sourceUrl)}" rel="noopener noreferrer">Photo: ${esc(label)}</a>`
    : `Photo: ${esc(label)}`;
  document.getElementById('story-hero').hidden = false;
  document.body.classList.add('has-story-hero');
  document.getElementById('report-lead').innerHTML = `<a href="${esc(story.reportUrl)}">${esc(story.headline)}</a>`;
  document.getElementById('report-dek').innerHTML = `<a href="${esc(story.reportUrl)}">${esc(story.summary)}</a>`;
  document.getElementById('report-link').href = story.reportUrl;
  const kicker = document.getElementById('report-kicker');
  if (story.date && kicker && !/\d{4}/.test(kicker.textContent)) {
    kicker.insertAdjacentHTML('beforeend', `<span class="sep">/</span>${esc(story.date)}`);
  }
}

async function bootCover() {
  const [report, story] = await Promise.all([loadReport(), loadLatest()]);
  paintReport(report);
  if (story && (await mountHero(story))) applyHero(story);
}

function paintReport(r) {
  const kicker = document.getElementById('report-kicker');
  if (r.kicker) kicker.innerHTML = r.kicker.split(/\s*\/\s*/).filter(Boolean).map(esc).join('<span class="sep">/</span>');
  document.getElementById('report-lead').innerHTML = `<a href="${esc(r.href || '/news/')}">${esc(r.lead || r.serp_hook || '港股美股盤前早報')}</a>`;
  document.getElementById('report-dek').textContent = r.dek || '';
  document.getElementById('report-link').href = r.href || '/news/';
  document.getElementById('report-stories').innerHTML = (r.stories || [])
    .map((s, i) => `<li><span class="n">${String(i + 1).padStart(2, '0')}</span><span>${esc(s)}</span></li>`)
    .join('');
  document.getElementById('report-markets').innerHTML = (r.markets || [])
    .map((m) => `<tr><td class="n">${esc(m.name)}</td><td class="v">${esc(m.value)}</td><td class="c ${esc(m.dir || '')}">${esc(m.change)}</td></tr>`)
    .join('');
}

function doorPhoto({ webp, jpg, src, img: imgHtml, title, sub, subClass = '' }) {
  const img = imgHtml
    ? imgHtml
    : webp
      ? `<picture><source srcset="${esc(webp)} 2x" type="image/webp"><img src="${esc(jpg)}" srcset="${esc(jpg)} 2x" alt="" width="56" height="70"></picture>`
      : src
        ? `<img src="${esc(src)}" alt="" width="56" height="70">`
        : '';
  return `<div class="door-photo">${img}<div><b>${esc(title)}</b><span class="${esc(subClass)}">${esc(sub)}</span></div></div>`;
}

async function renderDoors() {
  const reg = await loadRegistry();
  const tools = ['backtest', 'politician-tracker', 'news'].map((id) => reg.tools.find((t) => t.id === id)).filter(Boolean);
  let filing = null;
  const latestRaw = await loadLatestRaw();
  try {
    const data = await getJson('/politician-tracker/data.json');
    const trade = data.trades?.[0];
    if (trade) filing = trade;
  } catch { /* tracker data is optional on the cover */ }
  const newsCap = newsDoorCaption(latestRaw);
  document.getElementById('tools').innerHTML = tools
    .map((t) => {
      let body = `<p>${esc(t.summary)}</p>`;
      if (t.id === 'backtest') {
        body = doorPhoto({
          webp: '/assets/img/doors/backtest.webp',
          jpg: '/assets/img/doors/backtest.jpg',
          title: 'TD Sequential 9 / 13',
          sub: 'Sharpe · CAGR · Max DD',
        });
      } else if (t.id === 'politician-tracker' && filing) {
        body = doorPhoto({
          img: memberPhotoImg(filing.bioguide),
          title: filing.name,
          sub: `${filing.tx} ${filing.ticker} · ${filing.amount}`,
          subClass: filing.tx === 'Buy' ? 'up' : 'down',
        });
      } else if (t.id === 'news') {
        body = doorPhoto({
          webp: '/assets/img/doors/news.webp',
          jpg: '/assets/img/doors/news.jpg',
          title: newsCap.title,
          sub: newsCap.sub,
        });
      }
      return `<a class="door" href="${esc(t.href)}">
        <span class="ey">${esc(t.category || '')}</span>
        <h2>${esc(t.title)}${t.zh ? `<span class="zh">${esc(t.zh)}</span>` : ''}</h2>
        ${body}
        <span class="go">Open →</span>
      </a>`;
    })
    .join('');
}

async function renderTape() {
  const m = await getJson(PRICES + 'manifest.json');
  const by = Object.fromEntries(m.symbols.map((s) => [s.symbol, s]));
  const items = TAPE.map((s) => by[s]).filter(Boolean);
  const arrow = (p) => (p > 0 ? '▲' : p < 0 ? '▼' : '');
  const html =
    `<span class="lbl">ADRRR</span>` +
    items
      .map((s) => {
        const cls = s.change_pct > 0 ? 'up' : s.change_pct < 0 ? 'down' : 'muted';
        return `<a class="tk" href="/backtest/#symbol=${encodeURIComponent(s.symbol)}"><b>${esc(LABEL[s.symbol] || s.symbol)}</b><span class="v">${fmtPrice(s.last_close)}</span><span class="c ${cls}">${arrow(s.change_pct)}${Math.abs(s.change_pct).toFixed(2)}%</span></a>`;
      })
      .join('');
  document.getElementById('tape').innerHTML = html;
  const tickers = document.querySelector('[data-stat="tickers"]');
  if (tickers) tickers.textContent = m.symbols.length;
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
  document.getElementById('sc-src').textContent = `Daily bars to ${last.time}`;

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
  const UP = '#0b8a3e';
  const DN = '#d0182a';
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
    if (td.buy13[j]) parts.push(`<text class="mk" x="${x(i)}" y="${y(b.low) + 26}" fill="#1a3fd1">13</text>`);
    if (td.sell13[j]) parts.push(`<text class="mk" x="${x(i)}" y="${y(b.high) - 18}" fill="#b06a00">13</text>`);
  });

  const ly = y(last.close);
  parts.push(`<line class="last-line" x1="0" x2="${W - padR}" y1="${ly}" y2="${ly}" stroke="#111" stroke-opacity=".45"/>`);
  parts.push(`<rect x="${W - padR + 2}" y="${ly - 9}" width="${padR - 4}" height="18" fill="#111"/><text x="${W - padR + 8}" y="${ly + 3.5}" fill="#fff" style="font:600 10px var(--font-mono)">${fmtPrice(last.close)}</text>`);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${parts.join('')}</svg>`;
}

renderDoors().catch((e) => console.warn(e));
bootCover().catch((e) => console.warn(e));
renderTape().catch((e) => console.warn(e));
renderSignalCard().catch((e) => {
  console.warn(e);
  document.getElementById('sc-chart').innerHTML = '<p class="muted" style="padding:40px 0;text-align:center">Price data unavailable right now.</p>';
});
