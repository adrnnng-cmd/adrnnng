from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date

SOURCE_PRIORITY = {"senate_efd": 0, "quantengines": 1, "quiver": 2}


@dataclass
class Trade:
    source: str
    name: str
    chamber: str
    ticker: str
    company: str
    tx: str
    amount: str
    trade_date: str
    filed_date: str
    party: str = ""
    state: str = ""
    bioguide: str = ""
    owner: str = ""
    asset_type: str = ""
    comment: str = ""
    filing_id: str = ""
    source_url: str = ""
    source_label: str = ""
    alt_url: str = ""
    vip: bool = False
    watchlist: bool = False
    watchlist_symbol: str = ""
    former: bool = False
    extra: dict = field(default_factory=dict)

    @property
    def lag_days(self) -> int | None:
        t, f = parse_date(self.trade_date), parse_date(self.filed_date)
        if not t or not f:
            return None
        return (f - t).days

    def person_key(self) -> str:
        if self.bioguide:
            return self.bioguide
        return f"{self.chamber}:{last_name_key(self.name)}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("extra", None)
        d["lag_days"] = self.lag_days
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Trade":
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


def parse_date(value: str | None) -> date | None:
    if not value:
        return None
    value = value.strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", value)
    if m:
        return date(int(m[1]), int(m[2]), int(m[3]))
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", value)
    if m:
        return date(int(m[3]), int(m[1]), int(m[2]))
    return None


def iso(value: str | None) -> str:
    d = parse_date(value)
    return d.isoformat() if d else ""


def normalize_tx(raw: str) -> str:
    r = (raw or "").strip().lower()
    if r.startswith("purchase") or r == "buy":
        return "Buy"
    if r.startswith("sale") or r.startswith("sell"):
        return "Sell"
    if r.startswith("exchange"):
        return "Exchange"
    return (raw or "").strip().title() or "—"


_AMOUNT_RE = re.compile(r"\$?\s*([\d,]+(?:\.\d+)?)")


def amount_bounds(raw: str) -> tuple[int | None, int | None]:
    nums = [int(float(n.replace(",", ""))) for n in _AMOUNT_RE.findall(raw or "")]
    if not nums:
        return None, None
    if (raw or "").lower().startswith("over") or len(nums) == 1:
        return nums[0], None
    return nums[0], nums[1]


def _short_money(n: int) -> str:
    if n >= 1_000_000:
        v = n / 1_000_000
        return f"${v:g}M"
    if n >= 1_000:
        v = round(n / 1_000)
        return f"${v:g}K"
    return f"${n}"


def normalize_amount(raw: str) -> str:
    lo, hi = amount_bounds(raw)
    if lo is None:
        return (raw or "").strip() or "—"
    if hi is None:
        return f"{_short_money(lo)}+"
    return f"{_short_money(lo)}–{_short_money(hi)}"


def band_min(display: str) -> int:
    """Lower bound in dollars of a normalized band such as "$15K–$50K" or "$5M+"."""
    m = re.match(r"\$([\d.]+)([KM]?)", display or "")
    if not m:
        return 0
    return int(float(m[1]) * {"K": 1_000, "M": 1_000_000, "": 1}[m[2]])


def normalize_ticker(raw: str) -> str:
    t = (raw or "").strip().upper()
    if t in {"", "-", "--", "N/A", "NONE"}:
        return ""
    return t


def display_ticker(ticker: str) -> str:
    """Bloomberg-style label: "MSFT" -> "MSFT US", "0700.HK"/"700" -> "0700 HK"."""
    t = (ticker or "").strip().upper()
    if not t:
        return ""
    hk = re.fullmatch(r"(\d{1,5})(?:[ .]HK)?", t)
    if hk:
        return f"{hk.group(1).lstrip('0').zfill(4)} HK"
    if re.search(r" (US|HK)$", t):
        return t
    return f"{t} US"


_SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "md", "dr", "dr."}


def last_name_key(name: str) -> str:
    """Lower-case surname for fuzzy matching across sources ("McConnell, Jr." -> "mcconnell")."""
    n = (name or "").replace(".", " ").strip()
    if "," in n:
        n = n.split(",")[0]
        parts = n.split()
    else:
        parts = [p for p in n.split() if p.lower().strip(".") not in _SUFFIXES]
    if not parts:
        return ""
    return re.sub(r"[^a-z]", "", parts[-1].lower())


def title_company(raw: str) -> str:
    s = re.sub(r"\s+", " ", (raw or "")).strip()
    if s and s.upper() == s:
        s = s.title()
        s = re.sub(r"\b(Inc|Corp|Co|Ltd|Plc|Llc|Etf|Adr|Spdr)\b", lambda m: m[0].upper() if m[0] in {"Etf", "Adr", "Spdr", "Llc", "Plc"} else m[0], s)
    return s
