"""Run a script in an existing Parallels guest, preserving its argument quoting."""
import argparse
import base64
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("guest", choices=["ubuntu", "windows"])
parser.add_argument("script", type=pathlib.Path)
parser.add_argument("--system", action="store_true", help="Use the guest service account for isolated service management")
parser.add_argument("--vm-name", help="Override the existing Parallels VM name")
parser.add_argument("--stage", help="Windows browser stage (no ui-stage.txt edit required)")
parser.add_argument("--source-root", help="Windows UNC path to this repository")
parser.add_argument("--workdir", help="Existing Windows scanner runtime directory")
parser.add_argument("--shared-root", help="Guest path for the current run's evidence and private configuration")
parser.add_argument("--browser", help="Windows browser executable path")
args = parser.parse_args()
vm_name = args.vm_name
if not vm_name:
    names = subprocess.check_output(["prlctl", "list", "-a", "-o", "name", "--no-header"], text=True).splitlines()
    default = {"ubuntu": "Ubuntu 24.04 (with Rosetta)", "windows": "Windows 11"}[args.guest]
    matches = [name for name in names if name.lower().startswith(args.guest)]
    if default in names:
        vm_name = default
    elif len(matches) == 1:
        vm_name = matches[0]
    else:
        parser.error(f"Select a {args.guest} VM with --vm-name. Available: {', '.join(names)}")
source = args.script.read_text(encoding="utf-8-sig")
if args.guest == "ubuntu":
    if args.stage or args.source_root or args.workdir or args.shared_root or args.browser:
        parser.error("Windows browser options require guest=windows")
    command = ["prlctl", "exec", vm_name, "bash", "-s"]
    raise SystemExit(subprocess.run(command, input=source.encode()).returncode)
else:
    settings = {"PROJECTX_FLOW_STAGE": args.stage, "PROJECTX_FLOW_SOURCE_ROOT": args.source_root, "PROJECTX_FLOW_WORKDIR": args.workdir,
                "PROJECTX_FLOW_SHARED_ROOT": args.shared_root, "PROJECTX_FLOW_BROWSER": args.browser}
    source = "".join(f"$env:{key}='" + value.replace("'", "''") + "'\n" for key, value in settings.items() if value is not None) + source
    source = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n$ProgressPreference='SilentlyContinue'\n" + source
    identity = [] if args.system else ["--current-user"]
    command = ["prlctl", "exec", vm_name, *identity, "powershell", "-NoProfile", "-EncodedCommand", base64.b64encode(source.encode("utf-16le")).decode()]
raise SystemExit(subprocess.run(command).returncode)
