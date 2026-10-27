import {
  addAssetsToAlbum,
  BulkIdErrorReason,
  createAlbum,
  getAllAlbums,
  getAssetInfo,
  getMyUser,
  getSupportedMediaTypes,
  Permission,
  updateAsset,
} from '@immich/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { hasEmbeddedCaptureDate, object } from 'src/import/metadata.js';
import { buildPlan, ImportPlan } from 'src/import/plan.js';
import { readSources, resolveSources } from 'src/import/source.js';
import { uploadImportFile } from 'src/import/upload.js';
import { authenticate, BaseOptions, requirePermissions } from 'src/utils.js';

export type ImportOptions = {
  dryRun?: boolean;
  includePartner?: boolean;
  includeTrashed?: boolean;
  progressFile?: string;
  report?: string;
};
type ProgressItem = { assetId: string; size: number; modified: string; completed?: string; hasEmbeddedDate?: boolean };
type Progress = {
  format: 'openframe-import-v1';
  target: string;
  assets: Record<string, ProgressItem>;
  pairs: string[];
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isMissing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const canonicalOutput = async (filename: string): Promise<string> => {
  try {
    return await realpath(filename);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    const parent = path.dirname(filename);
    return path.join(await canonicalOutput(parent), path.basename(filename));
  }
};

export const protectExports = async (filename: string, sources: string[]) => {
  const resolved = await canonicalOutput(path.resolve(filename));
  for (const source of sources) {
    const relative = path.relative(source, resolved);
    const stats = await lstat(source);
    if (
      !relative ||
      (stats.isDirectory() && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ) {
      throw new Error(`Import output must be outside the export: ${filename}`);
    }
  }
  return resolved;
};

const loadProgress = async (filename: string, target: string): Promise<Progress> => {
  const progress: Progress = { format: 'openframe-import-v1', target, assets: Object.create(null), pairs: [] };
  let text: string;
  try {
    text = await readFile(filename, 'utf8');
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await writeFile(filename, `${JSON.stringify(progress)}\n`, { flag: 'wx', mode: 0o600 });
    return progress;
  }
  if (!text) {
    throw new Error('Empty progress file');
  }
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1) {
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 && index > 0) {
        // A crash can leave an incomplete final journal record, after a validated header.
        text = text.slice(0, text.lastIndexOf('\n') + 1);
        await truncate(filename, Buffer.byteLength(text));
        break;
      }
      throw error;
    }
    const state = object(data);
    if (
      state.format !== progress.format ||
      state.target !== target ||
      !Array.isArray(state.pairs) ||
      state.pairs.some((pair) => typeof pair !== 'string')
    ) {
      throw new Error('Progress file has an invalid format or belongs to another server/user');
    }
    for (const [key, value] of Object.entries(object(state.assets))) {
      const item = object(value);
      if (
        typeof item.assetId !== 'string' ||
        !item.assetId ||
        typeof item.size !== 'number' ||
        !Number.isFinite(item.size) ||
        typeof item.modified !== 'string' ||
        (item.completed !== undefined && typeof item.completed !== 'string') ||
        (item.hasEmbeddedDate !== undefined && typeof item.hasEmbeddedDate !== 'boolean')
      ) {
        throw new Error('Invalid asset in progress file');
      }
      progress.assets[key] = {
        assetId: item.assetId,
        size: item.size,
        modified: item.modified,
        completed: item.completed,
        hasEmbeddedDate: item.hasEmbeddedDate,
      };
    }
    progress.pairs.push(...state.pairs);
  }
  if (!text.endsWith('\n')) {
    const handle = await open(filename, 'a');
    await handle.writeFile('\n');
    await handle.close();
  }
  return progress;
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
};

// An interrupted import (Ctrl+C, crash) leaves its lock behind; reclaim it when the owning process is gone.
const acquireLock = async (filename: string) => {
  try {
    const handle = await open(filename, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
    const owner = await readFile(filename, 'utf8');
    const pid = Number(owner.trim());
    if (Number.isSafeInteger(pid) && pid > 0 && isRunning(pid)) {
      throw new Error(`Another import (pid ${pid}) is using this progress file: ${filename}`, { cause: error });
    }
    await rm(filename, { force: true });
    const handle = await open(filename, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    return handle;
  }
};

const saveProgress = async (filename: string, state: Progress, change: Pick<Progress, 'assets' | 'pairs'>) => {
  const handle = await open(filename, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ format: state.format, target: state.target, ...change })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const importExport = async (
  format: 'takeout' | 'icloud',
  inputs: string[],
  base: BaseOptions,
  options: ImportOptions,
) => {
  const sources = await resolveSources(inputs, format);
  const identifier = digest({ sources, format }).slice(0, 16);
  const directory = path.join(base.configDirectory, 'imports');
  const progressFile = await protectExports(
    options.progressFile ?? path.join(directory, `${identifier}.progress.jsonl`),
    sources,
  );
  const reportFile = await protectExports(
    options.report ?? path.join(directory, `${identifier}-${randomUUID()}.report.json`),
    sources,
  );
  if (progressFile === reportFile || reportFile === `${progressFile}.lock`) {
    throw new Error('Report and progress paths must be different');
  }
  await mkdir(path.dirname(reportFile), { recursive: true });
  // Exclusive creation prevents a report flag from overwriting any existing user file.
  const reportHandle = await open(reportFile, 'wx', 0o600);
  let plan: ImportPlan | undefined;
  let imported = 0;
  let resumed = 0;
  let failed = 0;
  let failure: string | undefined;
  try {
    plan = await buildPlan(sources, format, options);
    console.log(
      `${options.dryRun ? 'Dry run' : 'Import'}: ${plan.summary.media} media, ${plan.summary.eligible} eligible, ${plan.summary.skippedTrashed} trashed skipped, ${plan.summary.skippedPartner} partner-shared skipped`,
    );
    console.log(
      `Sidecars: ${plan.summary.matchedSidecars} matched, ${plan.summary.unmatchedSidecars} unmatched; ${plan.summary.mediaWithoutSidecars} media without sidecars`,
    );
    console.log(
      `Albums to create or reuse (${plan.summary.albums.length}): ${plan.summary.albums.join(', ') || '(none)'}`,
    );
    console.log(`Live Photo pairs: ${plan.summary.livePhotos}. Problems: ${plan.problems.length}`);
    if (options.dryRun) {
      return plan.summary;
    }
    const auth = await authenticate(base);
    await requirePermissions([
      Permission.AssetUpload,
      Permission.AssetRead,
      Permission.AssetUpdate,
      Permission.AlbumRead,
      Permission.AlbumCreate,
      Permission.AlbumUpdate,
    ]);
    const user = await getMyUser();
    await mkdir(path.dirname(progressFile), { recursive: true });
    const lock = await acquireLock(`${progressFile}.lock`);
    let temporary: string | undefined;
    try {
      const state = await loadProgress(progressFile, `${auth.url}:${user.id}`);
      const linkedPairs = new Set(state.pairs);
      temporary = await mkdtemp(path.join(os.tmpdir(), 'openframe-import-'));
      const supported = await getSupportedMediaTypes();
      const extensions = new Set([...supported.image, ...supported.video].map((extension) => extension.toLowerCase()));
      const existingAlbums = plan.summary.albums.length > 0 ? await getAllAlbums({}) : [];
      const albums = new Map(existingAlbums.map((album) => [album.albumName, album.id]));
      const items = new Map(plan.items.map((item) => [item.id, item]));
      const completedAssets = new Set<string>();
      for await (const entry of readSources(sources)) {
        const item = items.get(entry.id);
        if (!item) {
          continue;
        }
        const modified = entry.modified.toISOString();
        const completion = digest({ update: item.update, albums: item.albums });
        let saved: ProgressItem | undefined = state.assets[entry.id];
        if (saved && (saved.size !== entry.size || saved.modified !== modified)) {
          saved = undefined;
        }
        if (saved?.completed === completion) {
          resumed++;
          completedAssets.add(entry.id);
          continue;
        }
        let staged: string | undefined;
        try {
          if (!extensions.has(path.posix.extname(entry.name).toLowerCase())) {
            throw new Error('Media extension is not supported by this server');
          }
          if (item.size !== entry.size || item.modified.toISOString() !== modified) {
            throw new Error('Export changed during import; rerun with a stable export');
          }
          if (!saved) {
            staged = path.join(temporary, path.posix.basename(entry.name));
            await pipeline(await entry.open(), createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
            await utimes(staged, entry.modified, entry.modified);
            const hasEmbeddedDate = item.update.dateTimeOriginal ? await hasEmbeddedCaptureDate(staged) : false;
            const assetId = await uploadImportFile(staged);
            saved = { assetId, size: entry.size, modified, hasEmbeddedDate };
            state.assets[entry.id] = saved;
            await saveProgress(progressFile, state, { assets: { [entry.id]: saved }, pairs: [] });
          }
          const { dateTimeOriginal, ...rest } = item.update;
          const update = saved.hasEmbeddedDate || !dateTimeOriginal ? rest : { ...rest, dateTimeOriginal };
          if (Object.keys(update).length > 0) {
            await updateAsset({ id: saved.assetId, updateAssetDto: update });
          }
          for (const albumName of item.albums) {
            let albumId = albums.get(albumName);
            if (!albumId) {
              const album = await createAlbum({ createAlbumDto: { albumName } });
              albumId = album.id;
              albums.set(albumName, albumId);
            }
            const results = await addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: [saved.assetId] } });
            if (
              results.length !== 1 ||
              results.some((result) => !result.success && result.error !== BulkIdErrorReason.Duplicate)
            ) {
              throw new Error(`Failed to add asset to album: ${albumName}`);
            }
          }
          saved.completed = completion;
          await saveProgress(progressFile, state, { assets: { [entry.id]: saved }, pairs: [] });
          completedAssets.add(entry.id);
          imported++;
        } catch (error) {
          failed++;
          console.error(`Failed ${entry.name}: ${String(error)}`);
          plan.problems.push({ file: entry.id, message: String(error) });
        } finally {
          if (staged) {
            await rm(staged, { force: true });
          }
        }
      }
      for (const pair of plan.pairs) {
        const image = state.assets[pair.image];
        const video = state.assets[pair.video];
        if (!image || !video || !completedAssets.has(pair.image) || !completedAssets.has(pair.video)) {
          continue;
        }
        const key = `${image.assetId}:${video.assetId}`;
        if (linkedPairs.has(key)) {
          continue;
        }
        try {
          const asset = await getAssetInfo({ id: image.assetId });
          if (asset.livePhotoVideoId && asset.livePhotoVideoId !== video.assetId) {
            throw new Error('Image already has a different Live Photo video; existing link preserved');
          }
          if (!asset.livePhotoVideoId) {
            await updateAsset({ id: image.assetId, updateAssetDto: { livePhotoVideoId: video.assetId } });
          }
          state.pairs.push(key);
          linkedPairs.add(key);
          await saveProgress(progressFile, state, { assets: {}, pairs: [key] });
        } catch (error) {
          failed++;
          plan.problems.push({ file: pair.image, message: `Live Photo link failed: ${String(error)}` });
        }
      }
    } finally {
      if (temporary) {
        await rm(temporary, { recursive: true, force: true });
      }
      await lock.close();
      await rm(`${progressFile}.lock`);
    }
    console.log(`Imported: ${imported}; already completed: ${resumed}; failed: ${failed}`);
    if (failed > 0) {
      throw new Error(`${failed} import operations failed; rerun with the same progress file to retry`);
    }
    return plan.summary;
  } catch (error) {
    failure = String(error);
    plan?.problems.push({ file: '', message: `Import stopped: ${String(error)}` });
    throw error;
  } finally {
    await reportHandle.writeFile(
      JSON.stringify(
        {
          format: 'openframe-import-report-v1',
          sources,
          dryRun: Boolean(options.dryRun),
          summary: plan?.summary,
          imported,
          resumed,
          failed,
          problems: plan?.problems ?? [{ file: '', message: failure ?? 'Could not scan export' }],
        },
        undefined,
        2,
      ),
    );
    await reportHandle.close();
    console.log(`Report: ${reportFile}`);
  }
};
