#!/usr/bin/env python3
"""HK Movers collector (reference implementation).

Runs on a machine that already has a local OpenD gateway. It builds the JSON
document described in scripts/hk-movers/schema.json and either writes it to a
file or pushes it to the Cloudflare KV key read by
functions/hk-movers/data/latest.js.

    python3 scripts/hk_movers_sync.py --out /tmp/hk-movers-latest.json
    python3 scripts/hk_movers_sync.py --push-kv          # needs HK_MOVERS_KV_NAMESPACE_ID

Design notes (verified against a LV1 OpenD at 127.0.0.1:11111, futu-api 10.12.7208):
  * Never call get_stock_quote; it needs subscription quota. Use snapshots.
  * get_plate_stock('HK.800000') returns about 95 Hang Seng Index constituents.
  * get_market_snapshot takes at most 400 codes per call and has no change_rate
    column. change % = (last_price / prev_close_price - 1) * 100.
  * get_stock_filter has no CHANGE_RATE / VOLUME filter, and the top 100 of
    get_top_movers_rank misses most mid-change, high-turnover shares. The main
    flow therefore snapshots every share from get_stock_basicinfo(SecurityType.STOCK)
    (about 2,800 codes, 8 calls, a few seconds) plus the HSI constituents and
    filters by turnover and market cap locally. get_top_movers_rank is only the
    fallback when that share list is empty. The rank call's `amplitude` is 10x
    the snapshot scale, so amplitude is recomputed from the snapshot
    (high - low) / prev_close.
  * get_owner_plate is called only for HSI constituents and qualifying shares
    that are in the SecurityType.STOCK list. It rejects REITs and ETFs ("does
    not support ETFs type"), so REITs (exchange 分類 = 房地產投資信託基金) are
    labelled "REITs" without a call, and a failing batch is bisected to skip
    the offending code. Its rows carry plate_type "OTHER" for the 113 industry
    plates, so industry rows are matched by plate_type INDUSTRY or by a plate
    name that get_heat_map_data / the sector map knows.
  * Snapshot DataFrames hold NaN; every numeric read goes through _num().
  * get_heat_map_data(Market.HK, count=200) returns a 4-tuple
    (ret, df, None, total_count) with about 113 industry plates.
  * get_top_movers_rank(market, sort_dir, count, offset, filter_list) takes
    RankSortDir.DESCENDING / ASCENDING and returns (0, (all_count, df)); the
    code column is "security". Candidates are limited to HK$ equities
    (00001-09999, listed as shares), so RMB counters, ETFs and leveraged
    products cannot crowd the lists.
  * Plate names from get_heat_map_data and get_owner_plate are English. The
    sector map translates them to Traditional Chinese and groups them.
  * Snapshot names and get_search_news headlines are English. Names come from
    the exchange's Traditional Chinese securities list (hk_movers_names.py);
    headlines come from Google News Hong Kong RSS (hk_movers_news.py), and
    anything that names a quote vendor is dropped.

The OpenD adapters at the bottom (heat map, top movers, news, owner plate) are
thin and isolated: field names differ between SDK releases, so check them
against the installed SDK. Everything above them is pure and unit-tested.
No credentials are hard-coded. Host, port and the KV namespace id come from
environment variables or flags.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hk_movers_names as names_mod  # noqa: E402
import hk_movers_news as news_mod  # noqa: E402

SCHEMA_VERSION = 1
KV_KEY = "hk-movers:latest.json"
HKT = timezone(timedelta(hours=8))
MIN_TURNOVER_HKD = 10_000_000
MIN_MARKET_CAP_HKD = 1_000_000_000
TOP_N = 10
HSI_PLATE = "HK.800000"
SNAPSHOT_CHUNK = 400
SECTOR_MAP_PATH = Path(__file__).resolve().parent / "hk-movers" / "sector-map.json"

SESSIONS = ("pre_open", "morning", "lunch", "afternoon", "closing_auction", "closed")


# ---------------------------------------------------------------- pure helpers


def load_sector_map(path: Path = SECTOR_MAP_PATH) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class SectorMapper:
    """Industry name -> macro sector id and Traditional Chinese display name.

    Lookup order: the English plate names (case-insensitive), the Chinese names,
    then keywords, then the fallback sector.
    """

    def __init__(self, sector_map: dict):
        self.names = {s["id"]: s["name"] for s in sector_map["sectors"]}
        self.order = [s["id"] for s in sector_map["sectors"]]
        self.exact = {}
        for sector in sector_map["sectors"]:
            for industry in sector["industries"]:
                self.exact[industry] = sector["id"]
        self.english = {e["en"].casefold(): (e["zh"], e["sector"]) for e in sector_map.get("english", [])}
        self.keywords = [(kw.casefold(), sid) for kw, sid in sector_map.get("keywords", [])]
        self.fallback = sector_map.get("fallback", "other")
        self.unmapped: set[str] = set()

    def sector_for(self, industry: str | None) -> str:
        name = (industry or "").strip()
        hit = self.english.get(name.casefold())
        if hit:
            return hit[1]
        if name in self.exact:
            return self.exact[name]
        folded = name.casefold()
        for keyword, sector_id in self.keywords:
            if keyword and keyword in folded:
                return sector_id
        if name:
            self.unmapped.add(name)
        return self.fallback

    def knows(self, industry: str | None) -> bool:
        """True for a plate name the map recognises exactly (English plate, Chinese name or Chinese plate)."""
        name = (industry or "").strip()
        return bool(name) and (name.casefold() in self.english or name in self.exact)

    def industry_zh(self, industry: str | None) -> str:
        """Traditional Chinese industry name. Unknown English names show as 其他 and are recorded."""
        name = (industry or "").strip()
        hit = self.english.get(name.casefold())
        if hit:
            return hit[0]
        if names_mod.has_cjk(name):
            return name
        if name:
            self.unmapped.add(name)
        return "其他"


def normalize_code(code: str) -> str:
    """'HK.00700' -> '00700'. News search wants this short form."""
    text = str(code).strip()
    if "." in text:
        text = text.split(".", 1)[1]
    return text.zfill(5)


def change_pct(last: float, prev_close: float) -> float | None:
    last, prev_close = _num(last, math.nan), _num(prev_close, math.nan)
    if math.isnan(last) or math.isnan(prev_close) or prev_close <= 0:
        return None
    return (last / prev_close - 1.0) * 100.0


def amplitude_pct(high: float, low: float, prev_close: float) -> float | None:
    high, low, prev_close = _num(high, math.nan), _num(low, math.nan), _num(prev_close, math.nan)
    if math.isnan(high) or math.isnan(low) or math.isnan(prev_close) or prev_close <= 0:
        return None
    return (high - low) / prev_close * 100.0


def impact_hkd(pct: float, market_cap: float) -> float:
    """Approximate impact: change % x total market cap, as an HK$ market-cap change."""
    return _num(pct) / 100.0 * _num(market_cap)


def qualifies(turnover: float, market_cap: float,
              min_turnover: float = MIN_TURNOVER_HKD,
              min_market_cap: float = MIN_MARKET_CAP_HKD) -> bool:
    return _num(turnover) >= min_turnover and _num(market_cap) > min_market_cap


def market_session(now: datetime) -> str:
    """Weekday HKT schedule. Public holidays are not modelled; a holiday reads as a normal day."""
    now = now.astimezone(HKT)
    if now.weekday() >= 5:
        return "closed"
    minutes = now.hour * 60 + now.minute
    if 9 * 60 <= minutes < 9 * 60 + 30:
        return "pre_open"
    if 9 * 60 + 30 <= minutes < 12 * 60:
        return "morning"
    if 12 * 60 <= minutes < 13 * 60:
        return "lunch"
    if 13 * 60 <= minutes < 16 * 60:
        return "afternoon"
    if 16 * 60 <= minutes < 16 * 60 + 10:
        return "closing_auction"
    return "closed"


def _num(value, default: float = 0.0) -> float:
    """Finite float, or `default` for None, NaN, +/-Inf and anything non-numeric (pandas NaN is truthy)."""
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _r(value: float | None, digits: int):
    if value is None or (isinstance(value, float) and (math.isnan(value) or math.isinf(value))):
        return None
    return round(float(value), digits)


def build_stock(raw: dict, mapper: SectorMapper) -> dict | None:
    """Normalise one snapshot row. Returns None when the row cannot be priced."""
    prev = _num(raw.get("prev_close_price"))
    last = _num(raw.get("last_price"))
    pct = change_pct(last, prev)
    if pct is None or last <= 0:
        return None
    mcap = _num(raw.get("total_market_val"))
    turnover = _num(raw.get("turnover"))
    plate = str(raw.get("industry") or "").strip()
    row = {
        "code": normalize_code(raw["code"]),
        "name": str(raw.get("name_tc") or raw.get("name") or raw.get("stock_name") or "").strip(),
        "sector": mapper.sector_for(plate),
        "industry": mapper.industry_zh(plate),
        "last": _r(last, 3),
        "prev_close": _r(prev, 3),
        "change_pct": _r(pct, 4),
        "turnover_hkd": _r(turnover, 0),
        "market_cap_hkd": _r(mcap, 0),
        "impact_hkd": _r(impact_hkd(pct, mcap), 0),
    }
    amp = amplitude_pct(raw.get("high_price"), raw.get("low_price"), prev)
    if amp is not None:
        row["amplitude_pct"] = _r(amp, 3)
    return row


def is_flat(pct: float) -> bool:
    return round(_num(pct), 2) == 0


def breadth(rows: list[dict]) -> dict:
    up = sum(1 for r in rows if not is_flat(r.get("change_pct")) and _num(r.get("change_pct")) > 0)
    down = sum(1 for r in rows if not is_flat(r.get("change_pct")) and _num(r.get("change_pct")) < 0)
    return {"up": up, "down": down, "flat": len(rows) - up - down}


def rank(rows: list[dict], direction: str, limit: int = TOP_N) -> list[dict]:
    def pct(r):
        return _num(r.get("change_pct"))

    def turnover(r):
        return _num(r.get("turnover_hkd"))

    if direction == "up":
        pool = [r for r in rows if not is_flat(pct(r)) and pct(r) > 0]
        pool.sort(key=lambda r: (-pct(r), -turnover(r), r["code"]))
    else:
        pool = [r for r in rows if not is_flat(pct(r)) and pct(r) < 0]
        pool.sort(key=lambda r: (pct(r), -turnover(r), r["code"]))
    return pool[:limit]


def normalize_heatmap_row(row: dict) -> dict | None:
    """Tolerant reader for one get_heat_map_data row. Field names vary by SDK release."""

    def pick(*names, default=None):
        for name in names:
            if name in row and row[name] is not None:
                return row[name]
        return default

    name = pick("plate_name", "name", "industry")
    if not name:
        return None
    return {
        "name": str(name).strip(),
        "change_pct": _num(pick("change_rate", "change_pct", "pct", default=0)),
        "turnover_hkd": _num(pick("turnover", "amount", default=0)),
        "market_cap_hkd": _num(pick("total_market_val", "market_val", "market_cap", default=0)),
        "up": pick("up_count", "rise_count", "up"),
        "down": pick("down_count", "fall_count", "down"),
        "flat": pick("flat_count", "equal_count", "flat"),
    }


def _leader(row: dict) -> dict:
    return {"code": row["code"], "name": row["name"], "change_pct": row["change_pct"]}


def industries_from_stocks(stocks: list[dict]) -> list[dict]:
    """Fallback when no heat map is available: group the stock list by industry."""
    groups: dict[str, list[dict]] = {}
    for row in stocks:
        groups.setdefault(row["industry"], []).append(row)
    out = []
    for name, rows in groups.items():
        mcap = sum(r["market_cap_hkd"] for r in rows)
        weighted = (sum(r["change_pct"] * r["market_cap_hkd"] for r in rows) / mcap) if mcap else 0.0
        counts = breadth(rows)
        out.append({
            "name": name,
            "change_pct": weighted,
            "turnover_hkd": sum(r["turnover_hkd"] for r in rows),
            "market_cap_hkd": mcap,
            **counts,
        })
    return out


def localize_industries(industries: list[dict], mapper: SectorMapper) -> list[dict]:
    """Translate plate names to Traditional Chinese and merge rows that end up with the same name."""
    merged: dict[str, dict] = {}
    for ind in industries:
        zh = mapper.industry_zh(ind["name"])
        acc = merged.get(zh)
        if acc is None:
            acc = merged[zh] = {"name": zh, "turnover_hkd": 0.0, "market_cap_hkd": 0.0, "_weighted": 0.0,
                                "up": 0, "down": 0, "flat": 0, "_counts": True}
        acc["turnover_hkd"] += ind["turnover_hkd"]
        acc["market_cap_hkd"] += ind["market_cap_hkd"]
        acc["_weighted"] += ind["change_pct"] * ind["market_cap_hkd"]
        for key in ("up", "down", "flat"):
            if ind.get(key) is None:
                acc["_counts"] = False
            elif acc["_counts"]:
                acc[key] += int(ind[key])
    out = []
    for acc in merged.values():
        cap = acc["market_cap_hkd"]
        row = {"name": acc["name"], "turnover_hkd": acc["turnover_hkd"], "market_cap_hkd": cap,
               "change_pct": acc["_weighted"] / cap if cap else 0.0}
        for key in ("up", "down", "flat"):
            row[key] = acc[key] if acc["_counts"] else None
        out.append(row)
    return out


def build_macro_sectors(industries: list[dict], stocks: list[dict], mapper: SectorMapper) -> list[dict]:
    by_industry: dict[str, list[dict]] = {}
    for row in stocks:
        by_industry.setdefault(row["industry"], []).append(row)

    sectors: dict[str, dict] = {}
    for ind in industries:
        sector_id = mapper.sector_for(ind["name"])
        members = by_industry.get(ind["name"], [])
        counts = breadth(members) if members else {"up": 0, "down": 0, "flat": 0}
        up = ind["up"] if ind.get("up") is not None else counts["up"]
        down = ind["down"] if ind.get("down") is not None else counts["down"]
        flat = ind["flat"] if ind.get("flat") is not None else counts["flat"]
        leaders = [_leader(r) for r in rank(members, "up", 3)]
        entry = sectors.setdefault(sector_id, {"industries": []})
        entry["industries"].append({
            "name": ind["name"],
            "change_pct": _r(ind["change_pct"], 4),
            "turnover_hkd": _r(ind["turnover_hkd"], 0),
            "market_cap_hkd": _r(ind["market_cap_hkd"], 0),
            "up": int(up), "down": int(down), "flat": int(flat),
            "leaders": leaders,
        })

    out = []
    for sector_id in mapper.order:
        entry = sectors.get(sector_id)
        if not entry:
            continue
        inds = entry["industries"]
        inds.sort(key=lambda i: -i["turnover_hkd"])
        mcap = sum(i["market_cap_hkd"] for i in inds)
        weighted = (sum(i["change_pct"] * i["market_cap_hkd"] for i in inds) / mcap) if mcap else 0.0
        members = [r for r in stocks if r["sector"] == sector_id]
        best = rank(members, "up", 1)
        out.append({
            "id": sector_id,
            "name": mapper.names[sector_id],
            "change_pct": _r(weighted, 4),
            "turnover_hkd": _r(sum(i["turnover_hkd"] for i in inds), 0),
            "market_cap_hkd": _r(mcap, 0),
            "up": sum(i["up"] for i in inds),
            "down": sum(i["down"] for i in inds),
            "flat": sum(i["flat"] for i in inds),
            "leader": _leader(best[0]) if best else None,
            "industries": inds,
        })
    return out


def build_snapshot(*, now: datetime, hsi_index: dict | None, hsi_rows: list[dict],
                   stocks: list[dict], industries: list[dict] | None, news: dict | None,
                   mapper: SectorMapper, universe_count: int | None = None,
                   data_source: str = "live", notice: str | None = None,
                   min_turnover: float = MIN_TURNOVER_HKD,
                   min_market_cap: float = MIN_MARKET_CAP_HKD,
                   session: str | None = None) -> dict:
    """Assemble the public document. `hsi_rows` and `stocks` are build_stock() outputs."""
    now = now.astimezone(HKT)
    qualified = [r for r in stocks if qualifies(r["turnover_hkd"], r["market_cap_hkd"], min_turnover, min_market_cap)]
    qualified.sort(key=lambda r: -r["turnover_hkd"])
    hsi_rows = sorted(hsi_rows, key=lambda r: -r["market_cap_hkd"])

    hsi_mcap = sum(r["market_cap_hkd"] for r in hsi_rows)
    hsi_weighted = (sum(r["change_pct"] * r["market_cap_hkd"] for r in hsi_rows) / hsi_mcap) if hsi_mcap else 0.0
    index = dict(hsi_index or {})
    prev = index.get("prev_close")
    if index.get("last") is None and prev:
        index["last"] = prev * (1 + hsi_weighted / 100.0)
    if index.get("last") is not None and prev:
        index["change"] = index["last"] - prev
        index["change_pct"] = (index["last"] / prev - 1) * 100.0
    index.setdefault("name", "恒生指數")
    hsi_turnover = index.pop("turnover_hkd", None)
    if hsi_turnover is None:
        hsi_turnover = sum(r["turnover_hkd"] for r in hsi_rows)

    # Sector leaders and counts come from the qualified list, so the sector panel obeys the same filter as the rankings.
    macro = build_macro_sectors(
        localize_industries(industries, mapper) if industries else industries_from_stocks(qualified), qualified, mapper)
    movers = {
        "hsi": {"gainers": rank(hsi_rows, "up"), "losers": rank(hsi_rows, "down")},
        "hk": {"gainers": rank(qualified, "up"), "losers": rank(qualified, "down")},
    }
    known = {r["code"] for r in hsi_rows} | {r["code"] for r in qualified}
    kept_news = {code: item for code, item in (news or {}).items() if code in known and item}

    doc = {
        "schema_version": SCHEMA_VERSION,
        "data_source": data_source,
        "updated_at_hkt": now.strftime("%Y-%m-%d %H:%M:%S"),
        "market_session": session or market_session(now),
        "hsi": {
            "index": {
                "name": index["name"],
                "last": _r(index.get("last"), 2),
                "prev_close": _r(prev, 2),
                "change": _r(index.get("change"), 2),
                "change_pct": _r(index.get("change_pct"), 4),
            },
            "breadth": breadth(hsi_rows),
            "turnover_hkd": _r(hsi_turnover, 0),
            "constituents": hsi_rows,
        },
        "hk_market": {
            "filters": {"min_turnover_hkd": min_turnover, "min_market_cap_hkd": min_market_cap},
            "universe_count": universe_count if universe_count is not None else len(stocks),
            "qualified_count": len(qualified),
            "breadth": breadth(qualified),
            "turnover_hkd": _r(sum(r["turnover_hkd"] for r in qualified), 0),
            "stocks": qualified,
        },
        "macro_sectors": macro,
        "movers": movers,
        "news": kept_news,
    }
    if notice:
        doc["notice"] = notice
    return doc


# ------------------------------------------------------------- OpenD adapters


def _ok(result, what: str):
    """Unwrap an SDK reply. Replies are (ret, data) or longer, e.g. (ret, df, None, total)."""
    ret, data = result[0], result[1]
    if ret != 0:  # futu.RET_OK
        raise RuntimeError(f"OpenD {what} failed: {data}")
    return data


def _records(df) -> list[dict]:
    return df.to_dict("records") if hasattr(df, "to_dict") else list(df)


def _frame(data):
    """Some calls return (count, DataFrame) as the data part. Return the frame."""
    if isinstance(data, (tuple, list)) and len(data) == 2 and not isinstance(data[0], dict):
        return data[1]
    return data


def _code_of(row: dict) -> str | None:
    """Rank rows name the code column `security`; most other calls use `code`."""
    value = row.get("security") or row.get("code")
    return str(value) if value else None


def fetch_hsi_codes(ctx) -> list[str]:
    return [r["code"] for r in _records(_ok(ctx.get_plate_stock(HSI_PLATE), "get_plate_stock"))]


def fetch_snapshots(ctx, codes: list[str]) -> list[dict]:
    rows: list[dict] = []
    unique = list(dict.fromkeys(codes))
    for i in range(0, len(unique), SNAPSHOT_CHUNK):
        chunk = unique[i:i + SNAPSHOT_CHUNK]
        rows.extend(_records(_ok(ctx.get_market_snapshot(chunk), "get_market_snapshot")))
    return rows


def fetch_hk_stock_codes(ctx, market, security_type) -> set[str]:
    """Short codes of every listed HK share (no ETFs, warrants or structured products)."""
    data = _ok(ctx.get_stock_basicinfo(market, security_type), "get_stock_basicinfo")
    return {names_mod.short_code(c) for c in (_code_of(r) for r in _records(_frame(data))) if c}


def fetch_heatmap(ctx, market, count: int = 200) -> list[dict]:
    data = _frame(_ok(ctx.get_heat_map_data(market, count=count), "get_heat_map_data"))
    rows = [normalize_heatmap_row(r) for r in _records(data)]
    return [r for r in rows if r]


def fetch_top_movers(ctx, market, limit: int, sort_dirs) -> list[str]:
    """Candidate codes: the biggest gainers (descending) and losers (ascending), in rank order."""
    codes: list[str] = []
    for sort_dir in sort_dirs:
        data = _frame(_ok(ctx.get_top_movers_rank(market, sort_dir=sort_dir, count=limit), "get_top_movers_rank"))
        codes.extend(c for c in (_code_of(r) for r in _records(data)) if c)
    return list(dict.fromkeys(codes))


REIT_PLATE = "REITs"
REIT_CATEGORY = "房地產投資信託基金"
OWNER_PLATE_CHUNK = 200


def is_reit(code: str, names: dict[str, dict]) -> bool:
    entry = names.get(names_mod.short_code(code))
    return bool(entry) and entry.get("category") == REIT_CATEGORY


def _owner_plate_rows(ctx, codes: list[str]) -> list[dict]:
    """get_owner_plate for one batch. A failing batch is halved until the offending code is isolated and skipped."""
    if not codes:
        return []
    try:
        return _records(_ok(ctx.get_owner_plate(codes), "get_owner_plate"))
    except RuntimeError:
        if len(codes) == 1:
            return []
        mid = len(codes) // 2
        return _owner_plate_rows(ctx, codes[:mid]) + _owner_plate_rows(ctx, codes[mid:])


def fetch_owner_industries(ctx, codes: list[str], known=None) -> dict[str, str]:
    """code -> industry plate name (English). get_owner_plate is rate limited, so batch.

    The 113 industry plates arrive with plate_type "OTHER", so a row counts as an industry when its
    plate_type ends with INDUSTRY or when `known(plate_name)` accepts the name. A known name wins over
    a row that is only typed INDUSTRY.
    """
    known = known or (lambda name: False)
    by_name: dict[str, str] = {}
    by_type: dict[str, str] = {}
    unique = list(dict.fromkeys(codes))
    for i in range(0, len(unique), OWNER_PLATE_CHUNK):
        for row in _owner_plate_rows(ctx, unique[i:i + OWNER_PLATE_CHUNK]):
            code, name = row.get("code"), str(row.get("plate_name") or "").strip()
            if not code or not name:
                continue
            if known(name):
                by_name.setdefault(code, name)
            elif str(row.get("plate_type", "")).upper().endswith("INDUSTRY"):
                by_type.setdefault(code, name)
    return {**by_type, **by_name}


def fetch_news_backup(ctx, code: str, name: str) -> dict | None:
    """Gateway news search, used only when the RSS lookup finds nothing. Must be Chinese and vendor-free."""
    for query in (names_mod.short_code(code).lstrip("0") or code, name):
        try:
            data = _ok(ctx.get_search_news(query), "get_search_news")
        except RuntimeError:
            continue
        for row in _records(_frame(data)):
            item = news_mod.usable_backup({
                "title": str(row.get("title") or "").strip(),
                "url": str(row.get("url") or "").strip(),
                "source": str(row.get("source") or row.get("publisher") or "").strip() or "新聞",
                "published_at_hkt": str(row.get("time") or row.get("publish_time") or "")[:16],
            })
            if item:
                return item
    return None


def keep_candidates(codes: list[str], listed: set[str], names: dict[str, dict]) -> list[str]:
    """HK$ shares only: code range, the exchange's 分類, and the gateway's own share list when available."""
    out = []
    for code in codes:
        short = names_mod.short_code(code)
        if not names_mod.is_listed_equity(short, names):
            continue
        if listed and short not in listed:
            continue
        out.append(code)
    return out


def apply_tc_names(snap_rows: list[dict], names: dict[str, dict]) -> None:
    for raw in snap_rows:
        entry = names.get(names_mod.short_code(raw["code"]))
        if entry and entry.get("name"):
            raw["name_tc"] = entry["name"]


def collect_live(args) -> dict:
    from futu import Market, OpenQuoteContext, RankSortDir, SecurityType  # lazy: tests need no SDK

    mapper = SectorMapper(load_sector_map())
    now = datetime.now(HKT)
    names = names_mod.load_names(Path(args.names_cache))
    if not names:
        print("warning: no Traditional Chinese name list; names stay as the gateway returns them", file=sys.stderr)
    ctx = OpenQuoteContext(host=args.host, port=args.port)
    try:
        hsi_codes = fetch_hsi_codes(ctx)
        index_snap = fetch_snapshots(ctx, [HSI_PLATE])
        industries = fetch_heatmap(ctx, Market.HK)
        listed = fetch_hk_stock_codes(ctx, Market.HK, SecurityType.STOCK)
        if listed:
            universe = keep_candidates([f"HK.{c}" for c in sorted(listed)], listed, names)
        else:
            print("warning: empty share list; falling back to the top movers rank", file=sys.stderr)
            universe = keep_candidates(
                fetch_top_movers(ctx, Market.HK, args.candidates, (RankSortDir.DESCENDING, RankSortDir.ASCENDING)), listed, names)
        snap_rows = fetch_snapshots(ctx, list(dict.fromkeys(hsi_codes + universe)))

        hsi_set = set(hsi_codes)
        needed = [r["code"] for r in snap_rows
                  if r["code"] in hsi_set or qualifies(r.get("turnover"), r.get("total_market_val"))]
        reits = {c for c in needed if is_reit(c, names)}
        owner_codes = [c for c in needed if c not in reits and (not listed or names_mod.short_code(c) in listed)]
        known = {r["name"].casefold() for r in industries}
        industry_of = fetch_owner_industries(
            ctx, owner_codes, known=lambda name: name.casefold() in known or mapper.knows(name))
        for raw in snap_rows:
            raw["industry"] = REIT_PLATE if raw["code"] in reits else industry_of.get(raw["code"], "")
        apply_tc_names(snap_rows, names)

        hsi_rows = [s for s in (build_stock(r, mapper) for r in snap_rows if r["code"] in hsi_set) if s]
        stocks = [s for s in (build_stock(r, mapper) for r in snap_rows) if s]

        shortlist: dict[str, dict] = {}
        for pool in (hsi_rows, [r for r in stocks if qualifies(r["turnover_hkd"], r["market_cap_hkd"])]):
            for direction in ("up", "down"):
                for row in rank(pool, direction, args.news_top):
                    shortlist[row["code"]] = row
        news = {}
        for code, row in shortlist.items():
            item = news_mod.fetch_news(code, row["name"]) or fetch_news_backup(ctx, code, row["name"])
            if item:
                news[code] = item
            time.sleep(args.news_delay)

        index = {}
        if index_snap:
            raw = index_snap[0]
            index = {
                "last": _num(raw.get("last_price")) or None,
                "prev_close": _num(raw.get("prev_close_price")) or None,
                "turnover_hkd": _num(raw.get("turnover")) or None,
            }
        doc = build_snapshot(now=now, hsi_index=index, hsi_rows=hsi_rows, stocks=stocks,
                             industries=industries, news=news, mapper=mapper,
                             universe_count=len(listed) or None)
    finally:
        ctx.close()
    if mapper.unmapped:
        print("unmapped industries (add to sector-map.json): " + ", ".join(sorted(mapper.unmapped)), file=sys.stderr)
    return doc


# ----------------------------------------------------------------------- output


def write_json(doc: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")


def wrangler_command(wrangler_bin: str | None) -> list[str]:
    """`--wrangler-bin` or HK_MOVERS_WRANGLER_BIN, else `npx wrangler`. A value may hold arguments."""
    value = (wrangler_bin or os.environ.get("HK_MOVERS_WRANGLER_BIN") or "").strip()
    return shlex.split(value) if value else ["npx", "wrangler"]


def wrangler_cwd(wrangler_bin: str | None) -> str | None:
    """Directory that holds the node_modules of a `.../node_modules/.bin/wrangler` path.

    wrangler writes its `.cache` next to the project it is started in, so starting it at `/` fails with
    EACCES. Returns None (keep the current directory) when the path is not inside a node_modules folder.
    """
    command = wrangler_command(wrangler_bin)
    for token in command[:2]:
        if "/" not in token:
            continue
        parts = Path(os.path.abspath(token)).parts
        if "node_modules" in parts:
            at = len(parts) - 1 - parts[::-1].index("node_modules")
            root = Path(*parts[:at]) if at else None
            if root and root.is_dir():
                return str(root)
    return None


def push_kv(doc: dict, namespace_id: str, wrangler_bin: str | None = None) -> None:
    """Write the document with wrangler. Authentication comes from the wrangler login or CLOUDFLARE_API_TOKEN."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
        tmp = fh.name
    try:
        subprocess.run(
            [*wrangler_command(wrangler_bin), "kv", "key", "put", KV_KEY, "--path", tmp,
             "--namespace-id", namespace_id, "--remote"],
            check=True,
            cwd=wrangler_cwd(wrangler_bin),
        )
    finally:
        os.unlink(tmp)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--host", default=os.environ.get("HK_MOVERS_OPEND_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("HK_MOVERS_OPEND_PORT", "11111")))
    p.add_argument("--out", type=Path, help="write the JSON document to this file")
    p.add_argument("--push-kv", action="store_true", help="put the document at the hk-movers:latest.json KV key")
    p.add_argument("--namespace-id", default=os.environ.get("HK_MOVERS_KV_NAMESPACE_ID", ""))
    p.add_argument("--wrangler-bin", default=None, help="wrangler executable (default: env HK_MOVERS_WRANGLER_BIN, else `npx wrangler`)")
    p.add_argument("--names-cache", default=os.environ.get("HK_MOVERS_NAMES_CACHE", str(names_mod.CACHE_PATH)),
                   help="cache file for the Traditional Chinese name list (refreshed every 7 days)")
    p.add_argument("--candidates", type=int, default=100, help="fallback only: candidates per direction from the rank endpoint when the share list is empty")
    p.add_argument("--news-top", type=int, default=30, help="stocks per direction and universe that get a news lookup")
    p.add_argument("--news-delay", type=float, default=0.3, help="seconds between news requests")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if not args.out and not args.push_kv:
        print("nothing to do: pass --out and/or --push-kv", file=sys.stderr)
        return 2
    if args.push_kv and not args.namespace_id:
        print("--push-kv needs --namespace-id or HK_MOVERS_KV_NAMESPACE_ID", file=sys.stderr)
        return 2
    doc = collect_live(args)
    if args.out:
        write_json(doc, args.out)
    if args.push_kv:
        push_kv(doc, args.namespace_id, args.wrangler_bin)
    return 0


if __name__ == "__main__":
    sys.exit(main())
