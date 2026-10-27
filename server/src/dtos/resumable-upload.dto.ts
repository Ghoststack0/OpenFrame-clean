import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetMediaCreateSchema } from 'src/dtos/asset-media.dto.js';

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const UPLOAD_SESSION_TTL = 24 * 60 * 60 * 1000;

export const ResumableUploadCreateSchema = AssetMediaCreateSchema.pick({
  fileCreatedAt: true,
  fileModifiedAt: true,
  duration: true,
  filename: true,
  isFavorite: true,
  visibility: true,
  livePhotoVideoId: true,
  metadata: true,
})
  .extend({
    filename: z.string().min(1).max(255),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    checksum: z
      .string()
      .regex(/^(?:[\da-fA-F]{40}|[A-Za-z0-9+/]{27}=)$/)
      .describe('Hex or base64 SHA1'),
  })
  .meta({ id: 'ResumableUploadCreateDto' });

export class ResumableUploadCreateDto extends createZodDto(ResumableUploadCreateSchema) {}

export class ResumableUploadResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      offset: z.number().int().nonnegative(),
      size: z.number().int().positive(),
      expiresAt: z.iso.datetime(),
      chunkSize: z.number().int().positive(),
    })
    .meta({ id: 'ResumableUploadResponseDto' }),
) {}

export class ResumableUploadFinalizeDto extends createZodDto(
  AssetMediaCreateSchema.pick({ sidecarData: true }).meta({ id: 'ResumableUploadFinalizeDto' }),
) {}
