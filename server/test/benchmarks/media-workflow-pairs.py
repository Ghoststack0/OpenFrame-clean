"""Run after building: python3 media-workflow-pairs.py OUTPUT.json PHOTO12 PHOTO24 VIDEO.

Run this process under taskset to inherit a CPU affinity in every sample.
Each sample is a fresh Node process; samples run serially and alternate order.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile

output, photo12, photo24, video = sys.argv[1:]
script = pathlib.Path(__file__).with_name("media-workflow.mjs")
rows = []

with tempfile.TemporaryDirectory(prefix="media-workflow-pairs-") as temporary:
    def sample(phase, round_index, variant, count, jobs, threads, inputs):
        result = pathlib.Path(temporary) / "sample.json"
        command = [
            os.environ.get("NODE_BINARY", "node"), str(script), "profile", str(result),
            variant, str(count), str(jobs), str(threads), *inputs,
        ]
        with subprocess.Popen(command, stdout=subprocess.DEVNULL) as process:
            _, status, usage = os.wait4(process.pid, 0)
            process.returncode = os.waitstatus_to_exitcode(status)
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode, command)
        record = json.loads(result.read_text())["rows"][0]
        record.update({
            "phase": phase, "round": round_index,
            "wholeProcessCpuSeconds": usage.ru_utime + usage.ru_stime,
            "wholeProcessMaxRssKiB": usage.ru_maxrss,
        })
        rows.append(record)
        pathlib.Path(output).write_text(json.dumps({
            "method": "Three serial alternating pairs, fresh Node 24 processes, warmed OS caches. Whole-process CPU includes imports and FFmpeg children. Node workflow CPU excludes FFmpeg children. Peak RSS is the largest individual process, not an aggregate. Database and queue time are not measured.",
            "rows": rows,
        }, indent=2) + "\n")
        print(phase, round_index, variant, threads, round(record["milliseconds"], 1), flush=True)
        return record

    def fingerprints(row):
        return sorted((f["type"], f["isEdited"], f["sha256"]) for f in row["files"]), sorted(row["thumbhashes"])

    for round_index in range(3):
        versions = ["baseline", "candidate", "direct", "margin2"]
        if round_index % 2:
            versions.reverse()
        for label, path in [("photo12-single", photo12), ("photo24-single", photo24)]:
            results = {version: sample(label, round_index, version, 1, 1, 0, [path]) for version in versions}
            assert fingerprints(results["baseline"]) == fingerprints(results["candidate"])

        versions = ["baseline", "candidate"] if round_index % 2 == 0 else ["candidate", "baseline"]
        results = {version: sample("photo-batch20", round_index, version, 20, 3, 0, [photo12, photo24]) for version in versions}
        assert fingerprints(results["baseline"]) == fingerprints(results["candidate"])
        for threads in ([0, 2] if round_index % 2 == 0 else [2, 0]):
            sample("photo-batch20-threads", round_index, "candidate", 20, 3, threads, [photo12, photo24])
        results = {version: sample("video-single", round_index, version, 1, 1, 0, [video]) for version in versions}
        assert fingerprints(results["baseline"]) == fingerprints(results["candidate"])
