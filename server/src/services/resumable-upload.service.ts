import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { UploadFile } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto.js';
import { UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  ResumableUploadCreateDto,
  ResumableUploadCreateSchema,
  ResumableUploadResponseDto,
  UPLOAD_CHUNK_LEASE,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_SESSION_TTL,
} from 'src/dtos/resumable-upload.dto.js';
import { JobName, JobStatus, QueueName, StorageFolder } from 'src/enum.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { type UploadSession, UploadSessionRepository } from 'src/repositories/upload-session.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { fromChecksum } from 'src/utils/request.js';

@Injectable()
export class ResumableUploadService {
  constructor(
    private repository: UploadSessionRepository,
    private storage: StorageRepository,
    private media: AssetMediaService,
  ) {}

  async create(auth: AuthDto, dto: ResumableUploadCreateDto): Promise<ResumableUploadResponseDto> {
    await this.media.checkUploadAccess(auth, dto.size);
    const id = randomUUID();
    const file = this.uploadFile(id, dto);
    const request = { auth, fieldName: UploadFieldName.ASSET_DATA, file, body: { ...dto } };
    this.media.canUploadFile(request);
    const folder = this.media.getUploadFolder(request);
    const partial = join(folder, `${id}.part`);
    // Insert first, so a crash while creating the empty file is still discoverable by cleanup.
    const session = await this.repository.create({
      id,
      userId: auth.user.id,
      sharedLinkId: auth.sharedLink?.id ?? null,
      size: dto.size,
      offset: 0,
      metadata: { ...dto },
      result: null,
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL),
    });
    try {
      await this.storage.createFile(partial, Buffer.alloc(0));
    } catch (error) {
      await this.repository.delete(id);
      throw error;
    }
    return this.response(session);
  }

  async head(auth: AuthDto, id: string): Promise<ResumableUploadResponseDto> {
    const current = await this.checkSession(auth, await this.repository.get(id));
    return this.response(current);
  }

  async patch(auth: AuthDto, id: string, offset: number, input: Readable): Promise<ResumableUploadResponseDto> {
    await this.checkSession(auth, await this.repository.get(id));
    const leaseId = randomUUID();
    const current = await this.repository.acquire(id, leaseId, new Date(Date.now() + UPLOAD_CHUNK_LEASE));
    if (!current) {
      throw new ConflictException('Another chunk for this upload is in progress');
    }
    let isReleased = false;
    try {
      if (new Date(current.expiresAt).getTime() <= Date.now()) {
        throw new NotFoundException('Upload session not found or expired');
      }
      if (current.result || offset !== current.offset) {
        throw new ConflictException('Upload offset mismatch');
      }
      const limit = Math.min(UPLOAD_CHUNK_SIZE, current.size - offset);
      if (limit <= 0) {
        throw new ConflictException('Upload is complete; finalize it');
      }
      const written = await this.storage.writeUploadChunk(this.partialPath(current), input, offset, limit);
      if (written === 0) {
        throw new BadRequestException('Empty chunk');
      }
      const next = { ...current, offset: offset + written, expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL) };
      isReleased = await this.repository.release(id, leaseId, { offset: next.offset, expiresAt: next.expiresAt });
      if (!isReleased) {
        throw new ConflictException('Upload chunk took too long; query the offset and retry');
      }
      return this.response(next);
    } finally {
      if (!isReleased) {
        await this.repository.release(id, leaseId);
      }
    }
  }

  async finalize(auth: AuthDto, id: string, sidecarFile?: UploadFile): Promise<AssetMediaResponseDto> {
    let sidecarDelegated = false;
    try {
      const current = await this.repository.withLock(id, async (session, repository) => {
        const current = await this.checkSession(auth, session);
        if (current.leaseExpiresAt && new Date(current.leaseExpiresAt).getTime() > Date.now()) {
          throw new ConflictException('A chunk for this upload is still in progress');
        }
        if (current.offset !== current.size) {
          throw new ConflictException('Upload is incomplete');
        }
        await repository.update(id, { expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL) });
        return current;
      });
      if (current.result) {
        if (sidecarFile) {
          await this.storage.unlink(sidecarFile.originalPath);
        }
        return current.result;
      }
      const dto = ResumableUploadCreateSchema.parse(current.metadata);
      const checksum = await this.storage.hashFile(this.partialPath(current));
      if (!checksum.equals(fromChecksum(dto.checksum))) {
        throw new UnprocessableEntityException('Upload checksum mismatch');
      }
      const file = this.uploadFile(randomUUID(), dto);
      const request = { auth, fieldName: UploadFieldName.ASSET_DATA, file, body: { ...dto } };
      file.originalPath = join(this.media.getUploadFolder(request), this.media.getUploadFilename(request));
      // Separate hard links let concurrent finalizers use normal dedup cleanup without deleting staged data or an asset.
      await this.storage.linkOrCopy(this.partialPath(current), file.originalPath);
      // Release the session connection before normal asset creation needs connections from the same pool.
      sidecarDelegated = true;
      const result = await this.media.uploadAsset(auth, dto, file, sidecarFile);
      return await this.repository.withLock(id, async (session, repository) => {
        if (!session) {
          throw new NotFoundException('Upload session expired during finalization');
        }
        if (session.result) {
          return session.result;
        }
        await repository.update(id, { result });
        return result;
      });
    } catch (error) {
      if (sidecarFile && !sidecarDelegated) {
        await this.storage.unlink(sidecarFile.originalPath);
      }
      throw error;
    }
  }

  @OnJob({ name: JobName.UploadSessionCleanup, queue: QueueName.BackgroundTask })
  async cleanup(): Promise<JobStatus> {
    for (;;) {
      const expired = await this.repository.getExpired();
      if (expired.length === 0) {
        return JobStatus.Success;
      }
      for (const { id } of expired) {
        await this.repository.withLock(id, async (session, repository) => {
          if (!(session && new Date(session.expiresAt).getTime() <= Date.now())) {
            return;
          }

          await this.storage.unlink(this.partialPath(session));
          await repository.delete(id);
        });
      }
    }
  }

  private async checkSession(auth: AuthDto, session: UploadSession | undefined): Promise<UploadSession> {
    await this.media.checkUploadAccess(auth, 0);
    if (
      !session ||
      session.userId !== auth.user.id ||
      session.sharedLinkId !== (auth.sharedLink?.id ?? null) ||
      new Date(session.expiresAt).getTime() <= Date.now()
    ) {
      throw new NotFoundException('Upload session not found or expired');
    }
    if (!session.result) {
      await this.media.checkUploadAccess(auth, session.size);
    }
    return session;
  }

  private uploadFile(id: string, dto: ResumableUploadCreateDto): UploadFile {
    return {
      uuid: id,
      checksum: fromChecksum(dto.checksum),
      originalPath: '',
      originalName: dto.filename,
      size: dto.size,
    };
  }

  private partialPath(session: UploadSession) {
    return join(StorageCore.getNestedFolder(StorageFolder.Upload, session.userId, session.id), `${session.id}.part`);
  }

  private response(session: UploadSession): ResumableUploadResponseDto {
    return {
      id: session.id,
      offset: session.offset,
      size: session.size,
      expiresAt: new Date(session.expiresAt).toISOString(),
      chunkSize: UPLOAD_CHUNK_SIZE,
    };
  }
}
