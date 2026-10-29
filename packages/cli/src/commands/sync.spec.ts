/* eslint-disable unicorn/no-null -- SDK response fixtures require nullable fields. */
import {
  addAssetsToAlbum,
  AssetRejectReason,
  AssetResponseDto,
  AssetTypeEnum,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  createAlbum,
  defaults,
  deleteAssets,
  getAllAlbums,
  getAssetInfo,
  getMyUser,
  getSupportedMediaTypes,
  isHttpError,
  searchAssets,
  UserAvatarColor,
  UserStatus,
} from '@immich/sdk';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadBatch } from 'src/commands/asset.js';
import {
  collisionPath,
  downloadPath,
  loadState,
  localPath,
  parseState,
  saveState,
  STATE_FILE,
  SyncState,
} from 'src/commands/sync-state.js';
import { retry, scanLocal, sync, syncOnce } from 'src/commands/sync.js';
import { authenticate, requirePermissions, sha1 } from 'src/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@immich/sdk');
vi.mock('src/commands/asset.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/commands/asset.js')>()),
  uploadBatch: vi.fn(),
}));
vi.mock('src/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils.js')>()),
  authenticate: vi.fn(),
  requirePermissions: vi.fn(),
}));

const userId = '00000000-0000-4000-8000-000000000001';
const assetId = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const hash = (data: string) => createHash('sha1').update(data).digest('hex');
const asset = (overrides: Partial<AssetResponseDto> = {}): AssetResponseDto => ({
  id: assetId,
  checksum: Buffer.from(hash('photo'), 'hex').toString('base64'),
  originalFileName: 'photo.jpg',
  originalPath: '/server/photo.jpg',
  ownerId: userId,
  createdAt: '2026-01-02T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  fileCreatedAt: '2026-01-02T00:00:00Z',
  fileModifiedAt: '2026-01-02T00:00:00Z',
  localDateTime: '2026-01-02T00:00:00Z',
  duration: null,
  height: null,
  width: null,
  thumbhash: null,
  hasMetadata: false,
  isArchived: false,
  isEdited: false,
  isFavorite: false,
  isOffline: false,
  isTrashed: false,
  type: AssetTypeEnum.Image,
  visibility: AssetVisibility.Timeline,
  ...overrides,
});
const searchPage = (items: AssetResponseDto[], nextPage: string | null = null) => ({
  albums: { count: 0, facets: [], items: [], total: 0 },
  assets: { count: items.length, facets: [], items, total: items.length, nextPage, nextCursor: null },
});

const mockDownload = (data = 'photo') => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(data));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

describe('desktop sync', () => {
  let root: string;
  let state: SyncState;
  let signal: AbortSignal;

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(path.join(os.tmpdir(), 'openframe-sync-'));
    state = { version: 1, serverUrl: 'https://example.test/api', userId, entries: [] };
    signal = new AbortController().signal;
    vi.mocked(getSupportedMediaTypes).mockResolvedValue({ image: ['.jpg'], video: ['.mp4'], sidecar: ['.xmp'] });
    vi.mocked(searchAssets).mockResolvedValue(searchPage([]));
    vi.mocked(getAssetInfo).mockResolvedValue(asset());
    vi.mocked(authenticate).mockResolvedValue({ url: state.serverUrl, key: 'test-key' });
    vi.mocked(requirePermissions).mockResolvedValue();
    vi.mocked(getMyUser).mockResolvedValue({
      id: userId,
      name: 'Test',
      email: 'test@example.test',
      avatarColor: UserAvatarColor.Primary,
      clusterGroupId: userId,
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
      isAdmin: false,
      license: null,
      oauthId: '',
      profileChangedAt: '',
      profileImagePath: '',
      quotaSizeInBytes: null,
      quotaUsageInBytes: 0,
      shouldChangePassword: false,
      status: UserStatus.Active,
      storageLabel: null,
    });
    vi.mocked(uploadBatch).mockImplementation(async (files) => files.map((filepath) => ({ id: assetId, filepath })));
    vi.mocked(defaults).baseUrl = state.serverUrl;
    vi.mocked(defaults).headers = { 'x-api-key': 'test-key' };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  const track = async (relative = 'photo.jpg', data = 'photo', id = assetId) => {
    const filepath = path.join(root, relative);
    await mkdir(path.dirname(filepath), { recursive: true });
    await writeFile(filepath, data);
    const stats = await lstat(filepath);
    const entry = { path: relative, checksum: hash(data), assetId: id, size: stats.size, mtimeMs: stats.mtimeMs };
    state.entries.push(entry);
    return entry;
  };
  const run = (options = {}) => syncOnce(root, state, { concurrency: 1, ...options }, signal, 0);

  describe('sync state and paths', () => {
    it('round-trips atomic state, preserves permissions, and binds it to the account/server', async () => {
      await track();
      await saveState(root, state);
      expect(await loadState(root, state.serverUrl, userId)).toEqual(state);
      const stats = await lstat(path.join(root, STATE_FILE));
      if (process.platform === 'win32') {
        expect(stats.isFile()).toBe(true);
        expect(stats.mode & 0o600).toBe(0o600);
      } else {
        expect(stats.mode & 0o777).toBe(0o600);
      }
      expect(await readdir(root)).toEqual([STATE_FILE, 'photo.jpg']);
      await expect(loadState(root, 'https://other.test/api', userId)).rejects.toThrow('another server/account');
      await expect(loadState(root, state.serverUrl, otherId)).rejects.toThrow('another server/account');
    });

    it('starts empty but never silently resets malformed state', async () => {
      expect(await loadState(root, state.serverUrl, userId)).toEqual(state);
      await writeFile(path.join(root, STATE_FILE), '{broken');
      await expect(loadState(root, state.serverUrl, userId)).rejects.toThrow();
      expect(await readFile(path.join(root, STATE_FILE), 'utf8')).toBe('{broken');
    });

    it.each([
      '../outside.jpg',
      '/outside.jpg',
      'C:/outside.jpg',
      'a/../../outside.jpg',
      String.raw`a\outside.jpg`,
      '.openframe-sync.json',
    ])('rejects unsafe state paths: %s', async (relative) => {
      const entry = await track();
      expect(() => parseState({ ...state, entries: [{ ...entry, path: relative }] }, state.serverUrl, userId)).toThrow(
        'Unsafe',
      );
    });

    it('rejects invalid entries, duplicates, symlink state, and symlink ancestors', async () => {
      const entry = await track();
      expect(() =>
        parseState({ ...state, entries: [{ ...entry, assetId: '-'.repeat(36) }] }, state.serverUrl, userId),
      ).toThrow('Invalid');
      expect(() => parseState({ ...state, entries: [{ ...entry, checksum: 'bad' }] }, state.serverUrl, userId)).toThrow(
        'Invalid',
      );
      expect(() => parseState({ ...state, entries: [{ ...entry, size: -1 }] }, state.serverUrl, userId)).toThrow(
        'Invalid',
      );
      expect(() => parseState({ ...state, entries: [entry, entry] }, state.serverUrl, userId)).toThrow('Duplicate');
      await symlink(path.join(root, 'photo.jpg'), path.join(root, STATE_FILE));
      await expect(loadState(root, state.serverUrl, userId)).rejects.toThrow('regular file');
      await symlink(os.tmpdir(), path.join(root, 'escape'));
      await expect(localPath(root, 'escape/photo.jpg', true)).rejects.toThrow('symlinks');
    });

    it('formats UTC dates and sanitizes names without interpreting inserted template tokens', () => {
      expect(downloadPath(asset())).toBe('2026/01/photo.jpg');
      expect(
        downloadPath(asset({ fileCreatedAt: '2026-01-01T23:30:00-02:00' }), 'YYYY/MM/DD/{assetId}/{originalFileName}'),
      ).toBe(`2026/01/02/${assetId}/photo.jpg`);
      expect(downloadPath(asset({ originalFileName: '../../MM:photo.jpg' }))).toBe('2026/01/.._.._MM_photo.jpg');
      expect(downloadPath(asset({ originalFileName: 'CON.jpg' }))).toBe('2026/01/asset-CON.jpg');
      expect(() => downloadPath(asset(), '../{originalFileName}')).toThrow('Unsafe');
      expect(() => downloadPath(asset(), '{unknown}')).toThrow('Unknown');
      expect(() => downloadPath(asset({ fileCreatedAt: 'bad' }))).toThrow('date');
      expect(collisionPath('2026/01/photo.jpg', assetId, 1)).toBe(`2026/01/photo-${assetId}.jpg`);
      expect(collisionPath('2026/01/photo.jpg', assetId, 2)).toBe(`2026/01/photo-${assetId}-2.jpg`);
    });
  });

  describe('sync diff and upload', () => {
    it('dry-runs the real upload and album flow without transferring or mutating anything', async () => {
      const { uploadBatch: realUploadBatch } =
        await vi.importActual<typeof import('src/commands/asset.js')>('src/commands/asset.js');
      vi.mocked(uploadBatch).mockImplementation(realUploadBatch);
      const filepath = path.join(root, 'photo.jpg');
      await writeFile(filepath, 'photo');
      vi.mocked(checkBulkUpload).mockResolvedValue({ results: [{ id: filepath, action: AssetUploadAction.Accept }] });
      vi.mocked(getAllAlbums).mockResolvedValue([]);
      const fetcher = mockDownload();
      await run({ dryRun: true, album: true });
      expect(checkBulkUpload).toHaveBeenCalledOnce();
      expect(fetcher).not.toHaveBeenCalled();
      expect(createAlbum).not.toHaveBeenCalled();
      expect(addAssetsToAlbum).not.toHaveBeenCalled();
      expect(state.entries).toEqual([]);
      expect(await readFile(filepath, 'utf8')).toBe('photo');
    });

    it('uses the shared SDK bulk checksum check to skip uploads for existing server assets', async () => {
      const { uploadBatch: realUploadBatch } =
        await vi.importActual<typeof import('src/commands/asset.js')>('src/commands/asset.js');
      vi.mocked(uploadBatch).mockImplementation(realUploadBatch);
      const filepath = path.join(root, 'photo.jpg');
      await writeFile(filepath, 'photo');
      vi.mocked(checkBulkUpload).mockResolvedValue({
        results: [
          {
            id: filepath,
            action: AssetUploadAction.Reject,
            reason: AssetRejectReason.Duplicate,
            assetId,
          },
        ],
      });
      const fetcher = mockDownload();
      await run();
      expect(checkBulkUpload).toHaveBeenCalledExactlyOnceWith({
        assetBulkUploadCheckDto: {
          assets: [{ id: filepath, checksum: hash('photo') }],
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(state.entries).toEqual([expect.objectContaining({ path: 'photo.jpg', checksum: hash('photo'), assetId })]);
    });

    it('uploads new/changed media, reuses album options, and skips unchanged files after restart', async () => {
      await writeFile(path.join(root, 'photo.jpg'), 'photo');
      await writeFile(path.join(root, 'notes.txt'), 'not media');
      await run({ album: true });
      expect(uploadBatch).toHaveBeenCalledWith(
        [path.join(root, 'photo.jpg')],
        expect.objectContaining({ album: true, signal, progress: false }),
      );
      expect(state.entries).toHaveLength(1);
      await saveState(root, state);
      state = await loadState(root, state.serverUrl, userId);
      vi.mocked(uploadBatch).mockClear();
      await run();
      expect(uploadBatch).not.toHaveBeenCalled();
      await writeFile(path.join(root, 'photo.jpg'), 'changed photo');
      const changedChecksum = Buffer.from(hash('changed photo'), 'hex').toString('base64');
      vi.mocked(getAssetInfo).mockResolvedValue(asset({ checksum: changedChecksum }));
      await run();
      expect(uploadBatch).toHaveBeenCalledTimes(1);
      expect(state.entries[0]?.checksum).toBe(hash('changed photo'));
    });

    it('does not advance state for failed checks or a file changed during upload', async () => {
      await writeFile(path.join(root, 'photo.jpg'), 'photo');
      vi.mocked(uploadBatch).mockResolvedValue([]);
      await expect(run()).rejects.toThrow('state was not advanced');
      expect(state.entries).toEqual([]);
      vi.mocked(uploadBatch).mockImplementation(async (files) => {
        return Promise.all(
          files.map(async (filepath) => {
            await writeFile(filepath, 'still writing');
            return { id: assetId, filepath };
          }),
        );
      });
      await expect(run()).rejects.toThrow('changed during upload');
      expect(state.entries).toEqual([]);
    });

    it('waits for size/mtime stability, and checks aborts', async () => {
      await writeFile(path.join(root, 'photo.jpg'), 'photo');
      const scanning = scanLocal(root, state, { concurrency: 1 }, signal, 100);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writeFile(path.join(root, 'photo.jpg'), 'photo still writing');
      await expect(scanning).rejects.toThrow('still changing');
      const controller = new AbortController();
      controller.abort();
      await expect(scanLocal(root, state, { concurrency: 1 }, controller.signal, 0)).rejects.toThrow();
      await expect(sha1(path.join(root, 'photo.jpg'), controller.signal)).rejects.toThrow('aborted');
    });

    it('does not upload ignored or hidden files', async () => {
      await mkdir(path.join(root, 'ignored'));
      await writeFile(path.join(root, 'ignored', 'photo.jpg'), 'photo');
      await writeFile(path.join(root, '.hidden.jpg'), 'photo');
      await run({ ignore: 'ignored/**' });
      expect(uploadBatch).not.toHaveBeenCalled();
    });

    it('refreshes cached stats without uploading when content is unchanged', async () => {
      const entry = await track();
      await utimes(path.join(root, entry.path), new Date(), new Date(Date.now() + 1000));
      await run();
      expect(uploadBatch).not.toHaveBeenCalled();
      expect(state.entries[0]?.mtimeMs).not.toBe(entry.mtimeMs);
    });
  });

  describe('deletion safety', () => {
    it('defers deletion when a renamed copy is still being written', async () => {
      await track();
      await rm(path.join(root, 'photo.jpg'));
      await writeFile(path.join(root, 'renamed.jpg'), 'p');
      const running = syncOnce(root, state, { concurrency: 1, propagateLocalDeletions: true }, signal, 100);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writeFile(path.join(root, 'renamed.jpg'), 'photo');
      await expect(running).rejects.toThrow('still changing');
      expect(deleteAssets).not.toHaveBeenCalled();
      expect(uploadBatch).not.toHaveBeenCalled();
      await run({ propagateLocalDeletions: true });
      expect(deleteAssets).not.toHaveBeenCalled();
      expect(state.entries).toContainEqual(expect.objectContaining({ path: 'renamed.jpg', assetId }));
    });

    it('does not propagate local deletion of an excluded hidden path', async () => {
      await track('.hidden.jpg');
      await rm(path.join(root, '.hidden.jpg'));
      await run({ propagateLocalDeletions: true });
      expect(deleteAssets).not.toHaveBeenCalled();
      await run({ propagateLocalDeletions: true, includeHidden: true });
      expect(deleteAssets).toHaveBeenCalledExactlyOnceWith({ assetBulkDeleteDto: { ids: [assetId], force: false } });
    });

    it('never propagates deletions by default and never resurrects a locally removed file', async () => {
      await track();
      await rm(path.join(root, 'photo.jpg'));
      vi.mocked(searchAssets).mockResolvedValue(searchPage([asset()]));
      await run({ download: true });
      expect(deleteAssets).not.toHaveBeenCalled();
      expect(getAssetInfo).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
      expect(state.entries).toHaveLength(1);
    });

    it('trashes only previously tracked missing files with explicit opt-in', async () => {
      await track();
      await rm(path.join(root, 'photo.jpg'));
      await run({ propagateLocalDeletions: true });
      expect(deleteAssets).toHaveBeenCalledExactlyOnceWith({ assetBulkDeleteDto: { ids: [assetId], force: false } });
    });

    it('does not trash assets after a rename, an ignored path, or an already trashed server asset', async () => {
      await track();
      await rm(path.join(root, 'photo.jpg'));
      await writeFile(path.join(root, 'renamed.jpg'), 'photo');
      await run({ propagateLocalDeletions: true });
      expect(deleteAssets).not.toHaveBeenCalled();
      await run({ propagateLocalDeletions: true, ignore: '**' });
      expect(deleteAssets).not.toHaveBeenCalled();
      await rm(path.join(root, 'renamed.jpg'));
      vi.mocked(getAssetInfo).mockResolvedValue(asset({ isTrashed: true }));
      await run({ propagateLocalDeletions: true });
      expect(deleteAssets).not.toHaveBeenCalled();
    });

    it('dry-run performs no transfers, album mutations, deletions, or state updates', async () => {
      await track();
      await rm(path.join(root, 'photo.jpg'));
      vi.mocked(searchAssets).mockResolvedValue(searchPage([asset({ id: otherId })]));
      const before = structuredClone(state);
      await run({ download: true, propagateLocalDeletions: true, propagateServerDeletions: true, dryRun: true });
      expect(deleteAssets).not.toHaveBeenCalled();
      expect(uploadBatch).not.toHaveBeenCalled();
      expect(state).toEqual(before);
      expect(await readdir(root)).toEqual([]);
    });

    it('deletes only unchanged tracked local files after confirmed server trash', async () => {
      await track();
      await writeFile(path.join(root, 'photo.jpg.xmp'), 'sidecar');
      vi.mocked(getAssetInfo).mockResolvedValue(asset({ isTrashed: true }));
      await run({ propagateServerDeletions: true });
      expect(await readdir(root)).toEqual(['photo.jpg.xmp']);
      expect(uploadBatch).not.toHaveBeenCalled();
      expect(deleteAssets).not.toHaveBeenCalled();
    });

    it('keeps modified files and stops safely on permission/network failures', async () => {
      await track();
      await writeFile(path.join(root, 'photo.jpg'), 'edited');
      vi.mocked(getAssetInfo).mockResolvedValue(asset({ isTrashed: true }));
      vi.mocked(uploadBatch).mockResolvedValue([]);
      await expect(run({ propagateServerDeletions: true })).rejects.toThrow('state was not advanced');
      expect(await readFile(path.join(root, 'photo.jpg'), 'utf8')).toBe('edited');
      vi.mocked(getAssetInfo).mockRejectedValue(new Error('offline'));
      await expect(run({ propagateServerDeletions: true })).rejects.toThrow('offline');
      expect(await readFile(path.join(root, 'photo.jpg'), 'utf8')).toBe('edited');
    });
  });

  describe('downloads', () => {
    it('writes every stream chunk in order and sends credentials only to the original endpoint', async () => {
      vi.mocked(searchAssets).mockResolvedValue(searchPage([asset()]));
      const fetcher = vi.fn().mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const chunk of ['ph', 'o', 'to']) {
                  controller.enqueue(new TextEncoder().encode(chunk));
                }
                controller.close();
              },
            }),
          ),
      );
      vi.stubGlobal('fetch', fetcher);
      await run({ download: true });
      expect(await readFile(path.join(root, '2026/01/photo.jpg'), 'utf8')).toBe('photo');
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${state.serverUrl}/assets/${assetId}/original`, {
        headers: new Headers({ 'x-api-key': 'test-key' }),
        redirect: 'error',
        signal: expect.any(AbortSignal),
      });
    });

    it('streams verified originals, uses deterministic collision paths, and restarts incrementally', async () => {
      await mkdir(path.join(root, '2026/01'), { recursive: true });
      await writeFile(path.join(root, '2026/01/photo.jpg'), 'user file');
      vi.mocked(uploadBatch).mockImplementation(async () => [
        { id: otherId, filepath: path.join(root, '2026/01/photo.jpg') },
      ]);
      const existingChecksum = Buffer.from(hash('user file'), 'hex').toString('base64');
      vi.mocked(getAssetInfo).mockResolvedValue(asset({ id: otherId, checksum: existingChecksum }));
      vi.mocked(searchAssets).mockResolvedValue(searchPage([asset()]));
      const fetcher = mockDownload();
      await run({ download: true });
      const target = `2026/01/photo-${assetId}.jpg`;
      expect(await readFile(path.join(root, target), 'utf8')).toBe('photo');
      expect(await readFile(path.join(root, '2026/01/photo.jpg'), 'utf8')).toBe('user file');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await readdir(path.join(root, '2026/01'))).toHaveLength(2);
      await run({ download: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('deduplicates by local checksum even when the original filename differs', async () => {
      await track('renamed.jpg');
      vi.mocked(searchAssets).mockResolvedValue(searchPage([asset()]));
      const fetcher = mockDownload();
      await run({ download: true });
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual(['renamed.jpg']);
    });

    it('paginates and excludes other users and trashed assets', async () => {
      vi.mocked(searchAssets)
        .mockResolvedValueOnce(searchPage([asset({ ownerId: otherId })], '2'))
        .mockResolvedValueOnce(searchPage([asset({ isTrashed: true })]));
      const fetcher = mockDownload();
      await run({ download: true });
      expect(searchAssets).toHaveBeenNthCalledWith(2, { metadataSearchDto: expect.objectContaining({ page: 2 }) });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('uses cursor pagination and passes the exact album ID to the SDK', async () => {
      vi.mocked(getAllAlbums).mockResolvedValue([
        {
          id: otherId,
          albumName: 'Family',
          albumThumbnailAssetId: null,
          albumUsers: [],
          assetCount: 0,
          createdAt: '',
          updatedAt: '',
          description: '',
          hasSharedLink: false,
          isActivityEnabled: true,
          shared: false,
        },
      ]);
      const first = { ...searchPage([]), assets: { ...searchPage([]).assets, nextCursor: 'cursor-2' } };
      vi.mocked(searchAssets).mockResolvedValueOnce(first).mockResolvedValueOnce(searchPage([]));
      await run({ download: true, downloadAlbum: 'Family' });
      expect(searchAssets).toHaveBeenNthCalledWith(2, {
        metadataSearchDto: expect.objectContaining({
          cursor: 'cursor-2',
          albumIds: [otherId],
          withStacked: true,
        }),
      });
    });

    it('fails before mutations on ambiguous/missing album filters or failed pagination', async () => {
      vi.mocked(getAllAlbums).mockResolvedValue([]);
      await expect(run({ download: true, downloadAlbum: 'missing' })).rejects.toThrow('exactly one');
      await track();
      await rm(path.join(root, 'photo.jpg'));
      vi.mocked(searchAssets).mockRejectedValue(new Error('offline'));
      await expect(run({ download: true, propagateLocalDeletions: true })).rejects.toThrow('offline');
      expect(deleteAssets).not.toHaveBeenCalled();
    });

    it('retries failed/checksum-invalid downloads and removes only its temporary files', async () => {
      vi.mocked(searchAssets).mockResolvedValue(searchPage([asset()]));
      const fetcher = mockDownload('corrupt');
      await expect(run({ download: true })).rejects.toThrow('checksum mismatch');
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(await readdir(path.join(root, '2026/01'))).toEqual([]);
      expect(state.entries).toEqual([]);
    });

    it('never overwrites a file created concurrently during a download', async () => {
      vi.mocked(searchAssets).mockResolvedValue(searchPage([asset()]));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => {
          await writeFile(path.join(root, '2026/01/photo.jpg'), 'concurrent user file');
          return new Response('photo');
        }),
      );
      await expect(run({ download: true })).rejects.toThrow('EEXIST');
      expect(await readFile(path.join(root, '2026/01/photo.jpg'), 'utf8')).toBe('concurrent user file');
      expect(state.entries).toEqual([]);
    });

    it('reserves distinct collision paths during dry-run', async () => {
      const checksum = Buffer.from(hash('second'), 'hex').toString('base64');
      vi.mocked(searchAssets).mockResolvedValue(searchPage([asset(), asset({ id: otherId, checksum })]));
      const logging = vi.spyOn(console, 'log').mockImplementation(() => {});
      await run({ download: true, dryRun: true });
      expect(logging).toHaveBeenCalledWith(expect.stringContaining(`photo-${otherId}.jpg`));
      logging.mockRestore();
      expect(await readdir(root)).toEqual([]);
    });
  });

  it('retries transient failures and stops immediately when cancelled', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ok');
    expect(await retry(operation, signal)).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    await expect(retry(operation, controller.signal)).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  describe('lifecycle', () => {
    it('saves completed uploads and releases the lock when a later upload fails', async () => {
      await writeFile(path.join(root, 'a.jpg'), 'photo');
      await writeFile(path.join(root, 'b.jpg'), 'photo');
      vi.mocked(uploadBatch)
        .mockResolvedValueOnce([{ filepath: path.join(root, 'a.jpg'), id: assetId }])
        .mockResolvedValueOnce([]);
      await expect(sync(root, { configDirectory: root }, { concurrency: 1, once: true })).rejects.toThrow(
        'state was not advanced',
      );
      const saved = await loadState(root, state.serverUrl, userId);
      expect(saved.entries).toEqual([expect.objectContaining({ path: 'a.jpg', assetId, checksum: hash('photo') })]);
      expect(await readdir(root)).toEqual([STATE_FILE, 'a.jpg', 'b.jpg']);
    });

    it('runs once, saves state, releases its lock, and restores signal handlers', async () => {
      const before = process.listeners('SIGINT');
      const originalFetch = defaults.fetch;
      await sync(root, { configDirectory: root }, { concurrency: 1, once: true });
      expect(await loadState(root, state.serverUrl, userId)).toEqual(state);
      expect(await readdir(root)).toEqual([STATE_FILE]);
      expect(process.listeners('SIGINT')).toEqual(before);
      expect(defaults.fetch).toBe(originalFetch);
    });

    it('does not save state during dry-run or leave a lock after authentication failure', async () => {
      await sync(root, { configDirectory: root }, { concurrency: 1, once: true, dryRun: true });
      expect(await readdir(root)).toEqual([]);
      vi.mocked(authenticate).mockRejectedValue(new Error('auth failed'));
      await expect(sync(root, { configDirectory: root }, { concurrency: 1, once: true })).rejects.toThrow(
        'auth failed',
      );
      expect(await readdir(root)).toEqual([]);
    });

    it('refuses an existing lock and leaves it untouched', async () => {
      const lock = path.join(root, '.openframe-sync.lock');
      await writeFile(lock, '1234');
      await expect(sync(root, { configDirectory: root }, { concurrency: 1, once: true })).rejects.toThrow(
        'Sync lock exists',
      );
      expect(await readFile(lock, 'utf8')).toBe('1234');
    });

    const stopSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    it.each(stopSignals)('stops watching on %s and saves completed progress', async (event) => {
      const before = process.listeners(event);
      const running = sync(root, { configDirectory: root }, { concurrency: 1 });
      try {
        await vi.waitFor(async () => expect(await readdir(root)).toContain(STATE_FILE));
        const stop = process.listeners(event).find((listener) => !before.includes(listener));
        expect(stop).toBeDefined();
        stop?.(event);
        await running;
        expect(await readdir(root)).toEqual([STATE_FILE]);
        expect(process.listeners(event)).toEqual(before);
      } finally {
        const stop = process.listeners(event).find((listener) => !before.includes(listener));
        stop?.(event);
        await running;
      }
    });
  });

  it('never treats HTTP 404 (wrong base URL or proxy) as a server deletion', async () => {
    await track();
    vi.mocked(isHttpError).mockReturnValue(true);
    vi.mocked(getAssetInfo).mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    await expect(run({ propagateServerDeletions: true })).rejects.toThrow('gone');
    expect(await readFile(path.join(root, 'photo.jpg'), 'utf8')).toBe('photo');
    vi.mocked(getAssetInfo).mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await expect(run({ propagateServerDeletions: true })).rejects.toThrow('forbidden');
    expect(await readFile(path.join(root, 'photo.jpg'), 'utf8')).toBe('photo');
  });

  it('confirms a purged asset with the checksum check before deleting local data', async () => {
    await track();
    vi.mocked(isHttpError).mockReturnValue(true);
    vi.mocked(getAssetInfo).mockRejectedValue(
      Object.assign(new Error('Not found or no asset.read access'), { status: 400 }),
    );
    vi.mocked(checkBulkUpload).mockImplementation(async ({ assetBulkUploadCheckDto }) => ({
      results: assetBulkUploadCheckDto.assets.map(({ id }) => ({
        id,
        action: AssetUploadAction.Reject,
        reason: AssetRejectReason.Duplicate,
        assetId: otherId,
      })),
    }));
    await run({ propagateServerDeletions: true });
    expect(await readFile(path.join(root, 'photo.jpg'), 'utf8')).toBe('photo');
    vi.mocked(checkBulkUpload).mockImplementation(async ({ assetBulkUploadCheckDto }) => ({
      results: assetBulkUploadCheckDto.assets.map(({ id }) => ({ id, action: AssetUploadAction.Accept })),
    }));
    await run({ propagateServerDeletions: true });
    expect(await readdir(root)).toEqual([]);
  });
});
