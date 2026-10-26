// node upload-workflow-analyze.mjs WORKFLOW.jsonl TRACE.jsonl OUTPUT.json
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const [workflowPath, tracePath, output] = process.argv.slice(2);
assert(workflowPath && tracePath && output, 'Expected WORKFLOW.jsonl TRACE.jsonl OUTPUT.json');
const load = async (path) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const workflow = await load(workflowPath);
const trace = await load(tracePath);
for (const batch of workflow.filter((row) => row.kind === 'batch')) {
  const sameCase = (row) =>
    row.label === batch.label &&
    row.round === batch.round &&
    row.workload === batch.workload &&
    row.concurrency === batch.concurrency;
  assert.equal(
    workflow.filter((row) => row.kind === 'asset' && sameCase(row)).length,
    batch.count,
    'Incomplete asset measurements',
  );
  assert(
    workflow.some((row) => row.kind === 'parity' && sameCase(row)),
    'Missing workflow parity result',
  );
}
const round = (value) => Math.round(value * 100) / 100;
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2);
};
const unionMs = (spans) => {
  let total = 0;
  let end = -Infinity;
  for (const span of spans.toSorted((a, b) => a.startMs - b.startMs)) {
    total += Math.max(0, span.endMs - Math.max(span.startMs, end));
    end = Math.max(end, span.endMs);
  }
  return round(total);
};
const byAsset = new Map();
const requestIds = new Map(
  trace.filter((row) => row.requestId && row.assetId).map((row) => [row.requestId, row.assetId]),
);
for (const row of trace) {
  const id = row.assetId ?? requestIds.get(row.requestId);
  if (!id) continue;
  if (!byAsset.has(id)) byAsset.set(id, []);
  byAsset.get(id).push(row);
}
const assets = workflow
  .filter((row) => row.kind === 'asset')
  .map((asset) => {
    const rows = byAsset.get(asset.id);
    assert(rows, `No trace for ${asset.id}`);
    const response = rows.find((row) => row.kind === 'response.finish' && row.httpStatus === 201);
    assert(response, `No successful upload response for ${asset.id}`);
    const requestEnd = rows.find((row) => row.kind === 'request.end' && row.requestId === response.requestId);
    assert(requestEnd, `No request end for ${asset.id}`);
    const relative = (atMs) => round(atMs - requestEnd.atMs);
    const stages = {};
    for (const name of ['AssetExtractMetadata', 'StorageTemplateMigrationSingle', 'AssetGenerateThumbnails']) {
      const start = rows.find((row) => row.kind === 'job.start' && row.jobName === name);
      if (!start) {
        stages[name] = null;
        continue;
      }
      const finish = rows.find(
        (row) => row.kind === 'job.finish' && row.jobName === name && row.bullJobId === start.bullJobId,
      );
      assert(finish, `No finish for ${asset.id}/${name}`);
      stages[name] = {
        queuedMs: relative(start.queuedAtMs),
        startedMs: relative(start.atMs),
        finishedMs: relative(finish.atMs),
        queueWaitMs: round(start.processedOnMs - start.queuedAtMs),
        workWallMs: round(finish.atMs - start.atMs),
      };
    }
    const metadataSpans = rows.filter((row) => row.kind === 'span' && row.jobName === 'AssetExtractMetadata');
    const metadata = metadataSpans.find((row) => row.stage === 'metadata.handleMetadataExtraction');
    assert(metadata, `No metadata span for ${asset.id}`);
    const exiftool = metadataSpans.filter((row) => row.stage.startsWith('exiftool.'));
    const db = metadataSpans.filter((row) => row.stage.startsWith('db.'));
    const writes = db.filter((row) => /\.(?:update|upsert\w*|replaceAssetTags)$/.test(row.stage));
    const firstPreview = rows.find((row) => row.kind === 'preview.firstServed');
    assert(firstPreview, `No preview served for ${asset.id}`);
    return {
      id: asset.id,
      round: asset.round,
      workload: asset.workload,
      concurrency: asset.concurrency,
      fixture: asset.fixture,
      fixtureSha256: asset.fixtureSha256,
      previewSha256: asset.previewSha256,
      requestEndAtMs: requestEnd.atMs,
      requestEndMs: 0,
      responseMs: relative(response.atMs),
      stages,
      metadata: {
        startedMs: relative(metadata.startMs),
        finishedMs: relative(metadata.endMs),
        exiftoolWallMs: unionMs(exiftool),
        databaseWallMs: unionMs(db),
        databaseWriteWallMs: unionMs(writes),
        database: db.map((row) => ({
          stage: row.stage,
          startedMs: relative(row.startMs),
          finishedMs: relative(row.endMs),
        })),
      },
      firstPreviewMs: relative(firstPreview.atMs),
      readyMs: round(asset.readyMs),
    };
  });
const groups = new Map();
for (const row of workflow.filter((row) => row.kind === 'batch')) {
  const key = `${row.workload}/${row.concurrency}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const summary = [...groups].map(([workload, rows]) => ({
  workload,
  samples: rows.length,
  uploadWallMs: rows.map((row) => round(row.uploadWallMs)),
  allPreviewsWallMs: rows.map((row) => round(row.readyWallMs)),
  medianAllPreviewsWallMs: median(rows.map((row) => row.readyWallMs)),
  medianProcessCpuMs: median(rows.map((row) => row.workflowProcesses.cpuMs)),
  maxProcessRssBytes: Math.max(...rows.map((row) => row.workflowProcesses.peakRssBytes)),
}));
await writeFile(output, JSON.stringify({ summary, assets }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
