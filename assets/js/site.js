// Shared site chrome. Include on every page that uses the design system:
//   <header class="mast" data-site-header></header> ... <footer data-site-footer></footer>
//   <script type="module" src="/assets/js/site.js"></script>
// Header nav and footer links come from /assets/tools.json.
// Pages with a footer also get the newsletter end card, unless <body data-newsletter="off">.
import { mountNewsletterCard } from './newsletter.js';
import { esc, headerInner, footerInner } from './chrome-html.js';

const REGISTRY_URL = '/assets/tools.json';
let registryPromise = null;

export function loadRegistry() {
  registryPromise ??= fetch(REGISTRY_URL).then((r) => {
    if (!r.ok) throw new Error(`tools.json HTTP ${r.status}`);
    return r.json();
  });
  return registryPromise;
}

export { esc };

export const BRAND_MARK = '';

const ICONS = {
  backtest: '<path d="M3 20h18M5 16l4-5 4 3 6-8" /><circle cx="19" cy="6" r="1.6" fill="currentColor"/>',
  capitol: '<path d="M4 20h16M6 17h12M7 17v-6M10.5 17v-6M13.5 17v-6M17 17v-6M5 11h14M12 4c-3.3 0-6 2.4-6 5.5V11h12V9.5C18 6.4 15.3 4 12 4ZM12 2v2"/>',
  heatmap: '<rect x="3" y="4" width="11" height="10" rx="1"/><rect x="16" y="4" width="5" height="5" rx="1"/><rect x="16" y="11" width="5" height="9" rx="1"/><rect x="3" y="16" width="11" height="4" rx="1"/>',
  news: '<rect x="3" y="4" width="15" height="16" rx="2"/><path d="M18 8h2a1 1 0 0 1 1 1v9a2 2 0 0 1-4 0M7 8h7M7 12h7M7 16h4"/>',
  scanner: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 15v-3M12 15V9M16 15v-5"/>',
  greeks: '<path d="M4 18c3 0 4-12 8-12s5 12 8 12"/><path d="M4 21h16" opacity=".5"/>',
  tool: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6M12 9v6"/>',
};
export function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.tool}</svg>`;
}

export function mastDate(d = new Date()) {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Hong_Kong' }).toUpperCase();
}

const hrefsOf = (root) => [...root.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
const sameList = (a, b) => a.length === b.length && a.every((h, i) => h === b[i]);

// The committed HTML already carries these links (scripts/static-chrome.mjs). When they match the registry the
// anchors are kept, so nothing disappears or reflows, and only what needs scripting is added: the date and the menu
// button. When the registry differs (a tool was added or renamed since the HTML was built) the markup is rebuilt.
function renderHeader(el, reg) {
  const path = location.pathname;
  const home = el.dataset.mast === 'home';
  const opts = { path, home, date: mastDate(), toggle: true };
  el.classList.add('mast');
  const have = el.querySelector('.mast-r');
  const want = document.createElement('div');
  want.innerHTML = headerInner(reg, opts);
  if (have && el.querySelector('.logo') && sameList(hrefsOf(have), hrefsOf(want.querySelector('.mast-r')))) {
    const date = have.querySelector('.d');
    if (date) date.textContent = `${mastDate()} · HKT`;
    if (!el.querySelector('.nav-toggle')) have.insertAdjacentHTML('beforebegin', '<button class="nav-toggle" aria-label="Menu" aria-expanded="false"><span></span></button>');
  } else {
    el.innerHTML = headerInner(reg, opts);
  }
  const btn = el.querySelector('.nav-toggle');
  btn.addEventListener('click', () => {
    const open = el.dataset.open !== 'true';
    el.dataset.open = String(open);
    btn.setAttribute('aria-expanded', String(open));
  });
}

function renderFooter(el, reg) {
  el.classList.add('site-footer');
  const want = document.createElement('div');
  want.innerHTML = footerInner(reg);
  if (!sameList(hrefsOf(el), hrefsOf(want))) el.innerHTML = footerInner(reg);
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
