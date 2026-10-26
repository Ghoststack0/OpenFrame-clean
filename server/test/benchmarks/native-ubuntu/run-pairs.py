"""Only operates on the fixed disposable validation deployment, after its warmup."""

import os
import signal
import socket
import subprocess
import time
from pathlib import Path

root = Path.home() / "openframe-native-validation-20261026"
os.chdir(root)
assert (root / "env").exists() and (root / "app/server/dist-baseline/main.js").exists()
node = root / "local/node-v24.13.1-linux-x64/bin/node"
# Refuse to replace a listening application. Stop the warmup runtime first.
try:
    with socket.create_connection(("127.0.0.1", 2287), timeout=1):
        raise AssertionError("Stop the isolated warmup server before comparing")
except ConnectionRefusedError:
    pass
for round_number in range(3):
    order = (
        ["baseline", "candidate"]
        if round_number % 2 == 0
        else ["candidate", "baseline"]
    )
    for version in order:
        label = f"{version}-r{round_number}"
        dist = "dist-baseline" if version == "baseline" else "dist"
        with (root / f"logs/server-{label}.log").open("wb") as log:
            script = (
                'source ./run-env; set -a; source ./env; set +a; export NODE_ENV=production IMMICH_MEDIA_LOCATION="$PWD/state/media" IMMICH_BUILD_DATA="$PWD/state/build"; exec node app/server/'
                + dist
                + "/main.js"
            )
            proc = subprocess.Popen(
                ["bash", "-c", script], stdout=log, stderr=log, start_new_session=True
            )
            (root / "server.pid").write_text(str(proc.pid))
            try:
                deadline = time.monotonic() + 120
                while (
                    "Immich Microservices is running"
                    not in (root / f"logs/server-{label}.log").read_text()
                ):
                    assert proc.poll() is None, "Native runtime exited during startup"
                    assert time.monotonic() < deadline, (
                        "Microservices startup timed out"
                    )
                    time.sleep(0.5)
                with (root / f"logs/http-{label}.log").open("wb") as check_log:
                    subprocess.run(
                        [
                            node,
                            root / "app/server/test/benchmarks/native-http.mjs",
                            "http://127.0.0.1:2287",
                            root / "fixtures",
                            label,
                            root / "logs/native-http.jsonl",
                        ],
                        check=True,
                        stdout=check_log,
                        stderr=check_log,
                    )
                print(f"{label} passed", flush=True)
            finally:
                # The API is a separate process; stop our whole isolated process group.
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=120)
print("All three alternating native pairs passed.", flush=True)
