import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { AssetMediaService } from '/usr/src/app/server/dist/services/asset-media.service.js';
import { Candidate } from './candidate.mjs';

const auth = { user: { id: 'synthetic-owner' } };
const baseline = Object.create(AssetMediaService.prototype);
const candidate = new Candidate();
let rows = [];
let expectedChecksums;
let verifyRepository = false;
const repository = {
  async getByChecksums(ownerId, checksums) {
    if (verifyRepository) {
      assert.equal(ownerId, auth.user.id);
      assert.deepEqual(checksums, expectedChecksums);
    }
    return rows;
  },
};
baseline.assetRepository = candidate.assetRepository = repository;
const implementations = { baseline, candidate };
const checksum = createHash('sha1').update('synthetic-known').digest();
const other = createHash('sha1').update('synthetic-new').digest();
const dto = {
  assets: [
    { id: 'upper', checksum: checksum.toString('hex').toUpperCase() },
    { id: 'new', checksum: other.toString('base64') },
    { id: 'repeated', checksum: checksum.toString('base64') },
  ],
};
const expected = {
  results: [
    { id: 'upper', action: 'reject', reason: 'duplicate', assetId: 'known', isTrashed: true },
    { id: 'new', action: 'accept' },
    { id: 'repeated', action: 'reject', reason: 'duplicate', assetId: 'known', isTrashed: true },
  ],
};
verifyRepository = true;
expectedChecksums = [checksum, other, checksum];
rows = [{ id: 'known', checksum, deletedAt: new Date('2026-01-01T00:00:00Z') }];
for (const service of Object.values(implementations)) {
  assert.deepEqual(await service.bulkUploadCheck(auth, dto), expected);
  rows[0].deletedAt = null;
  const active = structuredClone(expected);
  active.results[0].isTrashed = active.results[2].isTrashed = false;
  assert.deepEqual(await service.bulkUploadCheck(auth, dto), active);
  rows[0].deletedAt = new Date('2026-01-01T00:00:00Z');
  expectedChecksums = [];
  assert.deepEqual(await service.bulkUploadCheck(auth, { assets: [] }), { results: [] });
  expectedChecksums = [checksum, other, checksum];
}
verifyRepository = false;
const decodeCounts = {};
for (const [version, service] of Object.entries(implementations)) {
  const original = Buffer.from;
  let calls = 0;
  try {
    Buffer.from = (...args) => {
      calls++;
      return original(...args);
    };
    await service.bulkUploadCheck(auth, dto);
  } finally {
    Buffer.from = original;
  }
  decodeCounts[version] = calls;
}
assert.equal(decodeCounts.baseline, dto.assets.length * 2);
if (process.argv.includes('--require-single-decode')) assert.equal(decodeCounts.candidate, dto.assets.length);
const warmupRounds = 5;
const measuredRounds = 30;
const results = [];
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
for (const count of [100, 1000, 10000]) {
  const buffers = Array.from({ length: count }, (_, i) => createHash('sha1').update(`synthetic-${i}`).digest());
  const input = {
    assets: buffers.map((buffer, i) => ({
      id: `client-${i}`,
      checksum: buffer.toString(i % 2 === 0 ? 'hex' : 'base64'),
    })),
  };
  for (const duplicateFraction of [0, 0.5, 1]) {
    rows = buffers.slice(0, count * duplicateFraction).map((checksum, i) => ({
      id: `stored-${i}`,
      checksum,
      deletedAt: i % 2 ? null : new Date('2026-01-01T00:00:00Z'),
    }));
    assert.deepEqual(await candidate.bulkUploadCheck(auth, input), await baseline.bulkUploadCheck(auth, input));
    const iterations = Math.max(2, Math.floor(2000 / count));
    const samples = [];
    for (let round = -warmupRounds; round < measuredRounds; round++) {
      const order = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const version of order) {
        const started = performance.now();
        for (let i = 0; i < iterations; i++) await implementations[version].bulkUploadCheck(auth, input);
        const elapsedMs = (performance.now() - started) / iterations;
        if (round >= 0) samples.push({ round, version, elapsedMs });
      }
    }
    results.push({
      count,
      duplicateFraction,
      iterations,
      samples,
      medians: Object.keys(implementations).map((version) => ({
        version,
        elapsedMs: median(samples.filter((s) => s.version === version).map((s) => s.elapsedMs)),
      })),
    });
  }
}
const result = {
  benchmark: 'AssetMediaService.bulkUploadCheck CPU with an in-memory repository',
  recordedAt: new Date().toISOString(),
  baseline: JSON.parse(await readFile('/bench/upstream-image.json', 'utf8')),
  release: JSON.parse(await readFile('/bench/upstream-release.json', 'utf8')),
  candidate: JSON.parse(await readFile('/bench/candidate-source.json', 'utf8')),
  host: JSON.parse(await readFile('/bench/host.json', 'utf8')),
  runtime: { node: process.version, kernel: release(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem() },
  behavior:
    'Passed mixed encodings, uppercase hex, repeated checksum, original request order, active/trashed duplicates, empty request, owner/checksum repository arguments, and differential output checks for every workload.',
  method: {
    warmupRounds,
    measuredRounds,
    order: 'Alternates baseline/candidate first each round',
    timing: 'Batch mean per invocation; medians across batches. Assertions and fixture generation excluded.',
    limitations:
      'CPU microbenchmark only. Repository returns synthetic rows without SQL/network/I/O. No HTTP upload throughput, mobile connectivity, TLS, database, decoding, or whole-app speed claim. Warm process, shared host, no resource reservation or confidence interval. Candidate is the actual working-tree method compiled in isolation with upstream helper/enums; baseline is the actual stable image service method.',
  },
  decodeCounts,
  results,
};
await writeFile('/bench/result.json', JSON.stringify(result, null, 2) + '\n');
console.table(
  results.map(({ count, duplicateFraction, medians }) => ({
    count,
    duplicateFraction,
    baselineMs: medians[0].elapsedMs,
    candidateMs: medians[1].elapsedMs,
    reductionPercent: 100 * (1 - medians[1].elapsedMs / medians[0].elapsedMs),
  })),
);
