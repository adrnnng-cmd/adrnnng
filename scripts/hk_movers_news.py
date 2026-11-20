"""One latest Traditional Chinese headline per stock, from Google News Hong Kong RSS.

Standard library only. Headlines or sources that name a quote vendor are never
returned, and a headline must contain Chinese text.
"""

from __future__ import annotations

import re
import urllib.parse
import urllib.request
from datetime import timedelta, timezone
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

from hk_movers_names import has_cjk, short_code

HKT = timezone(timedelta(hours=8))
RSS_URL = "https://news.google.com/rss/search?q={query}&hl=zh-HK&gl=HK&ceid=HK:zh-Hant"
BANNED = re.compile(r"futu|富途|moomoo|yahoo|雅虎", re.IGNORECASE)
MAX_ITEMS = 10


def rss_url(code: str, name: str) -> str:
    query = f"{short_code(code).lstrip('0') or '0'} {name}".strip()
    return RSS_URL.format(query=urllib.parse.quote_plus(query))


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


def pick_item(items: list[dict], name: str = "") -> dict | None:
    """Newest usable headline among the first results; headlines that mention the stock win."""
    usable = []
    for it in items[:MAX_ITEMS]:
        if not it["title"] or not it["source"] or not it["url"].startswith(("http://", "https://")):
            continue
        if is_banned(it["raw_title"], it["title"], it["source"], it["source_url"], it["url"]):
            continue
        if not has_cjk(it["title"]):
            continue
        usable.append(it)
    if not usable:
        return None
    named = [it for it in usable if name and name in it["title"]]
    pool = named or usable
    best = max(pool, key=lambda it: it["epoch"])
    return {"title": best["title"], "source": best["source"], "published_at_hkt": best["published_at_hkt"], "url": best["url"]}


def fetch_news(code: str, name: str, *, fetch=_download) -> dict | None:
    try:
        items = parse_items(fetch(rss_url(code, name)))
    except Exception:  # one failed lookup must not stop the run
        return None
    return pick_item(items, name)


def usable_backup(item: dict | None) -> dict | None:
    """Gate for a headline from another source: Chinese text, http(s) link, no vendor wording."""
    if not item:
        return None
    title = str(item.get("title") or "")
    url = str(item.get("url") or "")
    if not has_cjk(title) or not url.startswith(("http://", "https://")):
        return None
    if is_banned(title, str(item.get("source") or ""), url):
        return None
    return item
