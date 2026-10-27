import request from 'supertest';
import { ResumableUploadController } from 'src/controllers/resumable-upload.controller.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { Permission } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { ResumableUploadService } from 'src/services/resumable-upload.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { type ControllerContext, automock, controllerSetup } from 'test/utils.js';

const session = {
  id: '00000000-0000-4000-a000-000000000001',
  size: 6,
  offset: 2,
  chunkSize: 8 * 1024 * 1024,
  expiresAt: '2026-10-29T00:00:00.000Z',
};
const service = automock(ResumableUploadService);

describe(ResumableUploadController.name, () => {
  let ctx: ControllerContext;
  beforeAll(async () => {
    ctx = await controllerSetup(ResumableUploadController, [
      { provide: ResumableUploadService, useValue: service },
      { provide: StorageRepository, useValue: automock(StorageRepository, { args: [LoggingRepository.create()] }) },
    ]);
  });
  afterAll(() => ctx.close());
  beforeEach(() => {
    ctx.reset();
    ctx.authenticate.mockResolvedValue(authStub.user1);
    service.resetAllMocks();
  });

  it('validates creation metadata and uses the normal upload permission', async () => {
    service.create.mockResolvedValue(session);
    const dto = {
      filename: 'video.mp4',
      size: 6,
      checksum: 'a'.repeat(40),
      fileCreatedAt: '2026-10-28T00:00:00.000Z',
      fileModifiedAt: '2026-10-28T00:00:00.000Z',
    };
    await request(ctx.getHttpServer())
      .post('/assets/uploads')
      .send({ ...dto, size: -1 })
      .expect(400);
    const response = await request(ctx.getHttpServer()).post('/assets/uploads').send(dto).expect(201);
    expect(response.body).toEqual(session);
    expect(service.create).toHaveBeenCalledWith(authStub.user1, {
      ...dto,
      fileCreatedAt: new Date(dto.fileCreatedAt),
      fileModifiedAt: new Date(dto.fileModifiedAt),
    });
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ permission: Permission.AssetUpload, sharedLinkRoute: true }),
      }),
    );
  });

  it('streams raw chunks and rejects invalid offsets and content types', async () => {
    const received: Buffer[] = [];
    service.patch.mockImplementation(async (_auth, _id, offset, stream) => {
      expect(offset).toBe(2);
      for await (const chunk of stream) {
        received.push(chunk);
      }
      return { ...session, offset: 6 };
    });
    await request(ctx.getHttpServer())
      .patch(`/assets/uploads/${session.id}`)
      .set('Upload-Offset', '2')
      .set('Content-Type', 'application/offset+octet-stream')
      .send(Buffer.from('data'))
      .expect(200);
    expect(Buffer.concat(received).toString()).toBe('data');
    await request(ctx.getHttpServer())
      .patch(`/assets/uploads/${session.id}`)
      .set('Upload-Offset', '-1')
      .set('Content-Type', 'application/offset+octet-stream')
      .send(Buffer.from('data'))
      .expect(400);
    await request(ctx.getHttpServer())
      .patch(`/assets/uploads/${session.id}`)
      .set('Upload-Offset', '2')
      .send('data')
      .expect(400);
    expect(service.patch).toHaveBeenCalledTimes(1);
  });

  it('returns offset headers and the existing asset response at finalization', async () => {
    service.head.mockResolvedValue(session);
    const head = await request(ctx.getHttpServer()).head(`/assets/uploads/${session.id}`).expect(200);
    expect(head.headers['upload-offset']).toBe('2');
    expect(head.headers['upload-length']).toBe('6');
    expect(head.headers['cache-control']).toBe('no-store');
    service.finalize.mockResolvedValue({ id: session.id, status: AssetMediaStatus.CREATED });
    const response = await request(ctx.getHttpServer()).post(`/assets/uploads/${session.id}/finalize`).expect(200);
    expect(response.body).toEqual({ id: session.id, status: AssetMediaStatus.CREATED });
  });
});
