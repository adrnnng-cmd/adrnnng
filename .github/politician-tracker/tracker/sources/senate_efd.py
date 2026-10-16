"""Official Senate eFD (efdsearch.senate.gov): Periodic Transaction Reports, parsed from HTML."""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date

from ..http import Client
from ..model import Trade, iso, normalize_amount, normalize_ticker, normalize_tx, title_company
from . import strip_tags

log = logging.getLogger(__name__)

BASE = "https://efdsearch.senate.gov"


@dataclass
class Filing:
    first: str
    last: str
    filed_date: str
    url: str
    title: str
    electronic: bool

    @property
    def amendment(self) -> bool:
        return "amendment" in self.title.lower()


def parse_search_rows(rows: list[list[str]]) -> list[Filing]:
    out = []
    for r in rows:
        if len(r) < 5:
            continue
        m = re.search(r'href="([^"]+)"[^>]*>([^<]*)<', r[3])
        if not m:
            continue
        href, title = m.group(1), m.group(2).strip()
        out.append(
            Filing(
                first=r[0].strip(),
                last=r[1].strip(),
                filed_date=iso(r[4]),
                url=BASE + href if href.startswith("/") else href,
                title=title,
                electronic="/ptr/" in href,
            )
        )
    return out


def parse_ptr(page: str, filing: Filing) -> list[Trade]:
    tbody = re.search(r"<tbody>(.*?)</tbody>", page, re.S)
    if not tbody:
        return []
    name = _display_name(filing)
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody.group(1), re.S):
        cells = [strip_tags(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if len(cells) < 8:
            continue
        _, tdate, owner, ticker, asset, asset_type, tx, amount = cells[:8]
        comment = cells[8] if len(cells) > 8 else ""
        out.append(
            Trade(
                source="senate_efd",
                name=name,
                chamber="Senate",
                ticker=normalize_ticker(ticker),
                company=title_company(asset),
                asset_type=asset_type,
                owner=owner,
                tx=normalize_tx(tx),
                amount=normalize_amount(amount),
                trade_date=iso(tdate),
                filed_date=filing.filed_date,
                comment=("Amendment · " if filing.amendment else "") + (comment if comment != "--" else ""),
                filing_id=filing.url,
                source_url=filing.url,
                source_label="Senate eFD",
            )
        )
    return out


def _display_name(f: Filing) -> str:
    first = f.first.split()[0].title() if f.first.strip() else ""
    last = re.sub(r",?\s*(Jr\.?|Sr\.?|II+|IV)$", "", f.last.strip(), flags=re.I).strip()
    last = last.title() if last.isupper() else last
    return f"{first} {last}".strip()


class SenateEFD:
    def __init__(self, client: Client):
        self.client = client
        self._ready = False

    def _accept_terms(self) -> None:
        page = self.client.text(f"{BASE}/search/home/")
        tok = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', page)
        if not tok:
            raise RuntimeError("eFD: CSRF token not found")
        self.client.request(
            f"{BASE}/search/home/",
            data={"prohibition_agreement": "1", "csrfmiddlewaretoken": tok.group(1)},
            headers={"Referer": f"{BASE}/search/home/"},
        )
        self._ready = True

    def filings(self, since: date) -> list[Filing]:
        if not self._ready:
            self._accept_terms()
        csrf = self.client.cookie("csrftoken") or ""
        out: list[Filing] = []
        start, length = 0, 100
        while True:
            data = self.client.json(
                f"{BASE}/search/report/data/",
                data={
                    "start": str(start),
                    "length": str(length),
                    "report_types": "[11]",
                    "filer_types": "[]",
                    "submitted_start_date": since.strftime("%m/%d/%Y 00:00:00"),
                    "submitted_end_date": "",
                    "candidate_state": "",
                    "senator_state": "",
                    "office_id": "",
                    "first_name": "",
                    "last_name": "",
                    "csrfmiddlewaretoken": csrf,
                },
                headers={"Referer": f"{BASE}/search/", "X-CSRFToken": csrf},
            )
            out.extend(parse_search_rows(data.get("data", [])))
            start += length
            if start >= int(data.get("recordsFiltered", 0)):
                break
        return out

    def trades(self, filings: list[Filing]) -> list[Trade]:
        out: list[Trade] = []
        for f in filings:
            if not f.electronic:
                continue
            try:
                out.extend(parse_ptr(self.client.text(f.url), f))
            except Exception as e:  # one bad filing should not sink the build
                log.warning("eFD: failed to parse %s: %s", f.url, e)
        return out
