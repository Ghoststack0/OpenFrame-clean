import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('./results/', import.meta.url);
const runs = await Promise.all(
  [1, 2, 3].map(async (run) =>
    JSON.parse(await readFile(new URL(`upload-check-linux-run-${run}.json`, directory), 'utf8')),
  ),
);
const median = (values) => values.toSorted((a, b) => a - b)[1];
const results = runs[0].results.map(({ count, duplicateFraction }, index) => {
  const samples = runs.map((run) => {
    const result = run.results[index];
    if (result.count !== count || result.duplicateFraction !== duplicateFraction)
      throw new Error('Mismatched workloads');
    const baselineMs = result.medians.find((row) => row.version === 'baseline').elapsedMs;
    const candidateMs = result.medians.find((row) => row.version === 'candidate').elapsedMs;
    return { baselineMs, candidateMs, reductionPercent: 100 * (1 - candidateMs / baselineMs) };
  });
  return {
    count,
    duplicateFraction,
    baselineMedianMs: median(samples.map((sample) => sample.baselineMs)),
    candidateMedianMs: median(samples.map((sample) => sample.candidateMs)),
    medianReductionPercent: median(samples.map((sample) => sample.reductionPercent)),
    minReductionPercent: Math.min(...samples.map((sample) => sample.reductionPercent)),
    maxReductionPercent: Math.max(...samples.map((sample) => sample.reductionPercent)),
  };
});
const summary = {
  benchmark: runs[0].benchmark,
  baselineRelease: runs[0].release,
  candidate: runs[0].candidate,
  runFiles: [1, 2, 3].map((run) => `upload-check-linux-run-${run}.json`),
  note: 'Median of three per-process medians; reduction range is observed process variation, not a confidence interval. Runs 2 and 3 overlapped dependency copying on the host. No whole-app or transfer-throughput conclusion.',
  results,
};
await writeFile(new URL('upload-check-linux-summary.json', directory), JSON.stringify(summary, null, 2) + '\n');
console.table(results);
