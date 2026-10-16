"""Official House Clerk financial-disclosure index, used to link House rows to the PTR PDF."""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass

from ..http import Client
from ..model import iso, last_name_key

BASE = "https://disclosures-clerk.house.gov/public_disc"


@dataclass
class Filing:
    last: str
    first: str
    state_district: str
    filed_date: str
    doc_id: str
    year: int

    @property
    def url(self) -> str:
        return f"{BASE}/ptr-pdfs/{self.year}/{self.doc_id}.pdf"


def parse_index(text: str, year: int) -> list[Filing]:
    lines = text.splitlines()
    if not lines:
        return []
    header = [h.strip() for h in lines[0].split("\t")]
    idx = {h: i for i, h in enumerate(header)}
    out = []
    for line in lines[1:]:
        cols = line.split("\t")
        if len(cols) < len(header):
            continue
        if cols[idx["FilingType"]].strip() != "P":
            continue
        out.append(
            Filing(
                last=cols[idx["Last"]].strip(),
                first=cols[idx["First"]].strip(),
                state_district=cols[idx["StateDst"]].strip(),
                filed_date=iso(cols[idx["FilingDate"]]),
                doc_id=cols[idx["DocID"]].strip(),
                year=year,
            )
        )
    return out


def fetch_index(client: Client, year: int) -> list[Filing]:
    blob = client.request(f"{BASE}/financial-pdfs/{year}FD.zip")
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        text = z.read(f"{year}FD.txt").decode("utf-8", "replace")
    return parse_index(text, year)


class HouseIndex:
    def __init__(self, filings: list[Filing]):
        self.by_key: dict[tuple[str, str], list[Filing]] = {}
        for f in filings:
            self.by_key.setdefault((last_name_key(f.last), f.filed_date), []).append(f)

    def match(self, name: str, filed_date: str, state: str = "") -> Filing | None:
        cands = self.by_key.get((last_name_key(name), filed_date), [])
        if state:
            narrowed = [c for c in cands if c.state_district.startswith(state)]
            cands = narrowed or cands
        if len(cands) > 1:
            first = (name or "").split()[0].lower() if name else ""
            narrowed = [c for c in cands if c.first.lower().startswith(first[:3])]
            cands = narrowed or cands
        return cands[0] if cands else None
