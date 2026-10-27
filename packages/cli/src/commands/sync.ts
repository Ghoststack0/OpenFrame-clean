import {
  AssetResponseDto,
  defaults,
  deleteAssets,
  getAllAlbums,
  getAssetInfo,
  getMyUser,
  getSupportedMediaTypes,
  isHttpError,
  Permission,
  searchAssets,
} from '@immich/sdk';
import micromatch from 'micromatch';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startWatch, uploadBatch, UploadOptionsDto } from 'src/commands/asset.js';
import {
  collisionPath,
  DEFAULT_TEMPLATE,
  downloadPath,
  isMissing,
  loadState,
  localPath,
  saveState,
  SyncEntry,
  SyncState,
} from 'src/commands/sync-state.js';
import { authenticate, BaseOptions, crawl, requirePermissions, sha1 } from 'src/utils.js';

export interface SyncOptions extends Omit<UploadOptionsDto, 'delete' | 'deleteDuplicates' | 'skipHash'> {
  once?: boolean;
  download?: boolean;
  downloadAlbum?: string;
  template?: string;
  propagateLocalDeletions?: boolean;
  propagateServerDeletions?: boolean;
}

type LocalFile = Omit<SyncEntry, 'assetId'>;

export const retry = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || signal.aborted || (isHttpError(error) && error.status < 500 && error.status !== 429)) {
        throw error;
      }
      await sleep(250 * 2 ** attempt, undefined, { signal });
    }
  }
};

const hasSameFingerprint = (left: { size: number; mtimeMs: number }, right: { size: number; mtimeMs: number }) =>
  left.size === right.size && left.mtimeMs === right.mtimeMs;

const isExcluded = (root: string, relative: string, options: SyncOptions) =>
  (!options.includeHidden && relative.split('/').some((part) => part.startsWith('.'))) ||
  Boolean(options.ignore && micromatch.contains(path.join(root, relative), `**/${options.ignore}`));

export const scanLocal = async (
  root: string,
  state: SyncState,
  options: SyncOptions,
  signal: AbortSignal,
  stabilityMs = 1000,
): Promise<Map<string, LocalFile>> => {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) {
    throw new Error('Sync root must remain a directory.');
  }
  const { image, video } = await retry(() => getSupportedMediaTypes(), signal);
  const files = await crawl({
    pathsToCrawl: [root],
    recursive: true,
    includeHidden: options.includeHidden,
    exclusionPattern: options.ignore,
    extensions: [...image, ...video],
  });
  const tracked = new Map(state.entries.map((entry) => [entry.path, entry]));
  const candidates = new Set(files);
  for (const entry of state.entries) {
    if (!isExcluded(root, entry.path, options)) {
      candidates.add(path.join(root, entry.path));
    }
  }
  const snapshot = new Map<string, LocalFile>();
  const pending: { relative: string; filepath: string; size: number; mtimeMs: number }[] = [];
  for (const filepath of candidates) {
    signal.throwIfAborted();
    const relative = path.relative(root, filepath).split(path.sep).join('/');
    await localPath(root, relative);
    try {
      const stats = await lstat(filepath);
      const previous = tracked.get(relative);
      if (previous && hasSameFingerprint(previous, stats)) {
        snapshot.set(relative, previous);
      } else {
        pending.push({ relative, filepath, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
  if (pending.length > 0) {
    await sleep(stabilityMs, undefined, { signal });
  }
  for (const file of pending) {
    signal.throwIfAborted();
    const before = await lstat(await localPath(root, file.relative));
    if (!hasSameFingerprint(file, before)) {
      throw new Error(`File is still changing: ${file.relative}; sync deferred until the next pass.`);
    }
    const checksum = await sha1(file.filepath, signal);
    if (!hasSameFingerprint(before, await lstat(file.filepath))) {
      throw new Error(`File is still changing: ${file.relative}; sync deferred until the next pass.`);
    }
    snapshot.set(file.relative, { path: file.relative, checksum, size: before.size, mtimeMs: before.mtimeMs });
  }
  return snapshot;
};

const remoteAssets = async (albumName: string | undefined, userId: string, signal: AbortSignal) => {
  let albumIds: string[] | undefined;
  if (albumName) {
    const allAlbums = await retry(() => getAllAlbums({}), signal);
    const albums = allAlbums.filter((album) => album.albumName === albumName);
    if (albums.length !== 1) {
      throw new Error(`Download album must match exactly one album: ${albumName}`);
    }
    albumIds = albums.map((album) => album.id);
  }
  const assets = new Map<string, AssetResponseDto>();
  let page = 1;
  let cursor: string | undefined;
  const seen = new Set<string>();
  while (true) {
    const response = await retry(
      () => searchAssets({ metadataSearchDto: { size: 1000, page, cursor, albumIds, withStacked: true } }),
      signal,
    );
    for (const asset of response.assets.items) {
      if (asset.ownerId === userId && !asset.isTrashed) {
        assets.set(asset.id, asset);
      }
    }
    const next = response.assets.nextCursor || response.assets.nextPage;
    if (!next) {
      return assets;
    }
    if (seen.has(next)) {
      throw new Error('Server repeated a search page; sync stopped safely.');
    }
    seen.add(next);
    if (response.assets.nextCursor) {
      cursor = next;
    } else {
      page = Number(next);
      if (!Number.isSafeInteger(page) || page < 1) {
        throw new Error('Invalid server search page.');
      }
    }
  }
};

const isRemoteDeleted = async (assetId: string, userId: string, signal: AbortSignal) => {
  try {
    const asset = await retry(() => getAssetInfo({ id: assetId }), signal);
    if (asset.ownerId !== userId) {
      throw new Error('Sync refuses deletion of an asset owned by another account.');
    }
    return asset.isTrashed;
  } catch (error) {
    if (isHttpError(error) && error.status === 404) {
      return true;
    }
    throw error;
  }
};

const remember = (state: SyncState, entry: SyncEntry) => {
  const index = state.entries.findIndex((item) => item.path === entry.path);
  if (index === -1) {
    state.entries.push(entry);
  } else {
    state.entries[index] = entry;
  }
};

const downloadFile = async (root: string, relative: string, asset: AssetResponseDto, signal: AbortSignal) => {
  const target = await localPath(root, relative, true);
  const temporary = path.join(path.dirname(target), `.openframe-sync-${randomUUID()}.part`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(defaults.headers ?? {})) {
      if (value !== undefined) {
        headers.set(key, String(value));
      }
    }
    const response = await fetch(`${defaults.baseUrl}/assets/${encodeURIComponent(asset.id)}/original`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download ${asset.id} failed: HTTP ${response.status}`);
    }
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      await file.writeFile(chunk);
    }
    await file.sync();
    await file.close();
    const checksum = Buffer.from(asset.checksum, 'base64').toString('hex');
    if ((await sha1(temporary, signal)) !== checksum) {
      throw new Error(`Download checksum mismatch: ${asset.id}`);
    }
    await localPath(root, relative);
    // Hard-link publication is atomic and fails if a user created the destination meanwhile.
    await link(temporary, target);
  } finally {
    await file.close();
    await unlink(temporary);
  }
};

const receiveAsset = async (
  root: string,
  state: SyncState,
  options: SyncOptions,
  asset: AssetResponseDto,
  byChecksum: Map<string, LocalFile>,
  reserved: Set<string>,
  signal: AbortSignal,
) => {
  const checksum = Buffer.from(asset.checksum, 'base64').toString('hex');
  const base = downloadPath(asset, options.template ?? DEFAULT_TEMPLATE);
  for (let attempt = 0; ; attempt++) {
    const relative = collisionPath(base, asset.id, attempt);
    const filepath = await localPath(root, relative);
    if (reserved.has(relative)) {
      continue;
    }
    try {
      const stats = await lstat(filepath);
      if ((await sha1(filepath, signal)) === checksum) {
        if (!options.dryRun) {
          remember(state, { path: relative, checksum, assetId: asset.id, size: stats.size, mtimeMs: stats.mtimeMs });
        }
        return;
      }
      continue;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    console.log(`${options.dryRun ? 'Would download' : 'Downloading'} ${asset.id} to ${relative}`);
    reserved.add(relative);
    if (!options.dryRun) {
      await retry(() => downloadFile(root, relative, asset, signal), signal);
      const stats = await lstat(filepath);
      const entry = { path: relative, checksum, assetId: asset.id, size: stats.size, mtimeMs: stats.mtimeMs };
      remember(state, entry);
      byChecksum.set(checksum, entry);
    }
    return;
  }
};

export const syncOnce = async (
  root: string,
  state: SyncState,
  options: SyncOptions,
  signal: AbortSignal,
  stabilityMs = 1000,
) => {
  const local = await scanLocal(root, state, options, signal, stabilityMs);
  const byChecksum = new Map(local.values().map<[string, LocalFile]>((file) => [file.checksum, file]));
  // Fetch the complete download selection before performing any mutations.
  const remote = options.download
    ? await remoteAssets(options.downloadAlbum, state.userId, signal)
    : new Map<string, AssetResponseDto>();
  const deleted = new Map<string, boolean>();
  const presence = new Map<string, boolean>();
  for (const entry of state.entries) {
    signal.throwIfAborted();
    const filepath = await localPath(root, entry.path);
    let isPresent = true;
    try {
      await lstat(filepath);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      isPresent = false;
    }
    presence.set(entry.path, isPresent);
  }
  const presentAssetIds = new Set(
    state.entries.filter((entry) => presence.get(entry.path)).map((entry) => entry.assetId),
  );
  for (const entry of state.entries) {
    signal.throwIfAborted();
    const filepath = await localPath(root, entry.path);
    const isPresent = presence.get(entry.path);
    if (
      options.propagateLocalDeletions &&
      !isPresent &&
      !isExcluded(root, entry.path, options) &&
      !presentAssetIds.has(entry.assetId) &&
      !byChecksum.has(entry.checksum)
    ) {
      if (!(await isRemoteDeleted(entry.assetId, state.userId, signal))) {
        console.log(
          `${options.dryRun ? 'Would trash' : 'Trashing'} server asset ${entry.assetId} (local deletion: ${entry.path})`,
        );
        if (!options.dryRun) {
          await retry(() => deleteAssets({ assetBulkDeleteDto: { ids: [entry.assetId], force: false } }), signal);
        }
      }
      deleted.set(entry.assetId, true);
    }
    if (!options.propagateServerDeletions || !isPresent) {
      continue;
    }
    let removed = deleted.get(entry.assetId);
    if (removed === undefined) {
      removed = await isRemoteDeleted(entry.assetId, state.userId, signal);
      deleted.set(entry.assetId, removed);
    }
    if (!removed) {
      continue;
    }

    const before = await lstat(filepath);
    if ((await sha1(filepath, signal)) !== entry.checksum || !hasSameFingerprint(before, await lstat(filepath))) {
      console.warn(`Keeping locally modified file: ${entry.path}`);
      continue;
    }
    console.log(`${options.dryRun ? 'Would delete' : 'Deleting'} local file ${entry.path} (server deletion)`);
    if (!options.dryRun) {
      await localPath(root, entry.path);
      signal.throwIfAborted();
      await unlink(filepath);
    }
    local.delete(entry.path);
    byChecksum.delete(entry.checksum);
  }

  const tracked = new Map(state.entries.map((entry) => [entry.path, entry]));
  for (const file of local.values()) {
    signal.throwIfAborted();
    const previous = tracked.get(file.path);
    if (previous?.checksum === file.checksum) {
      if (!options.dryRun) {
        remember(state, { ...file, assetId: previous.assetId });
      }
      continue;
    }
    // Keep the existing upload/checksum/album flow behind this single call for resumable uploads.
    const filepath = await localPath(root, file.path);
    const results = await retry(() => uploadBatch([filepath], { ...options, signal, progress: false }), signal);
    if (options.dryRun) {
      continue;
    }
    const result = results[0];
    if (!result?.id) {
      throw new Error(`Upload/check failed for ${file.path}; state was not advanced.`);
    }
    const uploaded = await retry(() => getAssetInfo({ id: result.id }), signal);
    if (Buffer.from(uploaded.checksum, 'base64').toString('hex') !== file.checksum) {
      throw new Error(`File changed during upload: ${file.path}; retry on the next pass.`);
    }
    const stats = await lstat(await localPath(root, file.path));
    if (!hasSameFingerprint(file, stats)) {
      throw new Error(`File changed during upload: ${file.path}; retry on the next pass.`);
    }
    remember(state, { ...file, assetId: result.id });
  }

  const reserved = new Set<string>();
  const known = new Set(state.entries.map((entry) => entry.assetId));
  for (const asset of remote.values()) {
    signal.throwIfAborted();
    if (known.has(asset.id) || deleted.get(asset.id)) {
      continue;
    }
    const checksum = Buffer.from(asset.checksum, 'base64').toString('hex');
    if (!/^[a-f\d]{40}$/.test(checksum)) {
      throw new Error(`Invalid server checksum for ${asset.id}`);
    }
    const existing = byChecksum.get(checksum);
    if (existing) {
      if (!options.dryRun) {
        remember(state, { ...existing, assetId: asset.id });
      }
      continue;
    }
    await receiveAsset(root, state, options, asset, byChecksum, reserved, signal);
  }
};

export const sync = async (folder: string, baseOptions: BaseOptions, options: SyncOptions) => {
  const root = await realpath(folder);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) {
    throw new Error('Sync requires an existing folder.');
  }
  if (options.downloadAlbum && !options.download) {
    throw new Error('--download-album requires --download.');
  }
  downloadPath({ id: 'check', originalFileName: 'check.jpg', fileCreatedAt: '2000-01-01' }, options.template);
  const controller = new AbortController();
  const { signal } = controller;
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const originalFetch = defaults.fetch;
  defaults.fetch = (input, init) =>
    (originalFetch ?? fetch)(input, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000), ...(init?.signal ? [init.signal] : [])]),
    });
  const lockPath = path.join(root, '.openframe-sync.lock');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let watcher: Awaited<ReturnType<typeof startWatch>> | undefined;
  let wake: (() => void) | undefined;
  let hasPendingPass = false;
  const requestPass = () => {
    hasPendingPass = true;
    wake?.();
  };
  try {
    const auth = await authenticate(baseOptions);
    defaults.baseUrl = auth.url.replace(/\/+$/, '');
    await requirePermissions([
      Permission.AssetUpload,
      Permission.AssetRead,
      ...(options.download ? [Permission.AssetDownload] : []),
      ...(options.propagateLocalDeletions ? [Permission.AssetDelete] : []),
    ]);
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(
          `Sync lock exists: ${lockPath}. Stop the other process or remove a stale lock after checking its PID.`,
          { cause: error },
        );
      }
      throw error;
    }
    await lock.writeFile(`${process.pid}\n`);
    const user = await retry(() => getMyUser(), signal);
    const state = await loadState(root, defaults.baseUrl, user.id);
    if (!options.once) {
      watcher = await retry(
        () =>
          startWatch(
            [root],
            { ...options, recursive: true, progress: false },
            {
              debounceTimeMs: 1000,
              handleSignals: false,
              onBatch: async () => requestPass(),
              onRemove: requestPass,
            },
          ),
        signal,
      );
    }
    do {
      hasPendingPass = false;
      try {
        await syncOnce(root, state, options, signal);
      } catch (error) {
        if (options.once || signal.aborted) {
          throw error;
        }
        console.error(`Sync pass failed; retrying on the next pass: ${error}`);
      } finally {
        if (!options.dryRun) {
          await saveState(root, state);
        }
      }
      if (!options.once && !hasPendingPass && !signal.aborted) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            wake = undefined;
            resolve();
          };
          const timer = setTimeout(finish, 60_000);
          wake = finish;
          signal.addEventListener('abort', finish, { once: true });
          if (hasPendingPass || signal.aborted) {
            finish();
          }
        });
      }
    } while (!options.once && !signal.aborted);
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    await watcher?.close();
    defaults.fetch = originalFetch;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
};
