"""5-day, 1-month and year-to-date returns for the Movers index tables.

Pure functions plus a small on-disk cache; the only gateway call is injected (`fetch`), so everything
here is tested with fixtures and nothing in this module has been run against a live gateway.

Definitions (all dates are Hong Kong trading days; the gateway's adjusted daily closes are used):

  latest   the most recent trading day in the index's daily bars. During a session this is today, and the
           return is measured from the reference close to the current snapshot price.
  5D       reference = the close 5 trading days before `latest` (6th bar from the end).
  1M       reference = the last trading day on or before the same calendar day one month earlier
           (a 31st clamps to the end of the shorter month).
  YTD      reference = the last trading day of the previous calendar year.

  return % = (current price / reference close - 1) * 100.

A stock with no bar on or before a reference date (listed later) has no return for that horizon: null,
never a made-up number. A suspended stock uses its last close on or before the reference date.
Adjusted ("qfq") closes already carry dividend and split adjustments, so an ex-dividend day does not
appear as a price drop. The cache holds one bar list per code and is refreshed at most once per
Hong Kong day, a bounded number of codes per run, to stay within the gateway's history quota.
"""

from __future__ import annotations

import calendar
import json
import math
import time
from datetime import date, datetime
from pathlib import Path

HORIZONS = ("d5", "m1", "ytd")
RETURN_KEYS = {"d5": "ret_5d", "m1": "ret_1m", "ytd": "ret_ytd"}
CACHE_VERSION = 1
KEEP_FROM_MMDD = "12-01"  # bars are kept from 1 December of the previous year


def _day(text: str) -> date:
    return date.fromisoformat(str(text)[:10])


def one_month_before(day: date) -> date:
    year, month = (day.year, day.month - 1) if day.month > 1 else (day.year - 1, 12)
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def last_on_or_before(days: list[str], target: date) -> str | None:
    best = None
    for d in days:
        if _day(d) <= target:
            best = d
        else:
            break
    return best


def reference_dates(trading_days: list[str]) -> dict | None:
    """The three reference dates and the latest trading day, or None when there is no history at all.

    `trading_days` are 'YYYY-MM-DD' strings in any order. Horizons that the history cannot support are None.
    """
    days = sorted({str(d)[:10] for d in trading_days})
    if not days:
        return None
    latest = days[-1]
    latest_day = _day(latest)
    prior_year_end = last_on_or_before(days, date(latest_day.year - 1, 12, 31))
    return {
        "as_of": latest,
        "d5": days[-6] if len(days) >= 6 else None,
        "m1": last_on_or_before(days[:-1], one_month_before(latest_day)),
        "ytd": prior_year_end if prior_year_end and _day(prior_year_end).year < latest_day.year else None,
    }


def normalise_bars(bars) -> list[tuple[str, float]]:
    """[(date, close)] ascending, finite positive closes only, one bar per date (the last one wins)."""
    seen: dict[str, float] = {}
    for item in bars or []:
        try:
            d, close = str(item[0])[:10], float(item[1])
        except (TypeError, ValueError, IndexError):
            continue
        if math.isfinite(close) and close > 0:
            seen[d] = close
    return sorted(seen.items())


def close_on_or_before(bars: list[tuple[str, float]], target: str) -> float | None:
    out = None
    for d, close in bars:
        if d <= target:
            out = close
        else:
            break
    return out


def pct_return(last, reference) -> float | None:
    try:
        last, reference = float(last), float(reference)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(last) and math.isfinite(reference)) or last <= 0 or reference <= 0:
        return None
    return round((last / reference - 1.0) * 100.0, 4)


def compute_returns(last, bars, refs: dict | None) -> dict:
    """{'ret_5d','ret_1m','ret_ytd'} for one stock. Anything that cannot be computed is None."""
    out = {key: None for key in RETURN_KEYS.values()}
    if not refs:
        return out
    clean = normalise_bars(bars)
    if not clean:
        return out
    for horizon, key in RETURN_KEYS.items():
        ref_date = refs.get(horizon)
        if ref_date is None or clean[0][0] > ref_date:
            continue
        out[key] = pct_return(last, close_on_or_before(clean, ref_date))
    return out


class HistoryCache:
    """code -> bars, one JSON file. A corrupt or missing file is an empty cache."""

    def __init__(self, path: Path | None):
        self.path = Path(path) if path else None
        self.entries: dict[str, dict] = {}
        if self.path:
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                if raw.get("version") == CACHE_VERSION and isinstance(raw.get("entries"), dict):
                    self.entries = raw["entries"]
            except (OSError, ValueError, AttributeError):
                self.entries = {}

    def bars(self, code: str) -> list[tuple[str, float]]:
        return normalise_bars(self.entries.get(code, {}).get("bars"))

    def fetched_on(self, code: str) -> str | None:
        return self.entries.get(code, {}).get("fetched_on")

    def needs_refresh(self, code: str, today: str) -> bool:
        return self.fetched_on(code) != today

    def put(self, code: str, bars, today: str) -> None:
        keep_from = f"{int(today[:4]) - 1}-{KEEP_FROM_MMDD}"
        kept = [[d, c] for d, c in normalise_bars(bars) if d >= keep_from]
        self.entries[code] = {"fetched_on": today, "bars": kept}

    def save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps({"version": CACHE_VERSION, "entries": self.entries}, separators=(",", ":")), encoding="utf-8")
        tmp.replace(self.path)


def history_window(today: date) -> tuple[str, str]:
    """(start, end) for the history request: 1 Dec of the previous year through today."""
    return f"{today.year - 1}-{KEEP_FROM_MMDD}", today.isoformat()


def refresh_history(codes: list[str], cache: HistoryCache, *, today: str, fetch, budget: int,
                    delay: float = 0.0, sleep=time.sleep) -> dict:
    """Fetch bars for the codes whose cache is not from today, at most `budget` codes per call.

    `fetch(code, start, end)` returns [(date, close)] or raises. A failure (quota, unknown code) is recorded
    and the loop moves on, so one bad code never blocks the rest. Codes never fetched go first, then the
    oldest cache entries.
    """
    start, end = history_window(_day(today))
    due = [c for c in dict.fromkeys(codes) if cache.needs_refresh(c, today)]
    due.sort(key=lambda c: (cache.fetched_on(c) or "", c))
    stats = {"due": len(due), "fetched": 0, "failed": [], "deferred": 0}
    for code in due:
        if stats["fetched"] + len(stats["failed"]) >= budget:
            stats["deferred"] += 1
            continue
        try:
            bars = fetch(code, start, end)
        except Exception as exc:  # noqa: BLE001 - the gateway raises plain RuntimeError for quota and lookups
            stats["failed"].append({"code": code, "error": str(exc)[:120]})
        else:
            cache.put(code, bars, today)
            stats["fetched"] += 1
        if delay:
            sleep(delay)
    return stats


def trading_days_for(cache: HistoryCache, index_code: str, codes: list[str]) -> list[str]:
    """Trading calendar: the index's own bars when cached, else the longest stock history we hold."""
    own = [d for d, _ in cache.bars(index_code)]
    if own:
        return own
    best: list[str] = []
    for code in codes:
        days = [d for d, _ in cache.bars(code)]
        if len(days) > len(best):
            best = days
    return best


def parse_kline_rows(rows) -> list[tuple[str, float]]:
    """Gateway kline rows (dicts with time_key and close) to [(date, close)]."""
    out = []
    for row in rows or []:
        stamp = row.get("time_key") or row.get("date")
        if stamp is None:
            continue
        out.append((str(stamp)[:10], row.get("close")))
    return normalise_bars(out)


def hkt_today(now: datetime) -> str:
    return now.date().isoformat()
