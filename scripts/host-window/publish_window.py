#!/usr/bin/env python3
"""Pin and publish one frozen artifact tree, then return the morning path.

The webhook entry stays `bash check_sections.sh`. While a window pin is
present, that entry uploads the pinned artifacts or fails closed. It does not
reassemble the site, refresh images, or send mail. `release-daily` is what
lets a later `publish.sh` take the normal morning path again.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS = (
    "publish.sh",
    "check_sections.sh",
    "tools/latest_json.py",
    "tools/og_images.py",
)
NEW_SCRIPT = "tools/publish_window.py"
FUNCTIONS = "sections-src/functions"
PIN_NAME = ".publish_window_pin"
HOLD_NAME = ".publish_window_hold"
MARKER_NAME = ".sections_deployed"
HOLD_KEYS = (
    "version",
    "state",
    "main_sha",
    "script_identity",
    "artifact_identity",
    "daily_authorized",
    "deployment_id",
    "deployment_url",
)
PAGES_URL = re.compile(r"https://([A-Za-z0-9]{8,})\.[A-Za-z0-9.-]+\.pages\.dev\b")


class WindowStop(Exception):
    def __init__(self, message: str, code: int = 3):
        super().__init__(message)
        self.code = code


class ReadbackMismatch(Exception):
    def __init__(self, problems: list[str]):
        super().__init__(", ".join(problems))
        self.problems = problems


class ReadbackTransport(WindowStop):
    def __init__(self, message: str):
        super().__init__(message, code=1)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def identity_of(files: dict[str, str]) -> str:
    payload = "".join(f"{key} {files[key]}\n" for key in sorted(files))
    return hashlib.sha256(payload.encode()).hexdigest()


def is_public_artifact(rel: str) -> bool:
    """Files a deployment URL can actually serve back.

    Pages config and Functions source are part of the upload, and they are
    part of the artifact identity, but a GET of those paths is not the
    deployed page.
    """
    name = rel.rsplit("/", 1)[-1]
    if rel == "functions" or rel.startswith("functions/"):
        return False
    if name in ("_redirects", "_headers") or name.startswith("."):
        return False
    return True


def _files_under(root: Path, rel: str) -> dict[str, str]:
    base = root / rel
    if not base.exists():
        return {}
    out = {}
    if base.is_file():
        if base.is_symlink():
            raise WindowStop(f"STOP: symlink not allowed: {rel}")
        out[rel] = sha256(base)
        return out
    for path in sorted(base.rglob("*")):
        if path.is_symlink():
            raise WindowStop(f"STOP: symlink not allowed: {path.relative_to(root)}")
        if path.is_file():
            out[str(path.relative_to(root))] = sha256(path)
    return out


def collect_host(host: Path) -> dict[str, str]:
    found = {}
    for rel in list(SCRIPTS) + [NEW_SCRIPT]:
        path = host / rel
        if not path.is_file():
            raise WindowStop(f"STOP: missing {rel}")
        found[rel] = sha256(path)
    found.update(_files_under(host, FUNCTIONS))
    return found


def collect_tree(root: Path) -> dict[str, str]:
    if not root.is_dir():
        raise WindowStop(f"STOP: {root} is not a directory")
    out = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise WindowStop(f"STOP: symlink not allowed: {path.relative_to(root)}")
        if not path.is_file():
            continue
        out[str(path.relative_to(root))] = sha256(path)
    if not out:
        raise WindowStop(f"STOP: {root} has no files")
    return out


def assert_outside(host: Path, artifact: Path) -> None:
    host_r, art_r = host.resolve(), artifact.resolve()
    if art_r == Path("/"):
        raise WindowStop("STOP: artifact root is /")
    if art_r == host_r or host_r in art_r.parents or art_r in host_r.parents:
        raise WindowStop("STOP: artifact root must sit outside the digest tree")


def assert_functions(artifact_files: dict[str, str], host_files: dict[str, str]) -> None:
    art = {k[len("functions/"):]: v for k, v in artifact_files.items() if k.startswith("functions/")}
    src = {k[len(FUNCTIONS) + 1:]: v for k, v in host_files.items() if k.startswith(FUNCTIONS + "/")}
    if art != src:
        raise WindowStop("STOP: artifact functions/ does not match sections-src/functions")


def parse_until(until: str) -> datetime:
    try:
        expiry = datetime.fromisoformat(until)
    except ValueError as exc:
        raise WindowStop(f"STOP: pin until is not ISO time: {until}") from exc
    if expiry.tzinfo is None:
        raise WindowStop("STOP: pin until must include a timezone")
    return expiry


def assert_current(pin: dict) -> None:
    expiry = parse_until(str(pin.get("until", "")))
    if datetime.now(timezone.utc) > expiry.astimezone(timezone.utc):
        raise WindowStop("STOP: window pin expired; refusing the daily path")


def git_head(host: Path) -> str | None:
    git = host / "sections-src" / ".git"
    if not git.exists():
        return None
    out = subprocess.run(
        ["git", "-C", str(host / "sections-src"), "rev-parse", "HEAD"],
        text=True, capture_output=True,
    )
    if out.returncode != 0:
        return None
    return out.stdout.strip()


def remote_sha(host: Path) -> str:
    cfg_path = host / "sections_repo.json"
    if not cfg_path.is_file():
        raise WindowStop("STOP: no sections repo configured")
    cfg = json.loads(cfg_path.read_text())
    url = cfg.get("url") or ""
    branch = cfg.get("branch") or "main"
    if not url:
        raise WindowStop("STOP: no sections repo configured")
    try:
        out = subprocess.run(
            ["timeout", "60", "git", "ls-remote", url, f"refs/heads/{branch}"],
            text=True, capture_output=True, timeout=70,
        )
    except subprocess.TimeoutExpired as exc:
        raise WindowStop("STOP: ls-remote timed out") from exc
    if out.returncode != 0:
        detail = (out.stderr or out.stdout).strip()
        raise WindowStop(f"STOP: ls-remote failed: {detail}")
    parts = out.stdout.split()
    sha = parts[0] if parts else ""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise WindowStop("STOP: ls-remote returned no sha")
    return sha


def _atomic_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".new")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def hold_from(pin: dict) -> dict:
    return {key: pin.get(key) for key in HOLD_KEYS}


def write_pair(host: Path, pin: dict) -> None:
    pin_tmp = host / (PIN_NAME + ".new")
    hold_tmp = host / (HOLD_NAME + ".new")
    pin_tmp.write_text(json.dumps(pin, indent=2, sort_keys=True) + "\n")
    hold_tmp.write_text(json.dumps(hold_from(pin), indent=2, sort_keys=True) + "\n")
    os.replace(pin_tmp, host / PIN_NAME)
    os.replace(hold_tmp, host / HOLD_NAME)


def load_pin(host: Path) -> dict | None:
    path = host / PIN_NAME
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise WindowStop(f"STOP: {PIN_NAME} is not JSON") from exc


def load_hold(host: Path) -> dict | None:
    path = host / HOLD_NAME
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise WindowStop(f"STOP: {HOLD_NAME} is not JSON") from exc


def read_marker(host: Path) -> dict:
    path = host / MARKER_NAME
    marker = {"sha": None, "identity": None, "url": None}
    if not path.is_file():
        return marker
    lines = [line.strip() for line in path.read_text().splitlines() if line.strip()]
    if not lines:
        return marker
    marker["sha"] = lines[0]
    for line in lines[1:]:
        if line.startswith("identity "):
            parts = line.split()
            if len(parts) != 4:
                raise WindowStop("STOP: marker identity line is malformed")
            marker["identity"] = {
                "script": parts[1],
                "artifact": parts[2],
                "deployment_id": parts[3],
            }
        elif line.startswith("url "):
            marker["url"] = line[4:]
    return marker


def write_marker(host: Path, sha: str, script_id: str, artifact_id: str, deployment_id: str, url: str) -> None:
    path = host / MARKER_NAME
    tmp = path.with_name(MARKER_NAME + ".new")
    tmp.write_text(
        f"{sha}\nidentity {script_id} {artifact_id} {deployment_id}\nurl {url}\n"
    )
    os.replace(tmp, path)


def _require_v2(pin: dict) -> None:
    if pin.get("version") != 2:
        raise WindowStop("STOP: unsupported window pin")
    if pin.get("state") not in ("armed", "committed"):
        raise WindowStop("STOP: bad window state")


def _agree(pin: dict, hold: dict | None) -> None:
    if hold is None:
        raise WindowStop("STOP: window hold missing")
    for key in HOLD_KEYS:
        if hold.get(key) != pin.get(key):
            raise WindowStop(f"STOP: pin and hold disagree on {key}")


def _public_consistent(pin: dict) -> None:
    public = pin.get("public_files") or {}
    if not public:
        raise WindowStop("STOP: window has no public files to read back")
    artifacts = pin.get("artifact_files") or {}
    for key, digest in public.items():
        if artifacts.get(key) != digest:
            raise WindowStop(f"STOP: public manifest does not match artifacts ({key})")


def tree_state(host: Path, pin: dict) -> str:
    root = Path(pin["artifact_root"])
    if not root.exists():
        return "missing"
    if not root.is_dir():
        return "drift"
    try:
        assert_outside(host, root)
        found = collect_tree(root)
    except WindowStop:
        return "drift"
    if found != pin.get("artifact_files"):
        return "drift"
    try:
        assert_functions(found, pin["host_files"])
    except WindowStop:
        return "drift"
    return "ok"


def verify_scripts(host: Path, pin: dict, *, remote: bool) -> None:
    assert_current(pin)
    _require_v2(pin)
    _public_consistent(pin)
    host_files = collect_host(host)
    if host_files != pin.get("host_files"):
        raise WindowStop("STOP: script or functions drift")
    if identity_of(host_files) != pin.get("script_identity"):
        raise WindowStop("STOP: script identity drift")
    if identity_of(pin.get("artifact_files") or {}) != pin.get("artifact_identity"):
        raise WindowStop("STOP: artifact identity drift")
    head = git_head(host)
    if head != pin.get("main_sha"):
        raise WindowStop(
            f"STOP: sections-src HEAD {head} is not pinned {pin.get('main_sha')}; refusing to fetch or reset"
        )
    _agree(pin, load_hold(host))
    if remote:
        got = remote_sha(host)
        if got != pin.get("main_sha"):
            raise WindowStop(f"STOP: remote {got} drifted from pinned {pin.get('main_sha')}")


def deployment_from_log(log: str) -> tuple[str, str]:
    found = [(match.group(1), match.group(0)) for match in PAGES_URL.finditer(log)]
    if not found:
        raise WindowStop(
            "FAIL-CLOSED: no deployment-specific pages.dev URL in wrangler output",
            code=1,
        )
    return found[-1]


def _fetch(url: str) -> bytes | None:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status = getattr(response, "status", 200)
            if status != 200:
                raise ReadbackTransport(f"FAIL-CLOSED: readback status {status} for {url}")
            return response.read()
    except ReadbackTransport:
        raise
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise ReadbackTransport(f"FAIL-CLOSED: readback status {exc.code} for {url}") from exc
    except urllib.error.URLError as exc:
        raise ReadbackTransport(f"FAIL-CLOSED: readback transport {url}: {exc.reason}") from exc


def readback_url(deployment_url: str, deployment_id: str, rel: str) -> str:
    origin = os.environ.get("ADRRR_READBACK_ORIGIN", "").rstrip("/")
    quoted = urllib.parse.quote(rel, safe="/")
    if origin:
        return f"{origin}/{deployment_id}/{quoted}"
    return deployment_url.rstrip("/") + "/" + quoted


def compare_http(deployment_url: str, deployment_id: str, public_files: dict[str, str]) -> None:
    if not deployment_url or not deployment_id:
        raise WindowStop("FAIL-CLOSED: committed window has no deployment URL", code=1)
    if deployment_id not in deployment_url:
        raise WindowStop("FAIL-CLOSED: deployment id is not in the deployment URL", code=1)
    problems = []
    for rel in sorted(public_files):
        body = _fetch(readback_url(deployment_url, deployment_id, rel))
        if body is None:
            problems.append(f"missing {rel}")
            continue
        got = hashlib.sha256(body).hexdigest()
        if got != public_files[rel]:
            problems.append(rel)
    if problems:
        raise ReadbackMismatch(problems)


def _marker_matches(marker: dict, pin: dict) -> bool:
    identity = marker.get("identity")
    return bool(
        identity
        and marker.get("sha") == pin.get("main_sha")
        and identity["script"] == pin.get("script_identity")
        and identity["artifact"] == pin.get("artifact_identity")
        and marker.get("url")
    )


def _heal_commit(host: Path, pin: dict, marker: dict) -> dict:
    identity = marker["identity"]
    pin["state"] = "committed"
    pin["deployment_id"] = identity["deployment_id"]
    pin["deployment_url"] = marker["url"]
    write_pair(host, pin)
    return pin


def _after_commit(host: Path, pin: dict, entry: str, marker: dict) -> str:
    if entry == "0" and pin.get("daily_authorized"):
        # The authorized morning run is allowed to assemble again. A webhook
        # replay (entry 1) stays on the frozen transaction until that run
        # clears the pin.
        return "daily"
    if not marker.get("identity"):
        if marker.get("sha") == pin.get("main_sha") and pin.get("daily_authorized"):
            return "noop"
        raise WindowStop("STOP: committed window has no deployment identity on the marker")
    if not _marker_matches(marker, pin):
        raise WindowStop("STOP: marker identity does not match the pinned source and artifacts")
    if marker["identity"]["deployment_id"] != pin.get("deployment_id"):
        raise WindowStop("STOP: marker deployment id does not match the pin")
    tree = tree_state(host, pin)
    if tree == "drift":
        raise WindowStop("STOP: artifact tree drifted from the committed manifest")
    try:
        compare_http(pin["deployment_url"], pin["deployment_id"], pin["public_files"])
    except ReadbackMismatch:
        if tree != "ok":
            raise WindowStop(
                "STOP: public bytes differ and the artifact tree is not available to republish"
            )
        return "window"
    return "noop"


def route(host: Path, entry: str) -> str:
    if entry not in ("0", "1"):
        raise WindowStop("STOP: window entry must be 0 or 1")
    pin_exists = (host / PIN_NAME).is_file()
    hold_exists = (host / HOLD_NAME).is_file()
    marker = read_marker(host)
    if pin_exists != hold_exists:
        raise WindowStop("STOP: window pin and hold must both be present")
    if not pin_exists:
        if marker.get("identity"):
            raise WindowStop(
                "STOP: marker records a window deployment but the pin is gone; refusing to refresh"
            )
        return "daily"
    pin = load_pin(host)
    verify_scripts(host, pin, remote=True)
    if pin["state"] == "armed":
        if marker.get("identity"):
            if not _marker_matches(marker, pin):
                raise WindowStop("STOP: marker identity does not match the armed pin")
            pin = _heal_commit(host, pin, marker)
            return _after_commit(host, pin, entry, marker)
        if tree_state(host, pin) != "ok":
            raise WindowStop("STOP: artifact tree is missing or drifted")
        return "window"
    if pin["state"] == "committed":
        return _after_commit(host, pin, entry, marker)
    raise WindowStop("STOP: bad window state")


def stage(host: Path, dest: Path) -> None:
    pin = load_pin(host)
    if pin is None:
        raise WindowStop("STOP: no window pin")
    verify_scripts(host, pin, remote=True)
    if tree_state(host, pin) != "ok":
        raise WindowStop("STOP: artifact tree is missing or drifted")
    if dest.exists() and any(dest.iterdir()):
        raise WindowStop("STOP: stage directory is not empty")
    dest.mkdir(parents=True, exist_ok=True)
    root = Path(pin["artifact_root"])
    for rel, digest in sorted(pin["artifact_files"].items()):
        src = root / rel
        if not src.is_file() or src.is_symlink() or sha256(src) != digest:
            raise WindowStop(f"STOP: {rel} changed while staging")
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
        if sha256(target) != digest:
            raise WindowStop(f"STOP: {rel} mismatch after copy")


def finalize(host: Path, stage_dir: Path, log_path: Path, wrangler_rc: int) -> None:
    pin = load_pin(host)
    if pin is None:
        raise WindowStop("STOP: no window pin")
    verify_scripts(host, pin, remote=True)
    if tree_state(host, pin) != "ok":
        raise WindowStop("STOP: artifact tree is missing or drifted")
    if wrangler_rc != 0:
        raise WindowStop(f"FAIL-CLOSED: wrangler exit {wrangler_rc}", code=1)
    log = log_path.read_text(errors="replace")
    for rel, digest in pin["artifact_files"].items():
        path = stage_dir / rel
        if not path.is_file() or path.is_symlink() or sha256(path) != digest:
            raise WindowStop(f"STOP: staged {rel} is not the pinned artifact", code=1)
    if (stage_dir / "functions").is_dir() and "Uploading Functions bundle" not in log:
        raise WindowStop(
            "FAIL-CLOSED: functions/ present but Wrangler did not upload Functions bundle",
            code=1,
        )
    if "Deployment complete" not in log:
        raise WindowStop("FAIL-CLOSED: wrangler output has no Deployment complete", code=1)
    deployment_id, deployment_url = deployment_from_log(log)
    try:
        compare_http(deployment_url, deployment_id, pin["public_files"])
    except ReadbackMismatch as exc:
        raise WindowStop(
            "FAIL-CLOSED: readback mismatch: " + ", ".join(exc.problems),
            code=1,
        ) from exc
    write_marker(
        host,
        pin["main_sha"],
        pin["script_identity"],
        pin["artifact_identity"],
        deployment_id,
        deployment_url,
    )
    pin["state"] = "committed"
    pin["deployment_id"] = deployment_id
    pin["deployment_url"] = deployment_url
    write_pair(host, pin)


def arm(host: Path, artifacts: Path, until: str) -> None:
    expiry = parse_until(until)
    if expiry.astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise WindowStop("STOP: pin until must be in the future")
    assert_outside(host, artifacts)
    if (host / PIN_NAME).exists() or (host / HOLD_NAME).exists():
        raise WindowStop("STOP: a window pin already exists")
    head = git_head(host)
    if not head or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise WindowStop("STOP: pin requires the sections-src HEAD")
    artifact_files = collect_tree(artifacts)
    host_files = collect_host(host)
    assert_functions(artifact_files, host_files)
    public_files = {k: v for k, v in artifact_files.items() if is_public_artifact(k)}
    if not public_files:
        raise WindowStop("STOP: artifact tree has no public files to read back")
    marker = read_marker(host)
    pin = {
        "version": 2,
        "state": "armed",
        "until": until,
        "main_sha": head,
        "marker_before": marker["sha"] or "NONE",
        "host_files": host_files,
        "artifact_files": artifact_files,
        "public_files": public_files,
        "artifact_root": str(artifacts.resolve()),
        "script_identity": identity_of(host_files),
        "artifact_identity": identity_of(artifact_files),
        "daily_authorized": False,
        "deployment_id": None,
        "deployment_url": None,
    }
    write_pair(host, pin)
    print(f"armed: {head} artifacts={pin['artifact_identity'][:12]}")


def release_daily(host: Path) -> None:
    pin = load_pin(host)
    if pin is None:
        raise WindowStop("STOP: no window pin to release")
    verify_scripts(host, pin, remote=True)
    if pin.get("state") != "committed":
        raise WindowStop("STOP: release-daily requires a verified commit")
    marker = read_marker(host)
    if not _marker_matches(marker, pin):
        raise WindowStop("STOP: marker does not match the committed window")
    if tree_state(host, pin) == "drift":
        raise WindowStop("STOP: artifact tree drifted; not authorizing the morning path")
    compare_http(pin["deployment_url"], pin["deployment_id"], pin["public_files"])
    pin["daily_authorized"] = True
    write_pair(host, pin)
    print("daily authorized; the next publish.sh without ADRRR_WINDOW_ENTRY uses the morning path")


def abort(host: Path) -> None:
    marker = read_marker(host)
    if marker.get("identity"):
        raise WindowStop("STOP: deployment identity is on the marker; not aborting")
    pin = load_pin(host)
    hold = load_hold(host)
    if pin is None and hold is None:
        raise WindowStop("STOP: no window to abort")
    for label, obj in (("pin", pin), ("hold", hold)):
        if obj is None:
            continue
        if obj.get("state") != "armed" or obj.get("deployment_id"):
            raise WindowStop(f"STOP: refusing to abort a committed window ({label})")
    (host / PIN_NAME).unlink(missing_ok=True)
    (host / HOLD_NAME).unlink(missing_ok=True)
    print("aborted")


def resume(host: Path, artifacts: Path, until: str) -> None:
    if (host / PIN_NAME).exists() or (host / HOLD_NAME).exists():
        raise WindowStop("STOP: window pin still present; not resuming")
    parse_until(until)
    if parse_until(until).astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise WindowStop("STOP: pin until must be in the future")
    marker = read_marker(host)
    if not marker.get("identity") or not marker.get("url") or not marker.get("sha"):
        raise WindowStop("STOP: marker has no window identity to resume")
    head = git_head(host)
    if head != marker["sha"]:
        raise WindowStop("STOP: sections-src HEAD does not match the marker")
    if remote_sha(host) != marker["sha"]:
        raise WindowStop("STOP: remote does not match the marker")
    assert_outside(host, artifacts)
    artifact_files = collect_tree(artifacts)
    host_files = collect_host(host)
    if identity_of(artifact_files) != marker["identity"]["artifact"]:
        raise WindowStop("STOP: artifacts do not match the marker")
    if identity_of(host_files) != marker["identity"]["script"]:
        raise WindowStop("STOP: scripts do not match the marker")
    assert_functions(artifact_files, host_files)
    public_files = {k: v for k, v in artifact_files.items() if is_public_artifact(k)}
    pin = {
        "version": 2,
        "state": "committed",
        "until": until,
        "main_sha": marker["sha"],
        "marker_before": "RESUMED",
        "host_files": host_files,
        "artifact_files": artifact_files,
        "public_files": public_files,
        "artifact_root": str(artifacts.resolve()),
        "script_identity": marker["identity"]["script"],
        "artifact_identity": marker["identity"]["artifact"],
        "daily_authorized": False,
        "deployment_id": marker["identity"]["deployment_id"],
        "deployment_url": marker["url"],
    }
    write_pair(host, pin)
    print("resumed")


def consume_daily(host: Path) -> None:
    pin = load_pin(host)
    hold = load_hold(host)
    if pin is None and hold is None:
        print("consume: nothing to clear")
        return
    for label, obj in (("pin", pin), ("hold", hold)):
        if obj is not None and not obj.get("daily_authorized"):
            raise WindowStop(f"STOP: refusing to clear a window that is not daily-authorized ({label})")
    (host / PIN_NAME).unlink(missing_ok=True)
    (host / HOLD_NAME).unlink(missing_ok=True)
    print("consume: cleared")


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
        left, right = before.get(rel), after.get(rel)
        if left is None or right is None or left["sha256"] != right["sha256"] or left["size"] != right["size"]:
            content.append(rel)
            continue
        if left["mtime_ns"] != right["mtime_ns"]:
            mtime.append({"path": rel, "before_ns": left["mtime_ns"], "after_ns": right["mtime_ns"]})
        if left.get("lastmod") != right.get("lastmod"):
            lastmod.append({"path": rel, "before": left.get("lastmod"), "after": right.get("lastmod")})
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
    if (host / PIN_NAME).is_file() or (host / HOLD_NAME).is_file():
        raise WindowStop("STOP: window pin still present; abort or finish it before rollback")
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
    ap = argparse.ArgumentParser(description="Frozen artifact publication window")
    sub = ap.add_subparsers(dest="cmd", required=True)

    armed = sub.add_parser("arm")
    armed.add_argument("--host", type=Path, required=True)
    armed.add_argument("--artifacts", type=Path, required=True)
    armed.add_argument("--until", required=True)

    released = sub.add_parser("release-daily")
    released.add_argument("--host", type=Path, required=True)

    aborted = sub.add_parser("abort")
    aborted.add_argument("--host", type=Path, required=True)

    resumed = sub.add_parser("resume")
    resumed.add_argument("--host", type=Path, required=True)
    resumed.add_argument("--artifacts", type=Path, required=True)
    resumed.add_argument("--until", required=True)

    routed = sub.add_parser("route")
    routed.add_argument("--host", type=Path, required=True)
    routed.add_argument("--entry", required=True, choices=("0", "1"))

    staged = sub.add_parser("stage")
    staged.add_argument("--host", type=Path, required=True)
    staged.add_argument("--dest", type=Path, required=True)

    finished = sub.add_parser("finalize")
    finished.add_argument("--host", type=Path, required=True)
    finished.add_argument("--stage", type=Path, required=True)
    finished.add_argument("--log", type=Path, required=True)
    finished.add_argument("--wrangler-rc", type=int, required=True)

    consumed = sub.add_parser("consume-daily")
    consumed.add_argument("--host", type=Path, required=True)

    diff = sub.add_parser("diff")
    diff.add_argument("before", type=Path)
    diff.add_argument("after", type=Path)

    inst = sub.add_parser("install")
    inst.add_argument("--host", type=Path, required=True)
    inst.add_argument("--package", type=Path, required=True)
    inst.add_argument("--locked", action="store_true")

    rolled = sub.add_parser("rollback")
    rolled.add_argument("--host", type=Path, required=True)
    rolled.add_argument("--stamp")
    rolled.add_argument("--locked", action="store_true")

    args = ap.parse_args(argv)
    try:
        if args.cmd == "arm":
            arm(args.host, args.artifacts, args.until)
        elif args.cmd == "release-daily":
            release_daily(args.host)
        elif args.cmd == "abort":
            abort(args.host)
        elif args.cmd == "resume":
            resume(args.host, args.artifacts, args.until)
        elif args.cmd == "route":
            sys.stdout.write(route(args.host, args.entry) + "\n")
        elif args.cmd == "stage":
            stage(args.host, args.dest)
        elif args.cmd == "finalize":
            finalize(args.host, args.stage, args.log, args.wrangler_rc)
            print("verified")
        elif args.cmd == "consume-daily":
            consume_daily(args.host)
        elif args.cmd == "diff":
            found = manifest_diff(tree_manifest(args.before), tree_manifest(args.after))
            json.dump(found, sys.stdout, indent=2)
            sys.stdout.write("\n")
            if found["content"] or found["lastmod"]:
                return 4
        elif args.cmd == "install":
            _refuse_live(args.host)
            install(args.host, args.package)
        elif args.cmd == "rollback":
            _refuse_live(args.host)
            rollback(args.host, args.stamp)
    except ReadbackMismatch as exc:
        print("FAIL-CLOSED: readback mismatch: " + ", ".join(exc.problems), file=sys.stderr)
        return 1
    except WindowStop as exc:
        print(exc, file=sys.stderr)
        return exc.code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
