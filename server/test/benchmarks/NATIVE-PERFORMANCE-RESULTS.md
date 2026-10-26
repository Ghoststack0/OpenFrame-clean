# Native backend performance work

These are component measurements on the development host using Node 24.13.1, not an Ubuntu deployment benchmark or an end-to-end Immich speed claim. The requested 2–5x gain remains unmet. Shared-host noise, warmed filesystem caches and synthetic media limit what these results predict.

| Path               | Measurement                                                                                        | Integrity and tradeoff                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload file writes | 1.446x geometric mean of six paired 256 MiB writes; 25.9% less paired process CPU                  | SHA1 checked on input and reread stored file; `flush: true` retained. Write buffer grows from 64 KiB to 1 MiB per active write. One pair was slower.                               |
| Video transfers    | 1.65x ratio of median times; 24.5% less median process CPU                                         | Six alternating pairs, eight sequential 32 MiB loopback transfers each; warmup SHA256 and timed byte counts. Read buffer grows from 64 KiB to 256 KiB per active video.            |
| Image previews     | 1.106x geometric mean of six paired 12 MP JPEG-to-1440-preview runs; 10.5% less paired process CPU | Exact encoded SHA256 matches against original transform. Skips an unchanged-size RGB/RGBA transform, preserves grayscale expansion and linear-light resizing. One pair was slower. |

Raw results are in `results/upload-write-native.jsonl`, `results/image-preview-local.jsonl`, and `results/video-stream-node24-transfer.json`. Earlier video runs, including less favorable results, remain available and are described in `VIDEO-STREAM-RESULTS.md`. Process CPU includes client work in the HTTP experiment and is not energy consumption.

Reproduce from `server` after building with Node 24:

```sh
node test/benchmarks/upload-write.mjs
node test/benchmarks/image-preview.mjs
node test/benchmarks/video-stream.mjs test/benchmarks/results/video-stream-repeat.json
node test/benchmarks/video-slow-clients.mjs test/benchmarks/results/video-slow-clients-repeat.json
```

The upload benchmark calls the built repository and compares it with the original write-stream options. The image benchmark subclasses the built repository with the original transform and calls the public decode/thumbnail path. The transfer benchmark isolates the actual Express sendFile read-size choice. The slow-client check uses the built shared helper for the candidate; its process memory includes both server and clients and cannot establish a per-connection memory bound.

## Remaining bottlenecks and limits

A native runtime is available in `scripts/native`. An isolated Ubuntu deployment passed authenticated PostgreSQL/Redis and vector operations, normal API/worker startup, CPU ML, uploads, search, original/range/conditional downloads, video playback and a transactional backup restore. See `NATIVE-UBUNTU-VALIDATION.md`. This is not an existing-library migration rehearsal.

The three alternating full HTTP pairs on that same native stack measured the following. Each metric has 18 paired samples. Baseline reverts only the three optimizations; this does not compare Docker with native execution.

| HTTP metric                 | Baseline median | Candidate median | Paired geometric mean speedup | Slower candidate samples |
| --------------------------- | --------------- | ---------------- | ----------------------------- | ------------------------ |
| Photo upload response       | 283.26 ms       | 255.74 ms        | 1.096x                        | 5/18                     |
| Upload to available preview | 3366.15 ms      | 3380.86 ms       | 1.019x                        | 10/18                    |
| Video transfer              | 100.11 ms       | 75.39 ms         | 1.167x                        | 6/18                     |

All paired fixture hashes and encoded photo previews matched. Every run passed smart search, queue drain and zero failed jobs. Upload-to-preview timing excludes later ML completion. Warm caches, loopback networking, six synthetic photos and one compatible H.264 video limit these results. Readiness median slightly worsened despite the paired geometric mean improving. Raw warmup and timed samples, including unfavorable samples, are in `results/native-ubuntu-http.jsonl`; `results/native-ubuntu-http-summary.json` contains the analysis. The 2–5x end-to-end target remains unmet.

The repeat with source-built codecs used three new alternating pairs. It measured 1.283x for upload response, 1.069x for upload-to-preview readiness, and 1.567x for video transfer. Baseline/candidate medians were 278.20/229.29 ms, 3749.32/3552.37 ms, and 143.54/80.70 ms, respectively. Candidate was slower in 3, 4 and 5 of the 18 paired samples for those metrics. All paired preview bytes and fixture hashes matched; search, queue drain and zero failed jobs passed for every run. `results/native-ubuntu-http-source-pairs.jsonl` and `results/native-ubuntu-http-source-summary.json` retain this separate dataset. These results do not establish the 2–5x target.

Bundled Sharp cannot decode the representative HEVC HEIC or Canon CR2 fixtures on Ubuntu. HDR AVIF previews match the baseline using the same reduced native codec stack. A separate user-local source build now decodes all three samples. HEIC and HDR encoded previews exactly matched Docker at that checkpoint. A subsequent TIFF dependency fix removed the RAW pixel mismatch exactly; see the diagnosis and retained before/after metrics in `NATIVE-UBUNTU-VALIDATION.md`. Broader format coverage and migration remain release gates. Keep Docker installation, comparison and e2e assets until codec and migration tests pass.

The subsequent runtime integration restores TIFF decoding through jpegli, dedicated SVG/JPEG XL loaders and the upstream JPEG XL skcms backend. Its smoke checks are functional checks, not new paired performance measurements. A realistic concurrent end-to-end comparison remains to be run.

JPEG encoding/decoding, full-resolution linear-light processing and video transcoding still dominate relevant media workloads. Fusing decode and resize may change resampling/color behavior, so that requires separate quality evidence. Hardware transcoding is device-dependent. No lossy quality, bitrate, durability, security, concurrency, or global kernel defaults were changed to reach a target number.

ZIP export already uses stored entries for compressed media. Database backups use `gzip --rsyncable`; this work retains its output and restore compatibility. Upload read buffering also reaches backup writes through the shared storage repository. Test real uploads and backup/restore under concurrent load before migration.

## Validation on the development host

Node 24.13.1 production server build, TypeScript check, full server ESLint, changed-file formatting, and `git diff --check` passed. The full unit suite passed 110 files with 2,446 passed tests, one expected failure and two skipped tests. A later targeted run including new grayscale/RGB/RGBA inside/outside transform-equivalence cases passed 52 tests with one opt-in benchmark skipped.

The native CLI temporary-state self-check passed, including configuration mode 0600, overwrite refusal, native paths, admin dispatch and credential-file precedence. Direct doctor execution passed JPEG/PNG/WebP encode/decode and FFmpeg H.264 encode/probe, then correctly failed with `ECONNREFUSED` against loopback port 1. Those service checks subsequently passed on isolated Ubuntu; the full record and remaining codec gate are in `NATIVE-UBUNTU-VALIDATION.md`.

The first unrestricted full-suite attempt exhausted available memory and was restarted with `--maxWorkers 2`. A subsequent lint fix temporarily made the 1.4 MiB integrity assertion use Vitest deep equality, causing two repeat timeouts. The final test assigns the awaited read and uses `Buffer.equals`; the final targeted run passed without raising timeouts.
