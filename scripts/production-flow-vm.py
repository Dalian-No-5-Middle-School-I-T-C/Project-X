"""Run a script in an existing Parallels guest, preserving its argument quoting."""
import argparse
import base64
import pathlib
import shlex
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("guest", choices=["ubuntu", "windows"])
parser.add_argument("script", type=pathlib.Path)
parser.add_argument("--system", action="store_true", help="Use the guest service account for isolated service management")
parser.add_argument("--vm-name", help="Override the existing Parallels VM name")
parser.add_argument("--stage", help="Windows browser stage (no ui-stage.txt edit required)")
parser.add_argument("--source-root", help="Windows UNC path to this repository")
parser.add_argument("--workdir", help="Existing Windows scanner runtime directory")
args = parser.parse_args()
source = args.script.read_text(encoding="utf-8")
if args.guest == "ubuntu":
    if args.stage or args.source_root or args.workdir:
        parser.error("--stage, --source-root and --workdir require guest=windows")
    command = ["prlctl", "exec", args.vm_name or "Ubuntu 24.04 (with Rosetta)", "bash", "-c", shlex.quote(source)]
else:
    settings = {"PROJECTX_FLOW_STAGE": args.stage, "PROJECTX_FLOW_SOURCE_ROOT": args.source_root, "PROJECTX_FLOW_WORKDIR": args.workdir}
    source = "".join(f"$env:{key}='" + value.replace("'", "''") + "'\n" for key, value in settings.items() if value is not None) + source
    source = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n$ProgressPreference='SilentlyContinue'\n" + source
    identity = [] if args.system else ["--current-user"]
    command = ["prlctl", "exec", args.vm_name or "Windows 11", *identity, "powershell", "-NoProfile", "-EncodedCommand", base64.b64encode(source.encode("utf-16le")).decode()]
raise SystemExit(subprocess.run(command).returncode)
