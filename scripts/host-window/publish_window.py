#!/usr/bin/env python3
"""Pin, install, and roll back the frozen publish window.

This is the host-side control for publish.sh / check_sections.sh. It does not
deploy, send mail, or talk to the platform webhook. The webhook entry remains
`bash check_sections.sh`; these checks run inside that process when the pin
file is present, and inside an explicit frozen invocation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = (
    "publish.sh",
    "check_sections.sh",
    "tools/latest_json.py",
    "tools/og_images.py",
)
NEW_SCRIPT = "tools/publish_window.py"
CONTENT_ROOTS = ("data", "cache/img", "site")
PUBLIC_FILE = "deploy/news/latest.json"
FUNCTIONS = "sections-src/functions"


class WindowStop(SystemExit):
    pass


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _files_under(root: Path, rel: str) -> dict[str, str]:
    base = root / rel
    if not base.exists():
        return {}
    out = {}
    if base.is_file():
        out[rel] = sha256(base)
        return out
    for path in sorted(p for p in base.rglob("*") if p.is_file()):
        out[str(path.relative_to(root))] = sha256(path)
    return out


def content_manifest(root: Path) -> dict[str, str]:
    found = {}
    for rel in CONTENT_ROOTS:
        found.update(_files_under(root, rel))
    return found


def host_manifest(host: Path, package_py: Path | None) -> dict[str, str]:
    found = {}
    for rel in SCRIPTS:
        path = host / rel
        if path.is_file():
            found[rel] = sha256(path)
    new = host / NEW_SCRIPT
    if new.is_file():
        found[NEW_SCRIPT] = sha256(new)
    elif package_py is not None and package_py.is_file():
        found[NEW_SCRIPT] = sha256(package_py)
    found.update(_files_under(host, FUNCTIONS))
    return found


def public_manifest(host: Path) -> dict[str, str]:
    return _files_under(host, PUBLIC_FILE)


def marker_text(host: Path) -> str:
    path = host / ".sections_deployed"
    if not path.is_file():
        return "NONE"
    return path.read_text().strip() or "NONE"


def git_head(host: Path) -> str | None:
    git = host / "sections-src" / ".git"
    if not git.exists():
        return None
    import subprocess
    out = subprocess.run(
        ["git", "-C", str(host / "sections-src"), "rev-parse", "HEAD"],
        text=True, capture_output=True,
    )
    if out.returncode != 0:
        return None
    return out.stdout.strip()


def write_pin(host: Path, until: str, main_sha: str | None, package_py: Path | None) -> dict:
    head = git_head(host)
    sha = main_sha or head
    if not sha or len(sha) < 40:
        raise WindowStop("STOP: pin requires the sections-src HEAD")
    try:
        expiry = datetime.fromisoformat(until)
    except ValueError as exc:
        raise WindowStop(f"STOP: pin until is not ISO time: {until}") from exc
    if expiry.tzinfo is None:
        raise WindowStop("STOP: pin until must include a timezone")
    pin = {
        "version": 1,
        "until": until,
        "main_sha": sha,
        "marker": marker_text(host),
        "host_files": host_manifest(host, package_py),
        "content_files": content_manifest(host),
        "public_files": public_manifest(host),
    }
    return pin


def _diff_map(label: str, expected: dict, actual: dict) -> list[str]:
    problems = []
    for key in sorted(set(expected) | set(actual)):
        if expected.get(key) != actual.get(key):
            problems.append(f"{label} {key}")
    return problems


def check_pin(pin: dict, host: Path, content: Path, live: Path | None, package_py: Path | None) -> list[str]:
    problems = []
    try:
        expiry = datetime.fromisoformat(pin["until"])
    except (KeyError, ValueError):
        return ["pin until missing or invalid"]
    if expiry.tzinfo is None:
        return ["pin until missing timezone"]
    if datetime.now(timezone.utc) > expiry.astimezone(timezone.utc):
        problems.append("pin expired")
    expected_host = dict(pin.get("host_files") or {})
    actual_host = host_manifest(host, None)
    if NEW_SCRIPT in expected_host and not (host / NEW_SCRIPT).is_file():
        actual_host[NEW_SCRIPT] = None
    problems.extend(_diff_map("host", expected_host, actual_host))
    problems.extend(_diff_map("content", pin.get("content_files") or {}, content_manifest(content)))
    if live is not None and live.resolve() != content.resolve():
        problems.extend(_diff_map("live", pin.get("content_files") or {}, content_manifest(live)))
    problems.extend(_diff_map("public", pin.get("public_files") or {}, public_manifest(host)))
    if marker_text(host) != pin.get("marker"):
        problems.append("marker")
    head = git_head(host)
    if head is not None and head != pin.get("main_sha"):
        problems.append(f"main_sha {head}")
    # de-duplicate host diffs from the first provisional call
    dedup = []
    seen = set()
    for item in problems:
        if item not in seen:
            seen.add(item)
            dedup.append(item)
    return dedup


def tree_manifest(root: Path) -> dict:
    files = {}
    if not root.exists():
        return files
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = str(path.relative_to(root))
        entry = {"sha256": sha256(path), "mtime_ns": path.stat().st_mtime_ns, "size": path.stat().st_size}
        if path.suffix == ".xml":
            entry["lastmod"] = [
                line.strip() for line in path.read_text(errors="replace").splitlines()
                if "<lastmod>" in line and "</lastmod>" in line
            ]
        files[rel] = entry
    return files


def manifest_diff(before: dict, after: dict) -> dict:
    content, mtime, lastmod = [], [], []
    for rel in sorted(set(before) | set(after)):
        a, b = before.get(rel), after.get(rel)
        if a is None or b is None or a["sha256"] != b["sha256"] or a["size"] != b["size"]:
            content.append(rel)
            continue
        if a["mtime_ns"] != b["mtime_ns"]:
            mtime.append({"path": rel, "before_ns": a["mtime_ns"], "after_ns": b["mtime_ns"]})
        if a.get("lastmod") != b.get("lastmod"):
            lastmod.append({"path": rel, "before": a.get("lastmod"), "after": b.get("lastmod")})
    return {"content": content, "mtime": mtime, "lastmod": lastmod}


def _package_file(package: Path, rel: str, kind: str) -> Path:
    if rel == NEW_SCRIPT:
        return package / "publish_window.py"
    return package / kind / rel


def install(host: Path, package: Path) -> None:
    """Replace snapshot bytes with the patched bytes. Stop if a live file matches neither."""
    host.mkdir(parents=True, exist_ok=True)
    plan = []
    for rel in list(SCRIPTS) + [NEW_SCRIPT]:
        dest = host / rel
        patched = _package_file(package, rel, "patched")
        patched_bytes = patched.read_bytes()
        patched_sha = hashlib.sha256(patched_bytes).hexdigest()
        if rel == NEW_SCRIPT:
            baseline_sha = None
        else:
            baseline_sha = sha256(_package_file(package, rel, "baseline"))
        if dest.is_file():
            got = sha256(dest)
            if got == patched_sha:
                continue
            if baseline_sha is None or got != baseline_sha:
                raise WindowStop(
                    f"STOP: {rel} sha {got} is not the snapshot baseline "
                    f"{baseline_sha} or the patched {patched_sha}"
                )
        elif baseline_sha is not None:
            raise WindowStop(f"STOP: {rel} is absent; snapshot baseline was expected")
        plan.append((dest, patched_bytes, patched_sha))
    if not plan:
        print("install: already patched")
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = host / ".publish_window_backup" / stamp
    backup.mkdir(parents=True)
    manifest = {}
    for dest, data, patched_sha in plan:
        rel = str(dest.relative_to(host))
        if dest.is_file():
            stored = backup / rel
            stored.parent.mkdir(parents=True, exist_ok=True)
            stored.write_bytes(dest.read_bytes())
            manifest[rel] = {"previous": sha256(dest), "patched": patched_sha}
        else:
            manifest[rel] = {"previous": None, "patched": patched_sha}
        tmp = dest.with_name(dest.name + ".window-new")
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(data)
        os.replace(tmp, dest)
        if sha256(dest) != patched_sha:
            raise WindowStop(f"STOP: {rel} hash changed during install")
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"install: {stamp} ({len(plan)} files)")


def rollback(host: Path, stamp: str | None) -> None:
    root = host / ".publish_window_backup"
    if stamp:
        backup = root / stamp
    else:
        stamps = sorted(p for p in root.iterdir() if (p / "manifest.json").is_file()) if root.is_dir() else []
        if not stamps:
            raise WindowStop("STOP: no install backup to restore")
        backup = stamps[-1]
    manifest = json.loads((backup / "manifest.json").read_text())
    for rel, info in manifest.items():
        dest = host / rel
        previous = info["previous"]
        patched = info["patched"]
        if previous is None:
            if not dest.is_file():
                continue
            if sha256(dest) != patched:
                raise WindowStop(f"STOP: {rel} changed after install; not removing it")
            dest.unlink()
            continue
        stored = backup / rel
        if sha256(stored) != previous:
            raise WindowStop(f"STOP: backup {rel} does not match its manifest")
        if dest.is_file():
            got = sha256(dest)
            if got == previous:
                continue
            if got != patched:
                raise WindowStop(f"STOP: {rel} changed after install ({got}); not rolling back")
        else:
            raise WindowStop(f"STOP: {rel} is missing; not rolling back over a gap")
        tmp = dest.with_name(dest.name + ".window-new")
        tmp.write_bytes(stored.read_bytes())
        os.replace(tmp, dest)
    print(f"rollback: {backup.name}")


def _refuse_live(host: Path) -> None:
    if host.resolve() == Path("/workspace/digest").resolve() and os.environ.get("ADRRR_INSTALL_CONFIRM") != "1":
        raise WindowStop("refusing /workspace/digest without ADRRR_INSTALL_CONFIRM=1")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Frozen publish window pin and install")
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("write")
    w.add_argument("--host", type=Path, required=True)
    w.add_argument("--until", required=True)
    w.add_argument("--main")
    w.add_argument("--out", type=Path, required=True)
    c = sub.add_parser("check")
    c.add_argument("--host", type=Path, required=True)
    c.add_argument("--content", type=Path, required=True)
    c.add_argument("--live", type=Path)
    c.add_argument("--pin", type=Path, required=True)
    c.add_argument("--package", type=Path)
    d = sub.add_parser("diff")
    d.add_argument("before", type=Path)
    d.add_argument("after", type=Path)
    inst = sub.add_parser("install")
    inst.add_argument("--host", type=Path, required=True)
    inst.add_argument("--package", type=Path, required=True)
    inst.add_argument("--locked", action="store_true")
    rb = sub.add_parser("rollback")
    rb.add_argument("--host", type=Path, required=True)
    rb.add_argument("--stamp")
    rb.add_argument("--locked", action="store_true")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "write":
            pin = write_pin(args.host, args.until, args.main, None)
            args.out.write_text(json.dumps(pin, indent=2, sort_keys=True) + "\n")
            print(f"pin: {args.out}")
        elif args.cmd == "check":
            pin = json.loads(args.pin.read_text())
            package_py = (args.package / "publish_window.py") if args.package else None
            problems = check_pin(pin, args.host, args.content, args.live, package_py)
            if problems:
                print("STOP: drift in " + ", ".join(problems), file=sys.stderr)
                return 3
            print("pin: ok")
        elif args.cmd == "diff":
            diff = manifest_diff(tree_manifest(args.before), tree_manifest(args.after))
            json.dump(diff, sys.stdout, indent=2)
            sys.stdout.write("\n")
            if diff["content"] or diff["lastmod"]:
                return 4
        elif args.cmd == "install":
            _refuse_live(args.host)
            install(args.host, args.package)
        elif args.cmd == "rollback":
            _refuse_live(args.host)
            rollback(args.host, args.stamp)
    except WindowStop as exc:
        print(exc, file=sys.stderr)
        return int(exc.code) if isinstance(exc.code, int) else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
