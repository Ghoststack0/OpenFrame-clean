import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ExtraModel } from 'src/decorators.js';

export enum AssetProcessingStage {
  Uploaded = 'uploaded',
  Metadata = 'metadata',
  Thumbnails = 'thumbnails',
  Video = 'video',
  SmartSearch = 'smartSearch',
  Faces = 'faces',
}

export enum AssetProcessingState {
  Pending = 'pending',
  Complete = 'complete',
  Skipped = 'skipped',
  Failed = 'failed',
}

export const AssetProcessingStageSchema = z.enum(AssetProcessingStage).meta({ id: 'AssetProcessingStage' });
const AssetProcessingStateSchema = z.enum(AssetProcessingState).meta({ id: 'AssetProcessingState' });

const AssetProcessingStatusRequestSchema = z.object({
  assetIds: z.array(z.uuidv4()).min(1).max(100).describe('Between 1 and 100 readable asset IDs'),
});

const AssetProcessingStageStatusSchema = z.object({
  stage: AssetProcessingStageSchema,
  state: AssetProcessingStateSchema,
});

const AssetProcessingStatusResponseSchema = z.object({
  assetId: z.uuidv4(),
  stages: z.array(AssetProcessingStageStatusSchema),
});

export class AssetProcessingStatusRequestDto extends createZodDto(AssetProcessingStatusRequestSchema) {}
export class AssetProcessingStatusResponseDto extends createZodDto(AssetProcessingStatusResponseSchema) {}

@ExtraModel()
export class AssetProcessingEventV1 extends createZodDto(
  AssetProcessingStageStatusSchema.extend({ assetId: z.uuidv4() }),
) {}
