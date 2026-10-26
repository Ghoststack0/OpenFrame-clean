// Diagnostic preload only: UPLOAD_WORKFLOW_TRACE=/private/trace.jsonl node --import ./test/benchmarks/upload-workflow-trace.mjs dist/main.js
import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { Server } from 'node:http';
import { threadId } from 'node:worker_threads';
import { JobService } from '../../dist/services/job.service.js';
import { MetadataService } from '../../dist/services/metadata.service.js';
import { AssetMediaService } from '../../dist/services/asset-media.service.js';
import { StorageTemplateService } from '../../dist/services/storage-template.service.js';
import { AssetRepository } from '../../dist/repositories/asset.repository.js';
import { AssetJobRepository } from '../../dist/repositories/asset-job.repository.js';
import { MetadataRepository } from '../../dist/repositories/metadata.repository.js';
import { JobRepository } from '../../dist/repositories/job.repository.js';
import { WorkflowRepository } from '../../dist/repositories/workflow.repository.js';
import { TagRepository } from '../../dist/repositories/tag.repository.js';
import { MapRepository } from '../../dist/repositories/map.repository.js';
import { FileUploadInterceptor } from '../../dist/middleware/file-upload.interceptor.js';

const output = process.env.UPLOAD_WORKFLOW_TRACE;
if (!output) throw new Error('UPLOAD_WORKFLOW_TRACE must name a private JSONL output');
const context = new AsyncLocalStorage();
const requests = new WeakMap();
const previews = new Set();
const clock = () => performance.timeOrigin + performance.now();
const write = (event) =>
  appendFileSync(output, JSON.stringify({ pid: process.pid, threadId, ...event }) + '\n', { mode: 0o600 });
function replace(prototype, name, wrapper) {
  const original = prototype[name];
  if (typeof original !== 'function') throw new Error(`Missing traced method ${name}`);
  const wrapped = wrapper(original);
  Object.defineProperty(wrapped, 'name', { value: original.name });
  // Nest discovers job/event handlers using metadata on the method function.
  for (const key of Reflect.getMetadataKeys(original))
    Reflect.defineMetadata(key, Reflect.getMetadata(key, original), wrapped);
  prototype[name] = wrapped;
}
function span(prototype, name, label) {
  replace(
    prototype,
    name,
    (original) =>
      function (...args) {
        const scope = context.getStore();
        if (!scope) return original.apply(this, args);
        const startMs = clock();
        const finish = (failed = false) =>
          write({ ...scope, kind: 'span', stage: label, startMs, endMs: clock(), failed });
        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function')
            return result.then(
              (value) => {
                finish();
                return value;
              },
              (error) => {
                finish(true);
                throw error;
              },
            );
          finish();
          return result;
        } catch (error) {
          finish(true);
          throw error;
        }
      },
  );
}
replace(
  Server.prototype,
  'emit',
  (original) =>
    function (event, ...args) {
      if (event !== 'request') return original.call(this, event, ...args);
      const [request, response] = args;
      const previewId = /^\/api\/assets\/([^/?]+)\/thumbnail\?/.exec(request.url)?.[1];
      if (previewId && new URL(request.url, 'http://localhost').searchParams.get('size') === 'preview') {
        response.once('finish', () => {
          if (response.statusCode === 200 && !previews.has(previewId)) {
            previews.add(previewId);
            write({ kind: 'preview.firstServed', assetId: previewId, atMs: clock() });
          }
        });
      }
      if (request.method !== 'POST' || !/^\/api\/assets\/?(?:\?|$)/.test(request.url))
        return original.call(this, event, ...args);
      const scope = { requestId: `${process.pid}:${threadId}:${clock()}` };
      requests.set(request, scope);
      return context.run(scope, () => {
        write({ ...scope, kind: 'request.start', atMs: clock() });
        request.once('end', () => write({ ...scope, kind: 'request.end', atMs: clock() }));
        response.once('finish', () =>
          write({ ...scope, kind: 'response.finish', atMs: clock(), httpStatus: response.statusCode }),
        );
        return original.call(this, event, ...args);
      });
    },
);
replace(
  FileUploadInterceptor.prototype,
  'handleFile',
  (original) =>
    function (request, ...args) {
      return context.run(requests.get(request) ?? {}, () => original.call(this, request, ...args));
    },
);
replace(
  AssetMediaService.prototype,
  'uploadAsset',
  (original) =>
    async function (...args) {
      const scope = context.getStore();
      const result = await original.apply(this, args);
      if (scope) scope.assetId = result.id;
      write({ ...scope, kind: 'upload.responseReady', assetId: result.id, atMs: clock() });
      return result;
    },
);
replace(
  JobService.prototype,
  'onJobRun',
  (original) =>
    function (queue, job) {
      const scope = { assetId: job.data?.id, jobName: job.name, queue, bullJobId: job.id };
      return context.run(scope, async () => {
        write({
          ...scope,
          kind: 'job.start',
          atMs: clock(),
          queuedAtMs: job.timestamp,
          processedOnMs: job.processedOn,
        });
        try {
          return await original.call(this, queue, job);
        } finally {
          write({ ...scope, kind: 'job.finish', atMs: clock() });
        }
      });
    },
);
replace(
  JobRepository.prototype,
  'queueAll',
  (original) =>
    async function (items) {
      const atMs = clock();
      const result = await original.call(this, items);
      for (const item of items)
        write({
          ...context.getStore(),
          kind: 'job.queued',
          jobName: item.name,
          assetId: item.data?.id,
          atMs,
          acknowledgedAtMs: clock(),
        });
      return result;
    },
);
for (const [prototype, names, prefix] of [
  [MetadataService.prototype, ['handleMetadataExtraction', 'getExifTags'], 'metadata'],
  [MetadataRepository.prototype, ['readTags', 'extractBinaryTag'], 'exiftool'],
  [StorageTemplateService.prototype, ['handleMigrationSingle'], 'storageTemplate'],
  [AssetJobRepository.prototype, ['getForMetadataExtraction', 'getForStorageTemplateJob'], 'db'],
  [
    AssetRepository.prototype,
    [
      'create',
      'update',
      'upsertExif',
      'upsertJobStatus',
      'upsertMetadata',
      'upsertFile',
      'getForMetadataExtractionTags',
    ],
    'db',
  ],
  [WorkflowRepository.prototype, ['search'], 'db.workflow'],
  [TagRepository.prototype, ['upsertValue', 'replaceAssetTags'], 'db.tags'],
  [MapRepository.prototype, ['reverseGeocode'], 'db.map'],
])
  for (const name of names) span(prototype, name, `${prefix}.${name}`);
