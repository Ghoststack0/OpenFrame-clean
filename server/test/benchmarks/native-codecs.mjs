// Build server first. Usage: node test/benchmarks/native-codecs.mjs OUTPUT.json SAMPLE...
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { MediaRepository } from '../../dist/repositories/media.repository.js';

class Baseline extends MediaRepository {
  transform(image, { size, fit = 'outside', edits = [] }) {
    if (!size && edits.length === 0) return Promise.resolve(image);
    return this.edit(this.raw(image).pipelineColorspace('scrgb'), edits)
      .resize(size, size, { fit, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  }
}
const [output, ...samples] = process.argv.slice(2);
assert(output && samples.length, 'Expected OUTPUT.json SAMPLE...');
const logger = { setContext() {} };
const directory = await mkdtemp(join(tmpdir(), 'openframe-codecs-'));
const results = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  for (const path of samples) {
    const bytes = await readFile(path);
    const result = { sample: basename(path), bytes: bytes.length, sha256: hash(bytes) };
    try {
      const metadata = await sharp(bytes).metadata();
      result.metadata = {
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        space: metadata.space,
        depth: metadata.depth,
        hasProfile: metadata.hasProfile,
      };
      const hashes = [];
      for (const Repository of [Baseline, MediaRepository]) {
        const repository = new Repository(logger);
        const options = { colorspace: 'srgb', processInvalidImages: false, size: 1440, format: 'jpeg', quality: 80 };
        const decoded = await repository.decodeImage(bytes, options);
        const target = join(directory, `${Repository.name}.jpg`);
        await repository.generateThumbnail(decoded, options, target);
        hashes.push(hash(await readFile(target)));
      }
      assert.equal(hashes[1], hashes[0], 'Encoded preview changed from original transform');
      result.previewSha256 = hashes[1];
      result.status = 'identical-preview';
    } catch (error) {
      result.status = 'failed';
      result.error = error.message;
      process.exitCode = 1;
    }
    results.push(result);
  }
  await writeFile(output, JSON.stringify({ node: process.version, versions: sharp.versions, results }, null, 2) + '\n');
  console.log(results.map(({ sample, status }) => `${sample}: ${status}`).join('\n'));
} finally {
  await rm(directory, { recursive: true, force: true });
}
