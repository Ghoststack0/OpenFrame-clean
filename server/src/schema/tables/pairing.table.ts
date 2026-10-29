import {
  Column,
  ForeignKeyColumn,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  type Timestamp,
} from '@immich/sql-tools';
import { SessionTable } from 'src/schema/tables/session.table.js';

@Table('pairing')
export class PairingTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => SessionTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  sessionId!: string;

  @Column({ type: 'bytea' })
  secretHash!: Buffer;

  @Column({ type: 'timestamp with time zone' })
  expiresAt!: Timestamp;

  @Column({ type: 'timestamp with time zone', nullable: true })
  redeemedAt!: Timestamp | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;
}
