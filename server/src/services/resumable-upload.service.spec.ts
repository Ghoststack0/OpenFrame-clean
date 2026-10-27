import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { ResumableUploadCreateSchema } from 'src/dtos/resumable-upload.dto.js';
import { JobName, JobStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { type UploadSession, UploadSessionRepository } from 'src/repositories/upload-session.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { ResumableUploadService } from 'src/services/resumable-upload.service.js';
import { ASSET_CHECKSUM_CONSTRAINT } from 'src/utils/database.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { automock, newTestService } from 'test/utils.js';

const data = Buffer.from('a resumable video');
const checksum = createHash('sha1').update(data).digest('hex');
const dto = () =>
  ResumableUploadCreateSchema.parse({
    filename: 'video.mp4',
    size: data.length,
    checksum,
    fileCreatedAt: '2026-10-01T00:00:00.000Z',
    fileModifiedAt: '2026-10-01T00:00:00.000Z',
  });

describe(ResumableUploadService.name, () => {
  let directory: string;
  let session: UploadSession | undefined;
  let sut: ResumableUploadService;
  let media: ReturnType<typeof newTestService<AssetMediaService>>;
  const repository = automock(UploadSessionRepository);
  const asset = AssetFactory.create();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'resumable-'));
    media = newTestService(AssetMediaService);
    StorageCore.setMediaLocation(directory);
    media.mocks.storage.mkdirSync.mockImplementation((folder) => {
      mkdirSync(folder, { recursive: true });
    });
    media.mocks.asset.create.mockResolvedValue(asset);
    media.mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(asset.id);
    media.mocks.job.queue.mockResolvedValue();
    media.mocks.storage.utimes.mockResolvedValue();
    media.mocks.asset.upsertExif.mockResolvedValue(undefined);
    media.mocks.event.emit.mockResolvedValue();
    repository.resetAllMocks();
    session = undefined;
    repository.create.mockImplementation((input) => {
      const created: UploadSession = {
        ...input,
        expiresAt: new Date(input.expiresAt),
        sharedLinkId: input.sharedLinkId ?? null,
        result: input.result ?? null,
        metadata: JSON.parse(JSON.stringify(input.metadata)),
      };
      session = created;
      return Promise.resolve(created);
    });
    repository.update.mockImplementation((_id, values) => {
      Object.assign(session!, values);
      return Promise.resolve();
    });
    repository.delete.mockImplementation(() => {
      session = undefined;
      return Promise.resolve();
    });
    repository.withLock.mockImplementation(async (_id, action) => action(session, repository));
    sut = new ResumableUploadService(
      repository,
      new StorageRepository(automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false })),
      media.sut,
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects offset mismatches without writing bytes', async () => {
    const { id } = await sut.create(authStub.user1, dto());
    await expect(sut.patch(authStub.user1, id, 1, Readable.from(data))).rejects.toBeInstanceOf(ConflictException);
    const head = await sut.head(authStub.user1, id);
    expect(head.offset).toBe(0);
  });

  it('resumes after an interrupted chunk and delegates finalization to normal asset creation', async () => {
    const { id } = await sut.create(authStub.user1, dto());
    await sut.patch(authStub.user1, id, 0, Readable.from(data.subarray(0, 4)));
    const broken = Readable.from(
      (async function* () {
        await Promise.resolve();
        yield Buffer.from('garbage');
        throw new Error('disconnected');
      })(),
    );
    await expect(sut.patch(authStub.user1, id, 4, broken)).rejects.toThrow('disconnected');
    const head = await sut.head(authStub.user1, id);
    expect(head.offset).toBe(4);
    await sut.patch(authStub.user1, id, 4, Readable.from(data.subarray(4)));
    await expect(sut.finalize(authStub.user1, id)).resolves.toEqual({ id: asset.id, status: AssetMediaStatus.CREATED });
    const uploaded = media.mocks.asset.create.mock.calls[0][0];
    expect(await readFile(uploaded.originalPath!)).toEqual(data);
    expect(media.mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.AssetExtractMetadata,
      data: { id: asset.id, source: 'upload' },
    });
    await expect(sut.finalize(authStub.user1, id)).resolves.toEqual({ id: asset.id, status: AssetMediaStatus.CREATED });
    expect(media.mocks.asset.create).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete uploads and checksum failures', async () => {
    const { id } = await sut.create(authStub.user1, dto());
    await expect(sut.finalize(authStub.user1, id)).rejects.toBeInstanceOf(ConflictException);
    await sut.patch(authStub.user1, id, 0, Readable.from(Buffer.alloc(data.length)));
    await expect(sut.finalize(authStub.user1, id)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(media.mocks.asset.create).not.toHaveBeenCalled();
  });

  it('uses normal checksum deduplication and preserves the staged file during duplicate cleanup', async () => {
    media.mocks.asset.create.mockRejectedValue(
      Object.assign(new Error('duplicate'), { constraint_name: ASSET_CHECKSUM_CONSTRAINT }),
    );
    const { id } = await sut.create(authStub.user1, dto());
    await sut.patch(authStub.user1, id, 0, Readable.from(data));
    await expect(sut.finalize(authStub.user1, id)).resolves.toEqual({
      id: asset.id,
      status: AssetMediaStatus.DUPLICATE,
    });
    expect(media.mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.FileDelete,
      data: { files: [expect.not.stringContaining('.part'), undefined] },
    });
  });

  it('expires abandoned sessions, without touching finalized asset files', async () => {
    const { id } = await sut.create(authStub.user1, dto());
    await sut.patch(authStub.user1, id, 0, Readable.from(data));
    await sut.finalize(authStub.user1, id);
    session!.expiresAt = new Date(0);
    await expect(sut.head(authStub.user1, id)).rejects.toBeInstanceOf(NotFoundException);
    repository.getExpired.mockResolvedValueOnce([{ id }]).mockResolvedValueOnce([]);
    await expect(sut.cleanup()).resolves.toBe(JobStatus.Success);
    expect(session).toBeUndefined();
    expect(await readFile(media.mocks.asset.create.mock.calls[0][0].originalPath!)).toEqual(data);
  });

  it('rejects another user and another sharing context', async () => {
    const { id } = await sut.create(authStub.user1, dto());
    await expect(sut.head(authStub.admin, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      sut.head(
        {
          ...authStub.user1,
          sharedLink: { ...authStub.adminSharedLink.sharedLink, id: 'other-link', allowUpload: true },
        },
        id,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enforces upload permission, quota and file type at creation', async () => {
    await expect(
      sut.create(
        { ...authStub.user1, sharedLink: { ...authStub.adminSharedLink.sharedLink, allowUpload: false } },
        dto(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      sut.create(
        { ...authStub.user1, user: { ...authStub.user1.user, quotaSizeInBytes: 1, quotaUsageInBytes: 0 } },
        dto(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(sut.create(authStub.user1, { ...dto(), filename: 'bad.exe' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.create).not.toHaveBeenCalled();
  });
});
