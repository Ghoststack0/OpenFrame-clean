// Disposable loopback installation only. Credentials and source media stay outside results.
// node test/benchmarks/upload-workflow.mjs URL MANIFEST.json ADMIN.json LABEL OUT.jsonl PID[,PID...]
import assert from 'node:assert/strict';
import { createReadStream, openAsBlob } from 'node:fs';
import { appendFile, open, readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { monitorProcesses, runBounded, sha256 } from './upload-workflow-lib.mjs';

const [origin, manifestPath, adminPath, label, output, pidList, roundsArgument = '3'] = process.argv.slice(2);
const rounds = Number(roundsArgument);
assert(Number.isInteger(rounds) && rounds > 0, 'Rounds must be a positive integer');
assert(
  origin && manifestPath && adminPath && label && output && pidList,
  'Expected URL MANIFEST.json ADMIN.json LABEL OUT.jsonl PID[,PID...]',
);
const url = new URL(origin);
assert(url.hostname === '127.0.0.1' && url.protocol === 'http:', 'Loopback HTTP only');
const roots = pidList.split(',').map(Number);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert(Array.isArray(manifest) && manifest.length >= 8, 'At least eight distinct media files required');
const fixtures = await runBounded(manifest, 1, async (item, index) => {
  assert(item && typeof item.path === 'string' && ['photo', 'video'].includes(item.kind));
  const path = resolve(dirname(resolve(manifestPath)), item.path);
  const blob = await openAsBlob(path);
  assert(blob.size > 1024);
  const checksum = createHash('sha1');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    checksum.update(chunk);
    digest.update(chunk);
  }
  return {
    path,
    kind: item.kind,
    index,
    bytes: blob.size,
    sha256: digest.digest('hex'),
    checksum: checksum.digest('base64'),
  };
});
assert.equal(new Set(fixtures.map((file) => file.sha256)).size, fixtures.length, 'Duplicate fixture bytes');
const credentials = JSON.parse(await readFile(adminPath, 'utf8'));
const request = (path, options = {}) =>
  fetch(new URL(`/api${path}`, url), {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
const json = async (path, body, token) => {
  const response = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert([200, 201, 204].includes(response.status), `${path}: HTTP ${response.status}`);
  return response.status === 204 ? undefined : response.json();
};
const admin = (await json('/auth/login', credentials)).accessToken;
const newUser = async () => {
  const user = {
    email: `${randomUUID()}@example.invalid`,
    name: `Workflow ${label}`,
    password: randomBytes(32).toString('hex'),
  };
  await json('/admin/users', user, admin);
  return (await json('/auth/login', user)).accessToken;
};
const record = (row) =>
  appendFile(output, JSON.stringify({ label, node: process.version, date: new Date().toISOString(), ...row }) + '\n', {
    mode: 0o600,
  });
const drain = async () => {
  const deadline = performance.now() + 900_000;
  while (true) {
    const response = await request('/queues', { headers: { authorization: `Bearer ${admin}` } });
    assert.equal(response.status, 200);
    const queues = await response.json();
    assert(
      queues.every((queue) => queue.statistics.failed === 0),
      'Background jobs failed',
    );
    if (queues.every((queue) => queue.statistics.active + queue.statistics.waiting + queue.statistics.delayed === 0))
      return;
    assert(performance.now() < deadline, 'Queues did not drain within 15 minutes');
    await delay(250);
  }
};
const upload = async (fixture, token, additions = {}) => {
  const body = new FormData();
  body.set('fileCreatedAt', '2026-01-01T00:00:00.000Z');
  body.set('fileModifiedAt', '2026-01-01T00:00:00.000Z');
  for (const [key, value] of Object.entries(additions)) body.set(key, value);
  body.set('assetData', await openAsBlob(fixture.path), `workflow-${fixture.index}.${fixture.path.split('.').at(-1)}`);
  const started = performance.now();
  const response = await request('/assets', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
  const result = await response.json();
  return { ...result, httpStatus: response.status, started, responseMs: performance.now() - started };
};
const preview = async (asset, token, signal) => {
  const deadline = performance.now() + 900_000;
  while (true) {
    const response = await request(`/assets/${asset.id}/thumbnail?size=preview`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status === 200) {
      const metadata = await sharp(bytes).metadata();
      assert(metadata.width > 0 && metadata.height > 0);
      return {
        readyMs: performance.now() - asset.started,
        previewSha256: await sha256([bytes]),
        width: metadata.width,
        height: metadata.height,
      };
    }
    assert.equal(response.status, 404);
    assert(performance.now() < deadline, 'Preview did not become available within 15 minutes');
    await delay(100, undefined, { signal });
  }
};
const verifyOriginal = async (asset, fixture, token) => {
  const headers = { authorization: `Bearer ${token}` };
  const original = await request(`/assets/${asset.id}/original`, { headers });
  assert.equal(original.status, 200);
  assert.equal(await sha256(original.body), fixture.sha256, 'Original bytes changed');
  const range = await request(`/assets/${asset.id}/original`, { headers: { ...headers, range: 'bytes=0-1023' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-1023/${fixture.bytes}`);
  const handle = await open(fixture.path);
  try {
    const expected = Buffer.alloc(1024);
    await handle.read(expected, 0, 1024, 0);
    assert(Buffer.from(await range.arrayBuffer()).equals(expected));
  } finally {
    await handle.close();
  }
};

// Warm up separately. Timed users are fresh, so no duplicate shortcuts enter measurements.
const warmToken = await newUser();
const warm = await upload(fixtures[0], warmToken);
assert.equal(warm.httpStatus, 201);
await preview(warm, warmToken);
await drain();
const workloads = [
  { workload: 'single', concurrency: 1, inputs: fixtures.slice(0, 1) },
  ...[1, 4, 8].map((concurrency) => ({ workload: 'batch', concurrency, inputs: fixtures })),
];
for (let round = 0; round < rounds; round++) {
  for (const { workload, concurrency, inputs } of workloads) {
    await drain();
    const token = await newUser();
    const monitor = await monitorProcesses(roots);
    const clientCpu = process.cpuUsage();
    const started = performance.now();
    let metrics;
    const previews = [];
    const cancellation = new AbortController();
    try {
      const assets = await runBounded(inputs, concurrency, async (fixture) => {
        const asset = await upload(fixture, token);
        assert.equal(asset.httpStatus, 201);
        assert.equal(asset.status, 'created');
        // Catch immediately so a fast failure cannot become an unhandled rejection.
        previews.push(
          preview(asset, token, cancellation.signal).then(
            (result) => ({ asset, fixture, result }),
            (error) => ({ error }),
          ),
        );
        return asset;
      });
      const uploadWallMs = performance.now() - started;
      const uploadProcesses = await monitor.snapshot();
      const ready = await Promise.all(previews);
      for (const item of ready) if (item.error) throw item.error;
      const readyWallMs = performance.now() - started;
      await drain();
      const workflowWallMs = performance.now() - started;
      metrics = await monitor.stop();
      await record({
        kind: 'batch',
        workload,
        round,
        concurrency,
        count: inputs.length,
        uploadWallMs,
        readyWallMs,
        workflowWallMs,
        uploadProcesses,
        workflowProcesses: metrics,
        clientCpu: process.cpuUsage(clientCpu),
        clientRssBytes: process.memoryUsage().rss,
      });
      await runBounded(ready, concurrency, async ({ asset, fixture, result }) => {
        await verifyOriginal(asset, fixture, token);
        await record({
          kind: 'asset',
          workload,
          round,
          concurrency,
          fixture: fixture.index,
          media: fixture.kind,
          bytes: fixture.bytes,
          fixtureSha256: fixture.sha256,
          id: asset.id,
          responseMs: asset.responseMs,
          ...result,
          integrity: true,
        });
      });
      const unauthorized = await request(`/assets/${assets[0].id}/original`);
      assert.equal(unauthorized.status, 401);
      await unauthorized.arrayBuffer();
      const duplicate = await upload(fixtures[0], token);
      assert.equal(duplicate.httpStatus, 200);
      assert.equal(duplicate.status, 'duplicate');
      assert.equal(duplicate.id, assets[0].id);
      const prechecked = await request('/assets', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-immich-checksum': fixtures[0].checksum },
      });
      assert.equal(prechecked.status, 200);
      assert.equal((await prechecked.json()).id, assets[0].id);
      // Malformed and empty multipart requests race a valid duplicate, outside the timed region.
      const empty = new FormData();
      empty.set('assetData', new Blob([]), 'empty.jpg');
      await Promise.all([
        request('/assets', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: empty }).then(
          async (response) => {
            assert.equal(response.status, 400);
            await response.arrayBuffer();
          },
        ),
        request('/assets', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=incomplete' },
          body: '--incomplete\r\n',
        }).then(async (response) => {
          assert.equal(response.status, 400);
          await response.arrayBuffer();
        }),
        upload(fixtures[0], token).then((result) => {
          assert.equal(result.id, assets[0].id);
          assert.equal(result.httpStatus, 200);
        }),
      ]);
      await drain();
      await record({
        kind: 'parity',
        workload,
        round,
        concurrency,
        originals: true,
        ranges: true,
        unauthenticated: true,
        duplicateIdentity: true,
        checksumHeaderDuplicate: true,
        concurrentMultipartErrors: true,
        failedJobs: 0,
      });
    } finally {
      cancellation.abort();
      await Promise.all(previews);
      if (!metrics) await monitor.stop();
    }
  }
}
console.log(`Upload workflow ${label} passed; ${rounds} rounds at 1/4/8 concurrency saved to ${output}`);
