# OpenFrame backend comparison

This directory contains two different measurements. The in-memory benchmark isolates checksum work in upload preflight. The HTTP bench compares the latest stable Immich server with the built OpenFrame server using real PostgreSQL, Redis, and disposable storage. Neither measures mobile connectivity or proves that the whole application is faster.

## Baseline and candidate

On 2026-10-26, the authoritative [Immich latest-release API](https://api.github.com/repos/immich-app/immich/releases/latest) reported [v3.3.5](https://github.com/immich-app/immich/releases/tag/v3.3.5), published 2026-10-21. The [tag API](https://api.github.com/repos/immich-app/immich/git/ref/tags/v3.3.5) resolves to commit `8303cb117e197c700332b33b61b45314c9cc5bb4`. Its image revision label agrees. The microbenchmark setup checks both APIs and refuses to run if latest stable changes. Results record image IDs, registry digests, release metadata, and source hashes.

OpenFrame starts at commit `62a489eaf996267ec8c246412a2d13f6010d7b42` plus the recorded server working-tree changes. The new change reuses decoded checksum buffers in `AssetMediaService.bulkUploadCheck`. Previously, each asset's checksum was decoded before the repository query and again while constructing the response. Owner scoping, database query, encoding rules, request order, and duplicate/trash decisions remain the same. No password cost or security check changed.

The HTTP candidate contains the full freshly built `server/dist`, compiled with Node 24.13.1 and the Nest CLI. It overlays the existing `immich-perf:local` production dependencies and native codecs. This avoids rebuilding native libraries or downloading another full application image. The prior web/CLI builds remain in that image and are outside the API comparison. `candidateBuild` records the source/dist tree hashes and server diff. The benchmark image overrides the inherited upstream source/version labels. It is a benchmark artifact, not a release build.

The parent later published the fork at [Ghoststack0/OpenFrame](https://github.com/Ghoststack0/OpenFrame), incorporating the service change and its test in commit `c0ccea8d9`. Benchmark artifacts deliberately retain the tested pre-integration HEAD, working-tree diff, and hashes. They were not rebuilt or relabeled after that integration.

## Host and isolation

All measured execution and service unit tests ran over SSH on `yvm@192.168.1.9`. `/home/yvm/AGENTS.md` was read before creating the bench. Persistent commands, compiled artifacts, and remote results live in `/home/yvm/openframe-bench-20261026`.

The host has an AMD A4-9125, two CPU cores, about 6.7 GiB RAM, and an ext4 NVMe home filesystem. Raw results include `lscpu`, memory, kernel, filesystem, Docker, and Node details. The application runtime is Node 24.22.1. Other host services can contend for CPU and I/O; no cores or memory were reserved.

The microbenchmark container has no network access, no production volumes, and a read-only root filesystem. It mounts only the bench directory. The HTTP bench uses two separate Compose projects named `openframe-bench-http-upstream` and `openframe-bench-http-candidate`, with independent database/upload volumes. Only one project's services run at a time. The sole published endpoint is `127.0.0.1:2297`. Only those disposable projects and their volumes are removed before/after a run. Existing Immich deployments and personal photos/databases are untouched.

The first HTTP setup used an internal Docker network whose published port was unavailable on this host. That attempt produced no performance samples. The corrected configuration uses a project bridge and explicit `IMMICH_HOST=0.0.0.0`, with the host port bound to loopback.

## Upload preflight CPU benchmark

`prepare-upload-check.mjs` uses the installed TypeScript compiler to extract and transpile the actual working-tree method. It does not maintain a second hand-written implementation. The baseline invokes the real service method from the pinned upstream image. Both use that image's actual checksum helper and response enums. The repository stub returns synthetic records immediately, so these numbers exclude PostgreSQL, HTTP, network, storage, and media jobs.

Workloads contain 100, 1,000, or 10,000 distinct synthetic SHA1 checksums, alternating hex/base64 encoding, with 0%, 50%, or 100% existing records. Each process runs five warmup rounds and 30 measured rounds. Order alternates baseline/candidate first. Each timing sample is the mean of a batch of `max(2, floor(2000 / assetCount))` calls; medians summarize the 30 batches. Fixture construction and output assertions are outside timing.

An unchanged control run differed from upstream by -1.3% to +0.8%. Before the edit, `--require-single-decode` failed with `6 !== 3` on a three-asset request. After the edit it passes, counting six baseline decodes versus three candidate decodes. The counting patch is removed before timing.

The three patched processes passed mixed encodings, uppercase hex, repeated checksums, original request order, active/trashed duplicate decisions, empty method input, repository owner/checksum arguments, and differential output checks for all workloads. The normal service suite passed all 135 tests on the Linux box, including the added repeated/mixed/trashed regression case.

Across three processes, median per-process CPU latency reductions ranged from 16.5% to 37.9%, depending on workload. For 1,000 assets and 50% duplicates, the process medians were 2.251/1.739 ms, 2.243/1.778 ms, and 2.672/2.015 ms for upstream/OpenFrame. Use the raw files for exact values. Runs 2 and 3 overlapped dependency copying for the unit-test environment, so their absolute times include additional host contention. Observed variation is not a confidence interval. `upload-check-linux-summary.json` reports the median of process medians and the median/range of per-process percentage reductions separately.

The CPU result establishes less checksum parsing work. It does not establish an equivalent percentage improvement in real uploads.

## HTTP upload and deployment comparison

`http-upload.py` starts each version with real PostgreSQL 14 and Redis 7, using pinned image digests. PostgreSQL uses normal durability settings, which the result queries directly. Machine learning is disabled for both; other background jobs retain their defaults. This includes initial geodata import and media processing, which can contend with requests.

The script alternates upstream/candidate first over three rounds. Each round includes one warmup upload and five measured sequential uploads of unique 512x512 RGB PNGs, about 0.75 MiB each. The standard-library PNG generator uses fixed seeds. Bytes differ between round/index pairs and match across versions; SHA256 hashes are recorded. Multipart construction occurs before request timing. HTTP timings include request transmission and complete response reading, but not subsequent behavioral assertions.

Each new upload must report `created`. The script downloads the original and checks every byte, verifies unauthenticated access returns 401, checks a 1,024-byte range returns 206 and the correct bytes, and checks ETag revalidation returns 304 with no body. A repeated upload with its SHA1 header must return the original asset ID and `duplicate`.

Each deployment also runs three warmup and 12 measured HTTP preflight requests, each with 1,000 entries and 50% duplicates. The existing checksum appears repeatedly, new checksums are deterministic, and hex/base64 encodings alternate. The entire ordered response must match literal expected decisions and stored asset IDs.

Volumes start empty per version, then persist between its rounds. Startup timing includes Compose/database readiness and API readiness; fresh and subsequent starts are different workloads. Upload HTTP completion does not mean background processing has completed. This is loopback HTTP smoke evidence with 15 measured uploads and 36 measured preflight requests per version, not a concurrent upload capacity test, WAN/TLS benchmark, or mobile-to-desktop connectivity test.

The completed comparison passed all behavior assertions across six deployments. Its performance gate is inconclusive. A behavior pass does not imply a performance pass. Across 15 measured uploads and 36 measured preflight requests per version:

| HTTP workload                          | Upstream median | OpenFrame median |          Observed difference |
| -------------------------------------- | --------------: | ---------------: | ---------------------------: |
| Upload a new synthetic PNG             |        64.21 ms |         67.26 ms |        OpenFrame 4.7% slower |
| Preflight 1,000 assets, 50% duplicates |        29.46 ms |         27.25 ms | OpenFrame 7.5% lower latency |

These are pooled request medians, not paired process averages or confidence bounds. Per-deployment medians vary materially. The data does not show faster file uploads. The CPU improvement supports the two-line change. The smoke result does not qualify upload performance, and mobile connectivity remains separate work. PostgreSQL reports `fsync=on`, `full_page_writes=on`, and `synchronous_commit=on`.

The deployment result includes full current-server behavior, not an isolated causal test of this one change. It cannot attribute every difference between the two builds to checksum reuse. `http-candidate-dependencies.json` records the reused production dependency versions; all non-workspace versions satisfy the checkout's declared ranges. The candidate's original dependency base image ID is in `http-candidate-base-image.txt`.

HTTP results are recorded in `results/http-upload-linux.json`. Its `behaviorStatus` and separate `performanceGate`, individual request samples, deployment order, database settings, images, build metadata, and limitations are authoritative.

## Controlled upload follow-up

The default-worker smoke cannot establish whether the observed 4.7% upload slowdown is a regression or background interference. `http-upload.py --controlled` therefore runs six alternating deployment pairs with 20 measured unique uploads per version per pair, after one warmup upload. It uses the same real authenticated HTTP, PostgreSQL durability, deduplication, and storage path, but sets `IMMICH_WORKERS_INCLUDE=api` equally for both builds. This prevents geodata import and media job execution from competing with timed uploads. Queues still receive jobs. This mode measures upload request completion, not media-ready throughput.

The original smoke keeps its own raw samples and an explicit `performanceGate.status=inconclusive`. The controlled follow-up uses a separate result file. `analyze-http.py` pairs each round's upstream/candidate upload medians and reports their log-ratio mean with an exploratory 95% interval from resampling whole paired blocks 10,000 times, seed 0. It does not treat 120 requests as 120 independent deployment experiments.

All 12 controlled deployments passed behavior checks, totaling 120 measured uploads and 72 measured preflight requests per version. Pooled upload medians were 38.67 ms upstream and 35.20 ms OpenFrame. Every deployment pair favored OpenFrame, by 4.4% to 11.4% in its upload median. The geometric mean of paired ratios gives 8.75% lower upload latency, with an exploratory block-bootstrap interval of 6.60% to 10.66% lower latency. See `results/http-upload-linux-controlled.json` for all request samples and paired analysis.

The default-mode positive upload difference disappears in this API-only comparison. This narrows further investigation to background processing, startup state, and their resource interactions; it does not prove the default-mode result was random noise. The default-worker performance gate remains inconclusive. Establishing default media-ready throughput needs a separate steady-state test that measures and controls background queue completion. WAN/mobile connectivity has not been measured.

A 5% slowdown budget scopes the exploratory classification to this controlled request path. This budget was chosen while the first controlled deployment pair was still running, before the run completed. It is not a user-approved release SLO or a preregistered experiment. An interval entirely above 5% records a measured-path regression; an interval whose upper bound is at most 5% records that a regression exceeding that budget was not detected. An interval crossing the budget remains inconclusive. Six paired blocks on one host cannot certify the whole application.

## Reproduce

Use the checkout's installed dependencies and Node 24 for compilation. No tests or timings need to run on the current PC. From the repository root:

```sh
NODE24=/home/yvm/.local/share/mise/installs/node/24.13.1/bin/node
(cd server && "$NODE24" node_modules/@nestjs/cli/bin/nest.js build)
"$NODE24" server/test/benchmarks/prepare-upload-check.mjs /tmp/openframe-bench-package
cp server/test/benchmarks/upload-check.mjs server/test/benchmarks/run-upload-check.sh /tmp/openframe-bench-package/
"$NODE24" server/test/benchmarks/prepare-http.mjs /tmp/openframe-bench-package
ssh yvm@192.168.1.9 'mkdir -p ~/openframe-bench-20261026'
rsync -a /tmp/openframe-bench-package/ yvm@192.168.1.9:openframe-bench-20261026/
ssh yvm@192.168.1.9 'cd ~/openframe-bench-20261026 && ./run-upload-check.sh --require-single-decode'
ssh yvm@192.168.1.9 'cd ~/openframe-bench-20261026 && ./run-http.sh'
ssh yvm@192.168.1.9 'cd ~/openframe-bench-20261026 && ./run-http.sh --controlled'
```

The Linux box already has the pinned upstream/PostgreSQL/Redis images and `immich-perf:local`. `run-http.sh` needs that existing candidate dependency/native-codec base; it does not silently replace it with upstream dependencies. On another host, supply an equivalent built current-fork production base using the Dockerfile's `BASE_IMAGE` build argument. Confirm production dependencies match the checkout before using a different base.

`run-upload-check.sh` writes `result.json`; save it under a new name between process runs. `run-http.sh` writes `http-upload-result.json` and server logs. Controlled mode writes `http-upload-controlled.json` and adds the paired analysis. Each mode then removes only its disposable Compose volumes. Copy raw results back into this directory. To regenerate the checked-in microbenchmark summary:

```sh
node server/test/benchmarks/summarize-upload-check.mjs
```

The older `bcrypt-local.json`, `media-local.json`, `person-linux-db.json`, deployment, and network artifacts were present before this work and remain unchanged. In particular, the older face benchmark ran a local client against remote PostgreSQL with durability disabled; it is not evidence for the current isolated HTTP comparison. The pre-existing edit to `server/test/medium/globalSetup.ts` was preserved.
