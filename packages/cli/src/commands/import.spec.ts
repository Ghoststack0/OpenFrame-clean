import { addAssetsToAlbum, createAlbum, getAllAlbums, updateAsset } from '@immich/sdk';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { importExport, protectExports } from 'src/commands/import.js';
import { hasEmbeddedCaptureDate } from 'src/import/metadata.js';
import { uploadImportFile } from 'src/import/upload.js';
import { authenticate } from 'src/utils.js';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existingLinks = vi.hoisted(() => new Map<string, string>());
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getMyUser: vi.fn(async () => ({ id: 'user-1' })),
  getAssetInfo: vi.fn(async ({ id }: { id: string }) => ({ livePhotoVideoId: existingLinks.get(id) })),
  getSupportedMediaTypes: vi.fn(async () => ({ image: ['.jpg', '.heic', '.png'], video: ['.mov', '.mp4'] })),
  getAllAlbums: vi.fn(async () => []),
  createAlbum: vi.fn(async () => ({ id: 'album-1' })),
  addAssetsToAlbum: vi.fn(async () => [{ id: 'asset-1', success: true }]),
  updateAsset: vi.fn(async () => ({})),
}));
vi.mock('src/utils.js', () => ({
  authenticate: vi.fn(async () => ({ url: 'https://server/api', key: 'secret' })),
  requirePermissions: vi.fn(),
}));
vi.mock('src/import/upload.js', () => ({ uploadImportFile: vi.fn(async () => 'asset-1') }));
vi.mock('src/import/metadata.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/import/metadata.js')>()),
  hasEmbeddedCaptureDate: vi.fn(async () => false),
}));

describe('import command', () => {
  let root: string;
  let source: string;
  let base: { configDirectory: string };
  let progressFile: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    existingLinks.clear();
    root = await mkdtemp(path.join(os.tmpdir(), 'import-command-test-'));
    source = path.join(root, 'Google Photos');
    base = { configDirectory: path.join(root, 'config') };
    progressFile = path.join(root, 'progress.json');
    await mkdir(path.join(source, 'Trip'), { recursive: true });
    await writeFile(path.join(source, 'Trip', 'a.jpg'), 'synthetic image');
    await writeFile(
      path.join(source, 'Trip', 'a.jpg.json'),
      JSON.stringify({ photoTakenTime: { timestamp: '1609459200' }, favorited: true }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('dry-runs offline, prints counts/albums and writes a problem report without state or uploads', async () => {
    await writeFile(path.join(source, 'Trip', 'orphan.jpg.json'), '{}');
    const report = path.join(root, 'report.json');
    await importExport('takeout', [source], base, { dryRun: true, report, progressFile });
    expect(console.log).toHaveBeenCalledWith(
      'Dry run: 1 media, 1 eligible, 0 trashed skipped, 0 partner-shared skipped',
    );
    expect(console.log).toHaveBeenCalledWith('Sidecars: 1 matched, 1 unmatched; 0 media without sidecars');
    expect(console.log).toHaveBeenCalledWith('Albums to create or reuse (1): Trip');
    expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({
      dryRun: true,
      summary: { eligible: 1 },
      problems: [{ message: 'Unmatched sidecar' }],
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(uploadImportFile).not.toHaveBeenCalled();
    expect(updateAsset).not.toHaveBeenCalled();
    expect(createAlbum).not.toHaveBeenCalled();
    await expect(access(progressFile)).rejects.toThrow();
    expect(await readFile(path.join(source, 'Trip', 'a.jpg'), 'utf8')).toBe('synthetic image');
  });

  it('uploads through the adapter, applies metadata and albums, then resumes without re-uploading', async () => {
    await importExport('takeout', [source], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(1);
    expect(updateAsset).toHaveBeenCalledWith({
      id: 'asset-1',
      updateAssetDto: { dateTimeOriginal: '2021-01-01T00:00:00.000Z', isFavorite: true },
    });
    expect(createAlbum).toHaveBeenCalledWith({ createAlbumDto: { albumName: 'Trip' } });
    expect(addAssetsToAlbum).toHaveBeenCalledWith({ id: 'album-1', bulkIdsDto: { ids: ['asset-1'] } });
    const staged = vi.mocked(uploadImportFile).mock.calls[0][0];
    await expect(access(staged)).rejects.toThrow();
    await importExport('takeout', [source], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(1);
    expect(updateAsset).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith('Imported: 0; already completed: 1; failed: 0');
    const journal = await readFile(progressFile, 'utf8');
    expect(JSON.parse(journal.split('\n', 1)[0])).toMatchObject({
      format: 'openframe-import-v1',
      target: 'https://server/api:user-1',
    });
  });

  it('keeps an embedded capture date instead of overwriting it with the UTC sidecar time', async () => {
    vi.mocked(hasEmbeddedCaptureDate).mockResolvedValueOnce(true);
    await importExport('takeout', [source], base, { progressFile });
    expect(updateAsset).toHaveBeenCalledWith({ id: 'asset-1', updateAssetDto: { isFavorite: true } });
  });

  it('remembers the embedded-date decision when resuming metadata after a failure', async () => {
    vi.mocked(hasEmbeddedCaptureDate).mockResolvedValueOnce(true);
    vi.mocked(updateAsset).mockRejectedValueOnce(new Error('temporary server failure'));
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow('failed');
    await importExport('takeout', [source], base, { progressFile });
    expect(hasEmbeddedCaptureDate).toHaveBeenCalledTimes(1);
    expect(updateAsset).toHaveBeenLastCalledWith({ id: 'asset-1', updateAssetDto: { isFavorite: true } });
  });

  it('reclaims a lock left behind by an interrupted import', async () => {
    await writeFile(`${progressFile}.lock`, '2147483646');
    await importExport('takeout', [source], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(1);
    await expect(access(`${progressFile}.lock`)).rejects.toThrow();
  });

  it('refuses to run while another live import holds the lock', async () => {
    await writeFile(`${progressFile}.lock`, String(process.pid));
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow('Another import');
    expect(uploadImportFile).not.toHaveBeenCalled();
    expect(await readFile(`${progressFile}.lock`, 'utf8')).toBe(String(process.pid));
    await rm(`${progressFile}.lock`);
  });

  it('resumes metadata after a failure without uploading again', async () => {
    vi.mocked(updateAsset).mockRejectedValueOnce(new Error('temporary server failure'));
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow(
      '1 import operations failed',
    );
    const journal = await readFile(progressFile, 'utf8');
    expect(
      JSON.parse(journal.trim().split('\n').at(-1) ?? '').assets[path.join(source, 'Trip', 'a.jpg')].completed,
    ).toBeUndefined();
    await importExport('takeout', [source], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(1);
    expect(updateAsset).toHaveBeenCalledTimes(2);
    await expect(access(`${progressFile}.lock`)).rejects.toThrow();
  });

  it('retries failed transfers, and notices changed source files', async () => {
    vi.mocked(uploadImportFile).mockRejectedValueOnce(new Error('network failure'));
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow('failed');
    await importExport('takeout', [source], base, { progressFile });
    await writeFile(path.join(source, 'Trip', 'a.jpg'), 'changed synthetic bytes');
    await importExport('takeout', [source], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(3);
  });

  it('links Live Photos only after both uploads and retries failed links', async () => {
    await writeFile(path.join(source, 'Trip', 'a.mov'), 'synthetic video');
    vi.mocked(uploadImportFile).mockResolvedValueOnce('image').mockResolvedValueOnce('video');
    const implementation = vi.mocked(updateAsset).getMockImplementation();
    if (!implementation) {
      throw new Error('Missing test mock');
    }
    vi.mocked(updateAsset).mockImplementationOnce(implementation).mockRejectedValueOnce(new Error('link failed'));
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow('failed');
    await importExport('takeout', [source], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(2);
    expect(updateAsset).toHaveBeenLastCalledWith({ id: 'image', updateAssetDto: { livePhotoVideoId: 'video' } });
    await importExport('takeout', [source], base, { progressFile });
    expect(updateAsset).toHaveBeenCalledTimes(3);
  });

  it('does not record rejected album membership as complete', async () => {
    vi.mocked(addAssetsToAlbum).mockResolvedValueOnce([{ id: 'asset-1', success: false }]);
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow('failed');
    await importExport('takeout', [source], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(1);
    expect(addAssetsToAlbum).toHaveBeenCalledTimes(2);
  });

  it('recovers an interrupted final journal record and can resume repeatedly', async () => {
    await importExport('takeout', [source], base, { progressFile });
    const before = await readFile(progressFile, 'utf8');
    await writeFile(progressFile, `${before}{"format":"openframe-`);
    await importExport('takeout', [source], base, { progressFile });
    await importExport('takeout', [source], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(1);
    expect(await readFile(progressFile, 'utf8')).toBe(before);
  });

  it('preserves an existing Live Photo link when the export suggests another video', async () => {
    await writeFile(path.join(source, 'Trip', 'a.mov'), 'synthetic video');
    vi.mocked(uploadImportFile).mockResolvedValueOnce('image').mockResolvedValueOnce('video');
    existingLinks.set('image', 'existing-video');
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow('failed');
    expect(updateAsset).not.toHaveBeenCalledWith({ id: 'image', updateAssetDto: { livePhotoVideoId: 'video' } });
    const reports = await readdir(path.join(base.configDirectory, 'imports'));
    expect(await readFile(path.join(base.configDirectory, 'imports', reports[0]), 'utf8')).toContain(
      'existing link preserved',
    );
  });

  it('rejects progress belonging to another user/server and malformed state', async () => {
    await writeFile(
      progressFile,
      JSON.stringify({ format: 'openframe-import-v1', target: 'another-user', assets: {}, pairs: [] }),
    );
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow('another server/user');
    await writeFile(progressFile, 'invalid');
    await expect(importExport('takeout', [source], base, { progressFile })).rejects.toThrow();
    expect(uploadImportFile).not.toHaveBeenCalled();
  });

  it('protects source files, including output paths through symlinks, and refuses report overwrites', async () => {
    const original = path.join(source, 'Trip', 'a.jpg.json');
    const before = await readFile(original);
    await expect(importExport('takeout', [source], base, { dryRun: true, report: original })).rejects.toThrow(
      'outside the export',
    );
    await expect(
      importExport('takeout', [source], base, { dryRun: true, progressFile: path.join(source, 'new.json') }),
    ).rejects.toThrow('outside the export');
    const alias = path.join(root, 'alias');
    await symlink(source, alias);
    await expect(protectExports(path.join(alias, 'new', 'report.json'), [source])).rejects.toThrow(
      'outside the export',
    );
    const report = path.join(root, 'existing.json');
    await writeFile(report, 'keep me');
    await expect(importExport('takeout', [source], base, { report })).rejects.toThrow('EEXIST');
    expect(await readFile(original)).toEqual(before);
    expect(await readFile(report, 'utf8')).toBe('keep me');
    expect(await readdir(path.join(source, 'Trip'))).toEqual(['a.jpg', 'a.jpg.json']);
  });

  it('imports streamed ZIP parts through the same transfer boundary', async () => {
    const fixtures = path.join(import.meta.dirname, '../import/fixtures');
    await importExport('takeout', [path.join(fixtures, 'media.zip'), path.join(fixtures, 'metadata.zip')], base, {
      progressFile,
    });
    expect(uploadImportFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadImportFile).mock.calls[0][0]).toMatch(/pixel\.png$/);
    expect(getAllAlbums).toHaveBeenCalledTimes(1);
  });

  it('streams a TGZ through both passes and removes its staging file', async () => {
    const archive = path.join(root, 'part.tgz');
    const tar = pack();
    tar.entry({ name: 'Takeout/Google Photos/Trip/a.jpg' }, 'synthetic image');
    tar.entry({ name: 'Takeout/Google Photos/Trip/a.jpg.json' }, '{}');
    tar.finalize();
    await pipeline(tar, createGzip(), createWriteStream(archive));
    await importExport('takeout', [archive], base, { progressFile });
    expect(uploadImportFile).toHaveBeenCalledTimes(1);
    const staged = vi.mocked(uploadImportFile).mock.calls[0][0];
    await expect(access(staged)).rejects.toThrow();
  });
});
