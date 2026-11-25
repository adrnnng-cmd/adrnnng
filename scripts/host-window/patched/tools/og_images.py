#!/usr/bin/env python3
"""Article photo for EVERY story (Lead + ranked Top Stories), EVERY Market Wrap / What-you-need-to-know point,
and every Worth Reading item + rehosting.
Usage: og_images.py <DATE> [--refresh]
Key per item = its first link URL (or "story:<n>" / "wrap:point:<i>" when a story or WYNTK point has no link). Resolution order, first hit wins:
 1. og:image / twitter:image of the source URL (real-browser UA; Bloomberg/WSJ/FT often 403 — no AMP/oEmbed bypass);
 2. (same request) — we never bypass bot protection / challenges;
 3. data `og_fallback` {key: [alt_url, ...]} — reputable copies of the SAME story (manual or auto search-copy);
 4. **Auto search-copy**: DuckDuckGo HTML → allowlisted outlets (Reuters/Yahoo Finance/CNBC/FT/TechCrunch/SCMP/Guardian/Axios/Investing/BBC/…).
    Triggers when (a) source is Bloomberg/WSJ/FT with no img, OR (b) key has **no URL** (`story:<n>` / `wrap:point:<i>`) — search by title/head so no-link news still get a photo.
    Persists into `og_fallback`; capped (default max 6 queries / run);
 5. data `og_manual` {key: {image_url, image_credit, image_page}} — company newsroom / public press image (logos allowed here);
 else null → no image box.
**Rule (Adrian 2026-10-28):** never leave a story or WYNTK bullet without attempting a photo — missing public Bloomberg URL is not a reason to skip.
`method: none` is **not sticky** — every run retries missing images (same spirit as hero hires upgrade).
SLOT keys (`read:<url>` / `wrap:<url>`) still try the source URL first, then fallbacks, then reuse base.
**Publish gate:** Worth Reading (`reads`) must be full coverage; exit 1 if any read slot lacks `image_url`.
Chosen image URL is upgraded to its largest CDN variant (hires_urls — peels Yahoo mysterio→zenfs etc.); Story #1 hero saved ≤2400px q85 + -1200 variant when source ≥1600px wide (soft heroes auto-refresh next run); others resized ≤1200px wide, WebP ≤~150KB → cache/img/<YYYYMMDD>/<slug>.webp; publish.sh copies
cache/img into deploy/news/img/. Cache in data/<DATE>.json `og_images`:
 {key: {image_url (self-hosted /news/img/…|null), orig_url, image_credit, site, image_page?, method, fetched_at}}."""
import json, os, re, sys, html, io, datetime, urllib.request, urllib.parse
from urllib.parse import urlparse, unquote
from pathlib import Path
# Unset ADRRR_HOST_ROOT keeps the live digest. Tests and the installer set it.
D = Path(os.environ.get("ADRRR_HOST_ROOT", "/workspace/digest"))

def publish_mode():
    return os.environ.get("ADRRR_PUBLISH_MODE", "")

def _is_relative_to(path, parent):
    try:
        Path(path).resolve().relative_to(Path(parent).resolve())
        return True
    except ValueError:
        return False

def frozen_root():
    """Isolated digest for ADRRR_PUBLISH_MODE=frozen.

    Unset mode keeps D and ignores ADRRR_FROZEN_ROOT. ADRRR_DIGEST_DIR is the
    data directory publish.sh already passes to home-preview; it is not this root.
    """
    if publish_mode() != "frozen":
        return None
    raw = os.environ.get("ADRRR_FROZEN_ROOT", "")
    if not raw:
        raise SystemExit("frozen mode requires ADRRR_FROZEN_ROOT pointing at an isolated copy")
    root = Path(raw).resolve()
    formal = D.resolve()
    if root == formal or _is_relative_to(root, formal) or root == Path("/"):
        raise SystemExit("frozen mode refuses the formal digest root")
    return root

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,image/avif,image/webp,*/*", "Accept-Language": "en-US,en;q=0.9"}
NAMES = {"bloomberg.com": "Bloomberg", "reuters.com": "Reuters", "ft.com": "Financial Times", "cnbc.com": "CNBC",
         "wsj.com": "The Wall Street Journal", "scmp.com": "South China Morning Post", "nikkei.com": "Nikkei Asia",
         "techcrunch.com": "TechCrunch", "yahoo.com": "Yahoo Finance", "theguardian.com": "The Guardian",
         "axios.com": "Axios", "investing.com": "Investing.com", "bbc.com": "BBC", "bbc.co.uk": "BBC",
         "apnews.com": "AP News", "channelnewsasia.com": "CNA"}
BAD = re.compile(r"fallback|default|placeholder|logo", re.I)
# Hosts that routinely 403 scripted fetches — trigger auto search-copy when source has no img.
AUTO_SEARCH_HOSTS = ("bloomberg.com", "wsj.com", "ft.com")
ALLOWLIST_HOSTS = (
    "reuters.com", "yahoo.com", "cnbc.com", "ft.com", "techcrunch.com", "scmp.com",
    "theguardian.com", "axios.com", "investing.com", "bbc.com", "bbc.co.uk",
    "apnews.com", "channelnewsasia.com", "nikkei.com", "business-standard.com",
    "japantimes.co.jp", "yna.co.kr", "nationalpost.com", "businesstimes.com.sg",
    "thestar.com.my",
)
MAX_SEARCH_QUERIES = 6   # per run (room for no-link story/WYNTK title searches)
MAX_ALTS_PER_KEY = 2

def meta(page, *keys):
    for k in keys:
        for pat in (r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]*content=["\']([^"\']+)' % re.escape(k),
                    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']%s["\']' % re.escape(k)):
            m = re.search(pat, page, re.I)
            if m: return html.unescape(m.group(1)).strip()
    return None

def source_name(url):
    h = urlparse(url).netloc.lower().removeprefix("www.")
    return next((v for k, v in NAMES.items() if h.endswith(k)), h)

def host_of(url):
    return urlparse(url).netloc.lower().removeprefix("www.")

def get_bytes(url, n=6_000_000):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20).read(n)

def fetch(url):
    try: page = get_bytes(url, 1_500_000).decode("utf-8", "ignore")
    except Exception as e:
        print("WARN og fetch", url, e, file=sys.stderr); return None, None, None
    img = meta(page, "og:image", "twitter:image")
    if img and BAD.search(img): img = None
    return img, meta(page, "og:image:credit", "image:credit", "parsely-image-credit"), meta(page, "og:site_name")

def slugify(key):
    pre = ""
    # wrap:/read:/story: URL slot prefixes (story:<n> no-link handled below)
    m = re.match(r"^(wrap|read|story):(?=https?://)", key)
    if m: pre, key = m.group(1) + "-", key[m.end():]
    if key.startswith("story:"): return pre + "story-" + key[6:]  # story:<n>
    if key.startswith("wrap:point:"): return "wrap-point-" + key.rsplit(":", 1)[-1]
    s = urlparse(key).path.rstrip("/").split("/")[-1] or "img"
    return pre + re.sub(r"[^a-z0-9-]+", "-", s.lower())[:60].strip("-")

SLOT = re.compile(r"^(wrap|read|story\d*):(?=https?://)")

def src_url(key):
    """Slot keys ("wrap:<url>", "read:<url>") share the article URL but need their own image.
    Synthetic no-link keys (`story:<n>`, `wrap:point:<i>`) have no source URL."""
    k = SLOT.sub("", key)
    if k.startswith("story:") or k.startswith("wrap:point:"):
        return None
    return k

def needs_auto_search(url):
    h = host_of(url)
    return any(h.endswith(x) for x in AUTO_SEARCH_HOSTS)

def allowlisted(url):
    h = host_of(url)
    return any(h.endswith(x) for x in ALLOWLIST_HOSTS)

def title_for(d, key):
    """Best-effort English/中 title for search query from reads / stories / wrap points."""
    if key.startswith("story:"):
        try: n = int(key.split(":", 1)[1])
        except ValueError: n = None
        for s in d.get("stories") or []:
            if s.get("n") == n:
                return s.get("en") or s.get("title_en") or s.get("title") or s.get("headline")
        return None
    if key.startswith("wrap:point:"):
        try: i = int(key.rsplit(":", 1)[-1])
        except ValueError: i = None
        pts = (d.get("market_wrap") or {}).get("points") or []
        if i is not None and 0 <= i < len(pts):
            p = pts[i]
            return p.get("en") or p.get("head") or p.get("title") or p.get("text")
        return None
    u = src_url(key)
    if not u: return None
    for r in d.get("reads") or []:
        if r.get("url") == u and r.get("title"): return r["title"]
    for s in d.get("stories") or []:
        links = s.get("links") or []
        if links and links[0].get("url") == u:
            return s.get("en") or s.get("title_en") or s.get("title") or s.get("headline")
    for p in (d.get("market_wrap") or {}).get("points") or []:
        links = p.get("links") or []
        if links and links[0].get("url") == u:
            return p.get("en") or p.get("head") or p.get("title") or p.get("text")
    # URL slug words as last resort
    slug = urlparse(u).path.rstrip("/").split("/")[-1]
    return re.sub(r"[-_]+", " ", slug)

def search_query(d, key):
    t = title_for(d, key) or ""
    # Strip leading 觀點／專題 labels; keep searchable tokens
    t = re.sub(r"^(觀點|專題|分析)[：:]\s*", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > 80: t = t[:80].rsplit(" ", 1)[0]
    return t

def ddg_search(query, n=8):
    """DuckDuckGo HTML results (free, no API key). Returns list of absolute http(s) URLs."""
    if not query: return []
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    try:
        page = get_bytes(url, 500_000).decode("utf-8", "ignore")
    except Exception as e:
        print("WARN ddg search", query, e, file=sys.stderr); return []
    out, seen = [], set()
    for raw in re.findall(r'uddg=([^&"]+)', page):
        u = unquote(raw)
        if not u.startswith("http"): continue
        # strip tracking
        u = u.split("&")[0]
        if u in seen: continue
        seen.add(u); out.append(u)
        if len(out) >= n: break
    return out

def auto_discover(d, key, url, budget):
    """Find ≤MAX_ALTS_PER_KEY allowlisted alts via DDG; mutates budget['left']. Returns alt URLs.
    `url` may be None for no-link keys (`story:<n>` / `wrap:point:<i>`)."""
    if budget is None or budget.get("left", 0) <= 0:
        return []
    q = search_query(d, key)
    if not q:
        return []
    budget["left"] -= 1
    print(f"auto-search [{budget['left']} left] {key[:60]} :: {q}", file=sys.stderr)
    src_h = host_of(url) if url else ""
    alts = []
    for cand in ddg_search(q):
        if src_h and host_of(cand) == src_h: continue          # skip same-paywall host
        if not allowlisted(cand): continue
        if cand in alts: continue
        alts.append(cand)
        if len(alts) >= MAX_ALTS_PER_KEY: break
    return alts

def peel_nested_img(u):
    """Yahoo mysterio/lightyear (and similar) wrap the real asset after a resize token:
    .../resizefill_w1200;quality_80;format_webp/https%3A%2F%2Fmedia.zenfs.com%2F....jpg
    Return the inner absolute image URL, or None."""
    raw = unquote(u)
    m = re.search(r"/(https://[^\s?]+\.(?:jpe?g|png|webp|gif))(?:\?|$)", raw, re.I)
    if m and m.group(1) != raw:
        return m.group(1)
    # path may end without a clear extension after further encoding — take trailing https://…
    m = re.search(r"/(https://[^\s?]+)$", raw)
    if m and "://" in m.group(1) and m.group(1) != raw:
        return m.group(1)
    return None

def hires_urls(u):
    """Highest-resolution variants of a CDN image URL, best first (original last). Known CDNs:
    Yahoo mysterio/zenfs unwrap, insider ?width=, Bloomberg /WIDTHxHEIGHT, Reuters/CNBC/WSJ ?width=/w=/resize=,
    Guardian i.guim ?width=&s=, Getty, WordPress -300x200, cdn-cgi/image."""
    from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
    out = []
    nested = peel_nested_img(u)
    if nested:
        # Prefer the bare original (often 1600–2400), then recurse its own CDN upgrades once
        out.append(nested)
        for cand in hires_urls(nested):
            if cand != nested:
                out.append(cand)
    v = re.sub(r"^.*/cdn-cgi/image/[^/]+/(https?://)", r"\1", u)
    v = re.sub(r"-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp))(\?|$)", r"\1\2", v)
    sp = urlsplit(v); h = sp.netloc.lower(); q = parse_qsl(sp.query, keep_blank_values=True)
    SIZE = {"width", "w", "height", "h", "resize", "fit", "size", "crop", "quality", "q", "dpr", "imwidth", "auto"}
    if "bloomberg" in h or "bwbx.io" in h:
        out.append(re.sub(r"/\d{2,4}x(-1|\d{2,4})(\.\w+)$", r"/-1x-1\2", v))
    if "insider.com" in h or "cnbcfm.com" in h or "reuters.com" in h or "wsj.net" in h or "dowjones" in h:
        keep = [(k, x) for k, x in q if k.lower() not in SIZE]
        out.append(urlunsplit(sp._replace(query=urlencode(keep + [("width", "3000")]))))
        out.append(urlunsplit(sp._replace(query=urlencode(keep + [("width", "2400")]))))
    if "yimg.com" in h or "yahoo.com" in h:
        # Bump mysterio resizefill_wNNNN (raw or percent-encoded) before falling back to the soft copy
        for w in (3000, 2400, 2000):
            out.append(re.sub(r"resizefill_w\d+", f"resizefill_w{w}", v, flags=re.I))
            out.append(re.sub(r"resizefill_w%3B", f"resizefill_w{w}%3B", u, flags=re.I))  # no-op safety
            out.append(re.sub(r"resizefill_w\d+", f"resizefill_w{w}", u, flags=re.I))
    if "guim.co.uk" in h:            # signed (s=) — master/ path w/o width is unsigned-safe on media.guim
        out.append(re.sub(r"^https://i\.guim\.co\.uk/img/media/", "https://media.guim.co.uk/", sp.scheme + "://" + sp.netloc + sp.path))
        out.append(urlunsplit(sp._replace(query=urlencode([(k, ("2400" if k == "width" else x)) for k, x in q]))))
    if "gettyimages" in h:
        out.append(urlunsplit(sp._replace(query=urlencode([(k, ("2048" if k == "s" or k == "w" else x)) for k, x in q]))))
    if v != u: out.append(v)
    out.append(u)
    return list(dict.fromkeys(out))

def download(img_url):
    """Fetch the largest variant that decodes and is at least as wide as the original."""
    import hashlib
    from PIL import Image
    best = None
    for cand in hires_urls(img_url):
        try:
            im = Image.open(io.BytesIO(get_bytes(cand, 25_000_000))); im.load()
        except Exception: continue
        if not best or im.width > best.width: best = im
        if best.width >= 2400: break
    if best is None: raise RuntimeError("no variant decoded")
    im = best.convert("RGB")
    h = hashlib.sha1(im.resize((16, 16)).tobytes()).hexdigest()   # content hash (survives resize/re-encode differences)
    return im, h

def _webp(im, w, qs, cap):
    from PIL import Image
    if im.width > w: im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    for q in qs:
        buf = io.BytesIO(); im.save(buf, "WEBP", quality=q, method=6)
        if buf.tell() <= cap: break
    return buf

def srcset_1200_url(image_url):
    """Self-hosted hero may be `<slug>.webp` or `<slug>-2000.webp`; the 1200w sibling is always `<slug>-1200.webp`."""
    if not image_url or not image_url.endswith('.webp'):
        return None
    base = image_url[:-5]
    base = re.sub(r'-(?:(?:16|18|20|24)00|2k)$', '', base)
    return base + '-1200.webp'

def save_webp(im, compact, slug, hero=False):
    """Normal slots: ≤1200px, ≤~150KB. hero=True (Story #1 → latest.json/landing): ≤2400px q85 (≤~600KB)
    + a <slug>-1200.webp variant for srcset.
    Hero masters use `<slug>-{w}.webp` when w≥1600 so a same-day soft→hires upgrade gets a new URL
    (Cloudflare Pages edge often keeps the old soft bytes if the path is unchanged and purge is unavailable)."""
    out_dir = D / "cache" / "img" / compact
    out_dir.mkdir(parents=True, exist_ok=True)
    if hero:
        buf = _webp(im, 2400, (85, 80, 75, 70), 600_000)
        # Decode width after the ≤2400 resize inside _webp — approximate from im
        w = min(im.width, 2400)
        hero_slug = f"{slug}-{w}" if w >= 1600 else slug
        out = out_dir / f"{hero_slug}.webp"
        (out_dir / f"{slug}-1200.webp").write_bytes(_webp(im, 1200, (85, 80, 70), 200_000).getvalue())
        # Also keep bare slug → same bytes only when first write; never overwrite a smaller existing bare slug in place
    else:
        buf = _webp(im, 1200, (80, 70, 60, 50, 40), 150_000)
        out = out_dir / f"{slug}.webp"
        hero_slug = slug
    out.write_bytes(buf.getvalue())
    (out_dir / "orig").mkdir(exist_ok=True); (out_dir / "orig" / out.name).write_bytes(buf.getvalue())   # uncropped (smartcrop.py)
    return f"/news/img/{compact}/{out.name}"

def persist_fallback(d, key, alt):
    fb = d.setdefault("og_fallback", {})
    lst = list(fb.get(key) or [])
    if alt not in lst:
        lst.append(alt)
        fb[key] = lst

def candidates(d, key, search_budget=None):
    url = src_url(key)
    credit_ovr = (d.get("og_credit") or {}).get(key)
    source_img = False
    # 1. Always try source — including SLOT keys (read:/wrap:) so prefixed Worth Reading still gets a real fetch
    if url:
        img, credit, site = fetch(url)
        if img:
            source_img = True
            yield dict(orig_url=img, image_credit=credit_ovr or credit or site or source_name(url),
                       site=site or source_name(url), method="source")
    # 2. Existing og_fallback alts
    for alt in (d.get("og_fallback") or {}).get(key) or []:
        img, credit, site = fetch(alt)
        if img: yield dict(orig_url=img, image_credit=credit_ovr or credit or site or source_name(alt),
                           site=site or source_name(alt), image_page=alt, method="search-copy")
    # 3. Auto search-copy: Bloomberg/WSJ/FT with no img, OR no-link key (story:<n> / wrap:point:<i>)
    want_search = (not source_img) and ((not url) or needs_auto_search(url))
    if want_search:
        existing = set((d.get("og_fallback") or {}).get(key) or [])
        # Also try base-key fallbacks for SLOT keys before searching
        if url and SLOT.match(key):
            for alt in (d.get("og_fallback") or {}).get(src_url(key)) or []:
                if alt in existing: continue
                img, credit, site = fetch(alt)
                if img:
                    persist_fallback(d, key, alt)
                    yield dict(orig_url=img, image_credit=credit_ovr or credit or site or source_name(alt),
                               site=site or source_name(alt), image_page=alt, method="search-copy")
        alts = auto_discover(d, key, url, search_budget)
        for alt in alts:
            if alt in existing: continue
            img, credit, site = fetch(alt)
            if img:
                persist_fallback(d, key, alt)
                yield dict(orig_url=img, image_credit=credit_ovr or credit or site or source_name(alt),
                           site=site or source_name(alt), image_page=alt, method="search-copy")
    # 4. Manual press images
    ms = (d.get("og_manual") or {}).get(key)
    for m in ([ms] if isinstance(ms, dict) else ms or []):
        if m.get("image_url"):
            yield dict(orig_url=m["image_url"], image_credit=m.get("image_credit"), site=m.get("site") or source_name(m.get("image_page") or m["image_url"]),
                       image_page=m.get("image_page"), method="press")
    # 5. Last resort for a slot: reuse the base story's image
    if SLOT.match(key):
        base = (d.get("og_images") or {}).get(src_url(key))
        if base and base.get("orig_url"): yield dict({k: base[k] for k in base if k not in ("image_url", "hash", "fetched_at")}, method="reuse")

def is_hero(d, key):
    st = sorted(d.get("stories") or [], key=lambda x: x.get("n", 99))
    return bool(st) and key == story_key(st[0])

def get(d, key, refresh=False, seen=None, search_budget=None):
    """Cached/resolved entry for key; mutates d['og_images'] (caller saves d). `seen` = image hashes already used on
    the page: a candidate whose content hash is already used is skipped (unless method=reuse). Never raises.
    `method: none` (or missing image_url) is NOT sticky — retries every run unless the entry already has an image."""
    if publish_mode() == "frozen":
        # Cached entry only. No hero upgrade, no fetch, no fetched_at rewrite.
        e = (d.get("og_images") or {}).get(key)
        if not isinstance(e, dict) or not e.get("image_url") or e.get("method") == "none":
            raise SystemExit(f"frozen mode has no cached image for {key}")
        return e
    cache = d.setdefault("og_images", {}); seen = seen if seen is not None else set()
    e = cache.get(key)
    if e and not refresh and is_hero(d, key) and e.get("image_url"):
        # Upgrade when missing hires flag OR claimed-hires but still soft (Yahoo w1200 etc. left size≤1200)
        sz = (e.get("size") or [0])[0] or 0
        if (not e.get("hires")) or sz < 1600:
            refresh = True
    # Sticky-none fix: missing / method=none always re-resolves (do not early-return)
    if e and not refresh and e.get("image_url") and e.get("method") != "none":
        if e.get("hash") and (e["hash"] not in seen or e.get("method") == "reuse"):
            seen.add(e["hash"]); return e
        if not e.get("hash"):
            return e
    compact = d["date"].replace("-", ""); r = None; low = None
    for c in candidates(d, key, search_budget):
        try: im, h = download(c["orig_url"])
        except Exception as ex: print("WARN download", c["orig_url"], ex, file=sys.stderr); continue
        if h in seen and c["method"] != "reuse": print("dup image skipped", key, c["orig_url"], file=sys.stderr); continue
        if im.width < 600 and c["method"] != "reuse": print("low-res skipped", key, im.size, file=sys.stderr); low = low or (c, im, h); continue
        hero = is_hero(d, key) and im.width >= 1600
        c["hash"] = h; c["image_url"] = save_webp(im, compact, slugify(key), hero); c["size"] = [min(im.width, 2400 if hero else 1200)]; c["hires"] = hero; r = c; seen.add(h); break
    if not r and low:                                   # only low-res candidates: better than nothing
        c, im, h = low; hero = is_hero(d, key) and im.width >= 1600
        c["hash"] = h; c["image_url"] = save_webp(im, compact, slugify(key), hero); c["size"] = [min(im.width, 2400 if hero else 1200)]; c["hires"] = hero; r = c; seen.add(h)
    if not r:
        u = src_url(key)
        r = {"image_url": None, "orig_url": None, "image_credit": None, "site": source_name(u) if u else None, "method": "none"}
    r["fetched_at"] = datetime.datetime.now().isoformat(timespec="seconds")
    cache[key] = r; return r

def story_key(s):
    u = (s.get("links") or [{}])[0].get("url")
    return u or f"story:{s.get('n')}"

def targets(d):
    """Ordered page slots → keys. Stories first (latest.json uses Story #1's key), then EVERY Market Wrap /
    What-you-need-to-know point (linked → first URL; no link → `wrap:point:<i>` for title search), then Worth Reading.
    A URL already used by an earlier slot gets a slot-prefixed key (`wrap:<url>` / `read:<url>`) so that spot
    gets its own distinct image. build_site.slot_keys mirrors this: wrap → one key per point (linked or not)."""
    out, used = [], set()
    def add(slot, u):
        k = u if u not in used else f"{slot}:{u}"
        used.add(u); out.append(k)
    for s_ in sorted(d.get("stories") or [], key=lambda x: x.get("n", 99)): add("story", story_key(s_))
    # Every WYNTK / market_wrap point — no-link bullets still get a photo slot
    for i, p in enumerate((d.get("market_wrap") or {}).get("points") or []):
        links = p.get("links") or []
        u = links[0].get("url") if links else None
        if u:
            add("wrap", u)
        else:
            k = f"wrap:point:{i}"
            if k not in used:
                used.add(k); out.append(k)
    for r in d.get("reads") or []:
        if r.get("url"): add("read", r["url"])
    return out

def read_keys(d):
    """Worth Reading slot keys only (same prefixing rules as targets)."""
    used = set()
    for s_ in sorted(d.get("stories") or [], key=lambda x: x.get("n", 99)):
        used.add(story_key(s_))
    for i, p in enumerate((d.get("market_wrap") or {}).get("points") or []):
        links = p.get("links") or []
        u = links[0].get("url") if links else None
        used.add(u if u else f"wrap:point:{i}")
    out = []
    for r in d.get("reads") or []:
        u = r.get("url")
        if not u: continue
        k = u if u not in used else f"read:{u}"
        used.add(u); out.append(k)
    return out

if __name__ == "__main__":
    date = sys.argv[1]; p = D / "data" / f"{date}.json"; d = json.loads(p.read_text())
    t = targets(d); ok = 0; seen = set()
    budget = {"left": MAX_SEARCH_QUERIES}
    for k in t:
        e = get(d, k, "--refresh" in sys.argv, seen, budget); ok += bool(e["image_url"])
        print(f'{e.get("method"):12} {k[:70]:72} -> {e["image_url"]} | {e.get("image_credit")}')
    hs = [d["og_images"][k].get("hash") for k in t if d["og_images"][k].get("hash")]
    print(f"coverage {ok}/{len(t)} | distinct images {len(set(hs))}/{len(hs)}")
    rk = read_keys(d)
    rok = sum(1 for k in rk if (d.get("og_images") or {}).get(k, {}).get("image_url"))
    print(f"reads_coverage {rok}/{len(rk)}")
    d["og_slots"] = t
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
    if rk and rok < len(rk):
        print(f"FAIL: Worth Reading photo coverage {rok}/{len(rk)} — fix og_fallback before publish", file=sys.stderr)
        sys.exit(1)
