import {
  AssetProcessingStage,
  AssetProcessingState,
  getAssetProcessingStatus,
  type AssetProcessingEventV1,
  type AssetProcessingStatusResponseDto,
} from '@immich/sdk';
import { get, writable } from 'svelte/store';

/**
 * UI subscribes to assetProcessingStore: a Map keyed by server asset ID, retaining the latest 1,000 uploads.
 * Stages are independent (pipeline jobs run concurrently). Configuration changes or reprocessing can change any state.
 * track() seeds uploaded status and batches a fetch. update() applies owner websocket events.
 * refresh() reconciles on reconnect/config changes; dismiss()/reset() remove session data. No polling or UI.
 */
export function createAssetProcessingStore() {
  const statuses = writable(new Map<string, AssetProcessingStatusResponseDto>());
  const versions = new Map<string, Map<AssetProcessingStage, number>>();
  let generation = 0;
  let refreshSequence = 0;
  let scheduled = false;

  const dismiss = (id: string) => {
    versions.delete(id);
    statuses.update((items) => {
      const next = new Map(items);
      next.delete(id);
      return next;
    });
  };

  const refresh = async () => {
    const currentGeneration = generation;
    const sequence = ++refreshSequence;
    const ids = [...get(statuses).keys()];
    const snapshots = new Map(ids.map((id) => [id, new Map(versions.get(id))]));
    const identities = new Map(ids.map((id) => [id, versions.get(id)]));
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      try {
        const response = await getAssetProcessingStatus({ assetProcessingStatusRequestDto: { assetIds: batch } });
        if (generation !== currentGeneration || sequence !== refreshSequence) {
          return;
        }
        statuses.update((items) => {
          const next = new Map(items);
          for (const status of response) {
            const current = next.get(status.assetId);
            if (!current || versions.get(status.assetId) !== identities.get(status.assetId)) {
              continue;
            }
            const stages = status.stages.map((stage) => {
              const version = versions.get(status.assetId)?.get(stage.stage) ?? 0;
              const before = snapshots.get(status.assetId)?.get(stage.stage) ?? 0;
              return version === before ? stage : (current.stages.find((item) => item.stage === stage.stage) ?? stage);
            });
            next.set(status.assetId, { ...status, stages });
          }
          return next;
        });
      } catch {
        // Keep known status on a lost connection or revoked access; reconnect or UI refresh can retry.
      }
    }
  };

  const track = (assetId: string) => {
    if (versions.has(assetId)) {
      return;
    }
    versions.set(assetId, new Map());
    statuses.update((items) =>
      new Map(items).set(assetId, {
        assetId,
        stages: Object.values(AssetProcessingStage).map((stage) => ({
          stage,
          state: stage === AssetProcessingStage.Uploaded ? AssetProcessingState.Complete : AssetProcessingState.Pending,
        })),
      }),
    );
    if (versions.size > 1000) {
      const oldest = versions.keys().next().value;
      if (oldest) {
        dismiss(oldest);
      }
    }
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void refresh();
      });
    }
  };

  const update = (event: AssetProcessingEventV1) => {
    const revision = versions.get(event.assetId);
    if (!revision) {
      return;
    }
    revision.set(event.stage, (revision.get(event.stage) ?? 0) + 1);
    statuses.update((items) => {
      const current = items.get(event.assetId);
      if (!current) {
        return items;
      }
      return new Map(items).set(event.assetId, {
        ...current,
        stages: current.stages.map((item) =>
          item.stage === event.stage ? { stage: event.stage, state: event.state } : item,
        ),
      });
    });
  };

  const reset = () => {
    generation++;
    versions.clear();
    statuses.set(new Map());
  };

  return { subscribe: statuses.subscribe, track, update, refresh, dismiss, reset };
}

export const assetProcessingStore = createAssetProcessingStore();
