"""QuantEngines free REST API (no key). Preferred source per brief; schema is mapped defensively."""
from __future__ import annotations

from datetime import date

from ..http import Client
from ..model import Trade, iso, normalize_amount, normalize_ticker, normalize_tx, parse_date, title_company

BASE = "https://quantengines.com/api/v1"


def _pick(d: dict, *keys, default=""):
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return default


def parse(rows: list[dict]) -> list[Trade]:
    out = []
    for r in rows:
        pol = r.get("politician") if isinstance(r.get("politician"), dict) else {}
        name = _pick(pol, "name", "full_name") or _pick(r, "politician_name", "representative", "senator", "name")
        if not name:
            continue
        chamber = str(_pick(pol, "chamber") or _pick(r, "chamber")).title()
        party = str(_pick(pol, "party") or _pick(r, "party"))[:1].upper()
        amount_raw = _pick(r, "amount_range", "amount", "range")
        if isinstance(amount_raw, dict):
            amount_raw = f"${amount_raw.get('min', '')} - ${amount_raw.get('max', '')}"
        out.append(
            Trade(
                source="quantengines",
                name=str(name),
                chamber="Senate" if chamber.startswith("Sen") else "House",
                party=party,
                state=str(_pick(pol, "state") or _pick(r, "state")),
                bioguide=str(_pick(pol, "bioguide_id", "bioguide") or _pick(r, "bioguide_id")),
                ticker=normalize_ticker(str(_pick(r, "ticker", "symbol"))),
                company=title_company(str(_pick(r, "asset_name", "asset_description", "company", "asset"))),
                tx=normalize_tx(str(_pick(r, "transaction_type", "type"))),
                amount=normalize_amount(str(amount_raw)),
                trade_date=iso(str(_pick(r, "transaction_date", "trade_date", "traded"))),
                filed_date=iso(str(_pick(r, "disclosure_date", "filing_date", "filed_date", "reported_date"))),
                owner=str(_pick(r, "owner")),
                source_url=str(_pick(r, "ptr_link", "filing_url", "source_url", "url")),
                source_label="Filing" if _pick(r, "ptr_link", "filing_url") else "QuantEngines",
            )
        )
    return out


def fetch(client: Client, since: date, max_pages: int = 20, page_size: int = 100) -> list[Trade]:
    trades: list[Trade] = []
    for page in range(max_pages):
        data = client.json(f"{BASE}/trades/?skip={page * page_size}&limit={page_size}")
        rows = data.get("trades", []) if isinstance(data, dict) else data
        batch = parse(rows or [])
        trades.extend(batch)
        oldest = min((parse_date(t.filed_date) for t in batch if t.filed_date), default=None)
        if len(rows or []) < page_size or (oldest and oldest < since):
            break
    return trades
