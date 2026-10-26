# Photo grid and video serving

These are development-host measurements of the real API worker (`dist/workers/api.js`, production mode) against a local PostgreSQL 16.6 with pgvector 0.8.0 and Redis 7.4.2, all on loopback. The machine had 12 cores and other workloads running (load average 3 to 6). They are not Ubuntu results and do not establish a 2–5x end-to-end gain.

## What a thumbnail request costs

Statement logging showed exactly three sequential PostgreSQL round trips for every owner thumbnail, video range and original request: the session lookup, the owner access check, and the file path lookup. Nothing ran twice within a request. A CPU profile of the API worker under the grid load attributed self time as follows:

| Area                                                 | Share |
| ---------------------------------------------------- | ----- |
| Node HTTP, net, stream and fs internals              | 34%   |
| Kysely query building and postgres.js (3 queries)    | 23%   |
| Nest, Express, router, rxjs, CLS, zod and middleware | 19%   |
| `ua-parser-js`, luxon and SHA-256 in session auth    | 9%    |
| Garbage collection                                   | 5%    |
| Application code                                     | 5%    |

The worker was CPU bound during the grid load, so throughput follows CPU per request. No single component accounts for enough time to make a 4–5x reduction possible on the cold request path.

## Changes

- Thumbnail, video playback and original lookups now return an `isOwner` column using the predicate of `AccessRepository.checkOwnerAccess`. Owners skip the separate access query: 3 round trips become 2. Album and partner viewers and shared links still run the unchanged `requireAccess` after that lookup. Session and API key users both get the owner shortcut. Shared links never use the owner column because they resolve to the link owner's user.
- Session validation compares the app version with the cheap regex and parses the full user agent only when it writes the hourly or version-change session update. Luxon date arithmetic in the same path became plain millisecond comparisons.

No caching was added. Revocation, permission and visibility changes still take effect on the next request.

## Results

`media-serving.mjs` ran 14 alternating baseline/candidate pairs. Baseline is the same build without these two changes. Every 200/206 body matched the bytes fetched during warmup, every range matched the full file, every revalidation returned 304 with no body, and no media response was content-encoded. The raw rows are in `results/media-serving-local.jsonl`; `python3 analyze-media-serving.py results/media-serving-local.jsonl` reproduces this table.

| Scenario                                 | Metric          | Baseline median | Candidate median | Paired geometric mean | Candidate slower |
| ---------------------------------------- | --------------- | --------------- | ---------------- | --------------------- | ---------------- |
| 200 thumbnails, 1 browser, 6 connections | grid wall time  | 217.75 ms       | 188.75 ms        | 1.11x                 | 2/14             |
|                                          | p50 / p95       | 125.5 / 206.8   | 108.1 / 179.7 ms | 1.10x / 1.12x         | 3/14, 2/14       |
| 4 browsers × 200 thumbnails              | requests/s      | 1397            | 1807             | 1.33x                 | 2/14             |
|                                          | p50 / p95       | 307.8 / 550.1   | 237.4 / 424.2 ms | 1.28x / 1.33x         | 2/14             |
| 200 thumbnails revalidated (304)         | grid wall time  | 141.9 ms        | 123.0 ms         | 1.19x                 | 3/14             |
| 40 video seeks, idle                     | TTFB p50 / p95  | 1.93 / 3.59 ms  | 1.74 / 3.31 ms   | 1.16x / 1.00x         | 4/14, 7/14       |
| 20 seeks during 2 grid loads and a slow player | TTFB p50 / p95 | 10.70 / 23.21 ms | 8.88 / 22.76 ms | 1.17x / 1.08x | 4/14, 7/14 |
| Grid requests in that mixed load         | p50 / p95       | 177.2 / 314.6   | 142.8 / 247.4 ms | 1.21x / 1.21x         | 4/14, 2/14       |

Seek p95 did not measurably change. A repeat grid scroll within 24 hours makes no requests at all, because thumbnails are served with `private, max-age=86400, stale-while-revalidate=2592000`. After that the browser shows the cached image immediately and revalidates in the background, so the 304 path affects server load more than visible latency.

## Reproduce

Build the server, start the API worker with a database containing photos that have thumbnails and videos, and write `{ "accessToken", "photos": [...200 ids], "videos": [...ids] }` to a fixture file. Then run, alternating variants:

```sh
node test/benchmarks/media-serving.mjs http://127.0.0.1:2283 fixture.json baseline-1 out.jsonl <api worker pid>
node test/benchmarks/media-serving.mjs http://127.0.0.1:2283 fixture.json candidate-1 out.jsonl <api worker pid>
python3 test/benchmarks/analyze-media-serving.py out.jsonl
```

The medium tests can use an existing PostgreSQL instead of a container: set `IMMICH_TEST_POSTGRES_URL` to a URL whose database is named `mich`, for example `postgres://postgres@127.0.0.1:25433/mich`.
