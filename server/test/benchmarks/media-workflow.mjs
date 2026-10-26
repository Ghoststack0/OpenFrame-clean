// Build with Node 24 first. See MEDIA-WORKFLOW-RESULTS.md for commands and measurement limits.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import fluentFfmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { StorageCore } from '../../dist/cores/storage.core.js';
import { defaults } from '../../dist/dtos/config.dto.js';
import { AssetType, AssetVisibility } from '../../dist/enum.js';
import { MediaRepository } from '../../dist/repositories/media.repository.js';
import { BASE_SERVICE_DEPENDENCIES } from '../../dist/services/base.service.js';
import { MediaService } from '../../dist/services/media.service.js';

const { setFfmpegPath, setFfprobePath } = fluentFfmpeg;
const run = promisify(execFile);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const logger = {
  setContext() {},
  debug() {},
  verbose() {},
  warn() {},
  log() {},
  error() {},
  isLevelEnabled: () => false,
};
const context = new AsyncLocalStorage();
const ffmpeg = process.env.MEDIA_FFMPEG_PATH ?? 'ffmpeg';
setFfmpegPath(ffmpeg);
setFfprobePath(process.env.MEDIA_FFPROBE_PATH ?? 'ffprobe');

class ProfileRepository extends MediaRepository {
  stages = {};
  constructor(variant) {
    super(logger);
    this.variant = variant;
  }
  add(key, ms) {
    this.stages[key] = (this.stages[key] ?? 0) + ms;
  }
  async transform(...args) {
    const start = performance.now();
    const result = await super.transform(...args);
    this.add(`${context.getStore() ?? 'other'}ResizeMs`, performance.now() - start);
    return result;
  }
  async decodeImage(input, options) {
    return context.run('decode', async () => {
      const start = performance.now();
      let result;
      if (this.variant === 'baseline') {
        const decoded = await this.getImageDecodingPipeline(input, options).raw().toBuffer({ resolveWithObject: true });
        result = await this.transform(decoded, options);
      } else if (['direct', 'margin2'].includes(this.variant) && options.size) {
        const metadata = await sharp(input).metadata();
        if (
          metadata.format === 'jpeg' &&
          metadata.space === 'srgb' &&
          metadata.channels === 3 &&
          metadata.depth === 'uchar' &&
          !metadata.isProgressive &&
          !metadata.gainMap &&
          !metadata.xmp
        ) {
          const margin = this.variant === 'direct' ? 1 : 2;
          const { width, height } = metadata.autoOrient;
          const scale = Math.min(1, options.size / Math.min(width, height));
          const decoded = await sharp(input, {
            failOn: options.processInvalidImages ? 'none' : 'error',
            unlimited: true,
          })
            .rotate()
            .withIccProfile(options.colorspace)
            .resize(
              Math.min(width, Math.round(width * scale) * margin),
              Math.min(height, Math.round(height * scale) * margin),
              { fit: 'fill', withoutEnlargement: true, fastShrinkOnLoad: true },
            )
            .raw()
            .toBuffer({ resolveWithObject: true });
          result = await this.transform(decoded, options);
        }
      }
      result ??= await super.decodeImage(input, options);
      this.add('decodeTotalMs', performance.now() - start);
      return result;
    });
  }
  async generateThumbnail(image, options, output) {
    const name = output.includes('_preview') ? 'preview' : output.includes('_fullsize') ? 'fullsize' : 'thumbnail';
    return context.run(name, async () => {
      const start = performance.now();
      await super.generateThumbnail(image, options, output);
      this.add(`${name}TotalMs`, performance.now() - start);
    });
  }
  async generateThumbhash(...args) {
    return context.run('thumbhash', async () => {
      const start = performance.now();
      const result = await super.generateThumbhash(...args);
      this.add('thumbhashTotalMs', performance.now() - start);
      return result;
    });
  }
  async transcodeThumbnails(input, outputs) {
    const start = performance.now();
    if (this.variant === 'baseline') {
      for (const { path, options } of outputs) await super.transcode(input, path, options);
    } else {
      await super.transcodeThumbnails(input, outputs);
    }
    this.add('videoThumbnailsMs', performance.now() - start);
  }
}

async function workflow({
  folder,
  fixtures,
  variant,
  count,
  jobs,
  threads,
  previewSize = defaults.image.preview.size,
}) {
  StorageCore.reset();
  StorageCore.setMediaLocation(folder);
  const repository = new ProfileRepository(variant);
  sharp.concurrency(threads);
  const records = new Map();
  const files = [];
  const hashes = [];
  let repositoryStubMs = 0;
  const stub =
    (fn) =>
    async (...args) => {
      const start = performance.now();
      const value = fn(...args);
      repositoryStubMs += performance.now() - start;
      return value;
    };
  for (let index = 0; index < count; index++) {
    const fixture = fixtures[index % fixtures.length];
    const metadata = fixture.video ? null : await sharp(fixture.path).metadata();
    const record = {
      id: randomUUID(),
      ownerId: '00000000-0000-4000-8000-000000000000',
      type: fixture.video ? AssetType.Video : AssetType.Image,
      visibility: AssetVisibility.Timeline,
      originalPath: fixture.path,
      originalFileName: basename(fixture.path),
      files: [],
      edits: fixture.edits ?? [],
      thumbhash: null,
      exifInfo: {
        colorspace: fixture.colorspace ?? 'srgb',
        profileDescription: null,
        bitsPerSample: 8,
        orientation: null,
        projectionType: null,
        exifImageWidth: metadata?.width,
        exifImageHeight: metadata?.height,
      },
    };
    if (fixture.video) {
      const {
        videoStreams: [videoStream],
        format,
      } = await repository.probe(fixture.path);
      Object.assign(record, { videoStream, format });
    }
    records.set(record.id, record);
  }
  const dependencies = {
    LoggingRepository: logger,
    MediaRepository: repository,
    AssetJobRepository: { getForGenerateThumbnailJob: stub((id) => records.get(id)) },
    AssetRepository: {
      upsertFiles: stub((value) => files.push(...value)),
      update: stub((value) => {
        if (value.thumbhash) hashes.push(value.thumbhash.toString('hex'));
      }),
    },
    StorageRepository: { mkdirSync: (path) => mkdirSync(path, { recursive: true }) },
    PersonRepository: { getFaces: async () => [], updateVisibility: async () => {} },
    OcrRepository: { getByAssetId: async () => [], updateOcrVisibilities: async () => {} },
  };
  const service = new MediaService(
    ...BASE_SERVICE_DEPENDENCIES.map((dependency) => dependencies[dependency.name] ?? {}),
  );
  service.getConfig = async () => ({
    ...defaults,
    image: { ...defaults.image, preview: { ...defaults.image.preview, size: previewSize } },
  });
  let nodeRssPeak = process.memoryUsage().rss;
  const sampleMemory = setInterval(() => {
    nodeRssPeak = Math.max(nodeRssPeak, process.memoryUsage().rss);
  }, 10);
  const cpu = process.cpuUsage();
  const start = performance.now();
  const ids = [...records.keys()];
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: jobs }, async () => {
        while (next < ids.length) {
          const id = ids[next++];
          assert.equal(await service.handleGenerateThumbnails({ id }), 'success');
        }
      }),
    );
  } finally {
    clearInterval(sampleMemory);
  }
  const milliseconds = performance.now() - start;
  const cpuUsage = process.cpuUsage(cpu);
  return {
    milliseconds,
    imagesPerSecond: (count * 1000) / milliseconds,
    cpuUsage,
    nodeRssPeak,
    nodeMaxRssKiB: process.resourceUsage().maxRSS,
    repositoryStubMs,
    stages: repository.stages,
    vipsThreads: sharp.concurrency(),
    availableCpus: availableParallelism(),
    files,
    thumbhashes: hashes,
  };
}

async function quality(before, after, folder) {
  const a = await sharp(before).metadata(),
    b = await sharp(after).metadata();
  const sameLayout =
    a.width === b.width && a.height === b.height && a.hasAlpha === b.hasAlpha && a.orientation === b.orientation;
  const sameTag = a.icc?.equals(b.icc ?? Buffer.alloc(0)) ?? !b.icc;
  if (!sameLayout || !sameTag) return { sameLayout, sameTag, passed: false };
  const x = await sharp(before).ensureAlpha().raw().toBuffer(),
    y = await sharp(after).ensureAlpha().raw().toBuffer();
  assert.equal(x.length, y.length);
  let squared = 0,
    alphaEqual = true;
  for (let index = 0; index < x.length; index++) {
    if (index % 4 === 3) alphaEqual &&= x[index] === y[index];
    else squared += (x[index] - y[index]) ** 2;
  }
  const psnr = squared === 0 ? 'infinity' : 10 * Math.log10((255 ** 2 * x.length * 3) / 4 / squared);
  const first = join(folder, 'before.png'),
    second = join(folder, 'after.png');
  await sharp(before).png().toFile(first);
  await sharp(after).png().toFile(second);
  const { stderr } = await run(ffmpeg, [
    '-hide_banner',
    '-i',
    first,
    '-i',
    second,
    '-lavfi',
    '[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]ssim',
    '-f',
    'null',
    '-',
  ]);
  const ssim = Number(stderr.match(/All:([\d.]+)/)?.[1]);
  assert(Number.isFinite(ssim), stderr);
  return {
    sameLayout,
    sameTag,
    alphaEqual,
    psnr,
    ssim,
    encodedEqual: hash(await readFile(before)) === hash(await readFile(after)),
    passed: sameLayout && sameTag && alphaEqual && ssim >= 0.99 && (psnr === 'infinity' || psnr >= 40),
  };
}

const [mode, output, ...args] = process.argv.slice(2);
assert(
  output,
  'Expected profile OUTPUT.json VARIANT COUNT JOBS VIPS_THREADS INPUT... or quality OUTPUT.json PHOTO12 PHOTO24',
);
const folder = await mkdtemp(join(tmpdir(), 'media-workflow-'));
try {
  const rows = [];
  if (mode === 'profile') {
    const [variant, n, j, t, ...inputs] = args;
    assert(['baseline', 'candidate', 'direct', 'margin2'].includes(variant) && inputs.length);
    const count = Number(n),
      jobs = Number(j),
      threads = Number(t);
    assert(
      Number.isInteger(count) &&
        count > 0 &&
        Number.isInteger(jobs) &&
        jobs > 0 &&
        Number.isInteger(threads) &&
        threads >= 0,
    );
    const fixtures = inputs.map((path) => ({ path, video: /\.(mp4|mov|mkv|ts|webm|gif)$/i.test(path) }));
    const result = await workflow({ folder, fixtures, variant, count, jobs, threads });
    const outputs = [];
    for (const file of result.files)
      outputs.push({ type: file.type, isEdited: file.isEdited, sha256: hash(await readFile(file.path)) });
    rows.push({
      variant,
      count,
      jobs,
      threads,
      inputs: inputs.map((input) => basename(input)),
      ...result,
      files: outputs,
    });
  } else {
    assert.equal(mode, 'quality');
    assert(args.length >= 2);
    const variants = [
      { name: 'real-12mp', path: args[0] },
      { name: 'real-24mp', path: args[1] },
    ];
    for (const [name, pipeline] of [
      ['rotated', sharp(args[0]).withExif({ IFD0: { Orientation: '6' } })],
      ['p3', sharp(args[0]).withIccProfile('p3')],
      ['grayscale', sharp(args[0]).toColourspace('b-w')],
      ['cmyk', sharp(args[0]).toColourspace('cmyk')],
    ]) {
      const path = join(folder, `${name}.jpg`);
      await pipeline.jpeg({ quality: 95 }).toFile(path);
      variants.push({ name, path, colorspace: name === 'p3' ? 'p3' : 'srgb' });
    }
    const alphaPath = join(folder, 'alpha-p3.png');
    await sharp(args[0]).ensureAlpha(0.5).withIccProfile('p3').png().toFile(alphaPath);
    variants.push({ name: 'alpha-p3', path: alphaPath, colorspace: 'p3' });
    variants.push({
      name: 'crop-edit',
      path: args[0],
      edits: [
        { action: 'crop', parameters: { x: 100, y: 100, width: 2000, height: 1500 } },
        { action: 'rotate', parameters: { angle: 90 } },
      ],
    });
    const text = Array.from(
      { length: 70 },
      (_, i) =>
        `<text x="20" y="${40 + i * 42}" font-family="sans-serif" font-size="${12 + (i % 25)}">Fine textile 0123456789 AaBbCc sharpness and moire</text>`,
    ).join('');
    const svg = `<svg width="4112" height="3088"><defs><pattern id="f" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="white"/><path d="M0 0h8v3H0zM0 0h3v8H0z" fill="#222"/></pattern></defs><rect width="4112" height="3088" fill="white"/><rect x="2000" width="2112" height="3088" fill="url(#f)"/>${text}</svg>`;
    const finePath = join(folder, 'fine-text-fabric.jpg');
    await sharp(Buffer.from(svg)).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(finePath);
    variants.push({ name: 'fine-text-fabric', path: finePath });
    for (const path of args.slice(2)) variants.push({ name: basename(path), path });
    for (const fixture of variants) {
      for (const previewSize of [1440, 250]) {
        const results = {};
        for (const variant of ['baseline', 'candidate', 'direct', 'margin2']) {
          results[variant] = await workflow({
            folder: join(folder, `${fixture.name}-${previewSize}-${variant}`),
            fixtures: [fixture],
            variant,
            count: 1,
            jobs: 1,
            threads: 1,
            previewSize,
          });
        }
        for (const variant of ['candidate', 'direct', 'margin2']) {
          const result = results[variant];
          for (const before of results.baseline.files) {
            const after = result.files.find((file) => file.type === before.type && file.isEdited === before.isEdited);
            assert(after);
            const metrics = await quality(before.path, after.path, folder);
            rows.push({
              fixture: fixture.name,
              inputSha256: hash(await readFile(fixture.path)),
              previewSize,
              variant,
              type: before.type,
              isEdited: before.isEdited,
              milliseconds: result.milliseconds,
              baselineMs: results.baseline.milliseconds,
              ...metrics,
            });
            if (variant === 'candidate') assert(metrics.passed, JSON.stringify(rows.at(-1)));
          }
          if (variant === 'candidate') assert.deepEqual(result.thumbhashes, results.baseline.thumbhashes);
        }
      }
    }
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        node: process.version,
        vips: sharp.versions.vips,
        cpu: cpus()[0].model,
        limit:
          'Local media service with real codecs and filesystem. Database repositories and config are in-memory stubs; no queues, ML, network or energy measurement. Stage wall times overlap. CPU excludes FFmpeg children. RSS is process RSS, not system or concurrent-process memory.',
        rows,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Wrote ${rows.length} rows to ${output}`);
} finally {
  await rm(folder, { recursive: true, force: true });
}
