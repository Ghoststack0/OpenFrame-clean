import { Injectable } from '@nestjs/common';
import type { ArgOf, ArgsOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  AssetProcessingStage as Stage,
  AssetProcessingState as State,
  AssetProcessingStatusRequestDto,
  AssetProcessingStatusResponseDto,
} from 'src/dtos/asset-processing.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetFileType,
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  Permission,
  TranscodePolicy,
} from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { MediaService } from 'src/services/media.service.js';
import { JobItem } from 'src/types.js';
import { isFacialRecognitionEnabled, isSmartSearchEnabled } from 'src/utils/misc.js';

type ProcessingAsset = Awaited<ReturnType<AssetJobRepository['getProcessingStatus']>>[number];

const getStageJob = (job: JobItem) => {
  switch (job.name) {
    case JobName.AssetExtractMetadata: {
      return { id: job.data.id, stage: Stage.Metadata };
    }
    case JobName.AssetGenerateThumbnails: {
      return { id: job.data.id, stage: Stage.Thumbnails };
    }
    case JobName.AssetEncodeVideo: {
      return { id: job.data.id, stage: Stage.Video };
    }
    case JobName.SmartSearch: {
      return { id: job.data.id, stage: Stage.SmartSearch };
    }
    case JobName.AssetDetectFaces: {
      return { id: job.data.id, stage: Stage.Faces };
    }
    default: {
      return;
    }
  }
};

@Injectable()
export class AssetProcessingService extends BaseService {
  private pending = new Map<string, Map<Stage, boolean | undefined>>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private stopping = false;

  async getStatus(auth: AuthDto, dto: AssetProcessingStatusRequestDto): Promise<AssetProcessingStatusResponseDto[]> {
    const { assetIds } = AssetProcessingStatusRequestDto.schema.parse(dto);
    const ids = [...new Set(assetIds)];
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids });
    const assets = await this.assetJobRepository.getProcessingStatus(ids);
    return this.mapStatus(assets);
  }

  private async mapStatus(assets: ProcessingAsset[]): Promise<AssetProcessingStatusResponseDto[]> {
    const { machineLearning, ffmpeg } = await this.getConfig({ withCache: true });
    const failures = await this.jobRepository.getAssetProcessingFailures(assets.map(({ id }) => id));
    const media = BaseService.create(MediaService, this);

    return assets.map((asset, index) => {
      const files = new Set(asset.files.map(({ type }) => type));
      const hidden = asset.visibility === AssetVisibility.Hidden;
      const videoSkipped =
        asset.type !== AssetType.Video ||
        ffmpeg.transcode === TranscodePolicy.Disabled ||
        (asset.videoStream &&
          asset.format &&
          !media.isVideoConversionRequired(ffmpeg, asset.videoStream, asset.format, asset.audioStream ?? undefined));
      const state = (stage: Stage, complete: boolean, skipped = false): State => {
        if (skipped) {
          return State.Skipped;
        }
        if (failures[index]?.includes(stage)) {
          return State.Failed;
        }
        return complete ? State.Complete : State.Pending;
      };

      return {
        assetId: asset.id,
        stages: [
          { stage: Stage.Uploaded, state: State.Complete },
          { stage: Stage.Metadata, state: state(Stage.Metadata, !!asset.metadataExtractedAt) },
          {
            stage: Stage.Thumbnails,
            state: state(
              Stage.Thumbnails,
              files.has(AssetFileType.Thumbnail) && files.has(AssetFileType.Preview),
              hidden,
            ),
          },
          { stage: Stage.Video, state: state(Stage.Video, files.has(AssetFileType.EncodedVideo), !!videoSkipped) },
          {
            stage: Stage.SmartSearch,
            state: state(Stage.SmartSearch, !!asset.hasEmbedding, hidden || !isSmartSearchEnabled(machineLearning)),
          },
          {
            stage: Stage.Faces,
            state: state(
              Stage.Faces,
              !!asset.facesRecognizedAt,
              hidden || !isFacialRecognitionEnabled(machineLearning),
            ),
          },
        ],
      };
    });
  }

  @OnEvent({ name: 'AssetCreate' })
  onAssetCreate({ asset }: ArgOf<'AssetCreate'>) {
    return this.notify(asset.id, Stage.Uploaded);
  }

  @OnEvent({ name: 'JobStart' })
  onJobStart(...[, job]: ArgsOf<'JobStart'>) {
    const item = getStageJob(job);
    if (item) {
      return this.notify(item.id, item.stage, false);
    }
  }

  @OnEvent({ name: 'JobSuccess' })
  onJobSuccess({ job, response }: ArgOf<'JobSuccess'>) {
    const item = getStageJob(job);
    if (item) {
      return this.notify(item.id, item.stage, response === JobStatus.Failed);
    }
  }

  @OnEvent({ name: 'JobError' })
  onJobError({ job }: ArgOf<'JobError'>) {
    const item = getStageJob(job);
    if (item) {
      return this.notify(item.id, item.stage, true);
    }
  }

  private notify(id: string, stage: Stage, failed?: boolean) {
    if (this.stopping) {
      return;
    }
    const stages = this.pending.get(id) ?? new Map<Stage, boolean | undefined>();
    stages.set(stage, failed);
    this.pending.set(id, stages);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.timer || this.flushing) {
      return;
    }
    // Coalesce concurrent stages without awaiting status queries in the job handler.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushing = this.flush().finally(() => {
        this.flushing = undefined;
        if (this.pending.size > 0) {
          this.scheduleFlush();
        }
      });
    }, 100);
    this.timer.unref();
  }

  @OnEvent({ name: 'AppShutdown', priority: -1 })
  async onShutdown() {
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    await this.flush();
  }

  private async flush() {
    while (this.pending.size > 0) {
      const batch = new Map([...this.pending].slice(0, 100));
      for (const id of batch.keys()) {
        this.pending.delete(id);
      }
      await this.notifyBatch(batch);
    }
  }

  private async notifyBatch(batch: Map<string, Map<Stage, boolean | undefined>>) {
    try {
      await Promise.all(
        [...batch].flatMap(([id, stages]) =>
          [...stages].flatMap(([stage, failed]) =>
            failed === undefined ? [] : [this.jobRepository.setAssetProcessingFailure(id, stage, failed)],
          ),
        ),
      );
      const assets = await this.assetJobRepository.getProcessingStatus(batch.keys().toArray());
      const statuses = await this.mapStatus(assets);
      for (const [index, asset] of assets.entries()) {
        for (const item of statuses[index].stages) {
          if (batch.get(asset.id)?.has(item.stage)) {
            this.websocketRepository.clientSend('AssetProcessingStatusV1', asset.ownerId, {
              assetId: asset.id,
              ...item,
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Unable to report processing status: ${error}`);
    }
  }
}
