#!/usr/bin/env python3
"""Refuse to publish a collected document that is stale, overdue or older than what is already live.

run_sync.sh calls this after the collect and before the KV upload and the local replace. The collector stamps
`updated_at_hkt` when the collect STARTS, so a collect that spans a host freeze would otherwise be published as
fresh. Rejecting it leaves the last good snapshot in place; the supervisor then starts a fresh collect.

Exit 0 = publish. Exit 3 = reject (reason on stderr). Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

HKT = timezone(timedelta(hours=8))
REJECT = 3


def stamp_epoch(doc):
    value = doc.get("updated_at_hkt") if isinstance(doc, dict) else None
    if not isinstance(value, str):
        raise ValueError("updated_at_hkt is missing")
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=HKT).timestamp()


def load(path):
    with open(path, "rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


def check(doc, now, start=None, publish_by=None, max_age=210, current_stamp=None):
    """Return None when the document may be published, otherwise the reason it may not."""
    if not isinstance(doc, dict) or not isinstance(doc.get("schema_version"), int):
        return "invalid: not a Movers document"
    try:
        stamp = stamp_epoch(doc)
    except ValueError as exc:
        return "invalid: %s" % exc
    if publish_by is not None and now > publish_by:
        return "overdue: %ds past the publish deadline" % (now - publish_by)
    age = now - stamp
    if age > max_age:
        return "stale: stamped %ds ago, limit %ds" % (age, max_age)
    if age < -60:
        return "invalid: stamped %ds in the future" % -age
    if start is not None and stamp < start - 5:
        return "stale: stamped %ds before this attempt started" % (start - stamp)
    if current_stamp is not None and stamp < current_stamp:
        return "stale: older than the snapshot already live"
    return None


def env_number(name):
    value = os.environ.get(name)
    return float(value) if value else None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("doc")
    p.add_argument("--current", help="the live latest.json, to refuse an older document")
    p.add_argument("--now", type=float, default=None, help="testing only")
    args = p.parse_args(argv)
    now = args.now if args.now is not None else time.time()
    try:
        doc = load(args.doc)
    except (OSError, ValueError) as exc:
        print("publish gate: rejected: invalid: %s" % exc, file=sys.stderr)
        return REJECT
    current = None
    if args.current and os.path.exists(args.current):
        try:
            current = stamp_epoch(load(args.current))
        except (OSError, ValueError):
            current = None
    max_age = env_number("HK_MOVERS_MAX_DOC_AGE") or 210
    reason = check(doc, now, env_number("HK_MOVERS_ATTEMPT_START_EPOCH"), env_number("HK_MOVERS_PUBLISH_BY_EPOCH"), max_age, current)
    if reason:
        print("publish gate: rejected: %s" % reason, file=sys.stderr)
        return REJECT
    return 0


if __name__ == "__main__":
    sys.exit(main())
