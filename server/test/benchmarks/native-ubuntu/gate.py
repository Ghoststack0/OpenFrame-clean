"""Run one candidate dry run or alternating upstream/candidate native pairs."""

import argparse
import fcntl
import hashlib
import json
import os
import runpy
import resource
import signal
import socket
import subprocess
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path
from build_gate import dist_hash

ROOT = Path.home() / "openframe-native-validation-20261026"
UPSTREAM = "256eb55dbe92ac77e02794442f9487e88ffed2b1"


def systemctl(*args):
    return subprocess.check_output(["systemctl", "--user", *args], text=True).strip()


def proc_stats(pids):
    result = {}
    for pid in pids:
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            result[pid] = {"cpu": int(fields[11]) + int(fields[12]), "start": fields[19], "rss": int(fields[21]) * os.sysconf("SC_PAGE_SIZE")}
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return result


def descendants(roots):
    selected = set()
    pending = list(roots)
    while pending:
        pid = pending.pop()
        if pid in selected:
            continue
        selected.add(pid)
        try:
            pending.extend(int(value) for value in Path(f"/proc/{pid}/task/{pid}/children").read_text().split())
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return selected


def cgroup_cpu_snapshot():
    result = {}
    for path in Path("/sys/fs/cgroup").rglob("cpu.stat"):
        try:
            values = dict(line.split() for line in path.read_text().splitlines())
            if "usage_usec" in values:
                result[str(path.parent)] = int(values["usage_usec"]) / 1_000_000
        except (FileNotFoundError, PermissionError):
            pass
    return result


def host_cpu():
    return [int(value) for value in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]


def idle_check():
    before = host_cpu()
    time.sleep(3)
    delta = [b - a for a, b in zip(before, host_cpu())]
    busy = 1 - delta[3] / sum(delta)
    assert busy < 0.10, f"Host is not idle: {busy:.1%} CPU busy before run"
    return {"sampleSeconds": 3, "cpuBusyFraction": busy, "loadAverage": os.getloadavg()}


class Resources:
    def __init__(self, cgroup):
        self.cgroup = cgroup
        self.stop_event = threading.Event()
        self.ticks = os.sysconf("SC_CLK_TCK")
        self.roots = [int((ROOT / "ml.pid").read_text()), int((ROOT / "redis.pid").read_text()), int((ROOT / "pgdata/postmaster.pid").read_text().splitlines()[0])]
        self.initial = proc_stats(descendants(self.roots))
        self.last = {(pid, stat["start"]): stat["cpu"] for pid, stat in self.initial.items()}
        self.ancillary_ticks = 0
        self.peak_rss = self.peak_stack_rss = 0
        self.cgroup_start = cgroup_cpu_snapshot()
        self.cpu_start = self.cpu()
        self.host_start = host_cpu()
        usage = resource.getrusage(resource.RUSAGE_SELF)
        self.runner_start = usage.ru_utime + usage.ru_stime
        self.thread = threading.Thread(target=self.sample, daemon=True)
        self.thread.start()

    def cpu(self):
        return int(dict(line.split() for line in (self.cgroup / "cpu.stat").read_text().splitlines())["usage_usec"]) / 1_000_000

    def sample(self):
        while not self.stop_event.is_set():
            try:
                backend = {int(pid) for pid in (self.cgroup / "cgroup.procs").read_text().split()}
            except FileNotFoundError:
                break
            ancillary = descendants(self.roots) - backend
            stats = proc_stats(backend | ancillary)
            backend &= stats.keys()
            ancillary &= stats.keys()
            for pid in ancillary:
                stat = stats[pid]
                key = (pid, stat["start"])
                self.ancillary_ticks += max(0, stat["cpu"] - self.last.get(key, 0))
                self.last[key] = stat["cpu"]
            self.peak_rss = max(self.peak_rss, sum(stats[pid]["rss"] for pid in backend))
            self.peak_stack_rss = max(self.peak_stack_rss, sum(stats[pid]["rss"] for pid in backend | ancillary))
            self.stop_event.wait(0.1)

    def finish(self, client_cpu=0):
        self.stop_event.set()
        self.thread.join()
        cgroups = cgroup_cpu_snapshot()
        cgroup_deltas = {name: value - self.cgroup_start.get(name, 0) for name, value in cgroups.items()}
        cgroup_deltas = {name: value for name, value in cgroup_deltas.items() if value >= 0.05}
        cpu = self.cpu() - self.cpu_start
        delta = [b - a for a, b in zip(self.host_start, host_cpu())]
        host_busy = (sum(delta) - delta[3] - delta[4]) / self.ticks
        usage = resource.getrusage(resource.RUSAGE_SELF)
        runner_cpu = usage.ru_utime + usage.ru_stime - self.runner_start
        unaccounted = max(0, host_busy - cpu - self.ancillary_ticks / self.ticks - client_cpu - runner_cpu)
        quiet = unaccounted <= max(5, host_busy * 0.05)
        return {"hostCgroupCpuDeltaSeconds": cgroup_deltas, "backendCpuSeconds": cpu, "hostIdleDuringRun": quiet, "hostBusyCpuSeconds": host_busy, "unattributedCpuSecondsUpperBound": unaccounted, "clientCpuSeconds": client_cpu, "samplerCpuSeconds": runner_cpu, "ancillaryCpuSecondsLowerBound": self.ancillary_ticks / self.ticks, "peakRssBytes": self.peak_rss, "peakStackRssBytes": self.peak_stack_rss, "backendCgroupMemoryPeakBytes": int((self.cgroup / "memory.peak").read_text()), "rssSamplingIntervalMs": 100, "scope": "Backend CPU is exact cgroup accounting including exited children. RSS is sampled aggregate process RSS, shared pages counted per process. Stack adds existing ML/PostgreSQL/Redis descendants. Ancillary CPU is a sampled lower bound; short-lived DB children may be missed. Includes untimed fixture uploads, warmup and queue drain, excludes source/fixture generation and service startup. Cgroup memory.peak includes startup and file cache. Unattributed CPU includes sampling gaps; reject runs above max(5 CPU seconds, 5% of host busy CPU)."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", required=True, type=Path, help="Directory containing dist-baseline and dist-candidate under app/server")
    parser.add_argument("--output", required=True, type=Path, help="Output directory inside the isolated deployment")
    parser.add_argument("--resume", action="store_true", help="Validate completed runs and archive interrupted attempts before continuing")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="One complete candidate workload; no baseline or pairs")
    mode.add_argument("--pairs", type=int, help="Number of alternating pairs")
    args = parser.parse_args()
    os.chdir(ROOT)
    build = args.build.resolve()
    output = args.output.resolve()
    assert build.is_relative_to(ROOT / "app/server") and output.is_relative_to(ROOT), "Isolated deployment paths only"
    assert args.resume == output.exists(), "Use a new output directory, or explicitly --resume an existing series"
    assert args.dry_run or args.pairs > 0
    locks = []
    for path in [ROOT / "gate.lock", ROOT / "codec-build/build.lock"]:
        lock = path.open("a")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        locks.append(lock)
    try:
        with socket.create_connection(("127.0.0.1", 2287), timeout=1):
            raise RuntimeError("Stop the isolated API before running the gate")
    except ConnectionRefusedError:
        pass
    variants = ["candidate"] if args.dry_run else ["baseline", "candidate"]
    manifests = {}
    for variant in variants:
        dist = build / f"dist-{variant}"
        manifest = json.loads((dist / "gate-build.json").read_text())
        assert manifest["variant"] == variant and manifest["distSha256"] == dist_hash(dist), "Build provenance/hash mismatch"
        for name, field in [("package.json", "runtimePackageSha256"), ("helmet.json", "runtimeHelmetSha256")]:
            assert hashlib.sha256((build / name).read_bytes()).hexdigest() == manifest[field], f"Shared runtime file differs: {name}"
        if variant == "baseline":
            assert manifest["sourceCommit"] == UPSTREAM, "Only actual upstream source is an accepted baseline"
        manifests[variant] = manifest
    if args.resume:
        assert json.loads((output / "builds.json").read_text()) == manifests, "Resume builds differ"
    else:
        output.mkdir(mode=0o700)
        (output / "builds.json").write_text(json.dumps(manifests, indent=2) + "\n")
    client_source = ROOT / "app/server/test/benchmarks/native-gate.mjs"
    frozen_client = output / "native-gate.mjs"
    if args.resume:
        assert frozen_client.read_bytes() == client_source.read_bytes(), "Resume client differs"
    else:
        frozen_client.write_bytes(client_source.read_bytes())
    launcher = output / "launch.sh"
    launcher.write_text('''#!/bin/bash
set -euo pipefail
cd "$HOME/openframe-native-validation-20261026"
source ./run-env
set -a
source ./env
set +a
export NODE_ENV=production
export IMMICH_MEDIA_LOCATION="${IMMICH_MEDIA_LOCATION:-$OPENFRAME_STATE/media}"
export IMMICH_BUILD_DATA="${IMMICH_BUILD_DATA:-$OPENFRAME_STATE/build}"
export IMMICH_MACHINE_LEARNING_URL="${IMMICH_MACHINE_LEARNING_URL:-http://127.0.0.1:3003}"
export PATH="$PWD/app/server/bin:$PATH"
export LD_LIBRARY_PATH="$OPENFRAME_CODECS/prefix/lib:$OPENFRAME_CODECS/sysroot/usr/lib/x86_64-linux-gnu"
export MAGICK_CONFIGURE_PATH="$OPENFRAME_CODECS/prefix/etc/ImageMagick-7"
export NODE_OPTIONS="--require $PWD/app/scripts/native/codecs.cjs"
exec node "$1/main.js"
''')
    runs = [("candidate", 0)] if args.dry_run else [(variant, number) for number in range(args.pairs) for variant in (["baseline", "candidate"] if number % 2 == 0 else ["candidate", "baseline"])]
    if not args.resume:
        (output / "series.json").write_text(json.dumps({"dryRun": args.dry_run, "pairs": 0 if args.dry_run else args.pairs, "runOrder": [f"{variant}-r{number}" for variant, number in runs] if not args.dry_run else ["candidate-dry-run"], "clientSha256": hashlib.sha256(frozen_client.read_bytes()).hexdigest(), "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "rssSamplingIntervalMs": 100, "gridCacheMeaning": "HTTP cold with no validators, then warm ETag/304 on the same six keep-alive connections. Filesystem caches are not globally dropped."}, indent=2) + "\n")
    analyzer = runpy.run_path(str(Path(__file__).with_name("analyze-gate.py")))
    if args.resume:
        series = json.loads((output / "series.json").read_text())
        assert series["pairs"] == (0 if args.dry_run else args.pairs)
        series.setdefault("resumes", []).append({"timeUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "runnerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
        (output / "series.json").write_text(json.dumps(series, indent=2) + "\n")
    for variant, number in runs:
        label = f"{variant}-r{number}" if not args.dry_run else "candidate-dry-run"
        run = output / label
        if run.exists():
            try:
                analyzer["summarize"](run)
            except (AssertionError, KeyError, FileNotFoundError, json.JSONDecodeError):
                interrupted = output / "interrupted"
                interrupted.mkdir(exist_ok=True, mode=0o700)
                run.rename(interrupted / f"{label}-{time.time_ns()}")
            else:
                print(f"{label} already complete; validated", flush=True)
                if not args.dry_run:
                    other = output / (f"baseline-r{number}" if variant == "candidate" else f"candidate-r{number}")
                    if (other / "artifacts.json").exists():
                        analyzer["compare_artifacts"](output / f"baseline-r{number}", output / f"candidate-r{number}")
                continue
        run.mkdir(mode=0o700)
        host_idle = idle_check()
        unit = f"openframe-gate-{os.getpid()}-{number}-{variant}"
        log = run / "server.log"
        resources = None
        client_usage_before = None
        started = time.monotonic()
        try:
            subprocess.run(["systemd-run", "--user", f"--unit={unit}", "--property=CPUAccounting=yes", "--property=MemoryAccounting=yes", "--property=RemainAfterExit=yes", f"--property=StandardOutput=append:{log}", f"--property=StandardError=append:{log}", "/bin/bash", launcher, build / f"dist-{variant}"], check=True, stdout=subprocess.DEVNULL)
            deadline = time.monotonic() + 180
            while not log.exists() or "Immich Microservices is running" not in log.read_text():
                assert systemctl("show", unit, "-p", "ActiveState", "--value") in {"active", "activating"}, "Runtime failed; inspect private server log"
                assert time.monotonic() < deadline, "Runtime startup timeout"
                time.sleep(0.5)
            while True:
                try:
                    with urllib.request.urlopen("http://127.0.0.1:2287/api/server/ping", timeout=2) as response:
                        assert response.status == 200
                        break
                except (urllib.error.URLError, TimeoutError):
                    assert time.monotonic() < deadline, "API readiness timeout"
                    time.sleep(0.5)
            cgroup = Path("/sys/fs/cgroup") / systemctl("show", unit, "-p", "ControlGroup", "--value").lstrip("/")
            # Settle work left by an interrupted attempt before starting this run's accounting.
            credentials = json.loads((ROOT / "fixtures/admin.json").read_text())
            request = urllib.request.Request("http://127.0.0.1:2287/api/auth/login", data=json.dumps(credentials).encode(), headers={"content-type": "application/json"})
            with urllib.request.urlopen(request, timeout=30) as response:
                token = json.load(response)["accessToken"]
            settle_deadline = time.monotonic() + 3600
            while True:
                request = urllib.request.Request("http://127.0.0.1:2287/api/queues", headers={"authorization": f"Bearer {token}"})
                with urllib.request.urlopen(request, timeout=30) as response:
                    queues = json.load(response)
                assert all(not queue["isPaused"] and queue["statistics"]["failed"] == 0 for queue in queues), "Paused or failed jobs before workload"
                if all(sum(queue["statistics"][key] for key in ["active", "waiting", "delayed"]) == 0 for queue in queues):
                    break
                assert time.monotonic() < settle_deadline, "Existing queues did not settle"
                time.sleep(1)
            resources = Resources(cgroup)
            client = ROOT / "local/node-v24.13.1-linux-x64/bin/node"
            # The client also needs the same source codecs to inspect artifacts.
            client_usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
            with (run / "client.log").open("wb") as client_log:
                subprocess.run(["/bin/bash", "-c", 'source ./run-env; set -a; source ./env; set +a; export LD_LIBRARY_PATH="$OPENFRAME_CODECS/prefix/lib:$OPENFRAME_CODECS/sysroot/usr/lib/x86_64-linux-gnu"; export NODE_OPTIONS="--require $PWD/app/scripts/native/codecs.cjs"; exec "$@"', "gate-client", client, frozen_client, "run", ROOT, label, run], check=True, stdout=client_log, stderr=client_log)
            client_usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
            client_cpu = client_usage_after.ru_utime + client_usage_after.ru_stime - client_usage_before.ru_utime - client_usage_before.ru_stime
            report = resources.finish(client_cpu)
            resources = None
            (run / "resources.json").write_text(json.dumps({**report, "hostIdleBeforeRun": host_idle, "wallSecondsIncludingStartup": time.monotonic() - started}, indent=2) + "\n")
            assert report["hostIdleDuringRun"], "Unattributed host CPU exceeded the idle gate; evidence retained"
            print(f"{label} passed", flush=True)
            other = output / (f"baseline-r{number}" if variant == "candidate" else f"candidate-r{number}")
            if (other / "artifacts.json").exists():
                analyzer["compare_artifacts"](output / f"baseline-r{number}", output / f"candidate-r{number}")
                print(f"Round {number} exact-byte parity passed", flush=True)
        finally:
            if resources:
                usage = resource.getrusage(resource.RUSAGE_CHILDREN)
                client_cpu = (usage.ru_utime + usage.ru_stime - client_usage_before.ru_utime - client_usage_before.ru_stime) if client_usage_before else 0
                (run / "resources.json").write_text(json.dumps({**resources.finish(client_cpu), "failed": True}, indent=2) + "\n")
            subprocess.run(["systemctl", "--user", "stop", unit], check=True)
            subprocess.run(["systemctl", "--user", "reset-failed", unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"Gate outputs: {output}", flush=True)


if __name__ == "__main__":
    def stop(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    main()
