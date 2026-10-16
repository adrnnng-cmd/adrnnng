from __future__ import annotations

import re


class Watchlist:
    def __init__(self, cfg: dict):
        self.us = {t.upper() for t in cfg.get("us", [])}
        self.hk = {self._hk(t) for t in cfg.get("hk", [])}
        self.aliases = {k.upper(): v.upper() for k, v in cfg.get("aliases", {}).items()}

    @staticmethod
    def _hk(code: str) -> str:
        return code.strip().lstrip("0").zfill(4)

    def match(self, ticker: str) -> str:
        """Return the Watchlist symbol a ticker maps to ("" if none)."""
        t = (ticker or "").strip().upper()
        if not t:
            return ""
        t = self.aliases.get(t, t)
        hk = re.fullmatch(r"(\d{1,5})(?:[ .]HK)?", t)
        if hk:
            code = self._hk(hk.group(1))
            return f"{code}.HK" if code in self.hk else ""
        t = t.replace("-", ".")
        return t if t in self.us else ""
