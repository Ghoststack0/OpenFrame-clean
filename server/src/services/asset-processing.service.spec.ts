import { BadRequestException } from '@nestjs/common';
import { cloneDeep } from 'lodash-es';
import { AssetProcessingStage as Stage, AssetProcessingState as State } from 'src/dtos/asset-processing.dto.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetFileType, AssetType, AssetVisibility, JobName, JobStatus, QueueName, TranscodePolicy } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetProcessingService } from 'src/services/asset-processing.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { probeStub } from 'test/fixtures/media.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

type ProcessingAsset = Awaited<ReturnType<AssetJobRepository['getProcessingStatus']>>[number];

const id = newUuid();
const ownerId = newUuid();
const pendingAsset: ProcessingAsset = {
  id,
  ownerId,
  createdAt: new Date(),
  type: AssetType.Image,
  visibility: AssetVisibility.Timeline,
  metadataExtractedAt: null,
  facesRecognizedAt: null,
  hasEmbedding: false,
  files: [],
  videoStream: null,
  audioStream: null,
  format: null,
};

const pendingStages = [
  { stage: Stage.Uploaded, state: State.Complete },
  { stage: Stage.Metadata, state: State.Pending },
  { stage: Stage.Thumbnails, state: State.Pending },
  { stage: Stage.Video, state: State.Skipped },
  { stage: Stage.SmartSearch, state: State.Pending },
  { stage: Stage.Faces, state: State.Pending },
];

describe(AssetProcessingService.name, () => {
  let sut: AssetProcessingService;
  let mocks: ServiceMocks;
  const auth = AuthFactory.create();
  let config: typeof defaults;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ sut, mocks } = newTestService(AssetProcessingService));
    config = cloneDeep(defaults);
    vi.spyOn(sut, 'getConfig').mockResolvedValue(config);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
    mocks.assetJob.getProcessingStatus.mockResolvedValue([{ ...pendingAsset }]);
  });

  afterEach(() => vi.useRealTimers());

  const status = () => sut.getStatus(auth, { assetIds: [id] });
  const getStages = async () => {
    const [result] = await status();
    return result.stages;
  };

  it('reports each stage after the upload bytes arrive', async () => {
    await expect(status()).resolves.toEqual([{ assetId: id, stages: pendingStages }]);
  });

  it('derives completion without requiring any detected face rows', async () => {
    mocks.assetJob.getProcessingStatus.mockResolvedValue([
      {
        ...pendingAsset,
        type: AssetType.Video,
        metadataExtractedAt: new Date(),
        facesRecognizedAt: new Date(),
        hasEmbedding: true,
        files: [
          { type: AssetFileType.Preview },
          { type: AssetFileType.Thumbnail },
          { type: AssetFileType.EncodedVideo },
        ],
      },
    ]);
    await expect(status()).resolves.toEqual([
      {
        assetId: id,
        stages: Object.values(Stage).map((stage) => ({ stage, state: State.Complete })),
      },
    ]);
  });

  it.each([AssetFileType.Preview, AssetFileType.Thumbnail])(
    'requires both thumbnail and preview (%s only)',
    async (type) => {
      mocks.assetJob.getProcessingStatus.mockResolvedValue([{ ...pendingAsset, files: [{ type }] }]);
      expect(await getStages()).toContainEqual({ stage: Stage.Thumbnails, state: State.Pending });
    },
  );

  it.each(['global', 'individual'])('skips disabled ML stages (%s toggle)', async (toggle) => {
    if (toggle === 'global') {
      config.machineLearning.enabled = false;
    } else {
      config.machineLearning.clip.enabled = false;
      config.machineLearning.facialRecognition.enabled = false;
    }
    const stages = await getStages();
    expect(stages).toContainEqual({ stage: Stage.SmartSearch, state: State.Skipped });
    expect(stages).toContainEqual({ stage: Stage.Faces, state: State.Skipped });
  });

  it('skips video conversion when disabled', async () => {
    config.ffmpeg.transcode = TranscodePolicy.Disabled;
    mocks.assetJob.getProcessingStatus.mockResolvedValue([{ ...pendingAsset, type: AssetType.Video }]);
    expect(await getStages()).toContainEqual({ stage: Stage.Video, state: State.Skipped });
  });

  it('skips compatible videos using the conversion policy', async () => {
    config.ffmpeg.transcode = TranscodePolicy.Required;
    mocks.assetJob.getProcessingStatus.mockResolvedValue([
      { ...pendingAsset, type: AssetType.Video, ...probeStub.videoStreamH264 },
    ]);
    expect(await getStages()).toContainEqual({ stage: Stage.Video, state: State.Skipped });
  });

  it('keeps required video conversion pending', async () => {
    config.ffmpeg.transcode = TranscodePolicy.All;
    mocks.assetJob.getProcessingStatus.mockResolvedValue([
      { ...pendingAsset, type: AssetType.Video, ...probeStub.videoStreamH264 },
    ]);
    expect(await getStages()).toContainEqual({ stage: Stage.Video, state: State.Pending });
  });

  it('reports recent failures and lets disabled stages take precedence', async () => {
    mocks.job.getAssetProcessingFailures.mockResolvedValue([[Stage.Metadata, Stage.SmartSearch]]);
    config.machineLearning.clip.enabled = false;
    const stages = await getStages();
    expect(stages).toContainEqual({ stage: Stage.Metadata, state: State.Failed });
    expect(stages).toContainEqual({ stage: Stage.SmartSearch, state: State.Skipped });
  });

  it('rejects an entire batch containing an unreadable or missing asset before reading status', async () => {
    await expect(sut.getStatus(auth, { assetIds: [id, newUuid()] })).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.assetJob.getProcessingStatus).not.toHaveBeenCalled();
    expect(mocks.job.getAssetProcessingFailures).not.toHaveBeenCalled();
  });

  it.each(['album', 'partner', 'sharedLink'])('allows assets visible through %s access', async (kind) => {
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
    const caller = kind === 'sharedLink' ? AuthFactory.from().sharedLink({ showExif: false }).build() : auth;
    if (kind === 'album') {
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([id]));
    } else if (kind === 'partner') {
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([id]));
    } else {
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([id]));
    }
    await expect(sut.getStatus(caller, { assetIds: [id] })).resolves.toHaveLength(1);
  });

  it.each([0, 101])('rejects a batch of %i before permission or database access', async (size) => {
    await expect(sut.getStatus(auth, { assetIds: Array.from({ length: size }, () => id) })).rejects.toThrow();
    expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
    expect(mocks.assetJob.getProcessingStatus).not.toHaveBeenCalled();
  });

  it('accepts 100 IDs and deduplicates them', async () => {
    await status();
    await sut.getStatus(auth, { assetIds: Array.from({ length: 100 }, () => id) });
    expect(mocks.assetJob.getProcessingStatus).toHaveBeenLastCalledWith([id]);
  });

  it('sends upload completion only to the owner room', async () => {
    sut.onAssetCreate({ asset: { id, ownerId } });
    await vi.runAllTimersAsync();
    expect(mocks.websocket.clientSend).toHaveBeenCalledExactlyOnceWith('AssetProcessingStatusV1', ownerId, {
      assetId: id,
      stage: Stage.Uploaded,
      state: State.Complete,
    });
    expect(mocks.websocket.clientBroadcast).not.toHaveBeenCalled();
  });

  it.each([
    [JobName.AssetExtractMetadata, Stage.Metadata],
    [JobName.AssetGenerateThumbnails, Stage.Thumbnails],
    [JobName.AssetEncodeVideo, Stage.Video],
    [JobName.SmartSearch, Stage.SmartSearch],
    [JobName.AssetDetectFaces, Stage.Faces],
  ] as const)('emits completion for %s', async (name, stage) => {
    mocks.assetJob.getProcessingStatus.mockResolvedValue([
      {
        ...pendingAsset,
        type: AssetType.Video,
        metadataExtractedAt: new Date(),
        facesRecognizedAt: new Date(),
        hasEmbedding: true,
        files: [
          { type: AssetFileType.Preview },
          { type: AssetFileType.Thumbnail },
          { type: AssetFileType.EncodedVideo },
        ],
      },
    ]);
    sut.onJobSuccess({ job: { name, data: { id } }, response: JobStatus.Success });
    await vi.runAllTimersAsync();
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AssetProcessingStatusV1', ownerId, {
      assetId: id,
      stage,
      state: State.Complete,
    });
  });

  it('emits metadata completion for handlers that return no job status', async () => {
    mocks.assetJob.getProcessingStatus.mockResolvedValue([{ ...pendingAsset, metadataExtractedAt: new Date() }]);
    sut.onJobSuccess({ job: { name: JobName.AssetExtractMetadata, data: { id } } });
    await vi.runAllTimersAsync();
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AssetProcessingStatusV1', ownerId, {
      assetId: id,
      stage: Stage.Metadata,
      state: State.Complete,
    });
  });

  it('keeps library-wide reruns of old assets off the websocket', async () => {
    mocks.assetJob.getProcessingStatus.mockResolvedValue([
      { ...pendingAsset, createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), metadataExtractedAt: new Date() },
    ]);
    sut.onJobSuccess({ job: { name: JobName.AssetExtractMetadata, data: { id } } });
    await vi.runAllTimersAsync();
    expect(mocks.assetJob.getProcessingStatus).toHaveBeenCalledWith([id]);
    expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
  });

  it('emits skipped stages when ML is disabled', async () => {
    config.machineLearning.enabled = false;
    sut.onJobSuccess({ job: { name: JobName.SmartSearch, data: { id } }, response: JobStatus.Skipped });
    await vi.runAllTimersAsync();
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AssetProcessingStatusV1', ownerId, {
      assetId: id,
      stage: Stage.SmartSearch,
      state: State.Skipped,
    });
  });

  it.each(['exception', 'returned failure'])('retains and emits a %s', async (kind) => {
    mocks.job.getAssetProcessingFailures.mockResolvedValue([[Stage.Metadata]]);
    const job = { name: JobName.AssetExtractMetadata, data: { id } } as const;
    if (kind === 'exception') {
      sut.onJobError({ job, error: new Error('private path must not be sent') });
    } else {
      sut.onJobSuccess({ job, response: JobStatus.Failed });
    }
    await vi.runAllTimersAsync();
    expect(mocks.job.setAssetProcessingFailure).toHaveBeenCalledWith(id, Stage.Metadata, true);
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AssetProcessingStatusV1', ownerId, {
      assetId: id,
      stage: Stage.Metadata,
      state: State.Failed,
    });
  });

  it('clears failure state on retry', async () => {
    sut.onJobStart(QueueName.MetadataExtraction, { name: JobName.AssetExtractMetadata, data: { id } });
    await vi.runAllTimersAsync();
    expect(mocks.job.setAssetProcessingFailure).toHaveBeenCalledWith(id, Stage.Metadata, false);
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AssetProcessingStatusV1', ownerId, {
      assetId: id,
      stage: Stage.Metadata,
      state: State.Pending,
    });
  });

  it('ignores unrelated jobs and assets removed while a job runs', async () => {
    sut.onJobSuccess({ job: { name: JobName.TagCleanup }, response: JobStatus.Success });
    await vi.runAllTimersAsync();
    expect(mocks.assetJob.getProcessingStatus).not.toHaveBeenCalled();
    mocks.assetJob.getProcessingStatus.mockResolvedValue([]);
    sut.onAssetCreate({ asset: { id, ownerId } });
    await vi.runAllTimersAsync();
    expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
  });

  it('coalesces stages and assets without reading status on the awaited job path', async () => {
    const otherId = newUuid();
    mocks.assetJob.getProcessingStatus.mockResolvedValue([
      { ...pendingAsset, metadataExtractedAt: new Date() },
      { ...pendingAsset, id: otherId, ownerId: otherId },
    ]);
    sut.onAssetCreate({ asset: { id, ownerId } });
    sut.onJobStart(QueueName.MetadataExtraction, { name: JobName.AssetExtractMetadata, data: { id } });
    sut.onJobSuccess({ job: { name: JobName.AssetExtractMetadata, data: { id } } });
    sut.onAssetCreate({ asset: { id: otherId, ownerId: otherId } });
    expect(mocks.assetJob.getProcessingStatus).not.toHaveBeenCalled();
    expect(mocks.job.setAssetProcessingFailure).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(mocks.assetJob.getProcessingStatus).toHaveBeenCalledExactlyOnceWith([id, otherId]);
    expect(mocks.job.getAssetProcessingFailures).toHaveBeenCalledExactlyOnceWith([id, otherId]);
    expect(mocks.job.setAssetProcessingFailure).toHaveBeenCalledExactlyOnceWith(id, Stage.Metadata, false);
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AssetProcessingStatusV1', otherId, {
      assetId: otherId,
      stage: Stage.Uploaded,
      state: State.Complete,
    });
  });

  it('limits notification reads to 100 assets and drains pending notifications on shutdown', async () => {
    for (let i = 0; i < 205; i++) {
      sut.onAssetCreate({ asset: { id: newUuid(), ownerId } });
    }
    mocks.assetJob.getProcessingStatus.mockResolvedValue([]);
    await sut.onShutdown();
    expect(mocks.assetJob.getProcessingStatus.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 5]);
    await vi.runAllTimersAsync();
    expect(mocks.assetJob.getProcessingStatus).toHaveBeenCalledTimes(3);
  });

  it('skips hidden asset stages that the pipeline does not process', async () => {
    mocks.assetJob.getProcessingStatus.mockResolvedValue([{ ...pendingAsset, visibility: AssetVisibility.Hidden }]);
    const stages = await getStages();
    for (const stage of [Stage.Thumbnails, Stage.SmartSearch, Stage.Faces]) {
      expect(stages).toContainEqual({ stage, state: State.Skipped });
    }
  });

  it('rejects malformed IDs before access checks', async () => {
    await expect(sut.getStatus(auth, { assetIds: ['not-a-uuid'] })).rejects.toThrow();
    expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
  });

  it('does not turn status-notification errors into processing failures', async () => {
    mocks.job.setAssetProcessingFailure.mockRejectedValue(new Error('Redis offline'));
    expect(() =>
      sut.onJobError({ job: { name: JobName.SmartSearch, data: { id } }, error: new Error('processing failed') }),
    ).not.toThrow();
    await vi.runAllTimersAsync();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});
