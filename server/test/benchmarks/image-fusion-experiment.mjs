// A color-equality diagnostic, not a production optimization or a controlled timing benchmark.
// Usage: node test/benchmarks/image-fusion-experiment.mjs OUTPUT.json SAMPLE...
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { MediaRepository } from '../../dist/repositories/media.repository.js';

class Fused extends MediaRepository {
  decodeImage(input, options) {
    assert(options.size && !options.orientation);
    return this.getImageDecodingPipeline(input, options)
      .pipelineColorspace('scrgb')
      .resize(options.size, options.size, { fit: 'outside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  }
}
const [output, ...samples] = process.argv.slice(2);
assert(output && samples.length, 'Expected OUTPUT.json SAMPLE...');
const directory = await mkdtemp(join(tmpdir(), 'ofv-fused-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const results = [];
try {
  for (const path of samples) {
    const bytes = await readFile(path);
    const encoded = [];
    const milliseconds = [];
    for (const Repository of [MediaRepository, Fused]) {
      const repository = new Repository({ setContext() {} });
      const options = { colorspace: 'srgb', processInvalidImages: false, size: 1440, format: 'jpeg', quality: 80 };
      const start = performance.now();
      const decoded = await repository.decodeImage(bytes, options);
      const target = join(directory, `${Repository.name}.jpg`);
      await repository.generateThumbnail(decoded, options, target);
      milliseconds.push(performance.now() - start);
      encoded.push(await readFile(target));
    }
    const a = await sharp(encoded[0]).raw().toBuffer();
    const b = await sharp(encoded[1]).raw().toBuffer();
    assert.equal(a.length, b.length);
    let squared = 0,
      differing = 0,
      maximum = 0;
    for (let i = 0; i < a.length; i++) {
      const difference = Math.abs(a[i] - b[i]);
      squared += difference * difference;
      differing += difference > 0;
      maximum = Math.max(maximum, difference);
    }
    results.push({
      sample: basename(path),
      inputSha256: hash(bytes),
      encodedEqual: hash(encoded[0]) === hash(encoded[1]),
      baselineMs: milliseconds[0],
      fusedMs: milliseconds[1],
      differingChannelSamples: differing,
      totalChannelSamples: a.length,
      maxChannelDifference: maximum,
      psnr: squared === 0 ? 'infinity' : 10 * Math.log10((255 * 255) / (squared / a.length)),
    });
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        node: process.version,
        vips: sharp.versions.vips,
        timingLimit: 'Single baseline-first diagnostic per file on development host; no speed claim.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(results.map(({ sample, encodedEqual }) => `${sample}: encoded equality=${encodedEqual}`).join('\n'));
} finally {
  await rm(directory, { recursive: true, force: true });
}
