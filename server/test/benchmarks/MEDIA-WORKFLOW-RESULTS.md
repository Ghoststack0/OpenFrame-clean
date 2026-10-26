# Media workflow measurements

The requested 4–5× improvement remains unmet. These local media-job measurements show 1.09× for a real 12.7 MP JPEG, 1.22× for a real 24 MP JPEG, 1.25× for a mixed batch of 20 photos, and 1.23× for video thumbnails plus thumbhash. They do not measure upload HTTP latency, queue delay, database I/O, ML completion, energy, Docker versus native execution, or the remote Ubuntu host.

## Changes and quality gate

Video preview and thumbnail generation use one FFmpeg input with two independent outputs. Each output retains its existing frame-selection, scaling, tonemapping and encoding options. Automatic stream selection remains unchanged. Sharing a filter graph was rejected because selecting a graph input could change which stream FFmpeg chooses in multi-stream files. Video transcoding policy and compatible-original playback do not change.

For unprofiled, baseline, three-channel, 8-bit sRGB JPEG files, decode and the existing linear-light resize share a Sharp pipeline. This removes the full-resolution RGB buffer between them. It retains linear-light sampling and does **not** enable JPEG shrink-on-load. The decoded preview still supplies the preview encoder, thumbnail and thumbhash. Set `IMMICH_SRGB_JPEG_LINEAR_FUSION=false` in the worker environment and restart the worker to disable this path.

Embedded ICC profiles, P3 output, gain maps, XMP, progressive JPEGs, grayscale, CMYK, non-JPEGs, buffer inputs and full-resolution decoding retain the existing path. Edited fullsize processing already requests full-resolution decoding, so it also retains that path. No quality, subsampling, fullsize, FFmpeg thread or job-concurrency setting changes.

Direct JPEG preload and a 2× intermediate preload are benchmark-only experiments. Neither ships in the repository. Both fail the requested SSIM ≥ 0.99 and PSNR ≥ 40 dB gate against encoded workflow outputs, including the 250-pixel preview check. The actual implementation passes all 50 output comparisons with identical encoded bytes, dimensions, orientation, ICC tags, alpha and thumbhashes. The tests include real 12.7/24 MP photos, EXIF rotation, P3, grayscale, CMYK, alpha, crop plus rotation edits, a gain-map JPEG, XMP and fine text/fabric.

The following table gives the worst SSIM and PSNR across preview and thumbnail outputs at preview sizes 1440 and 250. Exact equality is SSIM 1 and infinite PSNR. Rows marked “existing path” do not demonstrate accelerated processing.

| Fixture | Direct preload SSIM / dB | 2× preload SSIM / dB | Implemented path SSIM / dB |
| --- | --- | --- | --- |
| Real 12.7 MP Lumix | 0.942662 / 27.43 | 0.975508 / 32.22 | 1 / infinite |
| Real 24 MP Sony | 0.977307 / 37.73 | 0.979876 / 38.94 | 1 / infinite |
| Rotated Lumix | 0.945034 / 27.56 | 0.975276 / 32.34 | 1 / infinite |
| Display-P3 derivative | 0.942644 / 27.45 | 0.973407 / 32.12 | 1 / infinite, existing path |
| Grayscale | 1 / infinite, existing path | 1 / infinite, existing path | 1 / infinite, existing path |
| CMYK | 1 / infinite, existing path | 1 / infinite, existing path | 1 / infinite, existing path |
| P3 with alpha | 1 / infinite, existing path | 1 / infinite, existing path | 1 / infinite, existing path |
| Crop plus rotation edit | 0.942662 / 27.43 | 0.975508 / 32.22 | 1 / infinite; edited fullsize uses existing path |
| Fine text and 8-pixel fabric pattern | 0.657918 / 16.83 | 0.659436 / 16.85 | 1 / infinite |
| Nikon JPEG with XMP | 1 / infinite, existing path | 1 / infinite, existing path | 1 / infinite, existing path |
| Gain-map JPEG | 1 / infinite, existing path | 1 / infinite, existing path | 1 / infinite, existing path |

The text/fabric comparison visibly darkens the fabric and changes fine-text edges under direct preload. At the normal 1440 preview setting it reaches only 19.18 dB, SSIM 0.946498. The 2× intermediate still fails at 21.70 dB, SSIM 0.967052. The 250-pixel check is worse. JPEG DCT reduction and gamma-space resampling do not preserve the existing linear-light average. A dimensions-only DCT-factor selector cannot identify this content failure; falling back from direct to 2× does not satisfy the gate. The implementation retains linear sampling instead.

The initial favorable Nikon diagnostic compared pre-encode pixels on a different photograph. It did not establish the required output-level quality gate across previews and WebP thumbnails.

## Single-image stage profile

`media-workflow.mjs` invokes the real `MediaService.handleGenerateThumbnails`, repository, Sharp, FFmpeg and filesystem. Database repository methods and config use in-memory stubs. Actual DB time is **not measured**. Each unedited photo makes one asset-job lookup, one file upsert and one thumbhash update; their stub execution totals less than 0.1 ms for a single image. The parent must measure real database and queue time on the integrated stack.

The table reports medians of three fresh-process samples, in milliseconds. Preview/thumbnail encoding is total generation time minus its resize time. These are elapsed stage times, including scheduling; output operations run concurrently, so the columns must not be added to estimate total job time. Thumbhash includes its own 100-pixel resize and alpha conversion. Fused decode/resize is one native operation and cannot be split by the JavaScript timer.

| Photo and version | Decode | Initial linear resize | Fused decode + resize | Preview encode | Thumbnail resize | Thumbnail encode | Thumbhash | Whole job |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12.7 MP baseline | 123.53 | 184.22 | n/a | 57.18 | 49.33 | 11.49 | 48.15 | 371.19 |
| 12.7 MP candidate | n/a | n/a | 277.72 | 56.16 | 45.62 | 12.59 | 44.23 | 339.17 |
| 24 MP baseline | 195.35 | 354.06 | n/a | 62.50 | 31.38 | 16.02 | 47.88 | 608.58 |
| 24 MP candidate | n/a | n/a | 434.26 | 58.30 | 50.63 | 11.23 | 37.88 | 497.76 |

Full-resolution decode and linear resize dominate. Encoders and thumbhash do not account for enough time to deliver 4–5× by optimizing them alone.

The rejected variants' whole-job timings show the quality/speed tradeoff. These timings use the same three alternating rounds as the candidate.

| Photo | Baseline median | Candidate median | Direct preload median, rejected | 2× preload median, rejected |
| --- | ---: | ---: | ---: | ---: |
| 12.7 MP | 371.19 ms | 339.17 ms | 171.03 ms | 410.15 ms |
| 24 MP | 608.58 ms | 497.76 ms | 201.48 ms | 475.43 ms |

## Batch, video and memory

Node 24.13.1 and Sharp/libvips 8.18.7 ran on an Intel i5-13420H under `taskset -c 0,2`, two distinct physical cores. The remote Ubuntu machine was untouched. All samples ran serially with no concurrent compiler or other benchmark from this task. OS caches were warm; unrelated host activity was not controlled. Each sample starts a fresh Node process. The batch repeats each of the two real photos ten times with the normal thumbnail concurrency of three. It is not a diverse 20-photo library.

| Workflow | Baseline median | Candidate median | Paired geometric mean speedup | Slower candidate samples |
| --- | ---: | ---: | ---: | ---: |
| 12.7 MP photo | 371.19 ms | 339.17 ms | 1.090× | 0/3 |
| 24 MP photo | 608.58 ms | 497.76 ms | 1.219× | 0/3 |
| Mixed batch of 20 | 6173.25 ms, 3.24 images/s | 4901.33 ms, 4.08 images/s | 1.252× | 0/3 |
| 8-second synthetic 4K H.264 video, thumbnails + thumbhash | 1824.86 ms | 1477.16 ms | 1.231× | 0/3 |

Photo batch process CPU falls from a median 12.058 to 9.647 seconds, about 20%. This includes native Sharp threads and excludes process startup. Video CPU must include FFmpeg children: whole-process CPU, including imports and metadata preparation, is 4.394 versus 4.230 seconds. This measurement includes substantial fixed startup work and is not a clean video CPU-stage comparison. Node-only CPU is not a video CPU result.

Median sampled Node peak RSS for the photo batch rises from 714.4 to 764.8 MiB. Per-process high-water RSS including startup rises from 721.6 to 767.2 MiB. The 24 MP single-image sampled RSS falls from 438.3 to 401.3 MiB; 12 MP is about 399–400 MiB. Do not claim a general memory improvement. The parent must check peak memory with normal workers and ML on Ubuntu before accepting the default path. RSS is not an aggregate of concurrently running Node and FFmpeg processes and does not prove a memory bound.

Sharp already selects one vips thread with this glibc allocator. On two available cores, three jobs × one vips thread already reaches three native workers before each job's parallel output pipelines. A separate three-pair test comparing default one thread with two threads has medians of 5035.21 and 5136.08 ms per batch. One two-thread sample is faster and two are slower. Two threads use median 10.071 versus 9.653 CPU seconds and 862.4 versus 788.4 MiB sampled Node RSS. There is no consistent throughput benefit from changing the cap. `sharp.concurrency` is process-global, so changing it per job would also race other jobs. Production thread settings remain unchanged.

## Reproduction and integration

Run from `server` with Node 24. Build the workspace SDKs before the server if this is a fresh isolated installation. Use the pinned Jellyfin FFmpeg/ffprobe binaries from `mise.lock`; stock FFmpeg does not provide `tonemapx` for the HDR test.

```sh
export PATH=/home/yvm/.local/share/mise/installs/node/24.13.1/bin:$PATH
export MEDIA_FFMPEG_PATH=/path/to/pinned/ffmpeg
export MEDIA_FFPROBE_PATH=/path/to/pinned/ffprobe
corepack pnpm --config.verify-deps-before-run=false build
corepack pnpm --config.verify-deps-before-run=false test run \
  src/repositories/media.repository.spec.ts \
  src/repositories/media.repository.video.spec.ts \
  src/services/media.service.spec.ts --maxWorkers 1
node test/benchmarks/media-workflow.mjs quality quality.json lumix12.jpg sony24.jpg nikon24.jpg /path/to/gain-map.jpg
taskset -c 0,2 python3 test/benchmarks/media-workflow-pairs.py pairs.json lumix12.jpg sony24.jpg 4k.mp4
```

The fixture URLs, hashes and exact video generation arguments are in `results/media-workflow-local-fixtures.json`. The [Lumix](https://www.photographyblog.com/reviews/panasonic_lumix_dmc_lx100_review), [Sony](https://www.photographyblog.com/reviews/sony_a6000_review) and [Nikon](https://www.photographyblog.com/reviews/nikon_d600_review) files are original camera samples from their reviewers. Originals and private photographs are not committed. The quality script generates its rotated, P3, alpha, grayscale, CMYK, edit and high-frequency derivatives. Supplying the original Nikon file additionally verifies the conservative XMP fallback.

`results/media-workflow-local-pairs.json` retains all 42 timing rows, stage counters, CPU/RSS observations and output hashes. `results/media-workflow-local-quality.json` retains all 150 quality rows, including every failure of the experimental preloads. Timings in the quality dataset are diagnostic and baseline-first; use the alternating-pair dataset for timing comparisons. Python `wait4` records each sample's CPU including waited FFmpeg descendants and its per-process RSS high-water mark.

The parent can cherry-pick the video commit followed by the SDR fusion/evidence commit. The new `transcodeThumbnails` repository method replaces only the two thumbnail calls in `MediaService.generateVideoThumbnails`; the repository mock changes with it. No global types, auth, storage writer, download helper, UI, native scripts, quality settings or codec selection change. Conflicts should be limited to the assigned media repository/service tests and their mock.

For endpoint proof, compare the integrated build against a baseline that reverts **these media changes as well as any other optimizations under comparison**. The earlier baseline generator only reverted upload buffering, video read buffering and the unchanged-size transform skip; using it unchanged would leave these new changes in both variants. Use the same source-built codecs, machine, normal workers, ML and concurrency in alternating runs. Preserve original hashes, authorization, ranges/conditional responses, all preview quality gates and queue drain/failed-job checks. Measure upload-to-preview and video-ready latency, real DB/queue stages, process-tree CPU and peak memory. The local media-job ratios do not establish those endpoint gains or resolve the existing RAW codec parity blocker.

## Validation

The assigned media tests pass 236 tests across three files, including seven real FFmpeg equivalence/failure tests. Production server build, TypeScript, changed-file ESLint and formatting, Python syntax checking, and `git diff --check` pass. The full server suite was not repeated. No UI source, parent dependencies/build outputs or remote deployment files were changed.
