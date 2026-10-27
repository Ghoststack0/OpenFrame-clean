import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { UserStatus } from 'src/enum.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TelemetryRepository } from 'src/repositories/telemetry.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

const setup = async () => {
  const { sut, ctx } = newMediumService(AuthService, {
    database,
    mock: [LoggingRepository, StorageRepository, EventRepository, TelemetryRepository],
    real: [
      ClusterGroupRepository,
      ConfigRepository,
      CryptoRepository,
      SessionRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
  });
  const { result: user } = await ctx.newUser({ shouldChangePassword: false, status: UserStatus.Active });
  const { result: session } = await ctx.newSession({
    userId: user.id,
    pinExpiresAt: new Date(Date.now() + 60_000),
    oauthSid: user.id,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const auth: AuthDto = { user, session: { id: session.id, hasElevatedPermission: true } };
  const pairing = await sut.createPairing(auth, 'https://example.com');
  return { sut, ctx, auth, pairing, session, user };
};
const details = { clientIp: '127.0.0.1', isSecure: true, deviceOS: 'iOS', deviceType: 'iPhone', appVersion: '3.3.0' };

describe('phone pairing transactions', () => {
  it('creates a normal listed session with device metadata and inherited expiry, without PIN elevation', async () => {
    const { sut, ctx, auth, pairing, session } = await setup();
    const result = await sut.redeemPairing({ code: pairing.code }, details);
    const tokenHash = ctx.get(CryptoRepository).hashSha256(result.accessToken);
    const phone = await ctx.get(SessionRepository).getByToken(tokenHash);
    expect(phone).toMatchObject({ user: { id: auth.user.id }, pinExpiresAt: null, appVersion: '3.3.0' });
    const sessions = await ctx.get(SessionRepository).getByUserId(auth.user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((item) => item.id !== session.id)).toMatchObject({
      deviceOS: 'iOS',
      deviceType: 'iPhone',
      oauthSid: session.oauthSid,
      expiresAt: session.expiresAt,
      pinExpiresAt: null,
    });
    const phoneAuth = await sut.authenticate({
      headers: { authorization: `Bearer ${result.accessToken}` },
      queryParams: {},
      metadata: { sharedLinkRoute: false, adminRoute: false, uri: '/test' },
    });
    expect(phoneAuth.session?.hasElevatedPermission).toBe(false);
    await expect(sut.getPairingStatus(auth, pairing.id)).resolves.toEqual({ status: 'redeemed' });
    await ctx.get(SessionRepository).delete(phoneAuth.session!.id);
    await expect(
      sut.authenticate({
        headers: { authorization: `Bearer ${result.accessToken}` },
        queryParams: {},
        metadata: { sharedLinkRoute: false, adminRoute: false, uri: '/test' },
      }),
    ).rejects.toThrow('Invalid user token');
  });

  it('includes the paired phone in OAuth backchannel revocation', async () => {
    const { sut, pairing, auth, ctx, user } = await setup();
    await sut.redeemPairing({ code: pairing.code }, details);
    const revoked = await ctx.get(SessionRepository).invalidateOAuth({ oauthSid: user.id });
    expect(revoked).toHaveLength(2);
    expect(await ctx.get(SessionRepository).getByUserId(auth.user.id)).toEqual([]);
  });

  it('allows OAuth accounts without passwords even when the default password-change flag is set', async () => {
    const { sut, pairing, user } = await setup();
    await database
      .updateTable('user')
      .set({ shouldChangePassword: true, password: null })
      .where('id', '=', user.id)
      .execute();
    await expect(sut.redeemPairing({ code: pairing.code }, details)).resolves.toMatchObject({ userId: user.id });
  });

  it('allows exactly one simultaneous redemption', async () => {
    const { sut, pairing, auth, ctx } = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => sut.redeemPairing({ code: pairing.code }, details)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await ctx.get(SessionRepository).getByUserId(auth.user.id)).toHaveLength(2);
    await expect(sut.redeemPairing({ code: pairing.code }, details)).rejects.toThrow('Invalid pairing');
  });

  it('rejects expired codes and creates no session', async () => {
    const { sut, pairing, auth, ctx } = await setup();
    await database
      .updateTable('pairing')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', pairing.id)
      .execute();
    await expect(sut.redeemPairing({ code: pairing.code }, details)).rejects.toThrow('Invalid pairing');
    expect(await ctx.get(SessionRepository).getByUserId(auth.user.id)).toHaveLength(1);
  });

  it('commits wrong-code attempts, locks after five, and rejects even the correct secret after lockout', async () => {
    const { sut, pairing, auth } = await setup();
    const wrong = `${pairing.id}.${'X'.repeat(43)}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(sut.redeemPairing({ code: wrong }, details)).rejects.toThrow('Invalid pairing');
    }
    await expect(sut.redeemPairing({ code: pairing.code }, details)).rejects.toThrow('Pairing attempt limit reached');
    await expect(sut.getPairingStatus(auth, pairing.id)).resolves.toEqual({ status: 'locked' });
  });

  it('stores only a hash and invalidates the previous QR on reissue', async () => {
    const { sut, pairing, auth } = await setup();
    const row = await database.selectFrom('pairing').selectAll().where('id', '=', pairing.id).executeTakeFirstOrThrow();
    expect(row.secretHash).toHaveLength(32);
    expect(row.secretHash.toString()).not.toContain(pairing.code.split('.', 2)[1]);
    await sut.createPairing(auth, 'https://example.com');
    await expect(sut.redeemPairing({ code: pairing.code }, details)).rejects.toThrow('Invalid pairing');
  });

  it('revoking the issuing session invalidates a pending code', async () => {
    const { sut, pairing, session, ctx } = await setup();
    await ctx.get(SessionRepository).delete(session.id);
    await expect(sut.redeemPairing({ code: pairing.code }, details)).rejects.toThrow('Invalid pairing');
  });

  it.each(['expired', 'password-change', 'deleted'] as const)(
    'rechecks the source restrictions on redemption: %s',
    async (restriction) => {
      const { sut, pairing, session, user } = await setup();
      if (restriction === 'expired') {
        await database
          .updateTable('session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', session.id)
          .execute();
      } else {
        await database
          .updateTable('user')
          .set(
            restriction === 'deleted'
              ? { deletedAt: new Date() }
              : { shouldChangePassword: true, password: 'password-hash' },
          )
          .where('id', '=', user.id)
          .execute();
      }
      await expect(sut.redeemPairing({ code: pairing.code }, details)).rejects.toThrow('Invalid pairing');
    },
  );
});
