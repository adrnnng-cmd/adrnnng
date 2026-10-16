from __future__ import annotations

import html
import re

_TAG_RE = re.compile(r"<[^>]+>")


def strip_tags(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(_TAG_RE.sub(" ", fragment))).strip()
