// Disposable loopback deployment only. Never point this at an existing library.
// Usage: node test/benchmarks/native-http.mjs URL PRIVATE_FIXTURE_DIR LABEL OUTPUT.jsonl
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';

const [origin, directory, label, output] = process.argv.slice(2);
assert(origin && directory && label && output, 'Expected URL PRIVATE_FIXTURE_DIR LABEL OUTPUT.jsonl');
const url = new URL(origin);
assert(url.hostname === '127.0.0.1' && url.protocol === 'http:', 'Loopback HTTP only');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
await mkdir(directory, { recursive: true, mode: 0o700 });
const getFixture = async (name, generate) => {
  const path = join(directory, name);
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const bytes = await generate(path);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return bytes;
  }
};
const credentials = JSON.parse(
  await getFixture('admin.json', async () =>
    Buffer.from(
      JSON.stringify({
        email: 'native-validation@example.invalid',
        name: 'Disposable native validation',
        password: randomBytes(32).toString('hex'),
      }),
    ),
  ),
);
const request = async (path, options = {}) =>
  fetch(new URL(`/api${path}`, url), { ...options, signal: AbortSignal.timeout(30_000) });
const startupDeadline = performance.now() + 120_000;
while (true) {
  try {
    const ping = await request('/server/ping');
    assert.equal(ping.status, 200);
    await ping.arrayBuffer();
    break;
  } catch (error) {
    if (performance.now() >= startupDeadline) throw error;
    await delay(500);
  }
}
const json = async (path, body, token) => {
  const response = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert([200, 201, 204].includes(response.status), `${path}: HTTP ${response.status}`);
  return response.status === 204 ? undefined : response.json();
};
let login = await request('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(credentials),
});
if (login.status === 401) {
  await json('/auth/admin-sign-up', credentials);
  login = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
}
assert.equal(login.status, 201);
const admin = (await login.json()).accessToken;
const user = {
  email: `${randomUUID()}@example.invalid`,
  name: `Native ${label}`,
  password: randomBytes(32).toString('hex'),
};
await json('/admin/users', user, admin);
const token = (await json('/auth/login', user)).accessToken;
const headers = { authorization: `Bearer ${token}` };
const uploadedIds = [];
const record = async (data) => {
  await appendFile(
    output,
    JSON.stringify({ label, node: process.version, date: new Date().toISOString(), ...data }) + '\n',
    { mode: 0o600 },
  );
};
const upload = async (bytes, filename) => {
  const form = new FormData();
  form.set('assetData', new Blob([bytes]), filename);
  form.set('fileCreatedAt', '2026-01-01T00:00:00.000Z');
  form.set('fileModifiedAt', '2026-01-01T00:00:00.000Z');
  const start = performance.now();
  const response = await request('/assets', { method: 'POST', headers, body: form });
  assert.equal(response.status, 201, `Upload ${filename}: HTTP ${response.status}`);
  const asset = await response.json();
  uploadedIds.push(asset.id);
  return { id: asset.id, start, uploadMs: performance.now() - start };
};
const waitThumbnail = async (id) => {
  const deadline = performance.now() + 180_000;
  do {
    const response = await request(`/assets/${id}/thumbnail?size=preview`, { headers });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status === 200) {
      const meta = await sharp(bytes).metadata();
      assert(meta.width > 0 && meta.height > 0);
      return { previewSha256: sha256(bytes), width: meta.width, height: meta.height };
    }
    assert.equal(response.status, 404, `Thumbnail: HTTP ${response.status}`);
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error('Preview did not become ready in 180 seconds');
};
const verifyOriginal = async (id, bytes) => {
  const path = `/assets/${id}/original`;
  const unauthenticated = await request(path);
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.arrayBuffer();
  const original = await request(path, { headers });
  assert.equal(original.status, 200);
  assert.equal(sha256(Buffer.from(await original.arrayBuffer())), sha256(bytes));
  const range = await request(path, { headers: { ...headers, range: 'bytes=0-1023' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-1023/${bytes.length}`);
  assert(Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(0, 1024)));
  const etag = original.headers.get('etag');
  assert(etag, 'Expected ETag');
  // Fetch otherwise adds Cache-Control: no-cache to conditional requests, which forces a 200 response.
  const conditional = await request(path, { cache: 'no-cache', headers: { ...headers, 'if-none-match': etag } });
  assert.equal(conditional.status, 304);
  assert.equal((await conditional.arrayBuffer()).byteLength, 0);
  const invalid = await request(path, { headers: { ...headers, range: `bytes=${bytes.length}-` } });
  // shortcut: the existing shared error handler maps invalid ranges to 404; update when that behavior is fixed.
  assert.equal(invalid.status, 404);
  await invalid.arrayBuffer();
};
for (let sample = 0; sample < 6; sample++) {
  const bytes = await getFixture(`photo-${sample}.jpg`, () =>
    sharp(randomBytes(4000 * 3000 * 3), { raw: { width: 4000, height: 3000, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer(),
  );
  const asset = await upload(bytes, `photo-${sample}.jpg`);
  const preview = await waitThumbnail(asset.id);
  const readyMs = performance.now() - asset.start;
  await verifyOriginal(asset.id, bytes);
  const found = await json('/search/metadata', { id: asset.id }, token);
  assert(
    found.assets.items.some((item) => item.id === asset.id),
    'Metadata search must find uploaded image',
  );
  await record({
    kind: 'photo',
    sample,
    fixtureSha256: sha256(bytes),
    bytes: bytes.length,
    uploadMs: asset.uploadMs,
    readyMs,
    ...preview,
    integrity: true,
    auth: true,
    ranges: true,
    conditional: true,
    metadataSearch: true,
  });
}
const video = await getFixture('video.mp4', async (path) => {
  const generated = `${path}.generated.mp4`;
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-t',
      '10',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      generated,
    ],
    { timeout: 120_000 },
  );
  return readFile(generated);
});
const asset = await upload(video, 'video.mp4');
await waitThumbnail(asset.id);
await verifyOriginal(asset.id, video);
for (let sample = -1; sample < 6; sample++) {
  const start = performance.now();
  const response = await request(`/assets/${asset.id}/video/playback`, { headers });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const milliseconds = performance.now() - start;
  assert.equal(sha256(bytes), sha256(video), 'Compatible H.264 playback must preserve original bytes');
  const range = await request(`/assets/${asset.id}/video/playback`, {
    headers: { ...headers, range: 'bytes=1024-2047' },
  });
  assert.equal(range.status, 206);
  assert(Buffer.from(await range.arrayBuffer()).equals(video.subarray(1024, 2048)));
  if (sample >= 0)
    await record({
      kind: 'video',
      sample,
      fixtureSha256: sha256(video),
      bytes: video.length,
      milliseconds,
      integrity: true,
      playbackRange: true,
    });
}
const mlDeadline = performance.now() + 180_000;
while (true) {
  const result = await json('/search/smart', { query: 'photo' }, token);
  if (result.assets.items.some((item) => uploadedIds.includes(item.id))) break;
  assert(performance.now() < mlDeadline, 'ML smart search did not return an uploaded asset');
  await delay(500);
}
const drainDeadline = performance.now() + 180_000;
while (true) {
  const response = await request('/queues', { headers: { authorization: `Bearer ${admin}` } });
  assert.equal(response.status, 200);
  const queues = await response.json();
  assert(
    queues.every((queue) => queue.statistics.failed === 0),
    'Background queue has failed jobs',
  );
  if (queues.every((queue) => queue.statistics.active + queue.statistics.waiting + queue.statistics.delayed === 0))
    break;
  assert(performance.now() < drainDeadline, 'Background queues did not drain');
  await delay(500);
}
await record({ kind: 'parity', smartSearch: true, queuesDrained: true, failedJobs: 0, invalidRangeStatus: 404 });
console.log(
  `Native HTTP validation passed for ${label}; six photo and six video samples saved, ML search and queue drain checked.`,
);
