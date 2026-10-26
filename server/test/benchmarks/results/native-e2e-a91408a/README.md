# Native end-to-end comparison — 2026-10-26

Candidate server source is `a91408a6b9047abcf98b3a13f3e765b29f5e5ced`: merged production `c6a0b91` plus the gate scripts. Subsequent gate commits change only measurement/resume/reporting code. Baseline is unmodified original Immich `256eb55dbe92ac77e02794442f9487e88ffed2b1`, built from a checksum-pinned upstream archive. Both use Node 24.13.1, identical locked dependencies, source codecs, normal workers, CPU ML and unchanged server policy. This compares server code on the same native platform, not Docker against native.

The accepted order is B0, C0, C1, B1, B2, C2. A completed B0 was reused after interruption. An incomplete C0 and a complete C1 that exceeded the predeclared host-noise limit remain in `interrupted/`; neither contributes to ratios. The noisy C1 recorded 129.53568199999967 unattributed CPU seconds of 1658.87 busy CPU seconds. The same limit was retained for its replacement.

The corpus is 18 distinct natural-photo-derived JPEGs (nine 12 MP, nine upscaled 24 MP), one HEIC and one Canon CR2. Grid setup uses 200 distinct crops; video is a synthetic six-second 4K H.264 clip. These fixtures cover formats and dimensions, not broad photographic diversity. HTTP cold means no validators/full responses; filesystem caches were not dropped. Requests use loopback HTTP/1.1 and six keep-alive connections for the grid.

Batch ML time ends when every normal queue drains after derivatives are ready, before integrity downloads. It includes downstream jobs and one-second polling. Readiness polling is every 250 ms. Resource totals include warmup, untimed grid creation/uploads, integrity downloads and queue drain; they exclude fixture generation and backend startup. Backend CPU is exact cgroup accounting including exited children. Ancillary CPU is a sampled lower bound. RSS is aggregate process RSS sampled every 100 ms; shared pages count per process and brief peaks may be missed.

The default image policy is P3. The merged SDR JPEG fusion requires sRGB and therefore is ineligible here. No color policy, image quality, concurrency, durability or authentication setting was changed to activate optimizations.

Full-precision raw data and summary accompany this report. `fixture-manifest.json.gz` preserves the exact fixture manifest (including source metadata), compressed without modification; its SHA256 is recorded in every artifact manifest. Binary renditions remain under `~/openframe-native-validation-20261026/gate-pairs-a91408a` on the Ubuntu host; the analyzer checks their actual bytes before producing the summary. Credentials, tokens and private server logs are excluded.

Reproduction and measurement definitions: [GATE.md](../../native-ubuntu/GATE.md). Exact series command on the Ubuntu host, with its prebuilt frozen source manifests:

```sh
cd ~/openframe-native-validation-20261026
python3 app/server/test/benchmarks/native-ubuntu/gate.py \
  --build "$PWD/app/server/gate-build-a91408a" \
  --output "$PWD/gate-pairs-a91408a" --pairs 3 --resume
python3 app/server/test/benchmarks/native-ubuntu/analyze-gate.py "$PWD/gate-pairs-a91408a"
```

Use a fresh output directory without `--resume` for a new series. The command above resumes only the recorded series and verifies source/client hashes.

## Accepted results

All six accepted runs passed the unchanged host-idle gate, original SHA256 checks, smart search and queue drain with zero failed jobs. All 969 paired rendition comparisons (323 per pair) were byte-identical, with matching dimensions and fixture/configuration hashes.

Ratios are paired geometric means, not ratios of medians. Above 1 favors the candidate; below 1 favors baseline. Displayed values are truncated, never rounded up; JSON retains full precision. Slower counts include every unfavorable accepted pair.

| Metric | Baseline median | Candidate median | Pair 0 / 1 / 2 ratios | Geometric mean | Slower pairs |
|---|---:|---:|---|---:|---:|
| batch-c1.uploadWallMs | 36179.796 | 17984.183 | 2.179 / 1.868 / 2.072 | 2.035× | 0/3 |
| batch-c1.allReadyMs | 98050.478 | 85490.107 | 0.994 / 1.146 / 1.140 | 1.091× | 1/3 |
| batch-c1.mlDoneMs | 106317.893 | 98790.148 | 1.025 / 1.123 / 1.050 | 1.065× | 0/3 |
| batch-c4.uploadWallMs | 11349.894 | 4505.463 | 2.519 / 2.656 / 1.681 | 2.240× | 0/3 |
| batch-c4.allReadyMs | 95135.450 | 83636.688 | 1.056 / 1.289 / 1.067 | 1.133× | 0/3 |
| batch-c4.mlDoneMs | 108451.888 | 97883.509 | 1.027 / 1.191 / 1.079 | 1.097× | 0/3 |
| batch-c8.uploadWallMs | 7979.277 | 3376.174 | 1.237 / 1.823 / 2.413 | 1.759× | 0/3 |
| batch-c8.allReadyMs | 98753.335 | 87356.859 | 1.114 / 1.104 / 1.156 | 1.125× | 0/3 |
| batch-c8.mlDoneMs | 107801.692 | 103325.990 | 1.039 / 1.051 / 1.043 | 1.044× | 0/3 |
| single.previewReadyMs | 2296.918 | 1977.887 | 1.089 / 1.161 / 1.296 | 1.179× | 0/3 |
| single.uploadMs | 49.907 | 52.360 | 0.360 / 1.010 / 1.240 | 0.767× | 1/3 |
| grid-cold.requestsPerSecond | 121.906 | 141.704 | 1.153 / 1.140 / 1.182 | 1.158× | 0/3 |
| grid-cold.p95Ms | 100.275 | 99.740 | 1.101 / 1.205 / 0.959 | 1.084× | 1/3 |
| grid-cold.wallMs | 1640.607 | 1411.385 | 1.153 / 1.140 / 1.182 | 1.158× | 0/3 |
| grid-warm.requestsPerSecond | 176.566 | 196.426 | 1.195 / 1.106 / 1.081 | 1.126× | 0/3 |
| grid-warm.p95Ms | 43.705 | 42.338 | 1.202 / 1.032 / 0.897 | 1.036× | 1/3 |
| grid-warm.wallMs | 1132.716 | 1018.193 | 1.195 / 1.106 / 1.081 | 1.126× | 0/3 |
| video-4k.previewReadyMs | 2622.451 | 2361.015 | 1.061 / 1.200 / 1.087 | 1.114× | 0/3 |
| video-4k.thumbnailReadyMs | 2614.620 | 2379.744 | 1.059 / 1.199 / 1.081 | 1.111× | 0/3 |
| video-4k.allReadyMs | 2622.451 | 2379.744 | 1.059 / 1.200 / 1.084 | 1.113× | 0/3 |
| video-seek.medianTtfbMs | 7.491 | 5.926 | 1.197 / 1.266 / 1.240 | 1.234× | 0/3 |
| video-seek.p95TtfbMs | 17.434 | 14.191 | 1.102 / 1.701 / 1.089 | 1.269× | 0/3 |
| video-transfer.medianMiBPerSecond | 72.937 | 96.650 | 1.416 / 1.258 / 1.537 | 1.399× | 0/3 |

Time metrics use milliseconds; grid throughput uses requests/second; video transfer uses MiB/second. Each video-seek p95 is based on 16 samples; each transfer aggregate is the median of three transfers.

| Individual video samples | Paired samples | Geometric mean | Slower candidate samples |
|---|---:|---:|---:|
| seek.ttfbMs | 48 | 1.196× | 5 |
| transfer.mibPerSecond | 9 | 1.423× | 1 |

## Resources

| Run | Backend CPU seconds | Ancillary CPU seconds, lower bound | Stack CPU seconds, lower bound | Backend peak RSS MiB | Stack peak RSS MiB | Unattributed host CPU upper bound |
|---|---:|---:|---:|---:|---:|---:|
| baseline-r0 | 432.946 | 1071.090 | 1504.036 | 1795.160 | 3675.019 | 25.316 |
| candidate-r0 | 374.508 | 1081.460 | 1455.968 | 1849.949 | 3881.675 | 25.654 |
| candidate-r1 | 365.103 | 1073.180 | 1438.283 | 1670.375 | 3704.242 | 25.217 |
| baseline-r1 | 442.057 | 1077.120 | 1519.177 | 1711.824 | 3757.066 | 27.400 |
| baseline-r2 | 447.189 | 1084.280 | 1531.469 | 1595.921 | 3593.214 | 26.675 |
| candidate-r2 | 380.415 | 1082.690 | 1463.105 | 1800.273 | 3883.386 | 31.689 |

| Resource reduction ratio | Pair 0 / 1 / 2 | Geometric mean | Worse candidate pairs |
|---|---|---:|---:|
| resources.backendCpuSeconds | 1.156 / 1.210 / 1.175 | 1.180× | 0/3 |
| resources.peakRssBytes | 0.970 / 1.024 / 0.886 | 0.958× | 2/3 |
| resources.peakStackRssBytes | 0.946 / 1.014 / 0.925 | 0.961× | 2/3 |
| resources.ancillaryCpuSecondsLowerBound | 0.990 / 1.003 / 1.001 | 0.998× | 1/3 |
| resources.stackCpuSecondsLowerBound | 1.033 / 1.056 / 1.046 | 1.045× | 0/3 |

The upload-response gains do not carry through to the whole workflow: batch derivative readiness improved 1.091–1.133× and queue-drain completion 1.044–1.097×. Backend CPU improved 1.180×, but stack CPU improved only 1.045× and peak RSS was worse in two pairs. This series does not meet a 2–5× end-to-end target.

## Validation and remaining limits

The final analyzer read and hashed all retained binary rendition files on Ubuntu. Its self-check passed exact-byte acceptance/rejection and pairing math. Python compilation, Node syntax checking and `git diff --check` passed. No production code changed in these gate commits; the parent previously reported 2493 unit tests, TypeScript and ESLint passing for the merged production source. That full suite was not rerun for these scripts.

After the series there were no `openframe-gate-*` services or API listener on 2287. PostgreSQL 25432, Redis 26379 and ML 3003 remained listening on loopback. No Docker baseline directory, global filesystem cache, network qdisc or existing application was changed.

Caddy/HTTP2 and added-latency testing were skipped. Loopback HTTP/1.1 results do not establish WAN/HTTP2 performance. Three pairs on one low-power host and a limited fixture corpus do not establish broad hardware or photographic performance. The benchmark retains growing disposable library state between runs; alternating order reduces but cannot eliminate ordering effects.
