"""One recent Traditional Chinese headline per stock, from Google News Hong Kong RSS.

Standard library only. Headlines or sources that name a quote vendor are never
returned, and a headline must contain Chinese text.

Freshness is a hard rule: a headline is used only when its publication time
parses, is not in the future, and is at most 72 hours old at `now` (Hong Kong
time). The RSS query also carries `when:1d` / `when:3d`, but the post-filter is
what guarantees the rule. Same-day (HKT calendar day) headlines win over older
ones. There is no fallback to older news: no match means no headline.
"""

from __future__ import annotations

import re
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

from hk_movers_names import has_cjk, short_code

HKT = timezone(timedelta(hours=8))
RSS_URL = "https://news.google.com/rss/search?q={query}&hl=zh-HK&gl=HK&ceid=HK:zh-Hant"
BANNED = re.compile(r"futu|富途|moomoo|yahoo|雅虎", re.IGNORECASE)
MAX_ITEMS = 20
MAX_AGE_HOURS = 72
MAX_AGE_SECONDS = MAX_AGE_HOURS * 3600
WINDOWS = ("1d", "3d")
HKT_STAMP = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$")


def rss_url(code: str, name: str, window: str = "3d") -> str:
    query = f"{short_code(code).lstrip('0') or '0'} {name} when:{window}".strip()
    return RSS_URL.format(query=urllib.parse.quote_plus(query))


def parse_hkt_stamp(text: str) -> float:
    """Strict "YYYY-MM-DD HH:MM[:SS]" (Hong Kong time) -> epoch seconds. 0.0 when missing or not a real date."""
    m = HKT_STAMP.match(str(text or "").strip())
    if not m:
        return 0.0
    year, month, day, hour, minute, second = (int(g or 0) for g in m.groups())
    try:
        return datetime(year, month, day, hour, minute, second, tzinfo=HKT).timestamp()
    except ValueError:
        return 0.0


def _now_epoch(now: datetime | float | None) -> float:
    if now is None:
        return datetime.now(HKT).timestamp()
    return now.timestamp() if isinstance(now, datetime) else float(now)


def is_fresh(epoch: float, now: datetime | float | None = None) -> bool:
    """True for 0 <= age <= 72 hours. Missing (0), future and older timestamps are rejected."""
    if not epoch or epoch <= 0:
        return False
    age = _now_epoch(now) - epoch
    return 0 <= age <= MAX_AGE_SECONDS


def hkt_day(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, HKT).strftime("%Y-%m-%d")


def is_same_day(epoch: float, now: datetime | float | None = None) -> bool:
    return bool(epoch) and hkt_day(epoch) == hkt_day(_now_epoch(now))


def _download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (news-chart hk-movers)"})
    with urllib.request.urlopen(req, timeout=10) as res:
        return res.read()


def is_banned(*texts: str) -> bool:
    return any(BANNED.search(t or "") for t in texts)


def strip_outlet(title: str, source: str) -> str:
    """Google appends " - 媒體名" to every title."""
    title = title.strip()
    if source and title.endswith(f" - {source}"):
        return title[: -len(source) - 3].rstrip()
    head, sep, tail = title.rpartition(" - ")
    return head.rstrip() if sep and head and len(tail) <= 24 else title


def to_hkt_stamp(pub_date: str) -> tuple[str, float]:
    """RFC 822 pubDate -> ("YYYY-MM-DD HH:MM" in HKT, epoch seconds). ("", 0) when unreadable."""
    try:
        dt = parsedate_to_datetime(pub_date)
    except (TypeError, ValueError):
        return "", 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(HKT).strftime("%Y-%m-%d %H:%M"), dt.timestamp()


def parse_items(xml_bytes: bytes) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    items = []
    for node in root.iter("item"):
        source_el = node.find("source")
        source = (source_el.text or "").strip() if source_el is not None else ""
        source_url = source_el.get("url", "") if source_el is not None else ""
        raw_title = (node.findtext("title") or "").strip()
        link = (node.findtext("link") or "").strip()
        stamp, epoch = to_hkt_stamp(node.findtext("pubDate") or "")
        items.append({
            "title": strip_outlet(raw_title, source), "raw_title": raw_title, "source": source,
            "source_url": source_url, "url": link, "published_at_hkt": stamp, "epoch": epoch,
        })
    return items


def pick_item(items: list[dict], name: str = "", now: datetime | float | None = None) -> dict | None:
    """Best usable headline among the first results, or None.

    Usable = http(s) link, source present, Chinese title, no vendor wording, and fresh (see is_fresh).
    Preference: same HKT day, then a title that mentions the stock, then the newest.
    """
    usable = []
    for it in items[:MAX_ITEMS]:
        if not it["title"] or not it["source"] or not it["url"].startswith(("http://", "https://")):
            continue
        if is_banned(it["raw_title"], it["title"], it["source"], it["source_url"], it["url"]):
            continue
        if not has_cjk(it["title"]):
            continue
        if not is_fresh(it["epoch"], now):
            continue
        usable.append(it)
    if not usable:
        return None
    best = max(usable, key=lambda it: (is_same_day(it["epoch"], now), bool(name and name in it["title"]), it["epoch"]))
    return {"title": best["title"], "source": best["source"], "published_at_hkt": best["published_at_hkt"], "url": best["url"]}


def fetch_news(code: str, name: str, *, fetch=_download, now: datetime | float | None = None) -> dict | None:
    """Same-day news first (`when:1d`), then the 72-hour window (`when:3d`). Returns None when nothing is fresh."""
    pool: list[dict] = []
    seen: set[str] = set()
    best = None
    for window in WINDOWS:
        try:
            items = parse_items(fetch(rss_url(code, name, window)))
        except Exception:  # one failed lookup must not stop the run
            continue
        for it in items:
            if it["url"] not in seen:
                seen.add(it["url"])
                pool.append(it)
        best = pick_item(pool, name, now)
        if best and is_same_day(parse_hkt_stamp(best["published_at_hkt"]), now):
            return best
    return best


def usable_backup(item: dict | None, now: datetime | float | None = None) -> dict | None:
    """Gate for a headline from another source: Chinese text, http(s) link, no vendor wording, fresh timestamp."""
    if not item:
        return None
    title = str(item.get("title") or "")
    url = str(item.get("url") or "")
    if not has_cjk(title) or not url.startswith(("http://", "https://")):
        return None
    if is_banned(title, str(item.get("source") or ""), url):
        return None
    if not is_fresh(parse_hkt_stamp(item.get("published_at_hkt")), now):
        return None
    return item


def keep_fresh(news: dict[str, dict], now: datetime | float | None = None) -> dict[str, dict]:
    """Final gate on a code -> headline map: drops anything missing, future or older than 72 hours."""
    return {code: item for code, item in news.items()
            if is_fresh(parse_hkt_stamp(item.get("published_at_hkt")), now)}
