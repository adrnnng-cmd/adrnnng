#!/usr/bin/env bash
# Entry point kept from the old daemon: `bash $DIR/daemon.sh`. The loop itself is supervisor.py, which is
# wall-clock and suspend aware. exec keeps the pid, so daemon.pid and `kill <pid>` mean what they did before.
set -u
DIR=${HK_MOVERS_DIR:-/workspace/futu/hk-movers}
exec "${HK_MOVERS_SUPERVISOR_PYTHON:-python3}" "$DIR/supervisor.py" --dir "$DIR" "$@"
