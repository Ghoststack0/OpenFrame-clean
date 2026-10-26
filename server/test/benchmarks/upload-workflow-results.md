# Upload-to-preview pipeline evidence

The large delay is thumbnail work and its backlog. Removing the disabled storage-template job saves one queue hop per uploaded/copied asset, but these measurements do not establish a large end-to-end improvement. The 2–5x target remains unmet.

The candidate dispatches thumbnails directly from the completed metadata event when storage templates are disabled. When enabled, the existing migration job still completes before thumbnails are dispatched. Metadata refreshes without an upload/copy source do not gain new thumbnail work. No upload bytes, checksum, fsync, metadata ordering, media transformation, quality, public interface or worker concurrency changed.

## Local comparison

This is a separate native installation on the development host, an Intel Core i5-13420H with 12 logical CPUs. PostgreSQL 16.6 and Redis 7.4.2 binaries were copied read-only from the remote validation prefix and run with fresh local data and credentials. No remote service, benchmark, deployment or codec build was changed. Both application worker types run under the normal supervisor, with default job concurrency of 5 for metadata and 3 for thumbnails. The supervisor runs directly with Node 24.13.1 and its default libuv thread pool. ML is disabled because this host has no installed ML runtime. This cannot evaluate ML CPU contention or predict the two-core Ubuntu host.

Three alternating baseline/candidate pairs each warm up separately, then run one idle upload and 20-photo batches with 1, 4 and 8 concurrent clients. Each case uses a fresh user. Both variants use the same diagnostic preload, codec stack, persistent fixtures and storage. The baseline reverts only this dispatch change; it retains the earlier upload buffering, video buffering and unchanged-size transform optimizations. This is not a Docker-to-native comparison.

The fixtures are 20 distinct generated 4000×3000 JPEGs at quality 90, approximately 10 MB each. They exercise valid large image imports but do not represent camera-library or video coverage. Writes use the home filesystem on `/dev/mapper/root`, with existing durability settings. Earlier runs under RAM-backed `/tmp` caused memory pressure and are excluded from the timing comparison. Their private diagnostic logs were retained.

| Workflow | Baseline median, ms | Candidate median, ms | Paired geometric mean ratio | Slower candidate pairs |
| --- | ---: | ---: | ---: | ---: |
| Single photo to preview | 604.53 | 588.69 | 1.077x | 0/3 |
| 20 photos, 1 client, all previews | 4580.65 | 4758.12 | 1.031x | 2/3 |
| 20 photos, 4 clients, all previews | 4686.68 | 4300.35 | 1.046x | 2/3 |
| 20 photos, 8 clients, all previews | 4547.63 | 4478.89 | 1.028x | 2/3 |

These small ratios do not establish a repeatable gain. Candidate batch medians and paired ratios point in different directions because samples vary substantially. A 100 ms preview polling interval also limits resolution for a change that saves only a few milliseconds. Desktop activity, caches, process restarts and growing disposable data remain sources of noise. No power claim follows from CPU measurements.

All 183 paired timed original/preview hashes matched. Every run passed exact original/range checks, unauthenticated rejection, duplicate identity, concurrent empty/malformed multipart rejection alongside a valid request, queue drain and zero failed jobs. An additional enabled-template run passed the complete single/1/4/8 workflow, including the later checksum-header duplicate check. A separate oriented JPEG with an XMP sidecar verified actual movement into the library, unchanged original bytes, imported sidecar description, EXIF orientation 6, a 1440×1920 preview and migration completion before thumbnail job start.

A candidate-only mixed import with six generated photos and two H.264 MP4s passed the single/1/4/8 workflow, including byte/range integrity, both duplicate paths and concurrent multipart failures. Its raw rows are in [upload-workflow-mixed.jsonl](results/upload-workflow-mixed.jsonl). This is import coverage, not a paired video speed measurement. [upload-workflow-template.mjs](upload-workflow-template.mjs) reproduces the enabled-template orientation/sidecar check.

Raw timed rows, including unfavorable samples, are in [upload-workflow-local.jsonl](results/upload-workflow-local.jsonl). [upload-workflow-local-summary.json](results/upload-workflow-local-summary.json) contains all paired wall times, stage statistics, hash parity and the full per-asset timelines for one single upload and both variants' 20-photo, 4-client batches. The original trace logs and disposable installation remain under `~/.cache/openframe-upload-pipeline-20261026` on the development host. Services were stopped after validation.

## Queue wait versus work

Across 183 baseline timed uploads:

| Stage | Median queue wait, ms | Median job wall time, ms |
| --- | ---: | ---: |
| Metadata extraction | 1 | 66.01 |
| Disabled storage-template migration | 1 | 2.18 |
| Thumbnail generation | 1482 | 622.51 |

The metadata handler's median exiftool interval was 21.27 ms. Its database intervals occupied 33.02 ms, including 24.15 ms of writes. These are interval unions, so overlapping writes are counted once. Exiftool includes pool wait and external processing. Job wall time also includes I/O and follow-up events; it is not isolated CPU time. The workflow rows separately retain sampled process-tree CPU and RSS.

The actual first timed baseline single-photo timeline, relative to request end, was:

| Event | Time, ms |
| --- | ---: |
| Metadata queued / started | 36.77 / 39.04 |
| Upload response finished | 42.88 |
| Exiftool within metadata | 8.23 elapsed |
| Metadata database calls / writes | 10.45 / 6.41 elapsed |
| Storage migration queued / started / finished | 54.77 / 56.61 / 57.41 |
| Thumbnails queued / started / finished | 56.77 / 57.78 / 496.75 |
| Metadata handler finished | 59.06 |
| Preview first served | 575.72 |

The event handler queues the next stage before the metadata job finishes its remaining event callbacks. This existing overlap explains the timestamps. All metadata writes that determine orientation and original path precede the event.

The 20-photo traces show the thumbnail queue filling while metadata and the no-op migration remain fast. Typical thumbnail queue wait is roughly 1.5 seconds. This is backlog behind active thumbnail work, not a multi-second Redis polling delay. Lowering BullMQ's drain timeout would not remove that backlog. Metadata database/exiftool tuning is bounded by tens of milliseconds here. The bypass removes all 183 timed no-op jobs, but leaves the dominant thumbnail computation intact. Media implementation belongs to the other worker and was not edited.

## Integration and remaining proof

Use [upload-workflow.md](upload-workflow.md) for the harness, process sampling and optional preload. On the Ubuntu target, alternate the previous dispatch with this candidate using the same 20-photo manifest, normal workers and normal ML. Include API/supervisor, ML, PostgreSQL and Redis process roots. Run the tracer first to distinguish thumbnail backlog from ML contention, then repeat without trace logging for final timings. Do not run a compiler or another benchmark concurrently.

Keep enabled templates in the validation matrix, including a moved original, sidecar and orientation. Run a mixed photo/video manifest separately. If ML starvation is observed, a cross-queue scheduling change needs real ML evidence; BullMQ priority on one queue alone does not prioritize work over separate ML queues. No speculative worker pause, global concurrency increase, metadata shortcut or exiftool behavior change was added.

The targeted storage-template/job/metadata suite passed 199 tests. Five harness self-checks, TypeScript checking, changed TypeScript lint, formatting and the production build passed. The full unit suite was not repeated. Cancellation cleanup, wider codec parity, shared-link permissions, backup restoration and normal-ML batch contention remain separate gates.
