import { AssetProcessingStage, AssetProcessingState } from '@immich/sdk';
import { derived, get, writable } from 'svelte/store';
import { assetProcessingStore } from '$lib/stores/asset-processing';

/** Matches the number of uploads that assetProcessingStore retains. */
const MAX_TRACKED = 1000;

/** Display state of one stage. The server only reports pending/complete/skipped/failed, so `active` is inferred. */
export type StageDisplayState = 'waiting' | 'active' | 'complete' | 'skipped' | 'failed';

export type StageDisplay = { stage: AssetProcessingStage; state: StageDisplayState };

export type ProcessingRow = {
  assetId: string;
  name: string;
  isVideo: boolean;
  stages: StageDisplay[];
  /** Every stage is complete or skipped */
  finished: boolean;
  failed: boolean;
};

export type ProcessingSummary = {
  total: number;
  /** Fully processed items */
  finished: number;
  /** Items with at least one failed stage */
  failed: number;
  /** Items that are neither finished nor failed */
  active: number;
};

type UploadedInfo = { name: string; isVideo: boolean };

const State = AssetProcessingState;
const settled = new Set<AssetProcessingState>([State.Complete, State.Skipped]);

/** Pipeline order: metadata → thumbnails → (video | smart search | faces) */
const prerequisite: Partial<Record<AssetProcessingStage, AssetProcessingStage>> = {
  [AssetProcessingStage.Metadata]: AssetProcessingStage.Uploaded,
  [AssetProcessingStage.Thumbnails]: AssetProcessingStage.Metadata,
  [AssetProcessingStage.Video]: AssetProcessingStage.Thumbnails,
  [AssetProcessingStage.SmartSearch]: AssetProcessingStage.Thumbnails,
  [AssetProcessingStage.Faces]: AssetProcessingStage.Thumbnails,
};

export const toStageDisplays = (
  stages: { stage: AssetProcessingStage; state: AssetProcessingState }[],
  isVideo: boolean,
): StageDisplay[] => {
  const states = new Map(stages.map(({ stage, state }) => [stage, state]));
  return stages
    .filter(({ stage }) => isVideo || stage !== AssetProcessingStage.Video)
    .map(({ stage, state }) => {
      switch (state) {
        case State.Complete: {
          return { stage, state: 'complete' };
        }
        case State.Skipped: {
          return { stage, state: 'skipped' };
        }
        case State.Failed: {
          return { stage, state: 'failed' };
        }
        default: {
          // The server can't tell queued from running jobs, so a pending stage is shown as in progress
          // only when the stage it depends on is done.
          const dependency = prerequisite[stage];
          const ready = !dependency || settled.has(states.get(dependency) ?? State.Pending);
          return { stage, state: ready ? 'active' : 'waiting' };
        }
      }
    });
};

const createUploadedAssets = () => {
  const items = writable(new Map<string, UploadedInfo>());

  const add = (assetId: string, file: File) => {
    items.update((current) => {
      if (current.has(assetId)) {
        return current;
      }
      const next = new Map(current).set(assetId, { name: file.name, isVideo: file.type.startsWith('video/') });
      if (next.size > MAX_TRACKED) {
        const oldest = next.keys().next().value;
        if (oldest) {
          next.delete(oldest);
        }
      }
      return next;
    });
  };

  return { subscribe: items.subscribe, add, reset: () => items.set(new Map()) };
};

/** File details of this session's uploads, which the processing status itself doesn't carry. */
export const uploadedAssets = createUploadedAssets();

/** One row per uploaded asset, in upload order. Derived once, shared by every consumer. */
export const processingRows = derived([assetProcessingStore, uploadedAssets], ([$statuses, $uploaded]) => {
  const rows: ProcessingRow[] = [];
  for (const [assetId, { name, isVideo }] of $uploaded) {
    const status = $statuses.get(assetId);
    if (!status) {
      continue;
    }
    const stages = toStageDisplays(status.stages, isVideo);
    const failed = stages.some(({ state }) => state === 'failed');
    const finished = stages.every(({ state }) => state === 'complete' || state === 'skipped');
    rows.push({ assetId, name, isVideo, stages, finished, failed });
  }
  return rows;
});

export const processingSummary = derived(processingRows, ($rows): ProcessingSummary => {
  let finished = 0;
  let failed = 0;
  for (const row of $rows) {
    if (row.failed) {
      failed++;
    } else if (row.finished) {
      finished++;
    }
  }
  return { total: $rows.length, finished, failed, active: $rows.length - finished - failed };
});

/** Stop tracking items that are fully processed. Failed and unfinished items stay. */
export const clearFinishedProcessing = () => {
  for (const row of get(processingRows)) {
    if (row.finished && !row.failed) {
      assetProcessingStore.dismiss(row.assetId);
    }
  }
};

/** Stop tracking one item, e.g. a failed one the user has seen. */
export const dismissProcessing = (assetId: string) => assetProcessingStore.dismiss(assetId);
