// Disposable native end-to-end gate. All network requests stay on loopback.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';

const [command, root, label, output] = process.argv.slice(2);
assert(root && ['prepare', 'run'].includes(command), 'Usage: native-gate.mjs prepare ROOT | run ROOT LABEL OUTPUT_DIR');
const directory = join(root, 'gate-fixtures');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestPath = join(directory, 'manifest.json');
const pinnedSample = async (name, path, expected) => {
  const target = join(root, 'samples', name);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(
      `https://raw.githubusercontent.com/immich-app/test-assets/ec56cc6c1d76c45bc9615dc6ea232470a2b0a3a1/${path}`,
    );
    assert.equal(response.status, 200);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), expected, name);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  assert.equal(hash(bytes), expected, name);
  return bytes;
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const pool = async (items, concurrency, task) => {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await task(items[index], index);
      }
    }),
  );
  return result;
};
if (command === 'prepare') {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const manifest = JSON.parse(await readFile(manifestPath));
    for (const file of [...manifest.photos, ...manifest.grid, manifest.video])
      assert.equal(hash(await readFile(join(directory, file.name))), file.sha256, file.name);
    console.log('Existing gate fixtures verified; generation skipped.');
    process.exit(0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const source = await pinnedSample(
    'gate-source-photo.jpg',
    'formats/motionphoto/pixel-6-pro.jpg',
    '4944eb4bb29ebf15dc342ab6d56399ab32efdfa78612bf08a9f53b1338c324bc',
  );
  assert.equal(hash(source), '4944eb4bb29ebf15dc342ab6d56399ab32efdfa78612bf08a9f53b1338c324bc');
  const sourceMeta = await sharp(source).metadata();
  const save = async (name, bytes, dimensions = {}) => {
    try {
      await writeFile(join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert((await readFile(join(directory, name))).equals(bytes), `Partial fixture differs: ${name}`);
    }
    return { name, bytes: bytes.length, sha256: hash(bytes), ...dimensions };
  };
  const photos = [];
  for (const [width, height] of [
    [4000, 3000],
    [6000, 4000],
  ]) {
    for (let i = 0; i < 9; i++) {
      const bytes = await sharp(source)
        .rotate()
        .extract({ left: i * 2, top: i * 2, width: sourceMeta.width - 20, height: sourceMeta.height - 20 })
        .resize(width, height, { fit: 'cover' })
        .jpeg({ quality: 90 })
        .toBuffer();
      photos.push(await save(`photo-${width}-${i}.jpg`, bytes, { width, height, format: 'jpeg' }));
    }
  }
  for (const [name, expected] of [
    ['IMG_2682.heic', '2d9d8493696fc0054ecb4517699fec11e04bf507f1f529f6a4f293fcefdeb35e'],
    ['EOS_30D.CR2', '1b977b9b848433b0f73342ff2796eb3091efe9fec2f6e51b8d2573f93d2f8edd'],
  ]) {
    const bytes = await pinnedSample(
      name,
      name.endsWith('heic') ? 'formats/heic/IMG_2682.heic' : 'formats/raw/Canon/EOS_30D.CR2',
      expected,
    );
    assert.equal(hash(bytes), expected, name);
    photos.push(await save(name, bytes, { format: name.endsWith('heic') ? 'heic' : 'raw' }));
  }
  assert.equal(new Set(photos.map((file) => file.sha256)).size, 20, 'Batch fixtures must be distinct');
  const grid = [];
  for (let i = 0; i < 200; i++) {
    const bytes = await sharp(source)
      .rotate()
      .extract({
        left: (i % 20) * 8,
        top: Math.floor(i / 20) * 8,
        width: sourceMeta.width - 180,
        height: sourceMeta.height - 100,
      })
      .resize(800, 600, { fit: 'cover' })
      .jpeg({ quality: 90 })
      .toBuffer();
    grid.push(await save(`grid-${String(i).padStart(3, '0')}.jpg`, bytes, { width: 800, height: 600, format: 'jpeg' }));
  }
  assert.equal(new Set(grid.map((file) => file.sha256)).size, 200);
  const videoPath = join(directory, 'video-4k.mp4');
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=3840x2160:rate=24',
      '-t',
      '6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      videoPath,
    ],
    { timeout: 600_000 },
  );
  const videoBytes = await readFile(videoPath);
  const video = {
    name: 'video-4k.mp4',
    bytes: videoBytes.length,
    sha256: hash(videoBytes),
    width: 3840,
    height: 2160,
    durationSeconds: 6,
    format: 'h264',
  };
  const manifest = {
    version: 1,
    source: {
      commit: 'ec56cc6c1d76c45bc9615dc6ea232470a2b0a3a1',
      path: 'formats/motionphoto/pixel-6-pro.jpg',
      sha256: hash(source),
      width: sourceMeta.width,
      height: sourceMeta.height,
      orientation: sourceMeta.orientation,
    },
    notes:
      '18 source-derived natural-photo JPEG crops, nine 12 MP and nine upscaled 24 MP. One original HEIC and one original CR2. Grid has 200 distinct 800x600 crops. Synthetic six-second 4K H.264 video; fixture encoding settings do not change server policy.',
    photos,
    grid,
    video,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Prepared ${photos.length} mixed photos, ${grid.length} grid photos and one 4K video.`);
  process.exit(0);
}
assert(label && output, 'Expected LABEL OUTPUT_DIR');
await mkdir(output, { recursive: true, mode: 0o700 });
const manifest = JSON.parse(await readFile(manifestPath));
assert.equal(manifest.photos.length, 20);
assert.equal(manifest.grid.length, 200);
const agents = [];
const agent = (connections) => {
  const value = new http.Agent({
    keepAlive: true,
    maxSockets: connections,
    maxTotalSockets: connections,
    scheduling: 'fifo',
  });
  agents.push(value);
  return value;
};
const controlAgent = agent(6);
const request = (path, { method = 'GET', headers = {}, body, connectionAgent = controlAgent } = {}) =>
  new Promise((resolve, reject) => {
    const start = performance.now();
    const req = http.request(
      new URL(`/api${path}`, 'http://127.0.0.1:2287'),
      { method, headers, agent: connectionAgent },
      (response) => {
        const chunks = [];
        let firstByte;
        const headersMs = performance.now() - start;
        response.on('data', (chunk) => {
          firstByte ??= performance.now() - start;
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const milliseconds = performance.now() - start;
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
            milliseconds,
            ttfbMs: firstByte ?? headersMs,
            localPort: req.socket?.localPort,
            reusedSocket: req.reusedSocket,
          });
        });
      },
    );
    req.setTimeout(120_000, () => req.destroy(new Error(`Request timed out: ${path}`)));
    req.on('error', reject);
    req.end(body);
  });
const json = async (path, body, token, method = 'POST') => {
  const response = await request(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert([200, 201, 204].includes(response.status), `${path}: HTTP ${response.status}`);
  return response.bytes.length ? JSON.parse(response.bytes) : undefined;
};
const startupDeadline = performance.now() + 180_000;
while (true) {
  try {
    assert.equal((await request('/server/ping')).status, 200);
    break;
  } catch (error) {
    if (performance.now() >= startupDeadline) throw error;
    await delay(500);
  }
}
const credentials = JSON.parse(await readFile(join(root, 'fixtures/admin.json')));
const admin = (await json('/auth/login', credentials)).accessToken;
const newUser = async (name) => {
  const user = {
    email: `${randomUUID()}@example.invalid`,
    name: `Gate ${name}`,
    password: randomBytes(32).toString('hex'),
  };
  await json('/admin/users', user, admin);
  return (await json('/auth/login', user)).accessToken;
};
const record = async (row) => {
  await appendFile(
    join(output, 'metrics.jsonl'),
    JSON.stringify({ label, date: new Date().toISOString(), ...row }) + '\n',
    { mode: 0o600 },
  );
  console.log(`${row.kind}: ${JSON.stringify(row)}`);
};
const drain = async () => {
  const deadline = performance.now() + 3600_000;
  while (true) {
    const queues = await json('/queues', undefined, admin, 'GET');
    assert(
      queues.every((q) => !q.isPaused && q.statistics.failed === 0),
      'Background queue has failed jobs',
    );
    if (queues.every((q) => q.statistics.active + q.statistics.waiting + q.statistics.delayed === 0)) return;
    assert(performance.now() < deadline, 'Queues did not drain in one hour');
    await delay(1000);
  }
};
const fixture = async (file) => {
  const bytes = await readFile(join(directory, file.name));
  assert.equal(hash(bytes), file.sha256, file.name);
  return { ...file, data: bytes };
};
const upload = async (file, token, connectionAgent) => {
  const boundary = `gate-${randomUUID()}`;
  const parts = [];
  for (const [name, value] of [
    ['fileCreatedAt', '2026-01-01T00:00:00.000Z'],
    ['fileModifiedAt', '2026-01-01T00:00:00.000Z'],
  ])
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const body = Buffer.concat(parts);
  const start = performance.now();
  const result = await request('/assets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.length,
    },
    body,
    connectionAgent,
  });
  assert.equal(result.status, 201, `${file.name}: upload must create a new asset`);
  const { id } = JSON.parse(result.bytes);
  return { id, start, uploadMs: performance.now() - start, file };
};
const rendition = async (id, size, token) => {
  const deadline = performance.now() + 1800_000;
  while (true) {
    const response = await request(`/assets/${id}/thumbnail?size=${size}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 200) {
      assert(response.bytes.length);
      return { ...response, readyAt: performance.now() };
    }
    assert.equal(response.status, 404, `${size}: HTTP ${response.status}`);
    assert(performance.now() < deadline, `${size} unavailable after 30 minutes`);
    await delay(250);
  }
};
const original = async (asset, token) => {
  const response = await request(`/assets/${asset.id}/original`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(hash(response.bytes), asset.file.sha256, `Original integrity: ${asset.file.name}`);
};
const artifacts = [];
const saveRendition = async (key, size, response) => {
  const metadata = await sharp(response.bytes).metadata();
  assert(metadata.width > 0 && metadata.height > 0);
  const filename = `${key}-${size}.bin`;
  await writeFile(join(output, filename), response.bytes, { flag: 'wx', mode: 0o600 });
  artifacts.push({
    fixture: key,
    size,
    file: filename,
    sha256: hash(response.bytes),
    width: metadata.width,
    height: metadata.height,
  });
};
try {
  await drain();
  const warmToken = await newUser('warmup');
  const warm = await fixture(manifest.grid[0]);
  const warmed = await upload(warm, warmToken);
  await rendition(warmed.id, 'preview', warmToken);
  await drain();
  const search = await json('/search/smart', { query: 'photo' }, warmToken);
  assert(
    search.assets.items.some((item) => item.id === warmed.id),
    'Normal ML smart search must work',
  );
  const config = await json('/system-config', undefined, admin, 'GET');
  await record({
    kind: 'warmup',
    smartSearch: true,
    queuesDrained: true,
    systemConfigSha256: hash(Buffer.from(JSON.stringify(config))),
    ffmpegPolicy: config.ffmpeg.transcode,
    image: config.image,
  });
  const photos = await pool(manifest.photos, 2, fixture);
  for (const concurrency of [1, 4, 8]) {
    await drain();
    const token = await newUser(`batch-${concurrency}`);
    const uploadAgent = agent(concurrency);
    const pending = [];
    const start = performance.now();
    const assets = await pool(photos, concurrency, async (file) => {
      const asset = await upload(file, token, uploadAgent);
      pending.push(
        Promise.all(['preview', 'thumbnail'].map((size) => rendition(asset.id, size, token))).then(
          ([preview, thumbnail]) => ({ asset, preview, thumbnail }),
        ),
      );
      return asset;
    });
    const uploadWallMs = performance.now() - start;
    const ready = await Promise.all(pending);
    const allReadyMs = Math.max(...ready.flatMap((item) => [item.preview.readyAt, item.thumbnail.readyAt])) - start;
    await drain();
    const mlDoneMs = performance.now() - start;
    await pool(assets, 4, (asset) => original(asset, token));
    for (const item of ready)
      for (const size of ['preview', 'thumbnail'])
        await saveRendition(`batch-c${concurrency}-${item.asset.file.name}`, size, item[size]);
    await record({
      kind: 'batch',
      concurrency,
      photos: 20,
      bytes: photos.reduce((sum, file) => sum + file.bytes, 0),
      uploadWallMs,
      allReadyMs,
      mlDoneMs,
      mlCompletionDefinition:
        'All normal queues drained after every derivative is available; includes ML and downstream jobs.',
      originalIntegrity: true,
      pollingIntervalMs: 250,
    });
    await drain();
  }
  const singleToken = await newUser('single');
  const single = await upload(photos[0], singleToken);
  const singlePreview = await rendition(single.id, 'preview', singleToken);
  const previewReadyMs = singlePreview.readyAt - single.start;
  await original(single, singleToken);
  await saveRendition(`single-${single.file.name}`, 'preview', singlePreview);
  await record({ kind: 'single', uploadMs: single.uploadMs, previewReadyMs, originalIntegrity: true });
  await drain();
  const gridToken = await newUser('grid');
  const gridUploadAgent = agent(8);
  const gridAssets = await pool(manifest.grid, 8, async (file) => {
    const asset = await upload(await fixture(file), gridToken, gridUploadAgent);
    await rendition(asset.id, 'thumbnail', gridToken);
    await original(asset, gridToken);
    return asset;
  });
  await drain();
  const gridAgent = agent(6);
  let cold;
  for (const cache of ['cold', 'warm']) {
    const start = performance.now();
    const responses = await pool(gridAssets, 6, async (asset, i) => {
      const response = await request(`/assets/${asset.id}/thumbnail?size=thumbnail`, {
        connectionAgent: gridAgent,
        headers: {
          authorization: `Bearer ${gridToken}`,
          ...(cache === 'warm' ? { 'if-none-match': cold[i].headers.etag } : {}),
        },
      });
      assert.equal(response.status, cache === 'warm' ? 304 : 200);
      assert(response.headers.etag);
      if (cache === 'warm') assert.equal(response.bytes.length, 0);
      return response;
    });
    const wallMs = performance.now() - start;
    assert(responses.every((response) => Number.isInteger(response.localPort)));
    assert.equal(
      new Set(responses.map((response) => response.localPort)).size,
      6,
      'Grid must use exactly six keep-alive connections',
    );
    if (cache === 'cold') cold = responses;
    await record({
      kind: 'grid',
      cache,
      thumbnails: 200,
      connectionLimit: 6,
      connectionsUsed: new Set(responses.map((response) => response.localPort)).size,
      reusedConnections: responses.filter((response) => response.reusedSocket).length,
      wallMs,
      requestsPerSecond: 200_000 / wallMs,
      p95Ms: percentile(
        responses.map((response) => response.milliseconds),
        0.95,
      ),
      responseBytes: responses.reduce((sum, response) => sum + response.bytes.length, 0),
      status: cache === 'warm' ? 304 : 200,
      originalIntegrity: true,
    });
  }
  for (let i = 0; i < cold.length; i++) await saveRendition(`grid-${i}`, 'thumbnail', cold[i]);
  const videoToken = await newUser('video');
  const video = await upload(await fixture(manifest.video), videoToken);
  const [videoPreview, videoThumbnail] = await Promise.all(
    ['preview', 'thumbnail'].map((size) => rendition(video.id, size, videoToken)),
  );
  await record({
    kind: 'video-ready',
    uploadMs: video.uploadMs,
    previewReadyMs: videoPreview.readyAt - video.start,
    thumbnailReadyMs: videoThumbnail.readyAt - video.start,
    allReadyMs: Math.max(videoPreview.readyAt, videoThumbnail.readyAt) - video.start,
    width: 3840,
    height: 2160,
  });
  await original(video, videoToken);
  await saveRendition('video-4k', 'preview', videoPreview);
  await saveRendition('video-4k', 'thumbnail', videoThumbnail);
  await drain();
  const playbackAgent = agent(1);
  const playbackHeaders = { authorization: `Bearer ${videoToken}` };
  let seed = 20261026;
  for (let sample = 0; sample < 16; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const offset = seed % (video.file.bytes - 65536);
    const response = await request(`/assets/${video.id}/video/playback`, {
      headers: { ...playbackHeaders, range: `bytes=${offset}-${offset + 65535}` },
      connectionAgent: playbackAgent,
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers['content-range'], `bytes ${offset}-${offset + 65535}/${video.file.bytes}`);
    assert(response.bytes.equals(video.file.data.subarray(offset, offset + 65536)));
    await record({
      kind: 'seek',
      sample,
      offset,
      bytes: response.bytes.length,
      ttfbMs: response.ttfbMs,
      milliseconds: response.milliseconds,
      integrity: true,
    });
  }
  for (let sample = 0; sample < 3; sample++) {
    const response = await request(`/assets/${video.id}/video/playback`, {
      headers: playbackHeaders,
      connectionAgent: playbackAgent,
    });
    assert.equal(response.status, 200);
    assert.equal(hash(response.bytes), video.file.sha256, 'Compatible H.264 playback must retain original bytes');
    await record({
      kind: 'transfer',
      sample,
      bytes: response.bytes.length,
      milliseconds: response.milliseconds,
      mibPerSecond: response.bytes.length / 1048576 / (response.milliseconds / 1000),
      integrity: true,
    });
  }
  await drain();
  await writeFile(
    join(output, 'artifacts.json'),
    JSON.stringify({ label, manifestSha256: hash(await readFile(manifestPath)), artifacts }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await record({
    kind: 'parity',
    originalIntegrity: true,
    smartSearch: true,
    queuesDrained: true,
    failedJobs: 0,
    artifactCount: artifacts.length,
  });
} finally {
  for (const connectionAgent of agents) connectionAgent.destroy();
}
