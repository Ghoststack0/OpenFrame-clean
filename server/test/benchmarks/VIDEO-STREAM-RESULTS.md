# Video file streaming experiment

The candidate uses 256 KiB filesystem reads for `video/*` responses in the shared `sendFile` helper, instead of Node's default 64 KiB. Photos retain the default buffer. Express continues to handle byte ranges, conditional requests, HEAD, backpressure, and stream cleanup.

Run from `server` with its dependencies installed:

```sh
node test/benchmarks/video-stream.mjs test/benchmarks/results/video-stream.json
```

This is a local transfer experiment, not a full Immich benchmark. It compares the actual Express `sendFile` implementation with the two read sizes, without authentication or database queries. Six alternating paired rounds each transfer eight 32 MiB files sequentially over loopback from a warmed local filesystem. SHA256 is checked during warmup, and every timed response is checked for the expected byte count. CPU includes both the server and client. There is no power measurement, TLS, shaped network, slow-client simulation, or concurrent-load measurement.

On Node 24.13.1, `results/video-stream-node24-transfer.json` records median sample wall time of 947.06 ms at 64 KiB and 573.64 ms at 256 KiB. This is 1.65 times the transfer rate in this experiment, with 24.5% less process CPU. Every paired sample favored the candidate in wall time. These exploratory observations do not establish a 2–5 times whole-application gain.

Earlier exploratory runs hashed every timed response. Their raw results are retained as `video-stream-local*.json` on Node 26 and `video-stream-node24.json` and `video-stream-node24-repeat.json` on Node 24. Median wall-time reductions ranged from 3.8% to 23.8%, with some slower candidate pairs. Hashing inside the timed loop measures additional client CPU; the final script validates hashes before timing to measure the transfer path more directly. Shared-host variation affects every run.

The tradeoff is a fourfold filesystem read buffer per active video stream, 256 KiB rather than 64 KiB. This does not cap total memory per connection; socket and HTTP buffers also contribute. Deployments serving many slow concurrent video clients should measure memory and throughput before adopting this tuning. The HTTP regression test covers complete video bytes, a range crossing the new buffer boundary, conditional requests, and HEAD. Existing missing-file, unreadable-file, and thumbnail tests remain in place.

A later integrity/cleanup stress check, `video-slow-clients.mjs`, runs 16 simultaneous 8 MiB clients pausing 2 ms per received chunk, then 16 early-aborted clients. Both variants passed all SHA256 and response cleanup assertions across two alternating rounds on Node 24.13.1. Raw data is in `results/video-slow-clients-node24.json`. Candidate sample times were 669.7 and 599.4 ms versus 658.0 and 532.5 ms for baseline. Sample peak RSS ranged 183–199 MiB and includes both server and clients with uncontrolled GC; these results establish neither a slow-client throughput win nor a production memory bound.
