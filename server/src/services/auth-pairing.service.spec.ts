import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PairingRedeemDto, PairingStatusDto } from 'src/dtos/auth.dto.js';
import { UserStatus } from 'src/enum.js';
import { AuthService } from 'src/services/auth.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { newTestService } from 'test/utils.js';

const id = '11111111-1111-4111-8111-111111111111';
const secret = randomBytes(32).toString('base64url');
const code = `${id}.${secret}`;
const details = { clientIp: '127.0.0.1', isSecure: true, deviceOS: 'iOS', deviceType: 'iPhone', appVersion: '3.3.0' };

const setup = () => {
  const { sut, mocks } = newTestService(AuthService);
  const user = UserFactory.create({ status: UserStatus.Active, shouldChangePassword: false });
  const auth = AuthFactory.from(user).session({ hasElevatedPermission: true }).build();
  mocks.user.get.mockResolvedValue(user);
  mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: 'password-hash' });
  mocks.crypto.randomBytes.mockReturnValue(Buffer.alloc(32, 1));
  return { sut, mocks, user, auth };
};

describe('phone pairing', () => {
  it('requires a session and rejects API keys and shared links', async () => {
    const { sut } = setup();
    for (const auth of [
      AuthFactory.create(),
      AuthFactory.from().apiKey().build(),
      AuthFactory.from().sharedLink().build(),
    ]) {
      await expect(sut.createPairing(auth, 'https://example.com')).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('does not issue or redeem when both login methods are disabled', async () => {
    const { sut, mocks, auth } = setup();
    mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.disabled);
    await expect(sut.createPairing(auth, 'https://example.com')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sut.redeemPairing({ code }, details)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mocks.session.redeemPairing).not.toHaveBeenCalled();
  });

  it('allows OAuth-only pairing and puts the external URL before the request origin', async () => {
    const { sut, mocks, auth } = setup();
    mocks.systemMetadata.get.mockResolvedValue({
      passwordLogin: { enabled: false },
      oauth: { enabled: true },
      server: { externalDomain: 'https://photos.example.com/base/' },
    });
    mocks.session.createPairing.mockImplementation((dto) =>
      Promise.resolve({
        ...dto,
        id,
        expiresAt: new Date(dto.expiresAt),
        attempts: 0,
        redeemedAt: null,
      }),
    );
    const result = await sut.createPairing(auth, 'http://192.168.1.9:2283');
    expect(result.serverUrls).toEqual(['https://photos.example.com', 'http://192.168.1.9:2283']);
  });

  it('allows passwordless OAuth accounts with the default password-change flag', async () => {
    const { sut, mocks, user, auth } = setup();
    mocks.user.get.mockResolvedValue({ ...user, shouldChangePassword: true });
    mocks.user.getForChangePassword.mockResolvedValue({ id: user.id, password: null });
    mocks.session.createPairing.mockImplementation((dto) =>
      Promise.resolve({ ...dto, id, expiresAt: new Date(dto.expiresAt), attempts: 0, redeemedAt: null }),
    );
    await expect(sut.createPairing(auth, 'https://example.com')).resolves.toMatchObject({ id });
  });

  it('rejects accounts which must change their password', async () => {
    const { sut, mocks, user, auth } = setup();
    mocks.user.get.mockResolvedValue({ ...user, shouldChangePassword: true });
    await expect(sut.createPairing(auth, 'https://example.com')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stores a hash, expires in five minutes, and includes the request origin', async () => {
    const { sut, mocks, auth } = setup();
    mocks.session.createPairing.mockImplementation((dto) =>
      Promise.resolve({
        ...dto,
        id,
        expiresAt: new Date(dto.expiresAt),
        attempts: 0,
        redeemedAt: null,
      }),
    );
    const start = Date.now();
    const result = await sut.createPairing(auth, 'https://example.com/');
    expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(start + 300_000);
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(result.serverUrls).toEqual(['https://example.com']);
    expect(result.code).toBe(`${id}.${Buffer.alloc(32, 1).toString('base64url')}`);
    expect(mocks.session.createPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: auth.session?.id,
        secretHash: expect.any(Buffer),
      }),
    );
    expect(mocks.crypto.hashSha256).toHaveBeenCalledWith(result.code.split('.', 2)[1]);
  });

  it.each(['invalid', 'locked'] as const)(
    'rejects a repository result of %s without returning a session',
    async (status) => {
      const { sut, mocks } = setup();
      mocks.session.redeemPairing.mockResolvedValue({ status });
      await expect(sut.redeemPairing({ code }, details)).rejects.toBeInstanceOf(
        status === 'locked' ? HttpException : UnauthorizedException,
      );
    },
  );

  it('returns a normal login response and passes device details without PIN elevation', async () => {
    const { sut, mocks, user } = setup();
    mocks.session.redeemPairing.mockResolvedValue({ status: 'redeemed', userId: user.id });
    const result = await sut.redeemPairing({ code }, details);
    expect(result).toMatchObject({ accessToken: expect.any(String), userId: user.id, userEmail: user.email });
    expect(mocks.session.redeemPairing).toHaveBeenCalledWith(id, expect.any(Buffer), {
      token: expect.any(Buffer),
      deviceOS: 'iOS',
      deviceType: 'iPhone',
      appVersion: '3.3.0',
    });
  });

  it.each([
    { redeemedAt: null, expiresAt: new Date(Date.now() + 60_000), attempts: 0, status: 'pending' },
    { redeemedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), attempts: 0, status: 'redeemed' },
    { redeemedAt: null, expiresAt: new Date(0), attempts: 0, status: 'expired' },
    { redeemedAt: null, expiresAt: new Date(Date.now() + 60_000), attempts: 5, status: 'locked' },
  ] satisfies Array<{
    redeemedAt: Date | null;
    expiresAt: Date;
    attempts: number;
    status: PairingStatusDto['status'];
  }>)('reports $status only to the issuing session', async ({ status, ...pairing }) => {
    const { sut, mocks, auth } = setup();
    mocks.session.getPairing.mockResolvedValue(pairing);
    await expect(sut.getPairingStatus(auth, id)).resolves.toEqual({ status });
    expect(mocks.session.getPairing).toHaveBeenCalledWith(id, auth.session?.id);
    mocks.session.getPairing.mockResolvedValue(undefined);
    await expect(sut.getPairingStatus(auth, id)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('validates bearer code shape at the HTTP boundary', () => {
    expect(PairingRedeemDto.schema.safeParse({ code }).success).toBe(true);
    for (const bad of ['', 'password', `${id}.short`, `------------------------------------.${secret}`]) {
      expect(PairingRedeemDto.schema.safeParse({ code: bad }).success).toBe(false);
    }
  });
});
