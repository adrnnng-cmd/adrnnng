"""python -m prices fetch --out <site root>

Writes <site root>/backtest/data/prices/<SYMBOL>.csv and manifest.json for the Backtest tool.
A symbol that fails to download keeps its previous CSV and is flagged stale in the manifest.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

from . import yahoo

HERE = Path(__file__).parent
SOURCE = {
    "name": "Yahoo Finance",
    "url": "https://finance.yahoo.com",
    "note": "Daily OHLCV, cash dividends and splits from Yahoo Finance's public chart endpoint, fetched on a schedule. "
    "Prices are split-adjusted as delivered; dividend adjustment is applied in the browser.",
}
HEADER = ["date", "open", "high", "low", "close", "volume", "dividend", "split"]


def file_name(symbol: str) -> str:
    return re.sub(r"[^A-Za-z0-9.\-]", "_", symbol) + ".csv"


def num(x: float) -> str:
    if x == 0:
        return "0"
    s = f"{x:.6f}" if abs(x) < 1 else f"{x:.4f}"
    return s.rstrip("0").rstrip(".")


def write_csv(path: Path, bars: list[yahoo.Bar]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(HEADER)
        for b in bars:
            w.writerow([b.date, num(b.open), num(b.high), num(b.low), num(b.close), b.volume,
                        num(b.dividend), num(b.split)])


def adj_check(bars: list[yahoo.Bar]) -> float | None:
    """Largest relative gap between our dividend adjustment and Yahoo's adjclose."""
    ours = yahoo.dividend_adjusted_closes(bars)
    gaps = [abs(o / b.adjclose - 1) for o, b in zip(ours, bars) if b.adjclose]
    return round(max(gaps), 6) if gaps else None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m prices")
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="download every symbol in universe.json")
    f.add_argument("--out", default=".", help="site root (default: .)")
    f.add_argument("--universe", type=Path, default=HERE / "universe.json")
    f.add_argument("--only", nargs="*", help="limit to these symbols (debugging)")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    uni = json.loads(args.universe.read_text("utf-8"))
    out_dir = Path(args.out) / uni["path"]
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"
    previous = {}
    if manifest_path.exists():
        previous = {s["symbol"]: s for s in json.loads(manifest_path.read_text("utf-8")).get("symbols", [])}

    start = date.fromisoformat(uni["start"])
    entries, ok = [], 0
    for group in uni["groups"]:
        for symbol in group["symbols"]:
            if args.only and symbol not in args.only:
                if symbol in previous:
                    entries.append(previous[symbol])
                continue
            fname = file_name(symbol)
            try:
                s = yahoo.parse(yahoo.fetch_json(symbol, start))
                if len(s.bars) < 30:
                    raise ValueError(f"only {len(s.bars)} bars")
                write_csv(out_dir / fname, s.bars)
                last, prev = s.bars[-1], s.bars[-2]
                gap = adj_check(s.bars)
                entries.append({
                    "symbol": symbol,
                    "file": fname,
                    "name": s.name,
                    "group": group["name"],
                    "exchange": s.exchange,
                    "currency": s.currency,
                    "type": s.type,
                    "first": s.bars[0].date,
                    "last": last.date,
                    "bars": len(s.bars),
                    "last_close": round(last.close, 6),
                    "change_pct": round((last.close / prev.close - 1) * 100, 3),
                    "adj_check": gap,
                    "stale": False,
                })
                ok += 1
                logging.info("%-9s %5d bars %s → %s  adj-check %s", symbol, len(s.bars), s.bars[0].date, last.date, gap)
            except Exception as e:
                logging.warning("%-9s failed: %s", symbol, e)
                if symbol in previous and (out_dir / fname).exists():
                    entries.append({**previous[symbol], "stale": True})
            time.sleep(0.4)

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": SOURCE,
        "columns": HEADER,
        "symbols": entries,
    }
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", "utf-8")
    logging.info("wrote %s: %d symbols (%d fetched now)", manifest_path, len(entries), ok)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
