// Shared site chrome. Include on every page that uses the design system:
//   <header class="site-header" data-site-header></header> ... <footer data-site-footer></footer>
//   <script type="module" src="/assets/js/site.js"></script>
// Header nav and footer links come from /assets/tools.json, so registering a tool there is
// all it takes to list it everywhere.

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

export const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <defs><linearGradient id="bm-g" x1="0" y1="0" x2="32" y2="32"><stop stop-color="#38bdf8"/><stop offset="1" stop-color="#818cf8"/></linearGradient></defs>
  <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="9" stroke="url(#bm-g)" stroke-width="1.5" fill="#0c1018"/>
  <path d="M9 13v9M16 9v10M23 7v9" stroke="#566074" stroke-width="1.5" stroke-linecap="round"/>
  <rect x="7" y="15" width="4" height="5" rx="1" fill="#fb7185"/>
  <rect x="14" y="11" width="4" height="6" rx="1" fill="#34d399"/>
  <rect x="21" y="9" width="4" height="5" rx="1" fill="#34d399"/>
</svg>`;

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

function renderHeader(el, reg) {
  const path = location.pathname;
  const items = reg.tools.filter((t) => t.nav && t.href);
  el.innerHTML = `<div class="container">
    <a class="brand" href="/" aria-label="${esc(reg.site.name)} home">${BRAND_MARK}
      <span class="brand-name">${esc(reg.site.name)}<small>${esc(reg.site.owner)}</small></span></a>
    <button class="nav-toggle" aria-label="Menu" aria-expanded="false"><span></span></button>
    <nav class="site-nav" aria-label="Tools">
      ${items
        .map((t) => `<a href="${esc(t.href)}"${isActive(t.href, path) ? ' aria-current="page"' : ''}>${esc(t.title)}${t.status === 'new' ? '<span class="dot" title="New"></span>' : ''}</a>`)
        .join('')}
    </nav></div>`;
  const btn = el.querySelector('.nav-toggle');
  btn.addEventListener('click', () => {
    const open = el.dataset.open !== 'true';
    el.dataset.open = String(open);
    btn.setAttribute('aria-expanded', String(open));
  });
}

function renderFooter(el, reg) {
  const live = reg.tools.filter((t) => t.href);
  const soon = reg.tools.filter((t) => !t.href);
  el.classList.add('site-footer');
  el.innerHTML = `<div class="container">
    <div><a class="brand" href="/">${BRAND_MARK}<span class="brand-name">${esc(reg.site.name)}<small>${esc(reg.site.owner)}</small></span></a>
      <p class="about" style="margin-top:14px">${esc(reg.site.description)}</p></div>
    <div><h4>Tools</h4><ul>${live.map((t) => `<li><a href="${esc(t.href)}">${esc(t.title)}</a></li>`).join('')}</ul></div>
    <div><h4>In the lab</h4><ul>${soon.map((t) => `<li><span class="muted" style="font-size:14px">${esc(t.title)}</span></li>`).join('') || '<li class="muted">More soon</li>'}</ul></div>
    <div class="fine"><span>© ${new Date().getFullYear()} ${esc(reg.site.owner)} · Hong Kong</span>
      <span>Research and education only. Not investment advice. Backtests are hypothetical and do not predict future results.</span></div>
  </div>`;
}

export async function mountChrome() {
  const header = document.querySelector('[data-site-header]');
  const footer = document.querySelector('[data-site-footer]');
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
