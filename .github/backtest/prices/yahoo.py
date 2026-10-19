"""Daily OHLCV + dividends/splits from Yahoo Finance's public chart endpoint.

The endpoint sends no CORS headers, so the browser cannot call it; this module runs
on a schedule (GitHub Actions) and the site serves the result as static CSV.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
URL = "https://{host}/v8/finance/chart/{symbol}"
# Yahoo answers 429 to full browser UA strings and to curl/urllib defaults, but not to this one.
UA = "Mozilla/5.0"


@dataclass
class Bar:
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: int
    adjclose: float | None = None
    dividend: float = 0.0
    split: float = 0.0  # ratio new/old shares, e.g. 4.0 for a 4-for-1; 0 = no split


@dataclass
class Series:
    symbol: str
    name: str
    exchange: str
    currency: str
    type: str
    timezone: str
    bars: list[Bar] = field(default_factory=list)


def fetch_json(symbol: str, start: date, retries: int = 3) -> dict:
    params = {
        "period1": int(datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp()),
        "period2": int(time.time()) + 86400,
        "interval": "1d",
        "events": "div,split",
        "includeAdjustedClose": "true",
    }
    query = "?" + urllib.parse.urlencode(params)
    last: Exception | None = None
    for attempt in range(retries):
        url = URL.format(host=HOSTS[attempt % len(HOSTS)], symbol=urllib.parse.quote(symbol)) + query
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # network errors and HTTP 429/5xx
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{symbol}: {last}")


def parse(payload: dict, now: datetime | None = None) -> Series:
    """Turn a chart payload into complete daily bars (an unfinished session is dropped)."""
    res = (payload.get("chart") or {}).get("result")
    if not res:
        err = (payload.get("chart") or {}).get("error")
        raise ValueError(f"no result: {err}")
    r = res[0]
    meta = r["meta"]
    tz = ZoneInfo(meta.get("exchangeTimezoneName") or "UTC")
    ts = r.get("timestamp") or []
    q = (r.get("indicators") or {}).get("quote", [{}])[0]
    adj = ((r.get("indicators") or {}).get("adjclose") or [{}])[0].get("adjclose")
    ev = r.get("events") or {}

    def day(t: int) -> str:
        return datetime.fromtimestamp(int(t), tz).date().isoformat()

    divs: dict[str, float] = {}
    for d in (ev.get("dividends") or {}).values():
        k = day(d["date"])
        divs[k] = divs.get(k, 0.0) + float(d["amount"])
    splits: dict[str, float] = {}
    for s in (ev.get("splits") or {}).values():
        num, den = float(s.get("numerator") or 0), float(s.get("denominator") or 0)
        if num > 0 and den > 0:
            splits[day(s["date"])] = num / den

    bars: dict[str, Bar] = {}
    for i, t in enumerate(ts):
        o, h, l, c, v = (q.get(k, [None] * len(ts))[i] for k in ("open", "high", "low", "close", "volume"))
        if None in (o, h, l, c) or c <= 0:
            continue
        k = day(t)
        bars[k] = Bar(
            date=k,
            open=float(o),
            high=max(float(h), float(o), float(c)),
            low=min(float(l), float(o), float(c)),
            close=float(c),
            volume=int(v or 0),
            adjclose=float(adj[i]) if adj and adj[i] is not None else None,
            dividend=divs.get(k, 0.0),
            split=splits.get(k, 0.0),
        )

    out = [bars[k] for k in sorted(bars)]
    now = now or datetime.now(timezone.utc)
    period = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    if out and period.get("end"):
        session_end = datetime.fromtimestamp(int(period["end"]), timezone.utc)
        if out[-1].date == session_end.astimezone(tz).date().isoformat() and now < session_end:
            out.pop()

    return Series(
        symbol=meta.get("symbol") or "",
        name=meta.get("longName") or meta.get("shortName") or meta.get("symbol") or "",
        exchange=meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        currency=meta.get("currency") or "",
        type=meta.get("instrumentType") or "",
        timezone=meta.get("exchangeTimezoneName") or "UTC",
        bars=out,
    )


def dividend_adjusted_closes(bars: list[Bar]) -> list[float]:
    """Back-adjust closes for cash dividends, the same way the site's data layer does.

    Each ex-dividend day scales all earlier prices by (1 - dividend / previous close).
    """
    factor = 1.0
    out = [0.0] * len(bars)
    for i in range(len(bars) - 1, -1, -1):
        out[i] = bars[i].close * factor
        if bars[i].dividend and i > 0 and bars[i - 1].close > 0:
            factor *= 1.0 - bars[i].dividend / bars[i - 1].close
    return out
