#!/usr/bin/env python3
"""Build the NC favicon from the accepted News Chart wordmark.

The N and C paths come from assets/brand/news-chart-white.svg. Two micro-size
edits, and nothing else:

- The N's verticals are 4-unit hairlines beside a heavy diagonal. Each hairline
  is opened into a stem wide enough to survive 16 device pixels. The diagonal
  anchors and the outer serif ends stay.
- The C keeps its path and gains a white stroke so the spine holds and the
  opening stays open.

The wordmark, OG image, and apple-touch icon are not written.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORDMARK = ROOT / "assets/brand/news-chart-white.svg"
OUT = ROOT / "assets/brand/favicon.svg"

GAP = 120
PAD_FRAC = 0.06
# Hairline is ~4 units. 460 units is a little over two pixels at 16px in the
# square this layout produces. Smaller and the stem aliases back to gray.
N_STEM = 460
# Centered stroke on the original C. Half of this is about one extra pixel.
C_STROKE = 200

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


def refine_n(d: str) -> str:
    """Open the two 4-unit vertical hairlines into stems. Diagonal anchors stay."""
    if "M235.5 1500" not in d or "H231.5" not in d or "H1253" not in d:
        raise SystemExit("N path is not the accepted wordmark N")
    if "L233.5 1500" not in d or "H603" not in d:
        raise SystemExit("N is missing the diagonal anchors")
    left_edge = 33.5
    left_right = left_edge + N_STEM
    serif_right = left_right + 36
    # Right hairline sits at 1249/1253. Grow it left into the counter and a
    # little right toward the existing serif end at 1463.
    right_outer = min(1463.0 - 20, 1253.0 + 160)
    right_inner = right_outer - N_STEM
    left = (
        f"M{left_right:.1f} 1500V22H{serif_right:.1f}V0H{left_edge:.1f}V22"
        f"H{left_edge + 8:.1f}V1476H{left_edge:.1f}V1500Z"
    )
    right = (
        f"M1463 1500V1476H{right_outer:.1f}V-20H{right_inner:.1f}"
        f"L233.5 1500H603L{right_inner:.1f} 509V1476"
        f"H{right_inner - 28:.1f}V1500Z"
    )
    return f"{left} {right}"


def shift(box, dx, extra=0.0):
    x0, y0, x1, y1 = box
    return x0 + dx - extra, y0 - extra, x1 + dx + extra, y1 + extra


def build(svg: str) -> str:
    items = paths(svg)
    n_src, n_tx = items[0]
    c_src, c_tx = items[4]
    if not c_src.startswith("M801.5 -20"):
        raise SystemExit("path 5 is not the accepted C")
    n_d = refine_n(n_src)
    n_box = shift(bbox(n_d), n_tx)
    c_box = shift(bbox(c_src), c_tx, C_STROKE / 2)
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
    origin = y1 + (side - ink_h) / 2
    comment = (
        "<!-- NC favicon. Source paths: N and C in assets/brand/news-chart-white.svg "
        "(refined 2026-11-13.1). Micro-size only: N vertical hairlines opened to "
        f"{N_STEM:.0f} font units, C path unchanged plus stroke-width {C_STROKE:.0f}. "
        "Diagonal anchors 233.5 and 603 stay. Not a new font. "
        "Regenerate with scripts/build-nc-favicon.py. -->"
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side:.1f} {side:.1f}" '
        f'fill="#fff" role="img" aria-label="NC">\n'
        f"{comment}\n"
        f'<rect width="{side:.1f}" height="{side:.1f}" fill="#000"/>\n'
        f'<g transform="translate(0 {origin:.1f}) scale(1 -1)">\n'
        f'<path d="{n_d}" transform="translate({n_out:.1f} 0)"/>\n'
        f'<path d="{c_src}" transform="translate({c_out:.1f} 0)" '
        f'fill="#fff" stroke="#fff" stroke-width="{C_STROKE:.0f}" stroke-linejoin="round"/>\n'
        f"</g>\n</svg>\n"
    )


def main() -> None:
    OUT.write_text(build(WORDMARK.read_text()))
    print(OUT.relative_to(ROOT))


if __name__ == "__main__":
    sys.exit(main())
