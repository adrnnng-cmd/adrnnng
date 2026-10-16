"""Current members of Congress (public-domain dataset by @unitedstates) for party/state enrichment."""
from __future__ import annotations

from dataclasses import dataclass

from .http import Client
from .model import last_name_key

URL = "https://unitedstates.github.io/congress-legislators/legislators-current.json"
PARTY = {"Democrat": "D", "Republican": "R", "Independent": "I"}


@dataclass
class Member:
    bioguide: str
    name: str
    chamber: str
    party: str
    state: str
    district: str


class Roster:
    def __init__(self, members: list[Member]):
        self.by_id = {m.bioguide: m for m in members}
        self.by_last: dict[tuple[str, str], list[Member]] = {}
        for m in members:
            self.by_last.setdefault((m.chamber, last_name_key(m.name)), []).append(m)

    def __len__(self) -> int:
        return len(self.by_id)

    def get(self, bioguide: str) -> Member | None:
        return self.by_id.get(bioguide)

    def find(self, chamber: str, name: str) -> Member | None:
        cands = self.by_last.get((chamber, last_name_key(name)), [])
        if len(cands) > 1:
            first = (name or "").split()[0].lower()
            cands = [c for c in cands if c.name.lower().startswith(first[:3])] or cands[:0]
        return cands[0] if len(cands) == 1 else None


def parse(data: list[dict]) -> Roster:
    members = []
    for p in data:
        term = p["terms"][-1]
        chamber = "Senate" if term["type"] == "sen" else "House"
        district = ""
        if chamber == "House" and term.get("district") is not None:
            d = int(term["district"])
            district = f"{term['state']}-{'AL' if d == 0 else f'{d:02d}'}"
        members.append(
            Member(
                bioguide=p["id"]["bioguide"],
                name=p["name"].get("official_full") or f"{p['name']['first']} {p['name']['last']}",
                chamber=chamber,
                party=PARTY.get(term.get("party", ""), term.get("party", "")[:1]),
                state=term["state"],
                district=district,
            )
        )
    return Roster(members)


def fetch(client: Client) -> Roster:
    return parse(client.json(URL))
