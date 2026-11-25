#!/usr/bin/env python3
"""Pin and publish one frozen artifact tree, then return the morning path.

The webhook entry stays `bash check_sections.sh`. Install writes a prearm hold
before the patched scripts can run, so every caller fail-closes until an
operator syncs the merged tip and arms a rollback tree. The armed entry
uploads the pinned artifacts once. A failed readback restores the previous
public bytes once and then stops. It does not reassemble the site, refresh
images, or send mail. `release-daily` is what lets a later direct `publish.sh`
take the normal morning path again.
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
import tempfile
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
BOOT_NAME = ".publish_window_bootstrap"
MARKER_NAME = ".sections_deployed"
HOLD_KEYS = (
    "version",
    "state",
    "main_sha",
    "baseline_sha",
    "synced_sha",
    "synced_tree",
    "script_identity",
    "artifact_identity",
    "rollback_identity",
    "daily_authorized",
    "deployment_id",
    "deployment_url",
    "rollback_attempts",
    "restore_required",
)
# Documented Pages production rollback. Wrangler has no equivalent subcommand.
# https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/
PAGES_ROLLBACK_URL = (
    "https://api.cloudflare.com/client/v4/accounts/"
    "{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/rollback"
)
PAGES_URL = re.compile(r"https://([A-Za-z0-9]{8,})\.[A-Za-z0-9.-]+\.pages\.dev\b")
# Pages config is uploaded and hashed, and a GET of it is not the page.
INVENTORY_ONLY_NAMES = ("_redirects", "_headers", "_routes.json")


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
    parts = [part for part in rel.split("/") if part]
    name = parts[-1] if parts else rel
    if any(part.startswith(".") for part in parts):
        return False
    if rel == "functions" or rel.startswith("functions/"):
        return False
    if name in INVENTORY_ONLY_NAMES:
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


def _git(host: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(host / "sections-src"), *args],
        text=True, capture_output=True, check=check,
    )


def sections_tree(host: Path) -> str:
    out = _git(host, "rev-parse", "HEAD^{tree}", check=False)
    tree = out.stdout.strip()
    if out.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", tree):
        raise WindowStop("STOP: sections-src tree id is unavailable")
    return tree


def porcelain(host: Path) -> str:
    out = _git(host, "status", "--porcelain", check=False)
    if out.returncode != 0:
        raise WindowStop("STOP: sections-src status failed")
    return out.stdout.strip()


def load_boot(host: Path) -> dict | None:
    path = host / BOOT_NAME
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise WindowStop(f"STOP: {BOOT_NAME} is not JSON") from exc


def write_boot(host: Path, boot: dict) -> None:
    _atomic_json(host / BOOT_NAME, boot)


def pages_rollback_url(account_id: str, project_name: str, deployment_id: str) -> str:
    if not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        deployment_id,
    ):
        raise WindowStop("STOP: rollback deployment id is not a Pages deployment UUID")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", project_name):
        raise WindowStop("STOP: Pages project name is not the documented form")
    return PAGES_ROLLBACK_URL.format(
        account_id=account_id,
        project_name=project_name,
        deployment_id=deployment_id,
    )


def _cf(host: Path) -> tuple[str, str, str]:
    cfg = json.loads((host / "cloudflare_config.json").read_text())
    token_file = host / ".cf_token"
    if token_file.is_file() and token_file.stat().st_size:
        token = token_file.read_text().strip()
    else:
        raw = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        match = re.search(r"Bearer\s+([A-Za-z0-9_-]+)", raw)
        token = match.group(1) if match else raw.strip()
    return cfg["account_id"], cfg["project"], token


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
    if pin.get("state") not in (
        "prearm",
        "armed",
        "upload-attempted",
        "restore-verified",
        "restore-failed",
        "committed",
    ):
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
    except ReadbackMismatch as exc:
        raise WindowStop(
            "STOP: public bytes differ from the committed deployment; not uploading again: "
            + ", ".join(exc.problems)
        ) from exc
    return "noop"


def _held(message: str) -> str:
    print(message, file=sys.stderr)
    return "held"


def route(host: Path, entry: str) -> str:
    if entry not in ("0", "1"):
        raise WindowStop("STOP: window entry must be 0 or 1")
    pin_exists = (host / PIN_NAME).is_file()
    hold_exists = (host / HOLD_NAME).is_file()
    marker = read_marker(host)
    boot = load_boot(host)
    if pin_exists != hold_exists:
        raise WindowStop("STOP: window pin and hold must both be present")
    if not pin_exists:
        if marker.get("identity"):
            raise WindowStop(
                "STOP: marker records a window deployment but the pin is gone; refusing to refresh"
            )
        if boot is None or boot.get("state") != "released":
            return _held("FAIL-CLOSED: prearm hold; refusing the morning assembler")
        return "daily"
    pin = load_pin(host)
    state = pin.get("state")
    if state == "prearm":
        _agree(pin, load_hold(host))
        return _held("FAIL-CLOSED: prearm hold; sync the merged tip, then arm")
    if state in ("restore-verified", "restore-failed"):
        _agree(pin, load_hold(host))
        return _held("FAIL-CLOSED: hold remains after rollback; not uploading")
    if state == "upload-attempted":
        _agree(pin, load_hold(host))
        return "restore"
    if state == "committed" and entry == "0" and pin.get("daily_authorized"):
        # The authorized morning assembler is allowed to fetch and reset.
        # Its own SHA gate still fail-closes. A webhook replay does not get here.
        _agree(pin, load_hold(host))
        return "daily"
    verify_scripts(host, pin, remote=True)
    if state == "armed":
        if marker.get("identity"):
            if not _marker_matches(marker, pin):
                raise WindowStop("STOP: marker identity does not match the armed pin")
            pin = _heal_commit(host, pin, marker)
            return _after_commit(host, pin, entry, marker)
        if tree_state(host, pin) != "ok":
            raise WindowStop("STOP: artifact tree is missing or drifted")
        return "window"
    if state == "committed":
        return _after_commit(host, pin, entry, marker)
    raise WindowStop("STOP: bad window state")


def stage(host: Path, dest: Path) -> None:
    pin = load_pin(host)
    if pin is None or pin.get("state") != "armed":
        raise WindowStop("STOP: stage is only for an armed window that has not started an upload")
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
    if pin is None or pin.get("state") != "upload-attempted":
        raise WindowStop("STOP: upload was not durably marked before finalize", code=1)
    try:
        _commit_upload(host, stage_dir, log_path, wrangler_rc)
    except (WindowStop, ReadbackMismatch, ReadbackTransport) as exc:
        try:
            restore(host, explicit=False)
        except WindowStop as restored:
            print(restored, file=sys.stderr)
        detail = str(exc)
        if isinstance(exc, ReadbackMismatch):
            detail = "readback mismatch: " + detail
        raise WindowStop(
            "FAIL-CLOSED: new deployment was not verified; marker not written. " + detail,
            code=1,
        ) from exc


def _commit_upload(host: Path, stage_dir: Path, log_path: Path, wrangler_rc: int) -> None:
    pin = load_pin(host)
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
    compare_http(deployment_url, deployment_id, pin["public_files"])
    write_marker(
        host,
        pin["main_sha"],
        pin["script_identity"],
        pin["artifact_identity"],
        deployment_id,
        deployment_url,
    )
    pin = load_pin(host)
    pin["state"] = "committed"
    pin["restore_required"] = False
    pin["deployment_id"] = deployment_id
    pin["deployment_url"] = deployment_url
    write_pair(host, pin)


def _blank_pin(host: Path, head: str, tree: str) -> dict:
    marker = read_marker(host)
    return {
        "version": 2,
        "state": "prearm",
        "until": "9999-01-01T00:00:00+00:00",
        "main_sha": head,
        "baseline_sha": head,
        "baseline_tree": tree,
        "synced_sha": None,
        "synced_tree": None,
        "marker_before": marker["sha"] or "NONE",
        "host_files": {},
        "artifact_files": {},
        "public_files": {},
        "rollback_files": {},
        "rollback_public": {},
        "rollback_root": None,
        "rollback_deployment_id": None,
        "artifact_root": None,
        "script_identity": None,
        "artifact_identity": None,
        "rollback_identity": None,
        "inventory_only": [],
        "daily_authorized": False,
        "deployment_id": None,
        "deployment_url": None,
        "restored_deployment_id": None,
        "restored_deployment_url": None,
        "rollback_attempts": 0,
        "restore_required": False,
    }


def write_prearm(host: Path) -> None:
    """Durable hold before any patched entry is allowed to publish."""
    head = git_head(host)
    if not head or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise WindowStop("STOP: prearm requires the sections-src HEAD")
    tree = sections_tree(host)
    pin = _blank_pin(host, head, tree)
    boot = {
        "version": 2,
        "state": "prearm",
        "baseline_sha": head,
        "baseline_tree": tree,
    }
    write_boot(host, boot)
    write_pair(host, pin)


def sync(host: Path, tip: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", tip):
        raise WindowStop("STOP: tip must be a 40-hex SHA")
    pin = load_pin(host)
    if pin is None or pin.get("state") != "prearm":
        raise WindowStop("STOP: sync is only available under the prearm hold")
    _agree(pin, load_hold(host))
    if porcelain(host):
        raise WindowStop("STOP: sections-src is not clean; not resetting")
    cfg = json.loads((host / "sections_repo.json").read_text())
    url = cfg.get("url") or ""
    branch = cfg.get("branch") or "main"
    if not url:
        raise WindowStop("STOP: no sections repo configured")
    fetched = _git(host, "fetch", url, f"refs/heads/{branch}", check=False)
    if fetched.returncode != 0:
        detail = (fetched.stderr or fetched.stdout).strip()
        raise WindowStop(f"STOP: fetch failed; not resetting: {detail}")
    remote = remote_sha(host)
    if remote != tip:
        raise WindowStop(f"STOP: remote {remote} is not the requested tip {tip}")
    baseline = pin.get("baseline_sha")
    ancestor = _git(host, "merge-base", "--is-ancestor", str(baseline), tip, check=False)
    if ancestor.returncode != 0:
        raise WindowStop(f"STOP: {tip} is not a descendant of baseline {baseline}")
    kind = _git(host, "cat-file", "-t", tip, check=False)
    if kind.stdout.strip() != "commit":
        raise WindowStop("STOP: tip is not a commit")
    reset = _git(host, "reset", "--hard", tip, check=False)
    if reset.returncode != 0:
        raise WindowStop("STOP: reset failed; hold remains")
    cleaned = _git(host, "clean", "-fdx", check=False)
    if cleaned.returncode != 0:
        raise WindowStop("STOP: clean failed; hold remains")
    if porcelain(host):
        raise WindowStop("STOP: sections-src is not clean after sync")
    head = git_head(host)
    tree = sections_tree(host)
    if head != tip or remote_sha(host) != head:
        raise WindowStop("STOP: remote, local HEAD, and tip disagree after sync")
    pin["synced_sha"] = tip
    pin["synced_tree"] = tree
    pin["main_sha"] = tip
    write_pair(host, pin)
    parents = _git(host, "rev-list", "--parents", "-n", "1", "HEAD", check=False).stdout.split()
    print(f"synced: {tip} tree={tree} parents={max(len(parents) - 1, 0)}")


def arm(
    host: Path,
    artifacts: Path,
    until: str,
    rollback: Path,
    rollback_deployment: str | None = None,
) -> None:
    expiry = parse_until(until)
    if expiry.astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise WindowStop("STOP: pin until must be in the future")
    assert_outside(host, artifacts)
    assert_outside(host, rollback)
    pin = load_pin(host)
    if pin is None or pin.get("state") != "prearm":
        raise WindowStop("STOP: arm requires the prearm hold")
    if not pin.get("synced_sha") or not pin.get("synced_tree"):
        raise WindowStop("STOP: arm requires a synced tip; the PR head is not the merge commit")
    _agree(pin, load_hold(host))
    if porcelain(host):
        raise WindowStop("STOP: sections-src is not clean")
    head = git_head(host)
    tree = sections_tree(host)
    remote = remote_sha(host)
    if head != pin["synced_sha"] or remote != head or tree != pin["synced_tree"]:
        raise WindowStop(
            "STOP: arm requires remote == local HEAD == synced tip and the synced tree"
        )
    artifact_files = collect_tree(artifacts)
    rollback_files = collect_tree(rollback)
    host_files = collect_host(host)
    assert_functions(artifact_files, host_files)
    public_files = {k: v for k, v in artifact_files.items() if is_public_artifact(k)}
    rollback_public = {k: v for k, v in rollback_files.items() if is_public_artifact(k)}
    if not public_files:
        raise WindowStop("STOP: artifact tree has no public files to read back")
    if not rollback_public:
        raise WindowStop("STOP: rollback tree has no public files to read back")
    if rollback_deployment:
        pages_rollback_url(*_cf(host)[:2], rollback_deployment)
    inventory_only = sorted(k for k in artifact_files if not is_public_artifact(k))
    pin["state"] = "armed"
    pin["until"] = until
    pin["main_sha"] = head
    pin["host_files"] = host_files
    pin["artifact_files"] = artifact_files
    pin["public_files"] = public_files
    pin["rollback_files"] = rollback_files
    pin["rollback_public"] = rollback_public
    pin["rollback_root"] = str(rollback.resolve())
    pin["rollback_deployment_id"] = rollback_deployment
    pin["artifact_root"] = str(artifacts.resolve())
    pin["script_identity"] = identity_of(host_files)
    pin["artifact_identity"] = identity_of(artifact_files)
    pin["rollback_identity"] = identity_of(rollback_files)
    pin["inventory_only"] = inventory_only
    pin["rollback_attempts"] = 0
    pin["restore_required"] = False
    write_pair(host, pin)
    print(f"armed: {head} artifacts={pin['artifact_identity'][:12]}")
    print(
        f"inventory: {len(artifact_files)} files; "
        f"http-verified {len(public_files)}; inventory-only {len(inventory_only)}"
    )


def begin_upload(host: Path) -> None:
    pin = load_pin(host)
    if pin is None:
        raise WindowStop("STOP: no window pin")
    if pin.get("state") != "armed":
        raise WindowStop("STOP: refusing a second upload of the new tree")
    verify_scripts(host, pin, remote=True)
    if tree_state(host, pin) != "ok":
        raise WindowStop("STOP: artifact tree is missing or drifted")
    pin["state"] = "upload-attempted"
    pin["restore_required"] = True
    write_pair(host, pin)
    print("upload-attempted")


def _copy_tree(files: dict[str, str], root: Path, dest: Path) -> None:
    if dest.exists() and any(dest.iterdir()):
        raise WindowStop("STOP: stage directory is not empty")
    dest.mkdir(parents=True, exist_ok=True)
    for rel, digest in sorted(files.items()):
        src = root / rel
        if not src.is_file() or src.is_symlink() or sha256(src) != digest:
            raise WindowStop(f"STOP: {rel} changed while staging")
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
        if sha256(target) != digest:
            raise WindowStop(f"STOP: {rel} mismatch after copy")


def _wrangler_deploy(host: Path, stage: Path) -> tuple[int, str]:
    _account, project, token = _cf(host)
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = _account
    env["CLOUDFLARE_API_TOKEN"] = token
    env["WRANGLER_SEND_METRICS"] = "false"
    cmd = [
        str(host / "tools/cfwrangler/node_modules/.bin/wrangler"),
        "pages", "deploy", ".",
        "--project-name", project,
        "--branch", "main",
        "--commit-dirty=true",
        "--cwd", str(stage),
    ]
    proc = subprocess.run(
        cmd,
        cwd=str(host / "tools/cfwrangler"),
        env=env,
        text=True,
        capture_output=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def _invoke_pages_rollback(host: Path, deployment_id: str) -> tuple[str, str]:
    account, project, token = _cf(host)
    url = pages_rollback_url(account, project, deployment_id)
    cmd = os.environ.get("ADRRR_PAGES_ROLLBACK_CMD", "")
    live = os.environ.get("ADRRR_PAGES_ROLLBACK_LIVE") == "1"
    if cmd:
        env = os.environ.copy()
        env["ADRRR_ROLLBACK_ROOT"] = str(Path(load_pin(host)["rollback_root"]))
        proc = subprocess.run([cmd, url], text=True, capture_output=True, env=env)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).strip()
            raise WindowStop(f"FAIL-CLOSED: Pages rollback command failed: {detail}", code=1)
        urls = [line.strip() for line in proc.stdout.splitlines() if line.strip().startswith("https://")]
        if not urls:
            raise WindowStop("FAIL-CLOSED: Pages rollback command returned no deployment URL", code=1)
        deployment_url = urls[-1]
        restored_id, _matched = deployment_from_log(deployment_url)
        return restored_id, deployment_url
    if not live:
        raise WindowStop(
            "Pages rollback API not invoked (ADRRR_PAGES_ROLLBACK_LIVE is not 1). Documented POST " + url,
            code=1,
        )
    request = urllib.request.Request(
        url,
        data=b"",
        method="POST",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode())
    except urllib.error.URLError as exc:
        raise WindowStop(f"FAIL-CLOSED: Pages rollback API transport: {exc.reason}", code=1) from exc
    if not body.get("success"):
        raise WindowStop("FAIL-CLOSED: Pages rollback API did not succeed", code=1)
    result = body.get("result") or {}
    restored_id = result.get("id") or ""
    deployment_url = result.get("url") or ""
    if not restored_id or not deployment_url:
        raise WindowStop("FAIL-CLOSED: Pages rollback API returned no deployment", code=1)
    return restored_id, deployment_url


def _emergency(detail: str) -> str:
    return (
        "EMERGENCY: rollback did not verify the previous public bytes. "
        "Hold remains. Marker was not written. Do not abort the pin. "
        "Do not run the morning assembler. "
        "Operator re-invoke only: python3 tools/publish_window.py restore --host <digest> --explicit\n"
        "Documented Pages rollback: POST /accounts/{account_id}/pages/projects/"
        "{project_name}/deployments/{deployment_id}/rollback\n"
        "Wrangler has no pages deployment rollback command. "
        f"Detail: {detail}"
    )


def restore(host: Path, *, explicit: bool = False) -> None:
    pin = load_pin(host)
    if pin is None:
        raise WindowStop("STOP: no window pin")
    state = pin.get("state")
    if state == "restore-verified":
        raise WindowStop("STOP: previous public bytes already verified; not uploading again")
    if state == "restore-failed" and not explicit:
        raise WindowStop("STOP: rollback already failed; explicit restore only")
    if state not in ("upload-attempted", "restore-failed"):
        raise WindowStop(f"STOP: restore is not available from {state}")
    attempts = int(pin.get("rollback_attempts") or 0)
    if attempts >= 1 and not explicit:
        raise WindowStop("STOP: rollback already attempted")
    if attempts >= 3:
        raise WindowStop("STOP: rollback attempt cap")
    pin["rollback_attempts"] = attempts + 1
    pin["restore_required"] = True
    write_pair(host, pin)
    try:
        _do_restore(host)
    except (WindowStop, ReadbackMismatch, ReadbackTransport) as exc:
        failed = load_pin(host)
        failed["state"] = "restore-failed"
        failed["restore_required"] = True
        write_pair(host, failed)
        raise WindowStop(_emergency(str(exc)), code=1) from exc
    done = load_pin(host)
    done["state"] = "restore-verified"
    done["restore_required"] = True
    write_pair(host, done)
    print("restore-verified: previous public bytes match; marker not written; hold remains")


def _do_restore(host: Path) -> None:
    pin = load_pin(host)
    root = Path(pin.get("rollback_root") or "")
    files = pin.get("rollback_files") or {}
    public = pin.get("rollback_public") or {}
    if not files or not public or not root.is_dir():
        raise WindowStop("STOP: rollback tree is not available")
    if collect_tree(root) != files:
        raise WindowStop("STOP: rollback tree drifted")
    work = host / "tools/cfwrangler"
    work.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="rollback-", dir=work))
    try:
        _copy_tree(files, root, stage)
        deployment_id = pin.get("rollback_deployment_id")
        use_api = bool(deployment_id) and (
            bool(os.environ.get("ADRRR_PAGES_ROLLBACK_CMD"))
            or os.environ.get("ADRRR_PAGES_ROLLBACK_LIVE") == "1"
        )
        if use_api:
            restored_id, restored_url = _invoke_pages_rollback(host, deployment_id)
        else:
            if deployment_id:
                print(
                    "Pages rollback API not invoked (ADRRR_PAGES_ROLLBACK_LIVE is not 1). "
                    "Documented POST "
                    + pages_rollback_url(*_cf(host)[:2], deployment_id)
                    + ". Restoring the pinned rollback bytes through wrangler.",
                    file=sys.stderr,
                )
            rc, log = _wrangler_deploy(host, stage)
            if rc != 0:
                raise WindowStop(f"FAIL-CLOSED: rollback wrangler exit {rc}", code=1)
            if (stage / "functions").is_dir() and "Uploading Functions bundle" not in log:
                raise WindowStop(
                    "FAIL-CLOSED: rollback functions/ present but Wrangler did not upload Functions bundle",
                    code=1,
                )
            if "Deployment complete" not in log:
                raise WindowStop("FAIL-CLOSED: rollback wrangler output has no Deployment complete", code=1)
            restored_id, restored_url = deployment_from_log(log)
        compare_http(restored_url, restored_id, public)
        for rel, digest in files.items():
            path = stage / rel
            if not path.is_file() or path.is_symlink() or sha256(path) != digest:
                raise WindowStop(f"STOP: rollback stage {rel} mismatch", code=1)
        current = load_pin(host)
        current["restored_deployment_id"] = restored_id
        current["restored_deployment_url"] = restored_url
        write_pair(host, current)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def retry_publish(host: Path) -> None:
    pin = load_pin(host)
    if pin is None or pin.get("state") != "restore-verified":
        raise WindowStop("STOP: retry-publish requires a verified rollback")
    verify_scripts(host, pin, remote=True)
    if tree_state(host, pin) != "ok":
        raise WindowStop("STOP: artifact tree is missing or drifted")
    pin["state"] = "armed"
    pin["restore_required"] = False
    pin["rollback_attempts"] = 0
    pin["deployment_id"] = None
    pin["deployment_url"] = None
    write_pair(host, pin)
    print("retry armed; the next entry may upload the new tree once")


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
    raise WindowStop(
        "STOP: abort does not remove the hold or return to the morning assembler"
    )


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
        "baseline_sha": marker["sha"],
        "synced_sha": marker["sha"],
        "synced_tree": sections_tree(host),
        "rollback_identity": None,
        "rollback_attempts": 0,
        "restore_required": False,
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
    boot = load_boot(host) or {"version": 2}
    boot["version"] = 2
    boot["state"] = "released"
    if pin and pin.get("baseline_sha"):
        boot["baseline_sha"] = pin["baseline_sha"]
        boot["baseline_tree"] = pin.get("baseline_tree")
    write_boot(host, boot)
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
    """Replace snapshot bytes with the patched bytes. Stop if a live file matches neither.

    The prearm hold is written before any script rename, while the caller holds
    the publish lock. A patched entry therefore cannot run without the hold.
    """
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
    pin = load_pin(host)
    boot = load_boot(host)
    if pin is not None and pin.get("state") != "prearm":
        if plan:
            raise WindowStop("STOP: refusing to replace scripts over an active window")
        print("install: already patched")
        return
    if pin is None and boot and boot.get("state") == "released":
        if plan:
            raise WindowStop("STOP: bootstrap is released; not installing over the morning path")
        print("install: already patched")
        return
    if pin is None:
        write_prearm(host)
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
        raise WindowStop("STOP: window pin still present; not returning to the unpatched assembler")
    boot = load_boot(host)
    if boot and boot.get("state") == "prearm":
        raise WindowStop("STOP: prearm hold is in force; rollback would return the morning assembler")
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
    armed.add_argument("--rollback", type=Path, required=True)
    armed.add_argument("--rollback-deployment")
    armed.add_argument("--until", required=True)

    synced = sub.add_parser("sync")
    synced.add_argument("--host", type=Path, required=True)
    synced.add_argument("--tip", required=True)

    started = sub.add_parser("begin-upload")
    started.add_argument("--host", type=Path, required=True)

    restored = sub.add_parser("restore")
    restored.add_argument("--host", type=Path, required=True)
    restored.add_argument("--explicit", action="store_true")

    retried = sub.add_parser("retry-publish")
    retried.add_argument("--host", type=Path, required=True)

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
            arm(args.host, args.artifacts, args.until, args.rollback, args.rollback_deployment)
        elif args.cmd == "sync":
            sync(args.host, args.tip)
        elif args.cmd == "begin-upload":
            begin_upload(args.host)
        elif args.cmd == "restore":
            restore(args.host, explicit=args.explicit)
        elif args.cmd == "retry-publish":
            retry_publish(args.host)
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
