import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { monitorProcesses, parseProcStat, runBounded, sha256 } from './upload-workflow-lib.mjs';

test('bounded requests keep order and never exceed the selected concurrency', async () => {
  let active = 0;
  let peak = 0;
  const values = await runBounded([1, 2, 3, 4, 5], 4, async (value) => {
    peak = Math.max(peak, ++active);
    await delay(6 - value);
    active--;
    return value * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.equal(peak, 4);
});

test('a failing request stops scheduling and waits for in-flight work', async () => {
  const started = [];
  let settled = false;
  await assert.rejects(
    runBounded([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) throw new Error('failed request');
      await delay(10);
      settled = true;
    }),
    /failed request/,
  );
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, true);
});

test('streamed integrity checks hash every byte', async () => {
  const bytes = Buffer.from('original image\0bytes');
  assert.equal(
    await sha256([bytes.subarray(0, 4), bytes.subarray(4)]),
    createHash('sha256').update(bytes).digest('hex'),
  );
});

test('proc stat accepts command names containing spaces and parentheses', () => {
  const fields = Array.from({ length: 22 }, () => '0');
  fields[11] = '12';
  fields[12] = '3';
  fields[19] = '12345';
  fields[21] = '7';
  assert.deepEqual(parseProcStat(`123 (a ) long command) ${fields.join(' ')}`), {
    ticks: 15,
    startTime: '12345',
    rssPages: 7,
  });
});

test('Linux process metrics measure a real process and stop sampling', async () => {
  const monitor = await monitorProcesses([process.pid]);
  const end = performance.now() + 40;
  while (performance.now() < end) createHash('sha256').update('cpu work').digest();
  const stats = await monitor.stop();
  assert(stats.cpuMs >= 10);
  assert(stats.peakRssBytes > 0);
  assert(stats.samples >= 2);
});
