import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "pairing" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "sessionId" uuid NOT NULL,
    "secretHash" bytea NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "redeemedAt" timestamp with time zone,
    "attempts" integer NOT NULL DEFAULT 0,
    CONSTRAINT "pairing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pairing_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session" ("id") ON UPDATE CASCADE ON DELETE CASCADE
  );`.execute(db);
  await sql`CREATE INDEX "pairing_sessionId_idx" ON "pairing" ("sessionId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "pairing";`.execute(db);
}
