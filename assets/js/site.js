// Shared site chrome. Include on every page that uses the design system:
//   <header class="mast" data-site-header></header> ... <footer data-site-footer></footer>
//   <script type="module" src="/assets/js/site.js"></script>
// Header nav and footer links come from /assets/tools.json.
// Pages with a footer also get the newsletter end card, unless <body data-newsletter="off">.
import { mountNewsletterCard } from './newsletter.js';

const REGISTRY_URL = '/assets/tools.json';
let registryPromise = null;

export function loadRegistry() {
  registryPromise ??= fetch(REGISTRY_URL).then((r) => {
    if (!r.ok) throw new Error(`tools.json HTTP ${r.status}`);
    return r.json();
  });
  return registryPromise;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export { esc };

export const BRAND_MARK = '';

const ICONS = {
  backtest: '<path d="M3 20h18M5 16l4-5 4 3 6-8" /><circle cx="19" cy="6" r="1.6" fill="currentColor"/>',
  capitol: '<path d="M4 20h16M6 17h12M7 17v-6M10.5 17v-6M13.5 17v-6M17 17v-6M5 11h14M12 4c-3.3 0-6 2.4-6 5.5V11h12V9.5C18 6.4 15.3 4 12 4ZM12 2v2"/>',
  news: '<rect x="3" y="4" width="15" height="16" rx="2"/><path d="M18 8h2a1 1 0 0 1 1 1v9a2 2 0 0 1-4 0M7 8h7M7 12h7M7 16h4"/>',
  scanner: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 15v-3M12 15V9M16 15v-5"/>',
  greeks: '<path d="M4 18c3 0 4-12 8-12s5 12 8 12"/><path d="M4 21h16" opacity=".5"/>',
  tool: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6M12 9v6"/>',
};
export function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.tool}</svg>`;
}

function isActive(href, path) {
  if (!href) return false;
  if (href === '/') return path === '/' || path === '/index.html';
  return path === href || path.startsWith(href);
}

export function mastDate(d = new Date()) {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Hong_Kong' }).toUpperCase();
}

function renderHeader(el, reg) {
  const path = location.pathname;
  const items = reg.tools.filter((t) => t.nav && t.href);
  const news = items.find((t) => t.id === 'news');
  const rest = items.filter((t) => t.id !== 'news');
  const home = el.dataset.mast === 'home';
  el.classList.add('mast');
  el.innerHTML = `<div class="wrap mast-in">
    <a class="logo" href="/" aria-label="${esc(reg.site.name)} home">
      <img class="mark" src="/assets/brand/adrrr-wordmark-white.svg" alt="${esc(reg.site.name)}" height="17">
    </a>
    <button class="nav-toggle" aria-label="Menu" aria-expanded="false"><span></span></button>
    <div class="mast-r">
      <span class="d">${mastDate()} · HKT</span>
      ${home ? '' : rest
        .map((t) => `<a href="${esc(t.href)}"${isActive(t.href, path) ? ' aria-current="page"' : ''}>${esc(t.title)}</a>`)
        .join('')}
      ${news ? `<a class="box" href="${esc(news.href)}"${isActive(news.href, path) ? ' aria-current="page"' : ''}>${esc(news.title)}</a>` : ''}
    </div>
  </div>`;
  const btn = el.querySelector('.nav-toggle');
  btn.addEventListener('click', () => {
    const open = el.dataset.open !== 'true';
    el.dataset.open = String(open);
    btn.setAttribute('aria-expanded', String(open));
  });
}

function renderFooter(el, reg) {
  const live = reg.tools.filter((t) => t.href);
  el.classList.add('site-footer');
  el.innerHTML = `<div class="wrap">
    <div class="row">
      <span>${esc(reg.site.owner)} · Hong Kong · ${esc(reg.site.name)}</span>
      <span>${live.map((t) => `<a href="${esc(t.href)}">${esc(t.title)}</a>`).join(' · ')}</span>
    </div>
    <div class="fine">Research and education only. Not investment advice. Backtests are hypothetical and do not predict future results.</div>
  </div>`;
}

export async function mountChrome() {
  const header = document.querySelector('[data-site-header]');
  const footer = document.querySelector('[data-site-footer]');
  mountNewsletterCard();
  if (!header && !footer) return;
  try {
    const reg = await loadRegistry();
    if (header) renderHeader(header, reg);
    if (footer) renderFooter(footer, reg);
  } catch (e) {
    console.warn('site chrome:', e);
  }
}

export function revealOnScroll(root = document) {
  const els = root.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) return els.forEach((e) => e.classList.add('in'));
  const io = new IntersectionObserver(
    (entries) => entries.forEach((en) => en.isIntersecting && (en.target.classList.add('in'), io.unobserve(en.target))),
    { rootMargin: '0px 0px -8% 0px' },
  );
  els.forEach((e) => io.observe(e));
}

mountChrome();
