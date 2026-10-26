// Run from server: node test/benchmarks/video-stream.mjs [output.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { cpus, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const directory = await fs.mkdtemp(join(tmpdir(), 'openframe-video-stream-'));
const filename = join(directory, 'video.mp4');
const content = Buffer.alloc(32 * 1024 * 1024, 37);
const expectedHash = createHash('sha256').update(content).digest('hex');
await fs.writeFile(filename, content);
const app = express();
app.get('/:variant', (req, res) => {
  const options = req.params.variant === 'candidate' ? { highWaterMark: 256 * 1024 } : {};
  res.sendFile(filename, options);
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const samples = [];
const download = async (variant, verifyHash = false) => {
  const response = await fetch(`${base}/${variant}`);
  assert.equal(response.status, 200);
  const hash = verifyHash ? createHash('sha256') : undefined;
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    hash?.update(chunk);
  }
  assert.equal(bytes, content.length);
  if (hash) {
    assert.equal(hash.digest('hex'), expectedHash);
  }
};
try {
  for (const variant of ['baseline', 'candidate']) {
    await download(variant, true);
    const range = await fetch(`${base}/${variant}`, { headers: { Range: 'bytes=262140-262150' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), content.subarray(262140, 262151));
  }
  for (let round = 0; round < 6; round++) {
    for (const variant of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const cpu = process.cpuUsage();
      const start = performance.now();
      for (let index = 0; index < 8; index++) {
        await download(variant);
      }
      const elapsed = performance.now() - start;
      const used = process.cpuUsage(cpu);
      samples.push({ round, variant, bytes: content.length * 8, ms: elapsed, cpuMs: (used.user + used.system) / 1000 });
    }
  }
  const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return (sorted[2] + sorted[3]) / 2;
  };
  const summary = ['baseline', 'candidate'].map((variant) => {
    const selected = samples.filter((sample) => sample.variant === variant);
    return {
      variant,
      medianMs: median(selected.map((sample) => sample.ms)),
      medianCpuMs: median(selected.map((sample) => sample.cpuMs)),
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    platform: { node: process.version, os: process.platform, release: release(), cpu: cpus()[0]?.model },
    method:
      'Real Express sendFile, default 64 KiB versus 256 KiB reads, six alternating paired rounds, eight sequential 32 MiB transfers per sample, warmed filesystem cache, SHA256 verification during warmup, byte count checked on every timed response. CPU includes both HTTP server and client. No authentication, database, TLS, network shaping, or power measurement.',
    summary,
    samples,
  };
  if (process.argv[2]) {
    await fs.writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
