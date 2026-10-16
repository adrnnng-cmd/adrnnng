from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import legislators
from .http import Client
from .model import SOURCE_PRIORITY, Trade, last_name_key, parse_date
from .sources import house_clerk, quantengines, quiver
from .sources.senate_efd import SenateEFD
from .watchlist import Watchlist

log = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).with_name("config.json")


def load_config(path: Path | None = None) -> dict:
    return json.loads((path or CONFIG_PATH).read_text("utf-8"))


@dataclass
class SourceStatus:
    name: str
    ok: bool
    count: int = 0
    note: str = ""


@dataclass
class Collected:
    trades: list[Trade] = field(default_factory=list)
    senate_filings: list = field(default_factory=list)
    house_index: house_clerk.HouseIndex | None = None
    roster: legislators.Roster | None = None
    status: list[SourceStatus] = field(default_factory=list)


def _attempt(collected: Collected, label: str, fn, note_empty: str = ""):
    try:
        result = fn()
    except Exception as e:
        log.warning("%s failed: %s", label, e)
        collected.status.append(SourceStatus(label, False, 0, str(e)[:160]))
        return None
    n = len(result) if hasattr(result, "__len__") else 0
    collected.status.append(SourceStatus(label, True, n, note_empty if n == 0 else ""))
    return result


def collect(cfg: dict, client: Client, today: date) -> Collected:
    since = today - timedelta(days=cfg["site"]["retention_days"])
    c = Collected()

    c.roster = _attempt(c, "Congress roster", lambda: legislators.fetch(client))

    qe = _attempt(c, "QuantEngines API", lambda: quantengines.fetch(client, since), "API returned no trades")
    c.trades += qe or []

    efd = SenateEFD(client)
    filings = _attempt(c, "Senate eFD filings", lambda: efd.filings(since))
    if filings:
        c.senate_filings = filings
        c.trades += _attempt(c, "Senate eFD transactions", lambda: efd.trades(filings)) or []

    c.trades += _attempt(c, "Quiver recent feed", lambda: quiver.fetch_recent(client)) or []
    vip_rows: list[Trade] = []
    vip_errors = []
    for v in cfg["vip"]:
        try:
            vip_rows += quiver.fetch_politician(client, v["name"], v["bioguide"])
        except Exception as e:
            vip_errors.append(f"{v['name']}: {e}")
    c.status.append(
        SourceStatus("Quiver VIP pages", len(vip_errors) < len(cfg["vip"]), len(vip_rows), "; ".join(vip_errors)[:160])
    )
    c.trades += vip_rows

    house_filings = []
    for year in range(since.year, today.year + 1):
        house_filings += _attempt(c, f"House Clerk index {year}", lambda y=year: house_clerk.fetch_index(client, y)) or []
    c.house_index = house_clerk.HouseIndex(house_filings)
    return c


class Enricher:
    def __init__(self, cfg: dict, roster: legislators.Roster | None, senate_filings, house_index):
        self.vips = {v["bioguide"]: v for v in cfg["vip"]}
        self.vip_by_last = {(v["chamber"], last_name_key(v["name"])): v for v in cfg["vip"]}
        self.watchlist = Watchlist(cfg["watchlist"])
        self.roster = roster
        self.house_index = house_index
        self.senate = {}
        for f in senate_filings or []:
            self.senate.setdefault((last_name_key(f.last), f.filed_date), f)

    def apply(self, t: Trade) -> Trade:
        member = None
        if self.roster:
            member = self.roster.get(t.bioguide) if t.bioguide else self.roster.find(t.chamber, t.name)
        vip = self.vips.get(t.bioguide) if t.bioguide else None
        if not vip and not t.bioguide:
            vip = self.vip_by_last.get((t.chamber, last_name_key(t.name)))
        if member and not t.bioguide:
            t.bioguide = member.bioguide
        if vip and not t.bioguide:
            t.bioguide = vip["bioguide"]

        t.vip = vip is not None
        if vip:
            t.name = vip["name"]
        elif member:
            t.name = member.name
        t.party = (member.party if member else "") or t.party or (vip or {}).get("party", "")
        t.state = (member.district or member.state) if member else (t.state or (vip or {}).get("state", ""))
        t.former = bool(self.roster) and len(self.roster) > 0 and member is None and t.bioguide != ""

        t.watchlist_symbol = self.watchlist.match(t.ticker)
        t.watchlist = bool(t.watchlist_symbol)

        if t.bioguide and not t.alt_url.startswith(quiver.BASE + "politician/"):
            t.alt_url = quiver.politician_url(t.name, t.bioguide)
        if t.source != "senate_efd" and not t.source_url:
            self._link_filing(t, member)
        if not t.source_url:
            t.source_url, t.source_label = t.alt_url or quiver.BASE, "Quiver"
        return t

    def _link_filing(self, t: Trade, member) -> None:
        if t.chamber == "Senate":
            f = self.senate.get((last_name_key(t.name), t.filed_date))
            if f:
                t.source_url, t.source_label = f.url, "Senate eFD"
        elif self.house_index:
            state = member.state if member else ""
            f = self.house_index.match(t.name, t.filed_date, state)
            if f:
                t.source_url, t.source_label = f.url, "House PTR"


def _base_key(t: Trade) -> tuple:
    asset = t.ticker or t.company.lower()[:24]
    return (t.person_key(), asset, t.trade_date, t.tx, t.amount)


def dedupe(batches: list[list[Trade]]) -> list[Trade]:
    """Merge rows from several batches/sources without collapsing genuine repeat trades.

    Within one filing, identical rows are distinct transactions, so each row gets an
    occurrence index per (batch, source, filing, key). Across sources/amendments the same
    (key, occurrence) is one trade; the earliest filing wins, then the most official source.
    """
    best: dict[tuple, tuple[tuple, Trade]] = {}
    for batch_no, batch in enumerate(batches):
        seen_ids: set[str] = set()
        counters: dict[tuple, int] = {}
        for t in batch:
            if t.source == "quiver" and t.filing_id:
                if t.filing_id in seen_ids:
                    continue
                seen_ids.add(t.filing_id)
            filing = t.filing_id if t.source == "senate_efd" else t.filed_date
            base = _base_key(t)
            ck = (t.source, filing, base)
            occ = counters.get(ck, 0)
            counters[ck] = occ + 1
            rank = (t.filed_date or "9999", SOURCE_PRIORITY.get(t.source, 9), batch_no)
            key = (base, occ)
            if key not in best or rank < best[key][0]:
                best[key] = (rank, t)
    return [t for _, t in best.values()]


PHOTO_URL = "https://unitedstates.github.io/images/congress/225x275/{}.jpg"


def fetch_photos(client: Client, vips: list[dict], out_dir: Path, url_prefix: str) -> None:
    """Cache public-domain member portraits as static files; sets v["photo"] when available."""
    img_dir = out_dir / "img"
    for v in vips:
        path = img_dir / f"{v['bioguide']}.jpg"
        if not path.exists():
            try:
                blob = client.request(PHOTO_URL.format(v["bioguide"]))
                if blob[:3] != b"\xff\xd8\xff":
                    raise ValueError("not a JPEG")
                img_dir.mkdir(parents=True, exist_ok=True)
                path.write_bytes(blob)
            except Exception as e:
                log.warning("photo for %s unavailable: %s", v["name"], e)
                continue
        v["photo"] = f"{url_prefix}/img/{path.name}"


def load_previous(path: Path) -> list[Trade]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text("utf-8"))
        return [Trade.from_dict(d) for d in data.get("trades", [])]
    except Exception as e:
        log.warning("ignoring unreadable previous data %s: %s", path, e)
        return []


def run(cfg: dict, out_root: Path, client: Client | None = None, now: datetime | None = None) -> dict:
    tz = ZoneInfo(cfg["site"]["timezone"])
    now = now or datetime.now(tz)
    today = now.date()
    since = today - timedelta(days=cfg["site"]["retention_days"])
    out_dir = out_root / cfg["site"]["path"]
    data_path = out_dir / "data.json"

    collected = collect(cfg, client or Client(), today)
    enricher = Enricher(cfg, collected.roster, collected.senate_filings, collected.house_index)
    fresh = [enricher.apply(t) for t in collected.trades]
    previous = load_previous(data_path)
    previous = [enricher.apply(t) for t in previous]

    def keep(t: Trade) -> bool:
        d = parse_date(t.filed_date)
        return bool(d) and since <= d <= today and (t.vip or t.watchlist)

    trades = [t for t in dedupe([fresh, previous]) if keep(t)]
    trades.sort(key=lambda t: (t.filed_date, t.trade_date, t.name, t.ticker), reverse=True)

    fresh_ok = any(s.ok and s.count > 0 for s in collected.status if not s.name.startswith(("Congress", "House Clerk")))
    payload = {
        "generated_at": now.isoformat(timespec="seconds"),
        "window_start": since.isoformat(),
        "stale": not fresh_ok,
        "sources": [s.__dict__ for s in collected.status],
        "vip": [
            {**v, "former": bool(collected.roster) and collected.roster.get(v["bioguide"]) is None}
            for v in cfg["vip"]
        ],
        "vip_criteria": cfg.get("vip_criteria", {}),
        "watchlist": cfg["watchlist"],
        "trades": [t.to_dict() for t in trades],
    }
    from .render import render_page

    out_dir.mkdir(parents=True, exist_ok=True)
    fetch_photos(client or Client(), payload["vip"], out_dir, f"/{cfg['site']['path']}")
    data_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), "utf-8")
    (out_dir / "index.html").write_text(render_page(cfg, payload, now), "utf-8")
    return payload
