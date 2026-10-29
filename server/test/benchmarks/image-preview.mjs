// Build the server first, then run: node test/benchmarks/image-preview.mjs
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { MediaRepository } from '../../dist/repositories/media.repository.js';

class Baseline extends MediaRepository {
  // Snapshot of the original transform; encoding and decoding use the actual repository.
  transform(image, { size, fit = 'outside', edits = [] }) {
    if (!size && edits.length === 0) return Promise.resolve(image);
    return this.edit(this.raw(image).pipelineColorspace('scrgb'), edits)
      .resize(size, size, { fit, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  }
}

const logger = { setContext() {} };
const repositories = { baseline: new Baseline(logger), candidate: new MediaRepository(logger) };
const input = await sharp(randomBytes(4000 * 3000 * 3), { raw: { width: 4000, height: 3000, channels: 3 } })
  .jpeg({ quality: 90 })
  .toBuffer();
const folder = await mkdtemp(join(tmpdir(), 'openframe-image-preview-'));
const baseOptions = { colorspace: 'srgb', processInvalidImages: false };
const options = { ...baseOptions, format: 'jpeg', quality: 80, size: 1440 };
const expected = new Map();

try {
  for (let round = -1; round < 6; round++) {
    for (const version of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const repository = repositories[version];
      const path = join(folder, version);
      const cpu = process.cpuUsage();
      const start = performance.now();
      const image = await repository.decodeImage(input, { ...baseOptions, size: options.size });
      await repository.generateThumbnail(image, options, path);
      const milliseconds = performance.now() - start;
      const usage = process.cpuUsage(cpu);
      const hash = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      if (!expected.has('hash')) expected.set('hash', hash);
      assert.equal(hash, expected.get('hash'), 'Encoded preview bytes differ from baseline');
      if (round >= 0) console.log(JSON.stringify({ round, version, milliseconds, cpu: usage, node: process.version }));
    }
  }
} finally {
  await rm(folder, { recursive: true, force: true });
}
