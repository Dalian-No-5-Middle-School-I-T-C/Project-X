"""Allocate Linux-owned ports inside WSL, rather than probing them on Windows."""
import json
from pathlib import Path
import socket
import sys

names = ("backend", "database", "proxy", "ai", "provider")
excluded = {int(value) for value in sys.argv[2:]}
sockets = []
ports = {}
try:
    for name in names:
        while True:
            server = socket.socket()
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = server.getsockname()[1]
            if port not in excluded:
                sockets.append(server)
                ports[name] = port
                excluded.add(port)
                break
            server.close()
    Path(sys.argv[1]).write_text("".join(f"{name}_port={port}\n" for name, port in ports.items()), encoding="utf-8")
    print(json.dumps(ports))
finally:
    for server in sockets:
        server.close()
