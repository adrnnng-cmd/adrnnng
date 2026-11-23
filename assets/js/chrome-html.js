// Markup for the shared header, footer and the four homepage doors, as pure string functions.
//
// Two callers render the same markup: the browser (site.js, home.js) and scripts/static-chrome.mjs, which writes
// it into the committed HTML so that the four canonical links (/backtest/ /movers/ /politician-tracker/ /news/)
// are real <a href> in view-source and work with scripting off. The browser then hydrates those anchors in place
// instead of replacing them. Nothing here touches the DOM, so Node can import it.
import { newsDoorCaption } from './latest.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function isActive(href, path) {
  if (!href) return false;
  if (href === '/') return path === '/' || path === '/index.html';
  return path === href || path.startsWith(href);
}

/** Inner HTML of <header data-site-header>. `toggle` is added by the browser only (it needs a click handler). */
export function headerInner(reg, { path = '', home = false, date = '', toggle = false } = {}) {
  const items = reg.tools.filter((t) => t.nav && t.href);
  const news = items.find((t) => t.id === 'news');
  const rest = items.filter((t) => t.id !== 'news');
  const link = (t, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(t.href)}"${isActive(t.href, path) ? ' aria-current="page"' : ''}>${esc(t.title)}</a>`;
  return [
    '<div class="wrap mast-in">',
    `  <a class="logo" href="/" aria-label="${esc(reg.site.name)} home"><img class="mark" src="/assets/brand/news-chart-white.svg" alt="${esc(reg.site.name)}" height="17"></a>`,
    toggle ? '  <button class="nav-toggle" aria-label="Menu" aria-expanded="false"><span></span></button>' : '',
    '  <div class="mast-r">',
    `    <span class="d">${date ? `${esc(date)} · HKT` : ''}</span>`,
    ...(home ? [] : rest.map((t) => `    ${link(t)}`)),
    news ? `    ${link(news, 'box')}` : '',
    '  </div>',
    '</div>',
  ].filter(Boolean).join('\n');
}

export function footerInner(reg) {
  const live = reg.tools.filter((t) => t.href);
  return [
    '<div class="wrap">',
    '  <div class="row">',
    `    <span>${esc(reg.site.owner)} · Hong Kong · ${esc(reg.site.name)}</span>`,
    `    <span>${live.map((t) => `<a href="${esc(t.href)}">${esc(t.title)}</a>`).join(' · ')}</span>`,
    '  </div>',
    '  <div class="fine">Research and education only. Not investment advice. Backtests are hypothetical and do not predict future results. <a href="/about/">About</a></div>',
    '</div>',
  ].join('\n');
}

// ---------------------------------------------------------------- homepage doors

// Door order and the registry ids each one answers to. The registry and the home module are cached separately, so a
// page can briefly see a registry from before the /hk-movers/ to /movers/ rename; accept the old id and always link
// the canonical URL.
const DOORS = [
  { id: 'backtest' },
  { id: 'movers', legacy: ['hk-movers'] },
  { id: 'politician-tracker' },
  { id: 'news' },
];
const CANONICAL_HREF = { movers: '/movers/' };

function findDoor(reg, id, legacy = []) {
  const tool = [id, ...legacy].map((want) => reg.tools.find((t) => t.id === want)).find(Boolean);
  if (!tool) return null;
  return { ...tool, id, href: CANONICAL_HREF[id] || tool.href };
}

export function doorTools(reg, onMissing = () => {}) {
  return DOORS.map(({ id, legacy = [] }) => {
    const door = findDoor(reg, id, legacy);
    if (!door) onMissing(id);
    return door;
  }).filter(Boolean);
}

export function doorPhoto({ webp, jpg, src, img: imgHtml, title, sub, subClass = '' }) {
  const img = imgHtml
    ? imgHtml
    : webp
      ? `<picture><source srcset="${esc(webp)} 2x" type="image/webp"><img src="${esc(jpg)}" srcset="${esc(jpg)} 2x" alt="" width="56" height="70"></picture>`
      : src
        ? `<img src="${esc(src)}" alt="" width="56" height="70">`
        : '';
  return `<div class="door-photo" data-door-body>${img}<div><b>${esc(title)}</b><span class="${esc(subClass)}">${esc(sub)}</span></div></div>`;
}

/** The body of a door that needs no data: what the committed HTML carries and what the browser shows before (or
 * without) live data. The Politician Tracker and Morning Report doors may replace theirs in the browser. */
export function staticDoorBody(t) {
  if (t.id === 'backtest') {
    return doorPhoto({
      webp: '/assets/img/doors/backtest.webp',
      jpg: '/assets/img/doors/backtest.jpg',
      title: 'TD Sequential 9 / 13',
      sub: 'Sharpe · CAGR · Max DD',
    });
  }
  if (t.id === 'movers') {
    return doorPhoto({
      src: '/assets/img/doors/movers-heat.svg',
      title: 'HSI · 升跌榜 · 板塊熱力圖',
      sub: '約 5–6 分鐘更新快照',
    });
  }
  if (t.id === 'news') {
    const cap = newsDoorCaption(null);
    return doorPhoto({
      webp: '/assets/img/doors/news.webp',
      jpg: '/assets/img/doors/news.jpg',
      title: cap.title,
      sub: cap.sub,
    });
  }
  return `<p data-door-body>${esc(t.summary)}</p>`;
}

export function doorAnchor(t, body = staticDoorBody(t)) {
  const zh = t.id === 'movers' ? '港股異動' : t.zh;
  return `<a class="door" data-door="${esc(t.id)}" href="${esc(t.href)}">
        <span class="ey">${esc(t.category || '')}</span>
        <h2>${esc(t.title)}${zh ? `<span class="zh">${esc(zh)}</span>` : ''}</h2>
        ${body}
        <span class="go">Open →</span>
      </a>`;
}

export function doorsInner(reg) {
  return doorTools(reg).map((t) => doorAnchor(t)).join('\n      ');
}
