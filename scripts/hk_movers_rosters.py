#!/usr/bin/env python3
"""Official Hang Seng Index and Hang Seng TECH Index rosters for /movers/.

The rosters come from Hang Seng Indexes Company's quarterly review announcement, never from a quote
gateway. The announcement lists, per index, the constituents with "Before" and "After" weightings:

  * Before = weighting of the current constituents on the review reference date (18 Nov 2026 for the
    Nov 2026 review), before any capping or constituent change takes effect;
  * After  = pro-forma weighting once the announced changes take effect (re-capping, new constituents).

Both columns are computed "assuming the rebalancing had taken place on" the reference date. They are
official published figures, not live daily weights, and the After column is NOT in force until the
announced effective date. index-rosters.json therefore keeps one dated version per column and
select_version() applies a version only from its effective date.

    python3 scripts/hk_movers_rosters.py --pdf-text /tmp/review.txt --out scripts/hk-movers/index-rosters.json

--pdf-text is the text of the announcement with a "=====PAGE n=====" line before each page (see
extract_text()). Traditional Chinese names come from the exchange's securities list
(hk_movers_names.py); the English short names are the announcement's own.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hk_movers_names as names_mod  # noqa: E402

ROSTER_PATH = Path(__file__).resolve().parent / "hk-movers" / "index-rosters.json"
INDEX_IDS = ("hsi", "hstech")

SOURCE = {
    "publisher": "Hang Seng Indexes Company",
    "title": "Hang Seng Indexes Company Announces Index Review Results",
    "review_period": "quarter ended 30 September 2026",
    "announced": "2026-11-20",
    "url": "https://www.hsi.com.hk/content/dam/wpb/hsil/en_hk/press_releases/content/20261120T174500.pdf",
    "weights_reference_date": "2026-11-18",
}

# index id -> (appendix title as printed, appendix heading, pages in the PDF, effective date of the changes)
APPENDICES = {
    "hsi": {"heading": "Appendix 1", "title": "Hang Seng Index", "pages": [4, 5], "expected": 95},
    "hstech": {"heading": "Appendix 3", "title": "Hang Seng TECH Index", "pages": [8, 9], "expected": 50},
}
EFFECTIVE_FROM = "2026-12-07"
IMPLEMENTED_AFTER_CLOSE = "2026-12-04"

NAMES = {"hsi": "恒生指數", "hstech": "恒生科技指數"}

PAGE_MARK = re.compile(r"^=====PAGE (\d+)=====$")
# 5 HSBC HOLDINGS 100 7.37 8.00   |   981 SMIC 85# 1.42 1.55   |   6869 YOFC (H) 100 - 0.94
ROW = re.compile(r"^(?P<code>\d{1,5}) (?P<name>.+?) (?P<faf>\d{1,3}(?:\.\d+)?)\s?(?P<flag>#?) (?P<before>\d+\.\d+|-) (?P<after>\d+\.\d+|-)$")
GROUP = re.compile(r"^(?P<name>.+) \(\d+ constituents?\) \d+\.\d+ \d+\.\d+$")


class RosterError(ValueError):
    pass


def extract_text(pdf_path: Path) -> str:
    """Page-marked text of a PDF (needs pdfplumber; only the importer uses it)."""
    import pdfplumber  # noqa: PLC0415

    parts = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            parts.append(f"=====PAGE {i}=====\n{page.extract_text() or ''}")
    return "\n".join(parts)


def split_pages(text: str) -> dict[int, list[str]]:
    pages: dict[int, list[str]] = {}
    current = 0
    for line in text.splitlines():
        m = PAGE_MARK.match(line.strip())
        if m:
            current = int(m.group(1))
            pages[current] = []
        elif current:
            pages[current].append(line.strip())
    return pages


def short_code(code: str) -> str:
    return str(code).strip().zfill(5)


def parse_rows(lines: list[str], group: str | None = None) -> list[dict]:
    """Constituent rows of one page. `group` is the sector heading carried over from the previous page."""
    rows = []
    for line in lines:
        header = GROUP.match(line)
        if header:
            group = header["name"].strip()
            continue
        m = ROW.match(line)
        if not m:
            continue
        rows.append({
            "group": group,
            "code": short_code(m["code"]),
            "name_en": m["name"].strip(),
            "faf_pct": float(m["faf"]),
            "before": None if m["before"] == "-" else float(m["before"]),
            "after": None if m["after"] == "-" else float(m["after"]),
        })
    return rows


def parse_appendix(text: str, index_id: str) -> list[dict]:
    """Rows of one appendix, with the page each came from. Raises when the table is not what is expected."""
    spec = APPENDICES[index_id]
    pages = split_pages(text)
    rows = []
    group = None
    for number in spec["pages"]:
        if number not in pages:
            raise RosterError(f"{index_id}: page {number} is missing from the text")
        if not any(spec["heading"] in line for line in pages[number]) and number == spec["pages"][0]:
            raise RosterError(f"{index_id}: page {number} does not carry '{spec['heading']}'")
        page_rows = parse_rows(pages[number], group)
        if page_rows:
            group = page_rows[-1]["group"]
        for row in page_rows:
            rows.append({**row, "page": number})
    codes = [r["code"] for r in rows]
    if len(codes) != len(set(codes)):
        raise RosterError(f"{index_id}: duplicate stock codes")
    after = [r for r in rows if r["after"] is not None]
    if len(after) != spec["expected"]:
        raise RosterError(f"{index_id}: expected {spec['expected']} constituents after the review, parsed {len(after)}")
    for column in ("before", "after"):
        total = sum(r[column] for r in rows if r[column] is not None)
        if abs(total - 100) > 0.6:
            raise RosterError(f"{index_id}: {column} weights add up to {total:.2f}, not about 100")
    return rows


def _member(row: dict, column: str, names: dict[str, dict]) -> dict:
    entry = names.get(row["code"]) or {}
    return {
        "code": row["code"],
        "name": entry.get("name") or row["name_en"],
        "name_en": row["name_en"],
        "weight_pct": row[column],
        "faf_pct": row["faf_pct"],
        "group": row["group"],
        "page": row["page"],
    }


def build_rosters(text: str, names: dict[str, dict]) -> dict:
    indices = {}
    for index_id in INDEX_IDS:
        spec = APPENDICES[index_id]
        rows = parse_appendix(text, index_id)
        before = [r for r in rows if r["before"] is not None]
        after = [r for r in rows if r["after"] is not None]
        before.sort(key=lambda r: (-r["before"], r["code"]))
        after.sort(key=lambda r: (-r["after"], r["code"]))
        added = sorted(set(r["code"] for r in after) - set(r["code"] for r in before))
        removed = sorted(set(r["code"] for r in before) - set(r["code"] for r in after))
        pages = f"{spec['heading']}, pp.{spec['pages'][0]}-{spec['pages'][-1]}"
        indices[index_id] = {
            "name": NAMES[index_id],
            "official_name": spec["title"],
            "versions": [
                {
                    "id": f"{index_id}-current",
                    "status": "current",
                    "effective_from": None,
                    "weights_column": "Before",
                    "weights_as_of": SOURCE["weights_reference_date"],
                    "weights_note": "Weighting of the current constituents on the review reference date, before re-capping and before the announced changes.",
                    "source_pages": pages,
                    "count": len(before),
                    "members": [_member(r, "before", names) for r in before],
                },
                {
                    "id": f"{index_id}-{EFFECTIVE_FROM}",
                    "status": "announced",
                    "effective_from": EFFECTIVE_FROM,
                    "implemented_after_close": IMPLEMENTED_AFTER_CLOSE,
                    "weights_column": "After",
                    "weights_as_of": SOURCE["weights_reference_date"],
                    "weights_note": "Pro-forma weighting after the announced re-capping and constituent changes. Not in force before the effective date.",
                    "source_pages": pages,
                    "count": len(after),
                    "added": added,
                    "removed": removed,
                    "members": [_member(r, "after", names) for r in after],
                },
            ],
        }
    return {"schema": 1, "source": SOURCE, "indices": indices}


# ---------------------------------------------------------------- runtime use


def load_rosters(path: Path = ROSTER_PATH) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def select_version(index: dict, today: date) -> tuple[dict, dict | None]:
    """(version in force on `today`, the next announced version or None).

    A version is in force from its effective_from date (None means already in force). Versions are
    listed oldest first. Dates are Hong Kong calendar dates.
    """
    versions = index["versions"]
    active = versions[0]
    for v in versions:
        start = v.get("effective_from")
        if start is None or date.fromisoformat(start) <= today:
            active = v
    later = [v for v in versions if v.get("effective_from") and date.fromisoformat(v["effective_from"]) > today]
    return active, (later[0] if later else None)


def roster_meta(version: dict, upcoming: dict | None, source: dict) -> dict:
    """Small public description of the roster in use. Never contains the full future roster."""
    meta = {
        "status": version["status"],
        "count": version["count"],
        "weights_as_of": version["weights_as_of"],
        "weights_basis": version["weights_note"],
        "effective_from": version.get("effective_from"),
        "source": {
            "publisher": source["publisher"],
            "announced": source["announced"],
            "pages": version["source_pages"],
            "url": source["url"],
        },
        "upcoming": None,
    }
    if upcoming:
        meta["upcoming"] = {
            "effective_from": upcoming["effective_from"],
            "count": upcoming["count"],
            "added": upcoming.get("added", []),
            "removed": upcoming.get("removed", []),
            "announced": source["announced"],
        }
    return meta


def drift(roster_codes: list[str], gateway_codes: list[str]) -> dict:
    """Differences between the official roster and a gateway's plate list. The roster stays authoritative."""
    official = {short_code(c.split(".")[-1]) for c in roster_codes}
    gateway = {short_code(c.split(".")[-1]) for c in gateway_codes}
    return {"missing_from_gateway": sorted(official - gateway), "extra_in_gateway": sorted(gateway - official)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--pdf", type=Path, help="the announcement PDF (needs pdfplumber)")
    src.add_argument("--pdf-text", type=Path, help="page-marked text of the announcement")
    p.add_argument("--names-cache", type=Path, default=names_mod.CACHE_PATH)
    p.add_argument("--out", type=Path, default=ROSTER_PATH)
    args = p.parse_args(argv)
    text = extract_text(args.pdf) if args.pdf else args.pdf_text.read_text(encoding="utf-8")
    names = names_mod.load_names(args.names_cache)
    if not names:
        print("error: no Traditional Chinese name list; run the collector once or fetch the exchange list", file=sys.stderr)
        return 2
    doc = build_rosters(text, names)
    missing = sorted({m["code"] for ix in doc["indices"].values() for v in ix["versions"] for m in v["members"]
                      if not names_mod.has_cjk(m["name"]) and m["name"] == m["name_en"]})
    if missing:
        print("warning: no Chinese name for " + ", ".join(missing), file=sys.stderr)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
