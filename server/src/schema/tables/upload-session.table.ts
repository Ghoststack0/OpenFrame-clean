import { Column, ForeignKeyColumn, Table, type Timestamp } from '@immich/sql-tools';
import type { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('upload_session')
export class UploadSessionTable {
  @Column({ type: 'uuid', primary: true })
  id!: string;

  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE' })
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  sharedLinkId!: string | null;

  @Column({ type: 'bigint' })
  size!: number;

  @Column({ type: 'bigint' })
  offset!: number;

  @Column({ type: 'jsonb' })
  metadata!: unknown;

  @Column({ type: 'jsonb', nullable: true })
  result!: AssetMediaResponseDto | null;

  @Column({ type: 'timestamp with time zone', index: true })
  expiresAt!: Timestamp;
}
