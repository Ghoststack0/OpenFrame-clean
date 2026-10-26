# Native end-to-end performance gate

This gate operates only on `~/openframe-native-validation-20261026` on the Ubuntu host. It creates disposable users and assets in that isolated database. PostgreSQL, authenticated Redis and CPU ML must already be running there, with the native source codec installation selected in its private `env`. The normal API must be stopped. Do not point these scripts at a production installation.

The historical `run-pairs.py` and `analyze.py` retain the old three-change comparison. They are not the final baseline. `build_gate.py` downloads and checksum-verifies original Immich commit `256eb55dbe92ac77e02794442f9487e88ffed2b1`, then builds its unmodified server source and the committed candidate source. The lockfile, server package, Helmet configuration, plugin SDK source and ML source must match the upstream dependency/runtime inputs. Both variants use the same locked dependencies, native codecs, database, normal workers and CPU ML. This measures total server-code gain over original Immich on the same native platform, not a Docker-to-native gain.

## Build and stage

On the development machine, use Node 24, the checkout's installed pinned dependencies and an absolute new output directory:

```sh
export PATH=/home/yvm/.local/share/mise/installs/node/24.13.1/bin:$PATH
python3 server/test/benchmarks/native-ubuntu/build_gate.py /absolute/path/gate-build
```

Commit production changes first. Uncommitted benchmark scripts are allowed. `--archive /path/upstream.tar.gz` reuses the same checksum-pinned archive. Source trees and build logs remain in the output directory. No source text replacements or optimization reverts are used to manufacture the baseline. The generated build manifests record source commits, source/dist hashes, archive checksum, lock checksum and Node version.

Create a new build directory under the isolated `app/server` directory and copy both dist trees and their shared runtime files there. For example:

```sh
ssh yvm@192.168.1.9 'mkdir -p ~/openframe-native-validation-20261026/app/server/gate-build'
rsync -a /absolute/path/gate-build/dist-baseline /absolute/path/gate-build/dist-candidate \
  /absolute/path/gate-build/package.json /absolute/path/gate-build/helmet.json \
  yvm@192.168.1.9:openframe-native-validation-20261026/app/server/gate-build/
```

Copy `native-gate.mjs` to the isolated `app/server/test/benchmarks` directory. Copy `gate.py`, `build_gate.py` and `analyze-gate.py` to its `native-ubuntu` subdirectory. Keep `build_gate.py` beside `gate.py`, which imports its dist-hash function. The Node scripts resolve Sharp through the existing production codec preload.

On Ubuntu, prepare immutable fixtures once, outside all timed runs:

```sh
cd ~/openframe-native-validation-20261026
source ./run-env
set -a; source ./env; set +a
export LD_LIBRARY_PATH="$OPENFRAME_CODECS/prefix/lib:$OPENFRAME_CODECS/sysroot/usr/lib/x86_64-linux-gnu"
export NODE_OPTIONS="--require $PWD/app/scripts/native/codecs.cjs"
node app/server/test/benchmarks/native-gate.mjs prepare "$PWD"
```

Preparation fetches checksum-pinned public samples from `immich-app/test-assets` commit `ec56cc6c1d76c45bc9615dc6ea232470a2b0a3a1`. The 20-photo batch contains nine 4000×3000 JPEGs, nine 6000×4000 JPEGs, one original HEIC and one original Canon CR2. The JPEGs are distinct crops of one natural-photo fixture; the 24 MP versions are upscaled, not native 24 MP camera captures. The grid uses 200 distinct 800×600 crops. The six-second 3840×2160 H.264 test clip is synthetic. Source hashes, dimensions and encoded fixture hashes are retained in `gate-fixtures/manifest.json`. This is a reproducible format/resolution workload, not a diverse photography corpus. Existing fixture files are verified before reuse.

## Run once or measure pairs

A candidate-only dry run exercises every case and reports no speedup:

```sh
python3 app/server/test/benchmarks/native-ubuntu/gate.py \
  --build "$PWD/app/server/gate-build" \
  --output "$PWD/gate-dry-run" --dry-run
python3 app/server/test/benchmarks/native-ubuntu/analyze-gate.py "$PWD/gate-dry-run"
```

After integrating and staging the final candidate, use a new output directory for the actual series:

```sh
python3 app/server/test/benchmarks/native-ubuntu/gate.py \
  --build "$PWD/app/server/gate-build" \
  --output "$PWD/gate-pairs" --pairs 3
python3 app/server/test/benchmarks/native-ubuntu/analyze-gate.py "$PWD/gate-pairs"
```

Order alternates baseline/candidate, candidate/baseline, baseline/candidate. There is no default series mode: specify either `--dry-run` or `--pairs`. The runner refuses existing output directories without explicit `--resume`, listening APIs, old/mismatched build provenance, overlapping gate/codec operations and hosts above 10% non-idle CPU during a three-second preflight. It starts each variant in a new transient user systemd service, waits for both worker startup and the API ping, and stops that service in `finally`. No global cache drop, privileged operation, durability change, quality change or worker concurrency change is performed. This requires the existing user systemd session and delegated cgroup v2 accounting.

Warmup uploads one image, checks actual smart search and drains normal queues. Each batch scenario gets a fresh user, so an identical fixture in another scenario cannot turn into a duplicate upload. Queues drain between scenarios, with zero failed jobs required. Grid setup is untimed. Existing database/media state is retained between runs; each run adds 263 assets. Alternating order reduces ordering bias but does not replace a populated-library or WAN trial.

## Recorded metrics and integrity

- A batch of 20 mixed photos at client concurrency 1, 4 and 8. Upload wall time ends at the final successful upload response. All-ready time ends when both preview and thumbnail responses are available for every asset. Readiness polling runs at 250 ms with at most six control connections, alongside the requested number of upload connections. A separate `mlDoneMs` records time from the same batch start until all normal queues drain after every derivative is available, before integrity downloads or artifact writes. This is a conservative ML-completion measurement that includes downstream jobs, with one-second queue polling.
- A single 12 MP JPEG's upload response and upload-to-preview time.
- 200 distinct thumbnails over exactly six HTTP/1.1 keep-alive connections. Cold means 200 full responses without validators; warm means the same requests with their ETags, requiring 200 empty 304 responses. Requests/second, per-request p95 and total wall time are recorded. Filesystem caches remain warm/unspecified; this is not a global disk-cache-cold test.
- Sixteen deterministic pseudorandom 64 KiB video range seeks, with offsets, body time-to-first-byte and response duration. Every range and Content-Range is checked. Three full playback transfers record throughput and exact hashes. The compatible H.264 clip must retain original playback bytes under the unchanged server policy.
- Upload-to-preview, upload-to-thumbnail and all-ready times for the 4K video.

Every original download is checked against the fixture's SHA256, including all 200 grid originals. The run retains 323 actual preview/thumbnail files and their hashes. Analysis rejects missing cases, incomplete pairs, different fixture manifests, different server policies, changed dimensions, modified artifact files, range differences and missing integrity/search/queue checks.

Parity requires identical rendition bytes for all 323 artifacts. There is no perceptual acceptance option. Per-fixture baseline/candidate hashes are retained in `summary.json`; a single changed preview or thumbnail fails the gate. The rejected perceptual shortcut is not part of the candidate.

The RSS sampler reads only the backend cgroup PIDs and known ML/PostgreSQL/Redis descendants, not every host process. Backend CPU seconds come from exact cgroup accounting, including exited FFmpeg/ExifTool children. Peak RSS is aggregate process RSS sampled every 100 ms; shared pages count once per process, and brief peaks can be missed. A separate stack RSS peak adds existing ML, PostgreSQL and Redis descendants. Ancillary CPU is a sampled lower bound. Exact cgroup memory peak, which includes file cache and startup, is reported separately. These resource totals include warmup, untimed grid setup, verification and queue drain; they are not CPU totals for only the timed HTTP intervals. Client and sampler CPU are reported separately. An upper bound on unattributed host CPU must stay below max(5 CPU seconds, 5% of host busy CPU), or the run fails with its evidence retained.

The analyzer reports each metric independently, with paired geometric mean speedup and unfavorable pair counts. It also reports the individual paired video samples, including slower-sample counts across 48 seeks and nine transfers in a three-pair series. Backend CPU is shown separately from the sampled ancillary/total stack CPU lower bounds. It does not invent an overall speedup or a 2–5x success claim. Raw JSONL samples, build manifests, per-run resource records and rendition files remain available for review. Server logs and credentials stay private in the isolated directory.

## Checks

```sh
python3 app/server/test/benchmarks/native-ubuntu/analyze-gate.py --self-test
```

The self-check exercises pairing math, exact-byte acceptance and rejection of every changed rendition. The recorded candidate dry run verifies real uploads, derivatives, all six keep-alive connections, ETag/304, seeks, full transfers, ML, queue drain and resource accounting. It is not a paired performance comparison.

## Current integrated comparison

The candidate is merged server commit `c6a0b91` plus the gate commit. The original upstream source baseline excludes every OpenFrame optimization, including the newly merged upload, media and serving changes. No tracing preload is enabled for release timing. The production source-codec preload is shared by both variants.

The unchanged default image policy is P3. The integrated SDR JPEG fusion requires `colorspace=srgb`, so it is ineligible under this policy. The gate does not switch color policy to activate an optimization. Candidate/baseline system configuration hashes must match. The successful earlier candidate-only dry run was a functional check; its high full-host sampler overhead makes its timings unsuitable as the integrated comparison.

## Resume after an interruption

First stop any old gate runner and its backend services, leaving PostgreSQL, Redis and ML running. Repeat the original command with `--resume`. The build manifests and frozen client must match. Complete runs are checked for all cases, checksums, resources and parity before reuse. Incomplete or failed attempts move into an `interrupted` subdirectory and remain available for review. The series records resume timestamps and runner hashes. Paired ratios use complete runs only; interrupted attempts are never silently merged into a timed run. Pending work from an interrupted attempt drains before accounting for the next run begins.

Rejected host-noise attempts are retained and rerun under the same idle threshold. Start/end cgroup CPU snapshots provide diagnostic attribution for host activity; they are not summed across the hierarchy because parent groups include child usage.

## Recorded three-pair result

The completed integrated series, exact source/build manifests, accepted and excluded raw runs, per-metric paired ratios and CPU/RSS measurements are in [native-e2e-a91408a](../results/native-e2e-a91408a/README.md). All 969 paired rendition comparisons passed exact bytes. The measured whole-workflow improvement did not meet the 2–5× target. Caddy/HTTP2 and added-latency testing were skipped.
