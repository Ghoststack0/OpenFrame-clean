"""Run one normal HTTP smoke test with the codec package selected through the native runtime preload."""

import os
import signal
import socket
import subprocess
import time
from pathlib import Path

root = Path.home() / "openframe-native-validation-20261026"
os.chdir(root)
try:
    with socket.create_connection(("127.0.0.1", 2287), timeout=1):
        raise RuntimeError("Stop the isolated API before changing its codec package")
except ConnectionRefusedError:
    pass
log_path = root / "logs/server-runtime-codecs.log"
with log_path.open("wb") as log:
    process = subprocess.Popen(
        ["bash", "-c", "source ./run-env; exec app/scripts/native/openframe start"],
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 120
        while "Immich Microservices is running" not in log_path.read_text():
            if process.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("Source-codec runtime did not start; inspect its private log")
            time.sleep(0.5)
        with (root / "logs/http-runtime-codecs.log").open("wb") as output:
            subprocess.run(
                [
                    root / "local/node-v24.13.1-linux-x64/bin/node",
                    root / "app/server/test/benchmarks/native-http.mjs",
                    "http://127.0.0.1:2287",
                    root / "fixtures",
                    "candidate-runtime-codecs",
                    root / "logs/native-http-runtime-codecs.jsonl",
                ],
                stdout=output,
                stderr=output,
                check=True,
            )
        print("Source-codec normal startup and full HTTP/ML smoke check passed.")
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        process.wait(timeout=120)
