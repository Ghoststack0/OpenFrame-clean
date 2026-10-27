import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import { DB } from 'src/schema/index.js';
import { UploadSessionTable } from 'src/schema/tables/upload-session.table.js';

export type UploadSession = Selectable<UploadSessionTable>;

@Injectable()
export class UploadSessionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  create(session: Insertable<UploadSessionTable>) {
    return this.db.insertInto('upload_session').values(session).returningAll().executeTakeFirstOrThrow();
  }

  async withLock<T>(
    id: string,
    action: (session: UploadSession | undefined, repository: UploadSessionRepository) => Promise<T>,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const session = await tx
        .selectFrom('upload_session')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      return action(session, new UploadSessionRepository(tx));
    });
  }

  get(id: string) {
    return this.db.selectFrom('upload_session').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Claim a session for one chunk without holding a transaction (and a pooled connection) while bytes stream in.
   * Returns undefined while another request holds an unexpired lease.
   */
  acquire(id: string, leaseId: string, leaseExpiresAt: Date) {
    return this.db
      .updateTable('upload_session')
      .set({ leaseId, leaseExpiresAt })
      .where('id', '=', id)
      .where((eb) => eb.or([eb('leaseExpiresAt', 'is', null), eb('leaseExpiresAt', '<=', new Date())]))
      .returningAll()
      .executeTakeFirst();
  }

  /** Apply values and drop the lease, only if the caller still holds it. */
  async release(id: string, leaseId: string, values: Updateable<UploadSessionTable> = {}) {
    const result = await this.db
      .updateTable('upload_session')
      .set({ ...values, leaseId: null, leaseExpiresAt: null })
      .where('id', '=', id)
      .where('leaseId', '=', leaseId)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async update(id: string, values: Updateable<UploadSessionTable>) {
    await this.db.updateTable('upload_session').set(values).where('id', '=', id).execute();
  }

  async delete(id: string) {
    await this.db.deleteFrom('upload_session').where('id', '=', id).execute();
  }

  getExpired() {
    return this.db
      .selectFrom('upload_session')
      .select('id')
      .where('expiresAt', '<=', new Date())
      .where((eb) => eb.or([eb('leaseExpiresAt', 'is', null), eb('leaseExpiresAt', '<=', new Date())]))
      .limit(100)
      .execute();
  }
}
