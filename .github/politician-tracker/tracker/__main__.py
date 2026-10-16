from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .pipeline import load_config, run


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m tracker", description="Build the Politician Tracker static page.")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="fetch sources and write <out>/politician-tracker/{index.html,data.json}")
    b.add_argument("--out", default="public", help="site deploy root (default: public)")
    b.add_argument("--config", type=Path, default=None, help="alternate config.json")
    b.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")
    cfg = load_config(args.config)
    payload = run(cfg, Path(args.out))
    trades = payload["trades"]
    for s in payload["sources"]:
        logging.info("source %-26s %s %5d %s", s["name"], "ok " if s["ok"] else "ERR", s["count"], s["note"])
    logging.info(
        "wrote %s/%s: %d rows (%d VIP, %d Watchlist)%s",
        args.out,
        cfg["site"]["path"],
        len(trades),
        sum(t["vip"] for t in trades),
        sum(t["watchlist"] for t in trades),
        " [STALE]" if payload["stale"] else "",
    )
    return 1 if payload["stale"] else 0


if __name__ == "__main__":
    sys.exit(main())
