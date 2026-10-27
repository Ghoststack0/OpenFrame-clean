import { Injectable } from '@nestjs/common';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import { timingSafeEqual } from 'node:crypto';
import type { Insertable, Kysely, Updateable } from 'kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { UserStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { PairingTable } from 'src/schema/tables/pairing.table.js';
import { SessionTable } from 'src/schema/tables/session.table.js';
import { asUuid } from 'src/utils/database.js';

@Injectable()
export class SessionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async createPairing(dto: Insertable<PairingTable>) {
    return this.db.transaction().execute(async (tx) => {
      // Serialize issuance per session so only its latest QR remains valid.
      await tx.selectFrom('session').select('id').where('id', '=', dto.sessionId).forUpdate().executeTakeFirstOrThrow();
      await tx
        .deleteFrom('pairing')
        .where((eb) => eb.or([eb('expiresAt', '<=', new Date()), eb('sessionId', '=', dto.sessionId)]))
        .execute();
      return tx.insertInto('pairing').values(dto).returningAll().executeTakeFirstOrThrow();
    });
  }

  getPairing(id: string, sessionId: string) {
    return this.db
      .selectFrom('pairing')
      .select(['expiresAt', 'redeemedAt', 'attempts'])
      .where('id', '=', id)
      .where('sessionId', '=', sessionId)
      .executeTakeFirst();
  }

  async redeemPairing(
    id: string,
    secretHash: Buffer,
    device: Pick<Insertable<SessionTable>, 'token' | 'deviceType' | 'deviceOS' | 'appVersion'>,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const pairing = await tx.selectFrom('pairing').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!pairing || pairing.redeemedAt || pairing.expiresAt <= new Date()) {
        return { status: 'invalid' } as const;
      }
      if (pairing.attempts >= 5) {
        return { status: 'locked' } as const;
      }
      if (!timingSafeEqual(pairing.secretHash, secretHash)) {
        await tx
          .updateTable('pairing')
          .set({ attempts: pairing.attempts + 1 })
          .where('id', '=', id)
          .execute();
        return { status: 'invalid' } as const;
      }
      const source = await tx
        .selectFrom('session')
        .innerJoin('user', 'user.id', 'session.userId')
        .select([
          'session.userId',
          'session.expiresAt',
          'session.parentId',
          'session.oauthSid',
          'session.oauthBearerToken',
        ])
        .where('session.id', '=', pairing.sessionId)
        .where('user.deletedAt', 'is', null)
        .where('user.status', '=', UserStatus.Active)
        .where((eb) => eb.or([eb('user.shouldChangePassword', '=', false), eb('user.password', 'is', null)]))
        .where((eb) => eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', new Date())]))
        .forShare('session')
        .executeTakeFirst();
      if (!source) {
        return { status: 'invalid' } as const;
      }
      await tx
        .insertInto('session')
        .values({ ...device, ...source, pinExpiresAt: null })
        .execute();
      await tx.updateTable('pairing').set({ redeemedAt: new Date() }).where('id', '=', id).execute();
      return { status: 'redeemed', userId: source.userId } as const;
    });
  }

  cleanup() {
    return this.db
      .deleteFrom('session')
      .where((eb) =>
        eb.or([
          eb('updatedAt', '<=', DateTime.now().minus({ days: 90 }).toJSDate()),
          eb.and([eb('expiresAt', 'is not', null), eb('expiresAt', '<=', DateTime.now().toJSDate())]),
        ]),
      )
      .returning(['id', 'deviceOS', 'deviceType'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db
      .selectFrom('session')
      .select(['id', 'expiresAt', 'pinExpiresAt', 'oauthBearerToken'])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async isPendingSyncReset(id: string) {
    const result = await this.db
      .selectFrom('session')
      .select(['isPendingSyncReset'])
      .where('id', '=', id)
      .executeTakeFirst();
    return result?.isPendingSyncReset ?? false;
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getByToken(token: Buffer) {
    return this.db
      .selectFrom('session')
      .select((eb) => [
        ...columns.authSession,
        jsonObjectFrom(
          eb
            .selectFrom('user')
            .select(columns.authUser)
            .whereRef('user.id', '=', 'session.userId')
            .where('user.deletedAt', 'is', null),
        ).as('user'),
      ])
      .where('session.token', '=', token)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', DateTime.now().toJSDate())]),
      )
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getByUserId(userId: string) {
    return this.db
      .selectFrom('session')
      .innerJoin('user', (join) => join.onRef('user.id', '=', 'session.userId').on('user.deletedAt', 'is', null))
      .selectAll('session')
      .where('session.userId', '=', userId)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', DateTime.now().toJSDate())]),
      )
      .orderBy('session.updatedAt', 'desc')
      .orderBy('session.createdAt', 'desc')
      .execute();
  }

  create(dto: Insertable<SessionTable>) {
    return this.db.insertInto('session').values(dto).returningAll().executeTakeFirstOrThrow();
  }

  update(id: string, dto: Updateable<SessionTable>) {
    return this.db
      .updateTable('session')
      .set(dto)
      .where('session.id', '=', asUuid(id))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('session').where('id', '=', asUuid(id)).execute();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, excludeId: DummyValue.UUID }] })
  async invalidateAll({ userId, excludeId }: { userId: string; excludeId?: string }) {
    await this.db
      .deleteFrom('session')
      .where('userId', '=', userId)
      .$if(!!excludeId, (qb) => qb.where('id', '!=', excludeId!))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.STRING, DummyValue.STRING] })
  async invalidateOAuth({ oauthSid, oauthId }: { oauthSid?: string; oauthId?: string }): Promise<string[]> {
    let query = this.db.deleteFrom('session').returning('session.id');

    if (oauthSid && oauthId) {
      query = query
        .using('user')
        .whereRef('user.id', '=', 'session.userId')
        .where('session.oauthSid', '=', oauthSid)
        .where('user.oauthId', '=', oauthId);
    } else if (!oauthSid && oauthId) {
      query = query.using('user').whereRef('user.id', '=', 'session.userId').where('user.oauthId', '=', oauthId);
    } else if (oauthSid && !oauthId) {
      query = query.where('session.oauthSid', '=', oauthSid);
    } else {
      throw new Error('Invalid arguments: at least one of oauthSid or oauthId must be present');
    }

    const deletedRows = await query.execute();
    return deletedRows.map((row) => row.id);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async lockAll(userId: string) {
    await this.db.updateTable('session').set({ pinExpiresAt: null }).where('userId', '=', userId).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async resetSyncProgress(sessionId: string) {
    await this.db.transaction().execute((tx) => {
      return Promise.all([
        tx.updateTable('session').set({ isPendingSyncReset: false }).where('id', '=', sessionId).execute(),
        tx.deleteFrom('session_sync_checkpoint').where('sessionId', '=', sessionId).execute(),
      ]);
    });
  }
}
