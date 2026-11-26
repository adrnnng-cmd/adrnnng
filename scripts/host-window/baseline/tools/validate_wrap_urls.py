#!/usr/bin/env python3
"""Fail-closed gate for every reader-facing Markets Wrap Bloomberg URL
that build_site.py will render from data/<DATE>.json.

A URL may be published only when mail/<DATE>/wrap_url_probes.json (or
wrap_url_verification.json) has a probe for that exact window/role, from an
opened Bloomberg original, whose canonical, headline, nonempty checked tape,
and verification timestamp match the version used in the report.

Scripted HTTP 403, timeouts, robot walls, missing probes, date-filled standing
slugs, page_opened alone, or Asia evidence reused for US close (same canonical)
are not verification. A rolled current article cannot establish a historical
body. Unverified URLs must be omitted before build.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

ROOT = Path("/workspace/digest")
STANDING_SLUG = "stock-market-today-dow-s-p-live-updates"
STANDING_RE = re.compile(
    r"^https://www\.bloomberg\.com/news/articles/\d{4}-\d{2}-\d{2}/"
    + re.escape(STANDING_SLUG)
    + r"/?$"
)
FAIL_STATUSES = {"", "timeout", "403", "404", "unverified", "robot", "captcha", "error"}
OK_STATUS = "verified"
# Exact window tokens used in data.market_wrap.wraps[].window and evidence probes.
WINDOW_ALIASES = {
    "asia-pre-open": "asia-pre-open",
    "asia_preopen": "asia-pre-open",
    "asia-preopen": "asia-pre-open",
    "us-pre-open": "us-pre-open",
    "us_preopen": "us-pre-open",
    "us-preopen": "us-pre-open",
    "us-close": "us-close",
    "us_close": "us-close",
    "us-cash-close": "us-close",
}
LABEL_WINDOW = (
    ("亞洲開市前", "asia-pre-open"),
    ("美股開市前", "us-pre-open"),
    ("美股收市", "us-close"),
)
MOVER_PERIODS = ("1D", "5D", "20D")
MOVER_SIDES = ("gainers", "losers")


def norm_url(url: str) -> str:
    if not url:
        return ""
    p = urlparse(url.strip())
    path = p.path.rstrip("/") or p.path
    return urlunparse((p.scheme, p.netloc, path, "", "", ""))


def is_standing_slug(url: str) -> bool:
    return bool(STANDING_RE.match(norm_url(url)))


def window_token(raw: str | None) -> str | None:
    if not raw:
        return None
    s = str(raw).strip().lower()
    s = re.sub(r"(-reader-link|-reader|-link)$", "", s)
    return WINDOW_ALIASES.get(s)


def window_from_label(label: str | None) -> str | None:
    text = str(label or "")
    for needle, token in LABEL_WINDOW:
        if needle in text:
            return token
    return None


def evidence_paths(root: Path, date: str) -> list[Path]:
    mail = root / "mail" / date
    return [
        mail / "wrap_url_probes.json",
        mail / "wrap_url_verification.json",
    ]


def load_json(path: Path):
    return json.loads(path.read_text())


def iter_probes(evidence: object) -> list[dict]:
    if isinstance(evidence, list):
        return [x for x in evidence if isinstance(x, dict)]
    if isinstance(evidence, dict):
        if isinstance(evidence.get("probes"), list):
            return [x for x in evidence["probes"] if isinstance(x, dict)]
        if "url" in evidence or "canonical" in evidence or "canonicalBloombergURL" in evidence:
            return [evidence]
    return []


def probe_canonical(p: dict) -> str:
    return norm_url(
        p.get("canonical")
        or p.get("canonicalBloombergURL")
        or p.get("final_url")
        or ""
    )


def probe_status(p: dict) -> str:
    return str(p.get("status") or p.get("result") or p.get("verification") or "").strip().lower()


def probe_window(p: dict) -> str | None:
    # Exact window first; role is only an alias if it maps to the same token.
    return window_token(p.get("window")) or window_token(p.get("role"))


def probe_tape(p: dict) -> str:
    return str(p.get("tape") or p.get("tape_raw") or p.get("checked_tape") or "").strip()


def probe_verified_at(p: dict) -> str:
    return str(
        p.get("verified_hkt")
        or p.get("verified_at")
        or p.get("captureHKT")
        or p.get("captured_hkt")
        or ""
    ).strip()


def body_actually_read(p: dict) -> bool:
    """page_opened alone is not proof the body/session was checked."""
    if p.get("page_opened") and not (
        p.get("body_read") is True or p.get("bloomberg_original_body_read") is True
    ):
        return False
    return p.get("body_read") is True or p.get("bloomberg_original_body_read") is True


def body_is_rolled(p: dict) -> bool:
    if p.get("body_rolled") is True or p.get("historical_body_verified") is False:
        return True
    note = str(p.get("notes") or p.get("note") or "").lower()
    return "rolled" in note and "not recertif" in note.replace("re-certif", "recertif")


def matching_probe(probes: list[dict], url: str, window: str | None) -> dict | None:
    """Exact window match only. Never fall back to another role's probe at the same URL."""
    want_url = norm_url(url)
    want_win = window_token(window) if window else None
    if not want_url or not want_win:
        return None
    for p in probes:
        if probe_window(p) != want_win:
            continue
        cand = {probe_canonical(p), norm_url(p.get("url") or "")}
        if want_url in cand:
            return p
    return None


def _links_from_unknown(obj, path: str) -> list[tuple[str, str]]:
    """Collect http(s) URLs from a mis-nested wrap-like object."""
    found: list[tuple[str, str]] = []
    if isinstance(obj, dict):
        url = str(obj.get("url") or "").strip()
        if url.startswith("http"):
            found.append((path, url))
        for k, v in obj.items():
            if k == "url":
                continue
            found.extend(_links_from_unknown(v, f"{path}.{k}"))
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            found.extend(_links_from_unknown(item, f"{path}[{i}]"))
    return found


def mistaken_wrap_locations(data: dict) -> list[str]:
    found = []
    if "wraps" in data and not isinstance((data.get("market_wrap") or {}).get("wraps"), list):
        found.append("data.wraps")
    mw = data.get("market_wrap")
    if isinstance(mw, dict):
        if "wrap" in mw and "wraps" not in mw:
            found.append("market_wrap.wrap")
    elif isinstance(mw, list):
        found.append("market_wrap (list, not object)")
    if data.get("marketWrap"):
        found.append("marketWrap")
    return found


def misnested_wrap_urls(data: dict) -> list[str]:
    """URLs that a wrong nesting would hide from market_wrap.wraps."""
    official = (data.get("market_wrap") or {}).get("wraps") if isinstance(data.get("market_wrap"), dict) else None
    if isinstance(official, list):
        return []
    found = []
    for path, obj in (
        ("data.wraps", data.get("wraps")),
        ("market_wrap.wrap", (data.get("market_wrap") or {}).get("wrap") if isinstance(data.get("market_wrap"), dict) else None),
        ("marketWrap", data.get("marketWrap")),
        ("market_wrap", data.get("market_wrap") if not isinstance(data.get("market_wrap"), dict) else None),
    ):
        if obj is None:
            continue
        for loc, url in _links_from_unknown(obj, path):
            found.append(f"{loc}={url}")
    return found


def wraps_container(data: dict) -> tuple[list | None, str | None]:
    """Require the real renderer schema: data.market_wrap.wraps as a list."""
    mw = data.get("market_wrap")
    if not isinstance(mw, dict):
        if mw is None and not data.get("market_wrap"):
            return [], None
        return None, "market_wrap is not an object (wrong nesting)"
    if "wraps" not in mw:
        return None, "market_wrap.wraps is missing (wrong nesting)"
    wraps = mw.get("wraps")
    if wraps is None:
        return None, "market_wrap.wraps is null (wrong nesting)"
    if not isinstance(wraps, list):
        return None, f"market_wrap.wraps is {type(wraps).__name__}, not a list (wrong nesting)"
    return wraps, None


def _add_link(out: list, path: str, url: str, label: str = "", window: str | None = None):
    url = str(url or "").strip()
    if not url.startswith("http"):
        return
    out.append({
        "path": path,
        "url": url,
        "label": label or "",
        "window": window_token(window) or window_from_label(label),
    })


def iter_renderer_links(data: dict) -> list[dict]:
    """Every href build_site.py can emit from wrap/story/sector/mover link lists."""
    out: list[dict] = []
    mw = data.get("market_wrap") if isinstance(data.get("market_wrap"), dict) else {}
    wraps, _ = wraps_container(data) if isinstance(data.get("market_wrap"), dict) and "wraps" in (data.get("market_wrap") or {}) else ([], None)
    if wraps is None:
        wraps = []
    for i, w in enumerate(wraps):
        if isinstance(w, dict):
            _add_link(out, f"market_wrap.wraps[{i}]", w.get("url") or "", w.get("label") or "", w.get("window"))
    for i, p in enumerate(mw.get("points") or []):
        if not isinstance(p, dict):
            continue
        for j, l in enumerate(p.get("links") or []):
            if isinstance(l, dict):
                _add_link(out, f"market_wrap.points[{i}].links[{j}]", l.get("url") or "", l.get("label") or "")
    src = mw.get("source") or {}
    if isinstance(src, dict) and src.get("url"):
        _add_link(out, "market_wrap.source", src.get("url") or "", src.get("label") or "")
    for i, s in enumerate(data.get("stories") or []):
        if not isinstance(s, dict):
            continue
        for j, l in enumerate(s.get("links") or []):
            if isinstance(l, dict):
                _add_link(out, f"stories[{i}].links[{j}]", l.get("url") or "", l.get("label") or s.get("title") or "")
    for i, s in enumerate(data.get("sectors") or []):
        if not isinstance(s, dict):
            continue
        for j, l in enumerate(s.get("links") or []):
            if isinstance(l, dict):
                _add_link(out, f"sectors[{i}].links[{j}]", l.get("url") or "", l.get("label") or "")
    mp = data.get("market_perf") or {}
    for mi, mkt in enumerate((mp.get("markets") or []) if isinstance(mp, dict) else []):
        if not isinstance(mkt, dict):
            continue
        movers = mkt.get("movers") or {}
        if not isinstance(movers, dict):
            continue
        for period in MOVER_PERIODS:
            bucket = movers.get(period) or {}
            if not isinstance(bucket, dict):
                continue
            for side in MOVER_SIDES:
                for gi, g in enumerate(bucket.get(side) or []):
                    if not isinstance(g, dict):
                        continue
                    for j, l in enumerate(g.get("why_links") or []):
                        if isinstance(l, dict):
                            _add_link(
                                out,
                                f"market_perf.markets[{mi}].movers.{period}.{side}[{gi}].why_links[{j}]",
                                l.get("url") or "",
                                l.get("label") or "",
                            )
    return out


def wrap_windows_by_url(wraps: list) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for w in wraps or []:
        if not isinstance(w, dict):
            continue
        url = norm_url(w.get("url") or "")
        win = window_token(w.get("window")) or window_from_label(w.get("label"))
        if url and win:
            found.setdefault(url, set()).add(win)
    return found


def is_wrap_reader_ref(ref: dict, wrap_urls: dict[str, set[str]]) -> bool:
    if ref.get("window"):
        return True
    if window_from_label(ref.get("label")):
        return True
    nurl = norm_url(ref.get("url") or "")
    if is_standing_slug(nurl) or nurl in wrap_urls:
        return True
    return False


def resolve_window(ref: dict, wrap_urls: dict[str, set[str]], errors: list[str]) -> str | None:
    declared = ref.get("window") or window_from_label(ref.get("label"))
    if declared:
        return declared
    nurl = norm_url(ref.get("url") or "")
    wins = wrap_urls.get(nurl) or set()
    if len(wins) == 1:
        return next(iter(wins))
    if len(wins) > 1:
        errors.append(
            f"FAIL-CLOSED: {ref['path']} standing/wrap URL {nurl} is used for multiple windows "
            f"({', '.join(sorted(wins))}) but has no exact role/window label; "
            "do not reuse another role's evidence"
        )
        return None
    if is_standing_slug(nurl):
        errors.append(
            f"FAIL-CLOSED: {ref['path']} has standing live-updates URL {nurl} with no exact window/role"
        )
        return None
    return None


def validate_probe_for_ref(ref: dict, probe: dict, nurl: str, window: str) -> list[str]:
    errors: list[str] = []
    label = f"{ref['path']} ({ref.get('label') or window})"
    status = probe_status(probe)
    canon = probe_canonical(probe)
    if status in FAIL_STATUSES or status != OK_STATUS:
        errors.append(
            f"FAIL-CLOSED: {label} evidence status is {status or 'missing'} "
            f"(403/timeout/unverified cannot publish a URL)"
        )
        return errors
    if body_is_rolled(probe):
        errors.append(
            f"FAIL-CLOSED: {label} probe is a rolled current article and cannot establish the historical {window} body"
        )
    if not canon:
        errors.append(f"FAIL-CLOSED: {label} verified probe is missing canonical URL")
    elif nurl != canon:
        errors.append(f"FAIL-CLOSED: {label} published URL {nurl} != opened canonical {canon}")
    if not body_actually_read(probe):
        errors.append(
            f"FAIL-CLOSED: {label} needs body_read or bloomberg_original_body_read true; "
            "page_opened alone is not body/session proof"
        )
    if not (probe.get("headline") or probe.get("title") or "").strip():
        errors.append(f"FAIL-CLOSED: {label} missing verified headline/title")
    if not probe_tape(probe):
        errors.append(f"FAIL-CLOSED: {label} missing nonempty checked tape for window {window}")
    if not probe_verified_at(probe):
        errors.append(f"FAIL-CLOSED: {label} missing verification timestamp (verified_hkt / verified_at / captureHKT)")
    if STANDING_RE.match(nurl) and canon and nurl != canon:
        errors.append(f"FAIL-CLOSED: {label} standing live-updates slug was date-filled, not opened")
    return errors


def validate(date: str, root: Path | None = None) -> list[str]:
    root = root or ROOT
    errors: list[str] = []
    data_path = root / "data" / f"{date}.json"
    if not data_path.is_file():
        return [f"missing data file: {data_path}"]
    data = load_json(data_path)

    wraps, nest_err = wraps_container(data)
    refs = iter_renderer_links(data)
    wrap_urls = wrap_windows_by_url(wraps or [])
    wrap_refs = [r for r in refs if is_wrap_reader_ref(r, wrap_urls)]
    published = [r for r in wrap_refs if r.get("url")]

    hidden = misnested_wrap_urls(data)
    if nest_err and (published or hidden):
        extra = mistaken_wrap_locations(data)
        hint_bits = list(extra)
        if hidden:
            hint_bits.append("hidden wrap URL(s): " + "; ".join(hidden[:8]))
        hint = f" ({'; '.join(hint_bits)})" if hint_bits else ""
        errors.append(f"FAIL-CLOSED: {nest_err}{hint}; cannot pass when wraps are missing or mis-nested")
        return errors
    if nest_err:
        # Broken wraps type/shape even with no published hrefs.
        errors.append(f"FAIL-CLOSED: {nest_err}")
        return errors
    if hidden:
        errors.append(
            "FAIL-CLOSED: wrap URL(s) found outside data.market_wrap.wraps "
            f"({'; '.join(hidden[:8])}); cannot pass when wraps are mis-nested"
        )
        return errors

    ev_files = [p for p in evidence_paths(root, date) if p.is_file()]
    probes: list[dict] = []
    if ev_files:
        try:
            probes = iter_probes(load_json(ev_files[0]))
        except Exception as e:
            errors.append(f"cannot read evidence {ev_files[0]}: {e}")
            return errors

    if published and not ev_files:
        errors.append(
            f"FAIL-CLOSED: {len(published)} reader-facing wrap URL(s) but no "
            f"mail/{date}/wrap_url_probes.json or wrap_url_verification.json"
        )
        return errors

    for ref in wrap_refs:
        url = ref["url"]
        if not url:
            continue
        nurl = norm_url(url)
        window = resolve_window(ref, wrap_urls, errors)
        if not window:
            if any(ref["path"] in e for e in errors):
                continue
            errors.append(f"FAIL-CLOSED: {ref['path']} wrap URL {nurl} has no exact window/role")
            continue
        # wraps[] itself must declare a canonical window token
        if ref["path"].startswith("market_wrap.wraps[") and not window_token(ref.get("window") or "") and not window_from_label(ref.get("label")):
            errors.append(f"FAIL-CLOSED: {ref['path']} is missing an exact window token")
            continue
        probe = matching_probe(probes, url, window)
        if probe is None:
            other = [
                probe_window(p) for p in probes
                if nurl in {probe_canonical(p), norm_url(p.get("url") or "")} and probe_window(p)
            ]
            extra = ""
            if other:
                extra = (
                    f" (found evidence for {', '.join(sorted(set(x for x in other if x)))} at the same URL; "
                    "Asia proof cannot be used for US close, and each role needs its own tape)"
                )
            errors.append(
                f"FAIL-CLOSED: {ref['path']} ({ref.get('label') or window}) has URL {nurl} "
                f"but no opened-original probe for exact window {window}{extra}"
            )
            continue
        errors.extend(validate_probe_for_ref(ref, probe, nurl, window))
    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Fail-closed Markets Wrap URL evidence gate")
    ap.add_argument("date", help="Report date YYYY-MM-DD")
    ap.add_argument("--root", default=str(ROOT), help="digest root (default /workspace/digest)")
    args = ap.parse_args(argv)
    errors = validate(args.date, Path(args.root))
    if errors:
        print("wrap URL evidence gate: FAIL", file=sys.stderr)
        for e in errors:
            print(e, file=sys.stderr)
        return 1
    print(f"wrap URL evidence gate: PASS {args.date}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
