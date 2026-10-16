"""Quiver Quantitative public Congress pages (aggregator fallback; no API key).

The pages embed trade arrays in inline <script> tags:
  /congresstrading/                    -> `let recentTradesData = [...]` (all members, ~3 weeks)
  /congresstrading/politician/<n>-<id> -> `let tradeData = [...]`          (one member, full history)
"""
from __future__ import annotations

import ast
import json
import re
import urllib.parse

from ..http import Client
from ..model import Trade, iso, normalize_amount, normalize_ticker, normalize_tx, title_company

BASE = "https://www.quiverquant.com/congresstrading/"


def politician_url(name: str, bioguide: str) -> str:
    return BASE + "politician/" + urllib.parse.quote(f"{name}-{bioguide}")


def _extract_array(page: str, var: str) -> list:
    m = re.search(r"let\s+%s\s*=\s*\[" % re.escape(var), page)
    if not m:
        raise ValueError(f"`{var}` not found on page")
    start = m.end() - 1
    end = page.find("];", start)
    if end < 0:
        raise ValueError(f"`{var}` array not terminated")
    raw = page[start : end + 1]
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    try:
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        fixed = re.sub(r"\bnull\b", "None", raw)
        fixed = re.sub(r"\btrue\b", "True", fixed)
        fixed = re.sub(r"\bfalse\b", "False", fixed)
        return ast.literal_eval(fixed)


def _clean(v) -> str:
    s = "" if v is None else str(v).strip()
    return "" if s == "-" else s


def _bioguide_from_id(trade_id: str) -> str:
    parts = (trade_id or "").split("-")
    return parts[1] if len(parts) >= 3 else ""


def parse_recent(page: str) -> list[Trade]:
    # [ticker, asset, asset_type, tx, amount, name, chamber, party, filed, traded,
    #  comment, id, excess_return, full_name, photo, bioguide]
    out = []
    for r in _extract_array(page, "recentTradesData"):
        if len(r) < 12:
            continue
        bioguide = _clean(r[15]) if len(r) > 15 else _bioguide_from_id(r[11])
        name = _clean(r[5])
        out.append(
            Trade(
                source="quiver",
                name=name,
                chamber=_clean(r[6]) or "House",
                party=_clean(r[7])[:1],
                bioguide=bioguide,
                ticker=normalize_ticker(_clean(r[0])),
                company=title_company(_clean(r[1])),
                asset_type=_clean(r[2]),
                tx=normalize_tx(_clean(r[3])),
                amount=normalize_amount(_clean(r[4])),
                filed_date=iso(_clean(r[8])),
                trade_date=iso(_clean(r[9])),
                comment=_clean(r[10])[:200],
                filing_id=_clean(r[11]),
                alt_url=politician_url(name, bioguide) if bioguide else BASE,
            )
        )
    return out


def parse_politician(page: str, display_name: str = "") -> list[Trade]:
    # [ticker, tx, filed, traded, ?, excess_return, name, id, asset, asset_type,
    #  amount, chamber, party, sector, amount_mid]
    out = []
    for r in _extract_array(page, "tradeData"):
        if len(r) < 13:
            continue
        name = _clean(r[6]) or display_name
        bioguide = _bioguide_from_id(_clean(r[7]))
        out.append(
            Trade(
                source="quiver",
                name=name,
                chamber=_clean(r[11]) or "House",
                party=_clean(r[12])[:1],
                bioguide=bioguide,
                ticker=normalize_ticker(_clean(r[0])),
                company=title_company(_clean(r[8])),
                asset_type=_clean(r[9]),
                tx=normalize_tx(_clean(r[1])),
                amount=normalize_amount(_clean(r[10])),
                filed_date=iso(_clean(r[2])),
                trade_date=iso(_clean(r[3])),
                filing_id=_clean(r[7]),
                alt_url=politician_url(name, bioguide) if bioguide else BASE,
            )
        )
    return out


def fetch_recent(client: Client) -> list[Trade]:
    return parse_recent(client.text(BASE))


def fetch_politician(client: Client, name: str, bioguide: str) -> list[Trade]:
    return parse_politician(client.text(politician_url(name, bioguide)), name)
