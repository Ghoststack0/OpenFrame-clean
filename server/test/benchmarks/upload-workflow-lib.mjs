import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

// Stop scheduling on failure, but let every in-flight request finish before cleanup.
export async function runBounded(items, concurrency, operation) {
  assert(Number.isInteger(concurrency) && concurrency > 0);
  let next = 0;
  let failed = false;
  const values = new Array(items.length);
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          values[index] = await operation(items[index], index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return values;
}

export async function sha256(body) {
  const hash = createHash('sha256');
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
}

export function parseProcStat(contents) {
  // comm can contain spaces and parentheses. Fields after its closing ')' start at field 3.
  const fields = contents
    .slice(contents.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  assert(fields.length >= 22, 'Truncated /proc stat');
  const ticks = Number(fields[11]) + Number(fields[12]);
  const startTime = fields[19];
  const rssPages = Number(fields[21]);
  assert(Number.isFinite(ticks) && Number.isFinite(rssPages));
  return { ticks, startTime, rssPages };
}

export async function monitorProcesses(roots) {
  assert(process.platform === 'linux', 'Process-tree metrics require Linux /proc');
  assert(roots.length > 0 && roots.every((pid) => Number.isInteger(pid) && pid > 0));
  const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const pageSize = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
  assert(ticksPerSecond > 0 && pageSize > 0);
  const previous = new Map();
  let cpuTicks = 0;
  let peakRssBytes = 0;
  let samples = 0;
  const sample = async () => {
    const visited = new Set();
    let rss = 0;
    const visit = async (pid) => {
      if (visited.has(pid)) return;
      visited.add(pid);
      try {
        const stat = parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
        const key = `${pid}:${stat.startTime}`;
        const before = previous.get(key);
        if (before !== undefined) cpuTicks += Math.max(0, stat.ticks - before);
        else if (samples > 0) cpuTicks += stat.ticks;
        previous.set(key, stat.ticks);
        rss += stat.rssPages * pageSize;
        // Worker threads can spawn exiftool/FFmpeg children from a non-leader task.
        const tasks = await readdir(`/proc/${pid}/task`);
        await Promise.all(
          tasks.map(async (tid) => {
            try {
              const children = (await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8')).trim();
              if (children) await Promise.all(children.split(/\s+/).map((child) => visit(Number(child))));
            } catch (error) {
              if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
            }
          }),
        );
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
        assert(!roots.includes(pid), `Measured root process ${pid} exited`);
      }
    };
    await Promise.all(roots.map(visit));
    peakRssBytes = Math.max(peakRssBytes, rss);
    samples++;
  };
  await sample();
  let pending = Promise.resolve();
  let failure;
  const timer = setInterval(() => {
    pending = pending.then(sample).catch((error) => {
      failure ??= error;
    });
  }, 100);
  const snapshot = async () => {
    await pending;
    if (failure) throw failure;
    await sample();
    return { cpuMs: (cpuTicks / ticksPerSecond) * 1000, peakRssBytes, samples, rootPids: roots };
  };
  return {
    snapshot,
    async stop() {
      clearInterval(timer);
      return snapshot();
    },
  };
}
