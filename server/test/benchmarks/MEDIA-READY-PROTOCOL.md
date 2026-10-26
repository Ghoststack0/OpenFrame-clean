# Default-worker upload comparison

The `--media-ready` mode was defined before completing any deployment pair. It runs exactly six paired blocks, alternating upstream/candidate first. Each deployment starts with empty disposable PostgreSQL/upload volumes, the same seeded PNG fixtures, normal database durability, and both default API/microservices workers. Machine learning alone remains disabled in the shared configuration. Existing installations and prior results are outside its named Compose projects.

Each deployment waits for API readiness and the actual `Geodata import completed` worker log, records startup/readiness duration, then uploads one unmeasured fixture and waits for its thumbnail and preview. Twenty measured unique 512x512 PNG uploads follow sequentially. HTTP completion measures transmission through complete upload response reading. Media-ready completion starts immediately before the same upload and ends after both authenticated thumbnail and preview endpoints return image content with more than 100 bytes. Readiness polls sleep 50 ms between unsuccessful checks; HTTP polling cost is included. This measures client-observed image readiness, not exact worker execution duration or completion of every queue.

The existing harness also checks original byte equality, unauthorized access, byte ranges, ETag revalidation, duplicate identity and ordered mixed-encoding preflight decisions. These checks occur after each asset's timed media-ready completion. There is no concurrent upload backlog. A fresh deployment and completed media warmup make each paired block comparable without disabling the processing under test. Full deployment logs are retained separately. Startup/geodata cost is reported separately from request metrics.

For each metric, compare each deployment's 20-sample median. Take the geometric mean of six paired candidate/upstream ratios. Resample whole paired log ratios 10,000 times using seed 0 and report the exploratory percentile 95% interval. Positive percentage means candidate slower. The predeclared exploratory budget is 5%: lower bound above 5% means regression, upper bound at most 5% meets this measured-path budget, and an interval crossing 5% is inconclusive. Both HTTP and media-ready metrics must meet the budget for the combined gate. Never add samples until the gate becomes favorable. This is a test budget, not a user-approved release SLO.

Reproduce on the Linux box with the already prepared pinned images and artifacts:

```sh
ssh yvm@192.168.1.9 'cd ~/openframe-bench-20261026 && python3 -u http-upload.py --media-ready > http-upload-media-ready.log 2>&1 && python3 analyze-media-ready.py http-upload-media-ready.json'
```

Use a new directory or archive the new mode's existing files before rerunning. The original smoke and controlled result filenames remain separate. The analysis script runs synthetic behavior assertions before analyzing results. `media-ready-harness.sha256` records the exact scripts used. On failure, the harness writes failure status and removes its two named projects and volumes in `finally`; complete per-deployment logs are saved before successful teardown.

Limits: one shared two-core host, six deployment pairs, sequential small synthetic PNGs, loopback HTTP, 50 ms polling granularity plus request time, no video, no ML, no WAN/TLS/mobile path, no populated-library or concurrent-load claim. The existing candidate image reuses production dependencies/native codecs and freshly compiled server code recorded in `candidateBuild`; it is not a fresh release image. The bootstrap interval is exploratory and does not certify application-wide absence of regressions.

The handoff also interprets the same final intervals against a strict 0% reference, requested while the bounded run was still underway. An upper bound at most 0% means the interval is entirely faster or equal. A lower bound above 0% means evidence of slowdown. An interval crossing 0% is inconclusive. This separately labeled interpretation does not replace the predeclared 5% analysis or add samples.
