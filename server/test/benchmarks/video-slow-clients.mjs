// Build first; run from server: node test/benchmarks/video-slow-clients.mjs [report.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { sendFile } from '../../dist/utils/file.js';
import { CacheControl } from '../../dist/enum.js';

const folder = await mkdtemp(join(tmpdir(), 'openframe-slow-clients-'));
const filename = join(folder, 'video.mp4');
const content = Buffer.alloc(8 * 1024 * 1024, 37);
const expected = createHash('sha256').update(content).digest('hex');
await writeFile(filename, content);
const app = express();
let active = 0;
app.get('/:variant', (req, res, next) => {
  active++;
  res.once('close', () => active--);
  if (req.params.variant === 'baseline') {
    res.sendFile(filename);
  } else {
    void sendFile(res, next, () => ({ path: filename, contentType: 'video/mp4', cacheControl: CacheControl.None }), {
      warn() {},
      error() {},
      debug() {},
      verbose() {},
    });
  }
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const download = (variant, abort = false) =>
  new Promise((resolve, reject) => {
    const request = http.get(`${url}/${variant}`, (response) => {
      assert.equal(response.statusCode, 200);
      const hash = createHash('sha256');
      let bytes = 0;
      response.on('error', (error) => {
        if (!abort) reject(error);
      });
      response.on('data', (chunk) => {
        if (abort) {
          response.destroy();
          resolve();
          return;
        }
        bytes += chunk.length;
        hash.update(chunk);
        response.pause();
        setTimeout(() => response.resume(), 2);
      });
      response.on('end', () => {
        assert.equal(bytes, content.length);
        assert.equal(hash.digest('hex'), expected);
        resolve();
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error('Slow-client check timed out')));
    request.on('error', reject);
  });
const samples = [];
try {
  for (let round = 0; round < 2; round++) {
    for (const variant of round ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const initial = process.memoryUsage();
      let peakRss = initial.rss;
      let peakArrayBuffers = initial.arrayBuffers;
      const timer = setInterval(() => {
        const memory = process.memoryUsage();
        peakRss = Math.max(peakRss, memory.rss);
        peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
      }, 5);
      const start = performance.now();
      try {
        await Promise.all(Array.from({ length: 16 }, () => download(variant)));
        await Promise.all(Array.from({ length: 16 }, () => download(variant, true)));
        for (let attempt = 0; active && attempt < 100; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(active, 0, 'Responses remain active after completion/abort');
        samples.push({
          round,
          variant,
          ms: performance.now() - start,
          initial,
          peakRss,
          peakArrayBuffers,
          final: process.memoryUsage(),
        });
      } finally {
        clearInterval(timer);
      }
    }
  }
  const report = {
    node: process.version,
    method:
      '16 simultaneous 8 MiB HTTP clients pausing 2ms per received chunk; SHA256 checked; then 16 early-aborted clients. Two alternating paired rounds. Candidate uses the actual built sendFile helper. Memory includes server and clients, GC is uncontrolled; this is a cleanup/integrity stress check, not a production memory bound or throughput claim.',
    samples,
  };
  if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
