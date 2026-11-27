"""Interrupt the named Parallels guest's test Nginx during the outage-A scanner stage."""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--vm-name", required=True)
parser.add_argument("--root", type=Path, default=os.environ.get("PROJECTX_FLOW_ROOT", "ignored/production-flow"))
args = parser.parse_args()
ready = args.root / "nginx-outage-ready.json"
restored = args.root / "nginx-restored.json"
if ready.exists() or restored.exists():
    parser.error("Archive earlier outage markers before beginning a new run")
deadline = time.monotonic() + 240
while not ready.exists():
    if time.monotonic() >= deadline:
        raise TimeoutError("No uploaded page observed")
    time.sleep(0.1)
command = """
set -eu
systemctl is-active --quiet project-x-server
systemctl is-active --quiet nginx
trap 'systemctl start nginx' EXIT
date -Ins
systemctl stop nginx
if systemctl is-active --quiet nginx; then exit 1; fi
sleep 10
systemctl start nginx
systemctl is-active nginx
date -Ins
"""
subprocess.run(["prlctl", "exec", args.vm_name, "bash", "-s"], input=command, text=True, check=True)
restored.write_text(json.dumps({"at": round(time.time() * 1000)}))
