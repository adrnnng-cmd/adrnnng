#!/usr/bin/env python3
"""Build the NC favicon from the accepted News Chart wordmark strokes.

Reads the N and C path data out of assets/brand/news-chart-white.svg and writes
assets/brand/favicon.svg. It does not redraw the letters and does not write the
wordmark, OG image, or apple-touch icon. Re-run this after an intentional
wordmark edit; the favicon test rejects a generic outline that is not these paths.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORDMARK = ROOT / "assets/brand/news-chart-white.svg"
OUT = ROOT / "assets/brand/favicon.svg"

# Ink-to-ink gap in the wordmark's font units. Wider than the "Ch" gap (36)
# and narrower than the word space (360), so the two capitals stay separate
# and still fill a 16px square.
GAP = 120
# Padding around the ink, as a fraction of the square side.
PAD_FRAC = 0.08

def paths(svg: str) -> list[tuple[str, float]]:
    found = re.findall(
        r'<path d="([^"]+)" transform="translate\(([-\d.]+) 0\)"/>',
        svg,
    )
    if len(found) != 9:
        raise SystemExit(f"expected 9 wordmark paths, found {len(found)}")
    return [(d, float(x)) for d, x in found]


def bbox(d: str) -> tuple[float, float, float, float]:
    tokens = re.findall(r"[MLHVQZ]|-?\d+(?:\.\d+)?", d)
    xs: list[float] = []
    ys: list[float] = []
    i = 0
    cx = cy = 0.0
    while i < len(tokens):
        op = tokens[i]
        i += 1
        if op == "Z":
            continue
        if op == "H":
            cx = float(tokens[i])
            i += 1
            xs.append(cx)
            ys.append(cy)
        elif op == "V":
            cy = float(tokens[i])
            i += 1
            xs.append(cx)
            ys.append(cy)
        elif op in ("M", "L"):
            cx, cy = float(tokens[i]), float(tokens[i + 1])
            i += 2
            xs.append(cx)
            ys.append(cy)
        elif op == "Q":
            nums = [float(tokens[i + n]) for n in range(4)]
            i += 4
            xs.extend(nums[0::2])
            ys.extend(nums[1::2])
            cx, cy = nums[2], nums[3]
        else:
            raise SystemExit(f"unexpected path op {op}")
    return min(xs), min(ys), max(xs), max(ys)


def shift(box, dx):
    x0, y0, x1, y1 = box
    return x0 + dx, y0, x1 + dx, y1


def build(svg: str) -> str:
    items = paths(svg)
    n_d, n_tx = items[0]
    c_d, c_tx = items[4]
    if not n_d.startswith("M235.5 1500"):
        raise SystemExit("path 1 is not the accepted N")
    if not c_d.startswith("M801.5 -20"):
        raise SystemExit("path 5 is not the accepted C")
    n_box = shift(bbox(n_d), n_tx)
    c_box = shift(bbox(c_d), c_tx)
    n_dx = -n_box[0]
    c_dx = (n_box[2] + n_dx) + GAP - c_box[0]
    placed_n = shift(n_box, n_dx)
    placed_c = shift(c_box, c_dx)
    x0 = min(placed_n[0], placed_c[0])
    y0 = min(placed_n[1], placed_c[1])
    x1 = max(placed_n[2], placed_c[2])
    y1 = max(placed_n[3], placed_c[3])
    ink_w = x1 - x0
    ink_h = y1 - y0
    side = max(ink_w, ink_h) / (1 - 2 * PAD_FRAC)
    ox = (side - ink_w) / 2 - x0
    n_out = n_tx + n_dx + ox
    c_out = c_tx + c_dx + ox
    # y-up ink: y1 is the cap, y0 is the lowest overshoot. Flip so the cap sits
    # one equal pad below the top of the square.
    origin = y1 + (side - ink_h) / 2
    comment = (
        "<!-- NC favicon. The N and C path data are copied from "
        "assets/brand/news-chart-white.svg (refined 2026-11-13.1). "
        "Do not replace them with a font outline. Regenerate with "
        "scripts/build-nc-favicon.py. -->"
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side:.1f} {side:.1f}" '
        f'fill="#fff" role="img" aria-label="NC">\n'
        f"{comment}\n"
        f'<rect width="{side:.1f}" height="{side:.1f}" fill="#000"/>\n'
        f'<g transform="translate(0 {origin:.1f}) scale(1 -1)">\n'
        f'<path d="{n_d}" transform="translate({n_out:.1f} 0)"/>\n'
        f'<path d="{c_d}" transform="translate({c_out:.1f} 0)"/>\n'
        f"</g>\n</svg>\n"
    )


def main() -> None:
    svg = WORDMARK.read_text()
    OUT.write_text(build(svg))
    print(OUT.relative_to(ROOT))


if __name__ == "__main__":
    sys.exit(main())
