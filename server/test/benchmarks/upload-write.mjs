// Run after building the server: node test/benchmarks/upload-write.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageRepository } from '../../dist/repositories/storage.repository.js';

const storage = new StorageRepository({ setContext() {} });
const folder = await mkdtemp(join(tmpdir(), 'openframe-upload-write-'));
const chunk = Buffer.alloc(64 * 1024, 123);
const count = 4096;
const expectedHash = createHash('sha1');
for (let index = 0; index < count; index++) expectedHash.update(chunk);
const checksum = expectedHash.digest('hex');

try {
  for (let round = 0; round < 6; round++) {
    const versions = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (const version of versions) {
      const path = join(folder, 'asset');
      const output =
        version === 'baseline' ? createWriteStream(path, { flags: 'w', flush: true }) : storage.createWriteStream(path);
      const hash = createHash('sha1');
      const input = Readable.from(
        (function* () {
          for (let index = 0; index < count; index++) yield chunk;
        })(),
      );
      input.on('data', (data) => hash.update(data));
      const cpu = process.cpuUsage();
      const start = performance.now();
      await pipeline(input, output);
      const milliseconds = performance.now() - start;
      const usage = process.cpuUsage(cpu);
      assert.equal(hash.digest('hex'), checksum);
      // Check stored bytes outside the timed region, including the durable close.
      const storedHash = createHash('sha1');
      for await (const data of createReadStream(path)) storedHash.update(data);
      assert.equal(storedHash.digest('hex'), checksum);
      console.log(
        JSON.stringify({
          round,
          version,
          bytes: chunk.length * count,
          milliseconds,
          cpu: usage,
          node: process.version,
          platform: process.platform,
          writeHighWaterMark: output.writableHighWaterMark,
        }),
      );
    }
  }
} finally {
  await rm(folder, { recursive: true, force: true });
}
