import { AssetProcessingStage as Stage, AssetProcessingState as State } from '@immich/sdk';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assetProcessingStore } from '$lib/stores/asset-processing';
import {
  clearFinishedProcessing,
  processingRows,
  processingSummary,
  toStageDisplays,
  uploadedAssets,
} from '$lib/stores/upload-processing';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getAssetProcessingStatus: vi.fn().mockResolvedValue([]),
}));

const stages = (overrides: Partial<Record<Stage, State>> = {}) =>
  Object.values(Stage).map((stage) => ({
    stage,
    state: overrides[stage] ?? (stage === Stage.Uploaded ? State.Complete : State.Pending),
  }));

const track = (id: string, type = 'image/jpeg') => {
  uploadedAssets.add(id, new File(['x'], `${id}.jpg`, { type }));
  assetProcessingStore.track(id);
};

describe('toStageDisplays', () => {
  it('maps server states to display states', () => {
    const result = toStageDisplays(
      stages({
        [Stage.Metadata]: State.Complete,
        [Stage.Thumbnails]: State.Complete,
        [Stage.Video]: State.Skipped,
        [Stage.SmartSearch]: State.Failed,
      }),
      true,
    );

    expect(result.map(({ state }) => state)).toEqual([
      'complete',
      'complete',
      'complete',
      'skipped',
      'failed',
      'active',
    ]);
  });

  it('shows only the next pending stage as in progress', () => {
    expect(toStageDisplays(stages(), false).map(({ state }) => state)).toEqual([
      'complete',
      'active',
      'waiting',
      'waiting',
      'waiting',
    ]);
  });

  it('drops the video stage for images', () => {
    expect(toStageDisplays(stages(), false).map(({ stage }) => stage)).not.toContain(Stage.Video);
    expect(toStageDisplays(stages(), true).map(({ stage }) => stage)).toContain(Stage.Video);
  });

  it('keeps downstream stages waiting when thumbnails failed', () => {
    const result = toStageDisplays(
      stages({ [Stage.Metadata]: State.Complete, [Stage.Thumbnails]: State.Failed }),
      false,
    );

    expect(result.find(({ stage }) => stage === Stage.Faces)?.state).toBe('waiting');
  });
});

describe('processing rows and summary', () => {
  beforeEach(() => {
    assetProcessingStore.reset();
    uploadedAssets.reset();
  });

  it('builds a row per uploaded asset in upload order', () => {
    track('b', 'video/mp4');
    track('a');

    expect(get(processingRows).map((row) => [row.assetId, row.name, row.isVideo])).toEqual([
      ['b', 'b.jpg', true],
      ['a', 'a.jpg', false],
    ]);
  });

  it('ignores assets the processing store no longer tracks', () => {
    track('a');
    assetProcessingStore.dismiss('a');

    expect(get(processingRows)).toEqual([]);
  });

  it('counts finished, failed and active items', () => {
    for (const id of ['done', 'failed', 'busy']) {
      track(id);
    }
    for (const stage of [Stage.Metadata, Stage.Thumbnails, Stage.Video, Stage.SmartSearch, Stage.Faces]) {
      assetProcessingStore.update({
        assetId: 'done',
        stage,
        state: stage === Stage.Video ? State.Skipped : State.Complete,
      });
    }
    assetProcessingStore.update({ assetId: 'failed', stage: Stage.Faces, state: State.Failed });

    expect(get(processingSummary)).toEqual({ total: 3, finished: 1, failed: 1, active: 1 });
  });

  it('clears only finished items', () => {
    track('done');
    track('busy');
    for (const stage of [Stage.Metadata, Stage.Thumbnails, Stage.Video, Stage.SmartSearch, Stage.Faces]) {
      assetProcessingStore.update({ assetId: 'done', stage, state: State.Complete });
    }

    clearFinishedProcessing();

    expect(get(processingRows).map((row) => row.assetId)).toEqual(['busy']);
    expect([...get(assetProcessingStore).keys()]).toEqual(['busy']);
  });

  it('keeps a bounded number of upload names', () => {
    for (let index = 0; index < 1005; index++) {
      uploadedAssets.add(`id-${index}`, new File(['x'], 'a.jpg'));
    }

    expect(get(uploadedAssets).size).toBe(1000);
    expect(get(uploadedAssets).has('id-0')).toBe(false);
  });
});
