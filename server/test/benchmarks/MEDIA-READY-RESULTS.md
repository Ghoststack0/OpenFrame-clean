# Default-worker benchmark handoff

All 12 deployments passed. The fixed run completed six alternating pairs, with 20 measured uploads per deployment. Each build completed 120 measured uploads, 72 measured preflight requests, and six media-ready warmups. No samples were added after results.

| Metric | Upstream pooled median | Candidate pooled median | Paired geometric mean change | Exploratory 95% block interval |
| --- | ---: | ---: | ---: | ---: |
| HTTP completion | 43.87 ms | 39.18 ms | -16.27% | -31.58% to -2.14% |
| Thumbnail and preview ready | 335.83 ms | 305.48 ms | -15.57% | -31.60% to -0.38% |

Positive change means candidate slower. The paired estimate compares deployment medians and differs from the pooled median ratio.

Both measured paths meet the predeclared 5% budget. Separately, both intervals lie entirely below the requested strict 0% reference. This is exploratory evidence of lower latency in this experiment. It does not prove that every workload or deployment avoids slowdown. Pair 4 favored upstream on both metrics. Two upstream deployments were much slower than the others, so shared-host variation affects the effect estimate. The media-ready upper bound is close to zero, and 50 ms readiness polling limits interpretation of small differences.

Each deployment used fresh disposable volumes, default API and microservices workers, and normal PostgreSQL durability. Only ML was disabled. Geodata import and one complete media warmup finished before measurement. Media-ready means successful authenticated thumbnail and preview image responses. It does not mean completion of every background queue.

No reproducible regression was detected in either metric, so no backend implementation fix was made. The original smoke remains inconclusive. The API-only result retains its narrower scope.

## Tested identity

- Source tree SHA256: `739ff34582320d749c7ecb7411a098718bbfbc836d30e096bd32c819e7a4e926`.
- Compiled tree SHA256: `9514b598569a8d3e9ddbdd7442ee5431ce6484272b6ea96c14a2d774e3fbceb2`.
- Upstream v3.3.5 image: `sha256:fb31598c03fbb3d68f6409548ab7b18148ee651bf7d6b40e1d907308edbf0dc2`.
- Candidate image: `sha256:0bb71185d49546fd049b5c6d33d3c08184ba7385bd4d4adb02229580f5689a27`.

The candidate metadata retains its original pre-integration HEAD and patch. Parent reports branding/docs HEAD `06844a915` with backend source unchanged. This experiment reused the already verified compiled candidate. It did not relabel the artifact as a new build.

## Artifacts and verification

`results/http-upload-media-ready.raw.json` preserves the completed run before analysis. `results/http-upload-media-ready.json` adds paired analysis, both reference interpretations, pooled media-ready medians, and mode-specific limitations. `results/media-ready-evidence.tar.gz` contains all 12 deployment logs, runner log, protocol, scripts, configuration, hashes, candidate build metadata, and shared-host observations.

The initial `media-ready-harness.sha256` predates metadata and strict-reference additions to the analyzer. `media-ready-final.sha256` records the final analysis script. The measured `http-upload.py` hash is unchanged.

Remote checks passed: Python compilation, analyzer assertions for known slowdown and unchanged samples under both references, real upload behavior assertions, matched paired sample indices and sizes, default-worker configuration, database durability, and shell syntax. Behavior checks cover original byte equality, unauthorized access, ranges, ETag caching, duplicate identity, ordered mixed-encoding preflight responses, and thumbnail/preview readability. Cleanup verification found no disposable benchmark containers or volumes. Existing installations and prior evidence were preserved.

The parent previously verified 2441 server tests and other builds. Those were not rerun for benchmark-only changes. No native rebuild, dependency installation, push, or PR was performed. The pre-existing `server/test/medium/globalSetup.ts` edit was preserved.

Reproduce using [MEDIA-READY-PROTOCOL.md](MEDIA-READY-PROTOCOL.md). All execution ran over SSH on `yvm@192.168.1.9`. Persistent scripts and evidence remain in `/home/yvm/openframe-bench-20261026`. Archive this mode's files before rerunning.

Limits: one shared two-core host, six deployment pairs, sequential synthetic PNGs, no concurrent backlog, no video, no ML, no populated library, and no WAN/TLS/mobile path. Readiness polling includes HTTP observer cost. The candidate reuses recorded production dependencies and native codecs with freshly compiled server code. It is not a fresh release image. The exploratory bootstrap interval cannot certify the whole application.
