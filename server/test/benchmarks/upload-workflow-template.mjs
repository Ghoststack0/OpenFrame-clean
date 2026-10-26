import assert from 'node:assert/strict';
// node upload-workflow-template.mjs URL LANDSCAPE.jpg ADMIN.json TRACE.jsonl MEDIA_DIRECTORY RESULT.json
import sharp from 'sharp';
import { resolve, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [origin, input, adminPath, tracePath, mediaDirectory, output] = process.argv.slice(2);
assert(
  origin && input && adminPath && tracePath && mediaDirectory && output,
  'Expected URL LANDSCAPE.jpg ADMIN.json TRACE.jsonl MEDIA_DIRECTORY RESULT.json',
);
const url = new URL(origin);
assert(url.hostname === '127.0.0.1' && url.protocol === 'http:', 'Loopback HTTP only');
const endpoint = (path) => new URL(`/api${path}`, url);
const metadata = await sharp(input).metadata();
assert(metadata.format === 'jpeg' && metadata.width > metadata.height, 'Use a landscape JPEG fixture');
const credentials = JSON.parse(await readFile(adminPath));
const call = async (path, body, token) => {
  const res = await fetch(endpoint(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert([200, 201].includes(res.status), `${path}: ${res.status}`);
  return res.json();
};
const admin = (await call('/auth/login', credentials)).accessToken;
const user = {
  email: `enabled-${randomBytes(8).toString('hex')}@example.invalid`,
  name: 'Enabled template check',
  password: randomBytes(32).toString('hex'),
};
await call('/admin/users', user, admin);
const token = (await call('/auth/login', user)).accessToken;
const headers = { authorization: `Bearer ${token}` };
const bytes = await sharp(input).withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer();
const body = new FormData();
body.set('fileCreatedAt', '2026-01-01T00:00:00.000Z');
body.set('fileModifiedAt', '2026-01-01T00:00:00.000Z');
body.set('assetData', new Blob([bytes]), 'oriented.jpg');
body.set(
  'sidecarData',
  new Blob([
    `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">Sidecar check</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
  ]),
  'oriented.xmp',
);
const res = await fetch(endpoint('/assets'), { method: 'POST', headers, body });
assert.equal(res.status, 201);
const asset = await res.json();
let preview;
for (let i = 0; i < 600; i++) {
  const r = await fetch(endpoint(`/assets/${asset.id}/thumbnail?size=preview`), { headers });
  const data = Buffer.from(await r.arrayBuffer());
  if (r.status === 200) {
    preview = await sharp(data).metadata();
    break;
  }
  assert.equal(r.status, 404);
  await delay(100);
}
assert(preview);
assert(preview.height > preview.width, 'Orientation must rotate the landscape source');
const detail = await fetch(endpoint(`/assets/${asset.id}`), { headers }).then((r) => r.json());
assert.equal(detail.exifInfo.orientation, '6');
assert.equal(detail.exifInfo.description, 'Sidecar check');
const original = await fetch(endpoint(`/assets/${asset.id}/original`), { headers });
assert.equal(original.status, 200);
assert(Buffer.from(await original.arrayBuffer()).equals(bytes));
const prechecked = await fetch(endpoint('/assets'), {
  method: 'POST',
  headers: { ...headers, 'x-immich-checksum': createHash('sha1').update(bytes).digest('base64') },
});
assert.equal(prechecked.status, 200);
assert.equal((await prechecked.json()).id, asset.id);
const stages = (await readFile(tracePath, 'utf8'))
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((r) => r.assetId === asset.id);
const migration = stages.find((r) => r.kind === 'span' && r.stage === 'storageTemplate.handleMigrationSingle');
const thumbnails = stages.find((r) => r.kind === 'job.start' && r.jobName === 'AssetGenerateThumbnails');
assert(migration && thumbnails);
assert(thumbnails.atMs >= migration.endMs, 'Thumbnail work must start after migration');
const moved = resolve(detail.originalPath);
assert(
  moved.startsWith(resolve(mediaDirectory, 'library') + sep),
  'Original must move into the template library folder',
);
assert((await readFile(moved)).equals(bytes));
await writeFile(
  output,
  JSON.stringify(
    {
      assetId: asset.id,
      orientation: 6,
      sidecarMetadata: true,
      originalBytes: true,
      checksumHeaderDuplicate: true,
      migrationBeforeThumbnails: true,
      movedIntoLibrary: true,
      previewWidth: preview.width,
      previewHeight: preview.height,
    },
    null,
    2,
  ),
);
console.log(
  'Enabled-template HTTP check passed: real migration, orientation, sidecar metadata, exact original and checksum duplicate',
);
