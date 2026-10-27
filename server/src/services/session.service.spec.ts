import { ZodValidationPipe } from 'nestjs-zod';
import { DeviceTransferDto } from 'src/dtos/session.dto.js';
import { JobStatus } from 'src/enum.js';
import { SessionService } from 'src/services/session.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe('SessionService', () => {
  let sut: SessionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SessionService));
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('handleCleanup', () => {
    it('should clean sessions', async () => {
      mocks.session.cleanup.mockResolvedValue([]);
      await expect(sut.handleCleanup()).resolves.toEqual(JobStatus.Success);
    });
  });

  describe('getAll', () => {
    it('should get the devices', async () => {
      const currentSession = SessionFactory.create();
      const otherSession = SessionFactory.create();
      const auth = AuthFactory.from().session(currentSession).build();

      mocks.session.getByUserId.mockResolvedValue([currentSession, otherSession]);

      await expect(sut.getAll(auth)).resolves.toEqual([
        expect.objectContaining({ current: true, id: currentSession.id }),
        expect.objectContaining({ current: false, id: otherSession.id }),
      ]);

      expect(mocks.session.getByUserId).toHaveBeenCalledWith(auth.user.id);
    });
  });

  describe('logoutDevices', () => {
    it('should logout all devices', async () => {
      const currentSession = SessionFactory.create();
      const auth = AuthFactory.from().session(currentSession).build();

      mocks.session.invalidateAll.mockResolvedValue();

      await sut.deleteAll(auth);

      expect(mocks.session.invalidateAll).toHaveBeenCalledWith({
        userId: auth.user.id,
        excludeId: currentSession.id,
      });
    });
  });

  describe('device transfers', () => {
    const current = SessionFactory.create();
    const auth = AuthFactory.from({ id: current.userId }).session(current).build();
    const target = SessionFactory.create({ userId: auth.user.id, deviceType: 'Chrome', deviceOS: 'Linux' });
    const dto: DeviceTransferDto = { targetSessionId: target.id, assetIds: [newUuid(), newUuid()], action: 'open' };

    beforeEach(() => {
      mocks.session.getByUserId.mockResolvedValue([target]);
      mocks.websocket.getOnlineSessionIds.mockResolvedValue(new Set([target.id]));
      mocks.websocket.sendToSession.mockResolvedValue(true);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(dto.assetIds));
      mocks.crypto.randomUUID.mockReturnValue(newUuid());
    });

    it('lists only other online sessions owned by the caller, with device labels', async () => {
      const offline = SessionFactory.create({ userId: auth.user.id });
      mocks.session.getByUserId.mockResolvedValue([current, target, offline]);
      mocks.websocket.getOnlineSessionIds.mockResolvedValue(new Set([current.id, target.id, newUuid()]));

      await expect(sut.getTargets(auth)).resolves.toEqual([
        {
          id: target.id,
          deviceType: 'Chrome',
          deviceOS: 'Linux',
          deviceName: 'Chrome',
          label: `Chrome on Linux (${target.id.slice(0, 8)})`,
        },
      ]);
      expect(mocks.session.getByUserId).toHaveBeenCalledWith(auth.user.id);
      expect(mocks.websocket.getOnlineSessionIds).toHaveBeenCalledWith(auth.user.id);
    });

    it('uses a fallback label when device metadata is empty', async () => {
      mocks.session.getByUserId.mockResolvedValue([{ ...target, deviceType: '', deviceOS: '' }]);
      await expect(sut.getTargets(auth)).resolves.toEqual([
        expect.objectContaining({ deviceName: 'Unknown device', label: `Unknown device (${target.id.slice(0, 8)})` }),
      ]);
    });

    it.each(['open', 'download'] as const)('sends an %s command only to the owned target session', async (action) => {
      const payload = await sut.sendToDevice(auth, { ...dto, action });
      expect(payload).toEqual({
        ...dto,
        action,
        id: expect.any(String),
        sourceSessionId: current.id,
        sentAt: expect.any(String),
      });
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set(dto.assetIds), false);
      expect(mocks.websocket.sendToSession).toHaveBeenCalledExactlyOnceWith(auth.user.id, payload);
    });

    it("rejects a different user's session even if online", async () => {
      mocks.session.getByUserId.mockResolvedValue([]);
      await expect(sut.sendToDevice(auth, dto)).rejects.toThrow('Target session not found');
      expect(mocks.session.getByUserId).toHaveBeenCalledWith(auth.user.id);
      expect(mocks.websocket.sendToSession).not.toHaveBeenCalled();
      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
    });

    it('rejects the current session', async () => {
      await expect(sut.sendToDevice(auth, { ...dto, targetSessionId: current.id })).rejects.toThrow(
        'Choose another session',
      );
      expect(mocks.websocket.sendToSession).not.toHaveBeenCalled();
    });

    it('rejects the whole transfer when any asset is inaccessible', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([dto.assetIds[0]]));
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set());
      await expect(sut.sendToDevice(auth, dto)).rejects.toThrow('Not found or no asset.read access');
      expect(mocks.websocket.sendToSession).not.toHaveBeenCalled();
    });

    it('allows assets accessible through a shared album', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set(dto.assetIds));
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set());
      await expect(sut.sendToDevice(auth, dto)).resolves.toMatchObject(dto);
    });

    it('rejects an offline target, including a disconnect after listing', async () => {
      await expect(sut.getTargets(auth)).resolves.toHaveLength(1);
      mocks.websocket.sendToSession.mockResolvedValue(false);
      await expect(sut.sendToDevice(auth, dto)).rejects.toThrow('Target session is offline');
    });

    it.each([AuthFactory.create(), AuthFactory.from().apiKey().build(), AuthFactory.from().sharedLink().build()])(
      'requires a signed-in session',
      async (otherAuth) => {
        await expect(sut.getTargets(otherAuth)).rejects.toThrow('session token');
        await expect(sut.sendToDevice(otherAuth, dto)).rejects.toThrow('session token');
        expect(mocks.websocket.sendToSession).not.toHaveBeenCalled();
      },
    );

    it.each([0, 101])('rejects %i assets at the HTTP validation boundary', (count) => {
      const pipe = new ZodValidationPipe();
      expect(() =>
        pipe.transform(
          { ...dto, assetIds: Array.from({ length: count }, () => newUuid()) },
          { type: 'body', metatype: DeviceTransferDto },
        ),
      ).toThrow();
    });

    it('accepts the 100 asset limit', () => {
      expect(
        DeviceTransferDto.schema.safeParse({ ...dto, assetIds: Array.from({ length: 100 }, () => newUuid()) }).success,
      ).toBe(true);
    });

    it.each([{ targetSessionId: 'invalid' }, { assetIds: ['invalid'] }, { action: 'delete' }])(
      'rejects invalid IDs and actions',
      (invalid) => {
        expect(DeviceTransferDto.schema.safeParse({ ...dto, ...invalid }).success).toBe(false);
      },
    );
  });

  describe('logoutDevice', () => {
    it('should logout the device', async () => {
      mocks.access.authDevice.checkOwnerAccess.mockResolvedValue(new Set(['token-1']));
      mocks.session.delete.mockResolvedValue();

      await sut.delete(authStub.user1, 'token-1');

      expect(mocks.access.authDevice.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.user1.user.id,
        new Set(['token-1']),
      );
      expect(mocks.session.delete).toHaveBeenCalledWith('token-1');
    });
  });
});
