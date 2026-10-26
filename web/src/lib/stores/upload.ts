import { derived, get, writable } from 'svelte/store';
import { UploadState, type UploadAsset } from '$lib/types';

export type UploadProgress = {
  /** Bytes processed, counting finished, failed and skipped files as fully processed */
  loaded: number;
  total: number;
  /** Combined speed of the files uploading right now, in bytes per second */
  speed: number;
  /** 0-100, weighted by file size so one large video doesn't read as "almost done" */
  percent: number;
};

/**
 * @param settledBytes size of finished files already removed from the list, so the bar doesn't move
 * backwards when completed uploads are cleared
 */
export const getUploadProgress = (items: UploadAsset[], settledBytes = 0): UploadProgress => {
  let loaded = settledBytes;
  let total = settledBytes;
  let speed = 0;
  for (const item of items) {
    const size = item.file.size;
    total += size;
    switch (item.state) {
      case UploadState.STARTED: {
        loaded += (size * (item.progress ?? 0)) / 100;
        speed += item.speed ?? 0;
        break;
      }
      case UploadState.PENDING:
      case undefined: {
        break;
      }
      default: {
        loaded += size;
      }
    }
  }

  const percent = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
  return { loaded, total, speed, percent };
};

const settledStates = new Set([UploadState.DONE, UploadState.ERROR, UploadState.DUPLICATED]);
const isSettled = ({ state }: UploadAsset) => state !== undefined && settledStates.has(state);

function createUploadStore() {
  const uploadAssets = writable<Array<UploadAsset>>([]);
  const stats = writable<{ errors: number; duplicates: number; success: number; total: number }>({
    errors: 0,
    duplicates: 0,
    success: 0,
    total: 0,
  });

  const { subscribe } = uploadAssets;

  const isUploading = derived(uploadAssets, (items) => items.length > 0);
  const isDismissible = derived(uploadAssets, (items) =>
    items.some((item) => item.state === UploadState.ERROR || item.state === UploadState.DUPLICATED),
  );
  const settledBytes = writable(0);
  const progress = derived([uploadAssets, settledBytes], ([$items, $settled]) => getUploadProgress($items, $settled));
  const settle = (items: UploadAsset[]) => {
    const bytes = items.reduce((sum, item) => sum + item.file.size, 0);
    if (bytes > 0) {
      settledBytes.update((value) => value + bytes);
    }
  };
  const remainingUploads = derived(
    uploadAssets,
    (values) => values.filter((a) => a.state === UploadState.PENDING || a.state === UploadState.STARTED).length,
  );

  const addItem = (newAsset: UploadAsset) => {
    uploadAssets.update(($assets) => {
      const duplicate = $assets.some((asset) => asset.id === newAsset.id);
      if (duplicate) {
        return $assets.map((asset) => (asset.id === newAsset.id ? newAsset : asset));
      }

      stats.update((stats) => {
        stats.total++;
        return stats;
      });

      $assets.push({
        ...newAsset,
        speed: 0,
        state: UploadState.PENDING,
        progress: 0,
        eta: 0,
      });

      return $assets;
    });
  };

  const updateProgress = (id: string, loaded: number, total: number) => {
    updateAssetMap(id, (v) => {
      const uploadSpeed = v.startDate ? loaded / ((Date.now() - v.startDate) / 1000) : 0;
      return {
        ...v,
        progress: Math.floor((loaded / total) * 100),
        speed: uploadSpeed,
        eta: Math.ceil((total - loaded) / uploadSpeed),
      };
    });
  };

  const markStarted = (id: string) => {
    updateItem(id, {
      state: UploadState.STARTED,
      startDate: Date.now(),
    });
  };

  const updateAssetMap = (id: string, mapper: (assets: UploadAsset) => UploadAsset) => {
    uploadAssets.update((uploadingAssets) => {
      return uploadingAssets.map((asset) => {
        if (asset.id === id) {
          return mapper(asset);
        }
        return asset;
      });
    });
  };

  const updateItem = (id: string, partialObject: Partial<UploadAsset>) => {
    updateAssetMap(id, (v) => ({ ...v, ...partialObject }));
  };

  const removeItem = (id: string) => {
    uploadAssets.update((uploadingAsset) => {
      const assetToRemove = uploadingAsset.find((a) => a.id === id);
      if (assetToRemove && isSettled(assetToRemove)) {
        settle([assetToRemove]);
      }
      if (assetToRemove) {
        stats.update((stats) => {
          switch (assetToRemove.state) {
            case UploadState.DUPLICATED: {
              stats.duplicates--;
              break;
            }

            case UploadState.ERROR: {
              stats.errors--;
              break;
            }

            case UploadState.DONE: {
              break;
            }

            case UploadState.PENDING:
            case UploadState.STARTED:
            case undefined: {
              console.error('Cannot remove uploads in progress');
              break;
            }
          }

          return stats;
        });
      }

      return uploadingAsset.filter((a) => a.id !== id);
    });
  };

  const dismissErrors = () => {
    const isDismissed = (e: UploadAsset) => e.state === UploadState.ERROR || e.state === UploadState.DUPLICATED;
    settle(get(uploadAssets).filter((e) => isDismissed(e)));
    uploadAssets.update((value) => value.filter((e) => !isDismissed(e)));
  };

  const reset = () => {
    uploadAssets.set([]);
    settledBytes.set(0);
    stats.set({ errors: 0, duplicates: 0, success: 0, total: 0 });
  };

  const track = (value: 'success' | 'duplicate' | 'error') => {
    stats.update((stats) => {
      switch (value) {
        case 'success': {
          stats.success++;
          break;
        }

        case 'duplicate': {
          stats.duplicates++;
          break;
        }

        case 'error': {
          stats.errors++;
          break;
        }
      }

      return stats;
    });
  };

  return {
    stats,
    progress,
    remainingUploads,
    isDismissible,
    isUploading,
    track,
    dismissErrors,
    reset,
    markStarted,
    addItem,
    updateItem,
    removeItem,
    updateProgress,
    subscribe,
  };
}

export const uploadAssetsStore = createUploadStore();
