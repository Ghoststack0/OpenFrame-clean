// Concurrent photo-grid and video-seek load against a running server.
// node test/benchmarks/media-serving.mjs <baseUrl> <fixture.json> <label> <out.jsonl> [serverPid]
// fixture.json: { "accessToken": "...", "photos": ["<asset id>", ...], "videos": ["<asset id>", ...] }
// Every 200/206 body is compared with bytes fetched once during warmup; ranges are checked against the full file.
// URLs are identical across variants (no cache-busting parameters) and the warmup reads every file once, so both
// variants run with a warm OS page cache. "ttfb" is time to response headers. Component numbers are diagnostic only.
// serverPid (optional, Linux): the API worker process, used to report its CPU ticks per scenario.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';

const [base, fixturePath, label, out, serverPid] = process.argv.slice(2);
const { accessToken, photos, videos } = JSON.parse(readFileSync(fixturePath, 'utf8'));
const { hostname, port } = new URL(base);
const headers = { authorization: `Bearer ${accessToken}` };
const thumbnailPath = (id) => `/api/assets/${id}/thumbnail?size=thumbnail`;
const videoPath = (id) => `/api/assets/${id}/video/playback`;

const cpuTicks = () => {
  if (!serverPid) return 0;
  // Includes reaped children such as the API worker when serverPid is the supervisor.
  const fields = readFileSync(`/proc/${serverPid}/stat`, 'utf8').split(') ')[1].split(' ');
  return fields.slice(11, 15).reduce((sum, value) => sum + Number(value), 0);
};

/** Resolves when the response ends, or after `limit` body bytes when the client aborts early. */
const request = (agent, path, extraHeaders = {}, limit = Infinity, readDelayMs = 0) =>
  new Promise((resolve, reject) => {
    const start = performance.now();
    let firstByte;
    const req = http.get({ hostname, port, path, agent, headers: { ...headers, ...extraHeaders } }, (res) => {
      firstByte ??= performance.now() - start;
      const chunks = [];
      let length = 0;
      const finish = (aborted) =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          ms: performance.now() - start,
          ttfb: firstByte,
          aborted,
        });
      res.on('data', (chunk) => {
        chunks.push(chunk);
        length += chunk.length;
        if (length >= limit) {
          req.destroy();
          finish(true);
        } else if (readDelayMs) {
          res.pause();
          setTimeout(() => res.resume(), readDelayMs);
        }
      });
      res.on('end', () => finish(false));
      res.on('error', (error) => (length >= limit ? undefined : reject(error)));
    });
    req.on('error', (error) => (req.destroyed && error.code === 'ECONNRESET' ? undefined : reject(error)));
  });

const browserAgent = () => new http.Agent({ keepAlive: true, maxSockets: 6 });
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2);
};
const summarize = (scenario, results, wallMs, ticks, extra = {}) => {
  const ms = results.map((r) => r.ms);
  const row = {
    label,
    scenario,
    requests: results.length,
    wallMs: +wallMs.toFixed(1),
    rps: +((results.length / wallMs) * 1000).toFixed(1),
    p50: quantile(ms, 0.5),
    p95: quantile(ms, 0.95),
    p99: quantile(ms, 0.99),
    serverCpuTicks: ticks,
    ...extra,
  };
  appendFileSync(out, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
  return row;
};

// Warmup: fetch the reference bytes and ETags once over a single connection.
const warm = browserAgent();
const expected = new Map();
for (const id of photos) {
  const r = await request(warm, thumbnailPath(id));
  assert.equal(r.status, 200, `thumbnail ${id}`);
  assert.equal(r.headers['content-encoding'], undefined, 'thumbnails must not be re-encoded');
  expected.set(id, { body: r.body, etag: r.headers.etag });
}
const videoBytes = new Map();
for (const id of videos) {
  const r = await request(warm, videoPath(id));
  assert.equal(r.status, 200, `video ${id}`);
  assert.equal(r.headers['content-encoding'], undefined, 'videos must not be re-encoded');
  videoBytes.set(id, r.body);
}
warm.destroy();

/** One browser loading the whole grid over six keep-alive connections. */
const loadGrid = async (order, revalidate) => {
  const agent = browserAgent();
  try {
    return await Promise.all(
      order.map(async (id) => {
        const reference = expected.get(id);
        const r = await request(agent, thumbnailPath(id), revalidate ? { 'if-none-match': reference.etag } : {});
        if (revalidate) {
          assert.equal(r.status, 304, `revalidate ${id}`);
          assert.equal(r.body.length, 0);
        } else {
          assert.equal(r.status, 200, `thumbnail ${id}`);
          assert.ok(r.body.equals(reference.body), `thumbnail bytes ${id}`);
        }
        return r;
      }),
    );
  } finally {
    agent.destroy();
  }
};

/** Seeks like a player: open-ended range, read the first 256 KiB, then abort. */
const seek = async (agent, id, offset) => {
  const full = videoBytes.get(id);
  const r = await request(agent, videoPath(id), { range: `bytes=${offset}-` }, 256 * 1024);
  assert.equal(r.status, 206, `seek ${id}@${offset}`);
  assert.equal(r.headers['content-range'], `bytes ${offset}-${full.length - 1}/${full.length}`);
  assert.ok(r.body.equals(full.subarray(offset, offset + r.body.length)), `seek bytes ${id}@${offset}`);
  return r;
};
const seekOffsets = (count) =>
  Array.from({ length: count }, (_, i) => {
    const id = videos[i % videos.length];
    // Deterministic, spread across the file and not chunk aligned.
    return { id, offset: Math.floor(((i * 7_919_993) % videoBytes.get(id).length) / 3) * 3 };
  });
const runSeeks = async (count) => {
  const agent = browserAgent();
  const results = [];
  for (const { id, offset } of seekOffsets(count)) results.push(await seek(agent, id, offset));
  agent.destroy();
  return results;
};

const measure = async (scenario, run, extra) => {
  const ticks = cpuTicks();
  const start = performance.now();
  const results = (await run()).flat();
  const wallMs = performance.now() - start;
  const row = summarize(scenario, results, wallMs, cpuTicks() - ticks, extra?.(results));
  return row;
};
const shuffled = (seed) =>
  photos
    .map((id, i) => [((i + 1) * seed) % 1009, id])
    .sort((a, b) => a[0] - b[0])
    .map(([, id]) => id);
const ttfb = (results) => ({
  ttfbP50: quantile(
    results.map((r) => r.ttfb),
    0.5,
  ),
  ttfbP95: quantile(
    results.map((r) => r.ttfb),
    0.95,
  ),
});

await measure('grid-cold-1-browser', () => loadGrid(photos, false));
await measure('grid-revalidate-1-browser', () => loadGrid(photos, true));
await measure('grid-cold-4-browsers', () =>
  Promise.all([1, 2, 3, 4].map((seed) => loadGrid(shuffled(seed * 13), false))),
);
await measure('video-seek-idle', () => runSeeks(40), ttfb);
await measure('mixed-grid-seek-slow-video', async () => {
  const slow = browserAgent();
  const id = videos[0];
  // A slow reader that stays connected for the whole mix, then aborts after 4 MiB.
  const slowPlayer = request(slow, videoPath(id), {}, 4 * 1024 * 1024, 5).then((r) => {
    assert.ok(r.body.equals(videoBytes.get(id).subarray(0, r.body.length)), 'slow player bytes');
    slow.destroy();
    return [];
  });
  const [grids, seeks] = await Promise.all([
    Promise.all([7, 11].map((seed) => loadGrid(shuffled(seed), false))),
    runSeeks(20),
    slowPlayer,
  ]);
  // Report seek TTFB separately; grid requests dominate the latency quantiles.
  appendFileSync(
    out,
    JSON.stringify({ label, scenario: 'mixed-seek-ttfb', requests: seeks.length, ...ttfb(seeks) }) + '\n',
  );
  console.log(JSON.stringify({ label, scenario: 'mixed-seek-ttfb', ...ttfb(seeks) }));
  return [grids.flat(), seeks];
});
