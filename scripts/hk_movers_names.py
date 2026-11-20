"""Traditional Chinese stock names from the exchange's official securities list.

Standard library only. The list is an .xlsx file, which is a zip of XML parts,
so it is read with zipfile and ElementTree. The parsed result is cached for
seven days.
"""

from __future__ import annotations

import json
import re
import time
import unicodedata
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

LIST_URL = "https://www.hkex.com.hk/chi/services/trading/securities/securitieslists/ListOfSecurities_c.xlsx"
CACHE_PATH = Path("/tmp/hkex_names_tc.json")
CACHE_TTL_SECONDS = 7 * 24 * 3600
EQUITY_CATEGORIES = {"股本", "股本證券", "房地產投資信託基金", "Equity"}

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
_CELL_REF = re.compile(r"([A-Z]+)")
CJK = re.compile(r"[\u4e00-\u9fff]")


def has_cjk(text: str) -> bool:
    return bool(CJK.search(text or ""))


def clean_name(text: str) -> str:
    """NFKC folds the full-width Latin letters and dashes the list uses ("－Ｗ" -> "-W")."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text or "")).strip()


def _column(ref: str) -> int:
    letters = _CELL_REF.match(ref).group(1)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx_rows(data: bytes) -> list[list[str]]:
    """First worksheet as rows of strings. Gaps become empty strings."""
    with zipfile.ZipFile(BytesIO(data)) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", _NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{_NS['m']}}}t")))
        sheet = sorted(n for n in zf.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))[0]
        root = ET.fromstring(zf.read(sheet))
        rows: list[list[str]] = []
        for row in root.iter(f"{{{_NS['m']}}}row"):
            cells: dict[int, str] = {}
            for c in row.findall("m:c", _NS):
                kind = c.get("t")
                if kind == "inlineStr":
                    text = "".join(t.text or "" for t in c.iter(f"{{{_NS['m']}}}t"))
                else:
                    v = c.find("m:v", _NS)
                    text = v.text if v is not None and v.text is not None else ""
                    if kind == "s" and text != "":
                        text = shared[int(text)]
                cells[_column(c.get("r", "A1"))] = text
            if cells:
                width = max(cells) + 1
                rows.append([cells.get(i, "") for i in range(width)])
        return rows


def parse_names(data: bytes) -> dict[str, dict]:
    """code -> {"name": Traditional Chinese name, "category": 分類}."""
    rows = read_xlsx_rows(data)
    header_at = next((i for i, r in enumerate(rows) if "股份代號" in [c.strip() for c in r]), None)
    if header_at is None:
        raise ValueError("securities list has no 股份代號 column")
    header = [c.strip() for c in rows[header_at]]
    col_code = header.index("股份代號")
    col_name = header.index("股份名稱")
    col_cat = header.index("分類") if "分類" in header else None
    out: dict[str, dict] = {}
    for r in rows[header_at + 1:]:
        if len(r) <= max(col_code, col_name):
            continue
        code = r[col_code].strip()
        if not code.isdigit():
            continue
        entry = {"name": clean_name(r[col_name])}
        if col_cat is not None and col_cat < len(r):
            entry["category"] = r[col_cat].strip()
        if entry["name"]:
            out[code.zfill(5)] = entry
    return out


def _download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (news-chart hk-movers)"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def load_names(cache_path: Path = CACHE_PATH, *, now: float | None = None, fetch=_download,
               url: str = LIST_URL, ttl: int = CACHE_TTL_SECONDS) -> dict[str, dict]:
    """Cached names. Refreshes after the TTL; a failed refresh falls back to a stale cache, then to {}."""
    now = time.time() if now is None else now
    cached = None
    try:
        cached = json.loads(Path(cache_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    if cached and now - float(cached.get("fetched_at", 0)) < ttl and cached.get("names"):
        return cached["names"]
    try:
        names = parse_names(fetch(url))
    except Exception:  # network, zip or layout problems must not stop the collector
        return cached["names"] if cached and cached.get("names") else {}
    try:
        Path(cache_path).write_text(json.dumps({"fetched_at": now, "source": "hkex", "names": names}, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return names


def short_code(code: str) -> str:
    text = str(code).strip()
    if "." in text:
        text = text.split(".", 1)[1]
    return text.zfill(5)


def is_hk_equity_code(code: str) -> bool:
    """HK$ counters 00001-09999. Drops 8xxxx RMB counters, warrants and other 5-digit products."""
    text = short_code(code)
    return text.isdigit() and 1 <= int(text) <= 9999


def is_listed_equity(code: str, names: dict[str, dict]) -> bool:
    """Range check, plus the list's 分類 when the code is in it (excludes ETFs and leveraged products)."""
    if not is_hk_equity_code(code):
        return False
    entry = names.get(short_code(code))
    if entry and entry.get("category"):
        return entry["category"] in EQUITY_CATEGORIES
    return True
