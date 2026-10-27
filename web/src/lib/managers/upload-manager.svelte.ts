import { getSupportedMediaTypes, type ServerMediaTypesResponseDto } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { assetProcessingStore } from '$lib/stores/asset-processing';
import { uploadAssetsStore } from '$lib/stores/upload';
import { uploadedAssets } from '$lib/stores/upload-processing';
import { cancelUploadRequests } from '$lib/utils';

class UploadManager {
  mediaTypes = $state<ServerMediaTypesResponseDto>({ image: [], sidecar: [], video: [] });

  constructor() {
    eventManager.on({
      AppInit: () => this.#loadExtensions(),
      AuthLogout: () => this.reset(),
      AssetsDelete: (ids) => {
        for (const id of ids) assetProcessingStore.dismiss(id);
      },
    });
  }

  reset() {
    cancelUploadRequests();
    uploadAssetsStore.reset();
    assetProcessingStore.reset();
    uploadedAssets.reset();
  }

  async #loadExtensions() {
    try {
      this.mediaTypes = await getSupportedMediaTypes();
    } catch {
      console.error('Failed to load supported media types');
    }
  }

  getExtensions() {
    return [...this.mediaTypes.image, ...this.mediaTypes.video];
  }
}

export const uploadManager = new UploadManager();
