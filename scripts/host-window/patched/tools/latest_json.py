#!/usr/bin/env python3
"""Write /news/latest.json for the landing page. Usage: latest_json.py <DATE> <out_path> [--refresh]
Top story = stories[] with lowest n; image from tools/og_images.py cache (data/<DATE>.json `og_images`).
ADRRR_PUBLISH_MODE=frozen reads ADRRR_FROZEN_ROOT, skips image refresh, and does not write
the data JSON. Unset mode still uses D and rewrites the data JSON."""
import json, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import og_images as og

def _under(path, parent):
    return Path(path).resolve() == Path(parent).resolve() or og._is_relative_to(path, parent)

frozen = og.publish_mode() == "frozen"
root = og.frozen_root() if frozen else og.D
BASE = json.load(open(root / "netlify_config.json"))["base_url"].rstrip("/")
date, out = sys.argv[1], Path(sys.argv[2])
p = root / "data" / f"{date}.json"; d = json.loads(p.read_text())
s = sorted(d["stories"], key=lambda x: x.get("n", 99))[0]
u = (s.get("links") or [{}])[0].get("url")
e = og.get(d, og.story_key(s), "--refresh" in sys.argv)
if not frozen:
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
body = re.sub(r"\s+", " ", s.get("body", "")).strip()
m = re.match(r"(.+?[。！？!?])", body)
obj = {"date": date, "headline": s["title"], "summary": m.group(1) if m else body,
       "image_url": (BASE + e["image_url"]) if (e.get("image_url") or "").startswith("/") else e.get("image_url"),
       "image_srcset": (lambda s1200: (
                        f'{BASE}{s1200} 1200w, {BASE}{e["image_url"]} {(e.get("size") or [2400])[0]}w'
                        if e.get("hires") and s1200 and (root / "cache/img" / date.replace("-", "") / s1200.rsplit("/",1)[-1]).exists()
                        else None))(og.srcset_1200_url(e.get("image_url") or "")),
       "image_url_original": e.get("orig_url"), "image_credit": e["image_credit"] if e["image_url"] else None,
       "source_name": og.source_name(u) if u else None, "source_url": u,
       "report_url": f"/news/{date.replace('-', '')}/"}
if frozen and (not _under(out, root) or _under(out, og.D)):
    raise SystemExit("frozen mode writes latest.json only inside the isolated digest, never the formal digest")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(obj, ensure_ascii=False))
