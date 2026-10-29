import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { Session } from 'src/database.js';

const SessionCreateSchema = z
  .object({
    duration: z.int().min(1).optional().describe('Session duration in seconds'),
    deviceType: z.string().optional().describe('Device type'),
    deviceOS: z.string().optional().describe('Device OS'),
  })
  .meta({ id: 'SessionCreateDto' });

const SessionUpdateSchema = z
  .object({
    isPendingSyncReset: z.boolean().optional().describe('Reset pending sync state'),
  })
  .meta({ id: 'SessionUpdateDto' });

const SessionResponseSchema = z
  .object({
    id: z.uuidv4().describe('Session ID'),
    createdAt: z.string().describe('Creation date'),
    updatedAt: z.string().describe('Last update date'),
    expiresAt: z.string().optional().describe('Expiration date'),
    current: z.boolean().describe('Is current session'),
    deviceType: z.string().describe('Device type'),
    deviceOS: z.string().describe('Device OS'),
    appVersion: z.string().nullable().describe('App version'),
    isPendingSyncReset: z.boolean().describe('Is pending sync reset'),
  })
  .meta({ id: 'SessionResponseDto' });

const SessionCreateResponseSchema = SessionResponseSchema.extend({
  token: z.string().describe('Session token'),
}).meta({ id: 'SessionCreateResponseDto' });

export class SessionCreateDto extends createZodDto(SessionCreateSchema) {}
export class SessionUpdateDto extends createZodDto(SessionUpdateSchema) {}
export class SessionResponseDto extends createZodDto(SessionResponseSchema) {}
export class SessionCreateResponseDto extends createZodDto(SessionCreateResponseSchema) {}

export const DEVICE_TRANSFER_MAX_ASSETS = 100;

const DeviceTransferActionSchema = z.enum(['open', 'download']).meta({ id: 'DeviceTransferAction' });

const DeviceTransferSchema = z
  .object({
    targetSessionId: z.uuidv4(),
    assetIds: z.array(z.uuidv4()).min(1).max(DEVICE_TRANSFER_MAX_ASSETS),
    action: DeviceTransferActionSchema,
  })
  .meta({ id: 'DeviceTransferDto' });

const DeviceTransferResponseSchema = DeviceTransferSchema.extend({
  id: z.uuidv4().describe('Transfer ID'),
  sourceSessionId: z.uuidv4(),
  sentAt: z.iso.datetime(),
}).meta({ id: 'DeviceTransferResponseDto' });

const SessionTargetResponseSchema = z
  .object({
    id: z.uuidv4(),
    deviceType: z.string(),
    deviceOS: z.string(),
    deviceName: z.string().describe('Device name inferred from existing session metadata'),
    label: z.string().describe('Friendly device label including a short session ID'),
  })
  .meta({ id: 'SessionTargetResponseDto' });

export class DeviceTransferDto extends createZodDto(DeviceTransferSchema) {}
export class DeviceTransferResponseDto extends createZodDto(DeviceTransferResponseSchema) {}
export class SessionTargetResponseDto extends createZodDto(SessionTargetResponseSchema) {}

export const mapSessionTarget = (session: Session): SessionTargetResponseDto => ({
  id: session.id,
  deviceType: session.deviceType,
  deviceOS: session.deviceOS,
  deviceName: session.deviceType || session.deviceOS || 'Unknown device',
  label: `${[session.deviceType, session.deviceOS].filter(Boolean).join(' on ') || 'Unknown device'} (${session.id.slice(0, 8)})`,
});

export const mapSession = (entity: Session, currentId?: string): SessionResponseDto => ({
  id: entity.id,
  createdAt: entity.createdAt.toISOString(),
  updatedAt: entity.updatedAt.toISOString(),
  expiresAt: entity.expiresAt?.toISOString(),
  current: currentId === entity.id,
  appVersion: entity.appVersion,
  deviceOS: entity.deviceOS,
  deviceType: entity.deviceType,
  isPendingSyncReset: entity.isPendingSyncReset,
});
