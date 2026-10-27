import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "upload_session" (
    "id" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "sharedLinkId" uuid,
    "size" bigint NOT NULL,
    "offset" bigint NOT NULL,
    "metadata" jsonb NOT NULL,
    "result" jsonb,
    "expiresAt" timestamp with time zone NOT NULL,
    "leaseId" uuid,
    "leaseExpiresAt" timestamp with time zone,
    CONSTRAINT "upload_session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "upload_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE
  );`.execute(db);
  await sql`CREATE INDEX "upload_session_userId_idx" ON "upload_session" ("userId");`.execute(db);
  await sql`CREATE INDEX "upload_session_expiresAt_idx" ON "upload_session" ("expiresAt");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "upload_session";`.execute(db);
}
