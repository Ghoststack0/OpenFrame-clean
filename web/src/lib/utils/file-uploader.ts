import {
  AssetMediaStatus,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  RESUMABLE_UPLOAD_THRESHOLD,
  uploadResumable,
  getBaseUrl,
  type AssetMediaResponseDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { tick } from 'svelte';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { addAssetsToAlbumsMutation } from '$lib/queries/album.query';
import { executeMutation } from '$lib/queries/client';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState, type UploadPhase } from '$lib/types';
import { trackUpload, uploadRequest } from '$lib/utils';
import { ExecutorQueue } from '$lib/utils/executor-queue';
import { asQueryString } from '$lib/utils/shared-links';
import { AdaptiveUploadConcurrency } from './adaptive-upload-concurrency';
import { handleError } from './handle-error';

export const uploadExecutionQueue = new ExecutorQueue({ concurrency: 2 });
let adaptiveConcurrency = new AdaptiveUploadConcurrency();
export const setUploadConcurrency = (concurrency: number) => {
  uploadExecutionQueue.concurrency = concurrency;
  uploadAssetsStore.setConcurrency(uploadExecutionQueue.concurrency);
};
const recordTransfer = (bytes: number) => {
  setUploadConcurrency(adaptiveConcurrency.record(bytes));
};
const recordUploadError = () => {
  setUploadConcurrency(adaptiveConcurrency.error());
};

type FilePickerParam = { multiple?: boolean; extensions?: string[] };
type FileUploadParam = { multiple?: boolean; albumId?: string };

export const openFilePicker = async (options: FilePickerParam = {}) => {
  const { multiple = true, extensions } = options;

  return new Promise<File[]>((resolve, reject) => {
    try {
      const fileSelector = document.createElement('input');

      fileSelector.type = 'file';
      fileSelector.multiple = multiple;

      if (extensions) {
        fileSelector.accept = extensions.join(',');
      }

      fileSelector.addEventListener(
        'change',
        (e: Event) => {
          fileSelector.remove();

          const target = e.target as HTMLInputElement;
          if (!target.files) {
            return;
          }

          const files = Array.from(target.files);
          resolve(files);
        },
        { passive: true },
      );

      fileSelector.addEventListener('cancel', () => fileSelector.remove(), { passive: true });

      // Safari requires the file selector to be mounted
      fileSelector.hidden = true;
      document.body.append(fileSelector);
      fileSelector.click();
    } catch (error) {
      console.log('Error selecting file', error);
      reject(error);
    }
  });
};

export const openFileUploadDialog = async (options: FileUploadParam = {}) => {
  const { albumId, multiple = true } = options;
  const extensions = uploadManager.getExtensions();
  const files = await openFilePicker({
    multiple,
    extensions,
  });

  return fileUploadHandler({ files, albumId });
};

type FileUploadHandlerParams = Omit<FileUploaderParams, 'deviceAssetId' | 'assetFile'> & {
  files: File[];
};

export const fileUploadHandler = async ({
  files,
  albumId,
  isLockedAssets = false,
}: FileUploadHandlerParams): Promise<string[]> => {
  if (get(uploadAssetsStore.remainingUploads) === 0) {
    adaptiveConcurrency = new AdaptiveUploadConcurrency();
    setUploadConcurrency(adaptiveConcurrency.concurrency);
  }
  const extensions = uploadManager.getExtensions();
  const promises = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (extensions.some((extension) => name.endsWith(extension))) {
      const deviceAssetId = getDeviceAssetId(file);
      uploadAssetsStore.addItem({ id: deviceAssetId, file, albumId });
      promises.push(
        uploadExecutionQueue.addTask(() => fileUploader({ deviceAssetId, assetFile: file, albumId, isLockedAssets })),
      );
    } else {
      toastManager.warning(get(t)('unsupported_file_type', { values: { file: file.name, type: file.type } }), {
        timeout: 10_000,
      });
    }
  }

  const results = await Promise.all(promises);
  return results.filter((result): result is string => !!result);
};

function getDeviceAssetId(asset: File) {
  return 'web-' + asset.name + '-' + asset.lastModified;
}

function hashFile(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('$lib/workers/hash-file.ts', import.meta.url), { type: 'module' });

    worker.addEventListener('message', ({ data }: MessageEvent<{ result?: string; error?: string }>) => {
      worker.terminate();

      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.result!);
      }
    });

    worker.addEventListener('error', (event) => {
      worker.terminate();

      reject(new Error(event.message));
    });

    worker.postMessage(file);
  });
}

type FileUploaderParams = {
  assetFile: File;
  albumId?: string;
  replaceAssetId?: string;
  isLockedAssets?: boolean;
  // TODO rework the asset uploader and remove this
  deviceAssetId: string;
};

// TODO: should probably use the @api SDK
async function fileUploader({
  assetFile,
  deviceAssetId,
  albumId,
  isLockedAssets = false,
}: FileUploaderParams): Promise<string | undefined> {
  const fileCreatedAt = new Date(assetFile.lastModified).toISOString();
  const $t = get(t);
  const wasInitiallyLoggedIn = !!authManager.authenticated;

  uploadAssetsStore.markStarted(deviceAssetId);

  try {
    const formData = new FormData();
    for (const [key, value] of Object.entries({
      fileCreatedAt,
      fileModifiedAt: new Date(assetFile.lastModified).toISOString(),
      isFavorite: 'false',
      assetData: new File([assetFile], assetFile.name),
    })) {
      formData.append(key, value);
    }

    if (isLockedAssets) {
      formData.append('visibility', AssetVisibility.Locked);
    }

    let checksum: string | undefined;
    let responseData: { id: string; status: AssetMediaStatus; isTrashed?: boolean } | undefined;
    if (!authManager.isSharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_hashing') });
      await tick();
      try {
        checksum = await hashFile(assetFile);

        const {
          results: [checkUploadResult],
        } = await checkBulkUpload({ assetBulkUploadCheckDto: { assets: [{ id: assetFile.name, checksum }] } });
        if (checkUploadResult.action === AssetUploadAction.Reject && checkUploadResult.assetId) {
          responseData = {
            status: AssetMediaStatus.Duplicate,
            id: checkUploadResult.assetId,
            isTrashed: checkUploadResult.isTrashed,
          };
        }
      } catch (error) {
        console.error(`Error calculating sha1 file=${assetFile.name})`, error);
      }
    }

    if (!responseData) {
      const queryParams = asQueryString(authManager.params);

      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_uploading') });
      recordTransfer(0);
      if (assetFile.size >= RESUMABLE_UPLOAD_THRESHOLD) {
        checksum ??= await hashFile(assetFile);
        const controller = new AbortController();
        const untrack = trackUpload(() => controller.abort());
        const storageKey = authManager.isSharedLink
          ? undefined
          : `upload:${authManager.user.id}:${checksum}:${assetFile.name}:${assetFile.lastModified}:${isLockedAssets}`;
        let initialOffset: number | undefined;
        let sessionId: string | undefined;
        let retryAttempt = 0;
        let verifying = false;
        const setPhase = (phase: UploadPhase) => uploadAssetsStore.updateItem(deviceAssetId, { phase });
        uploadAssetsStore.updateItem(deviceAssetId, { resumable: !!storageKey, phase: { kind: 'chunks' } });
        try {
          sessionId = storageKey ? (localStorage.getItem(storageKey) ?? undefined) : undefined;
        } catch {
          /* Storage can be disabled in private browsing. */
        }
        try {
          responseData = await uploadResumable({
            file: assetFile,
            metadata: {
              filename: assetFile.name,
              size: assetFile.size,
              checksum,
              fileCreatedAt,
              fileModifiedAt: fileCreatedAt,
              isFavorite: false,
              visibility: isLockedAssets ? AssetVisibility.Locked : undefined,
            },
            ...authManager.params,
            sessionId,
            signal: controller.signal,
            onSession: (id) => {
              try {
                if (storageKey) {
                  if (id) {
                    localStorage.setItem(storageKey, id);
                  } else {
                    localStorage.removeItem(storageKey);
                  }
                }
              } catch {
                /* Uploading does not require local storage. */
              }
            },
            onProgress: (offset, total) => {
              const isFirst = initialOffset === undefined;
              initialOffset ??= offset;
              uploadAssetsStore.updateProgress(deviceAssetId, offset, total, initialOffset);
              retryAttempt = 0;
              // Every chunk is committed, so the only request left is the finalize (server-side checksum)
              verifying = offset === total;
              if (verifying) {
                setPhase({ kind: 'verifying' });
              } else if (isFirst && offset > 0) {
                setPhase({ kind: 'resumed', from: offset });
              } else {
                setPhase({ kind: 'chunks' });
              }
            },
            onChunk: (bytes) => {
              retryAttempt = 0;
              recordTransfer(bytes);
              setPhase({ kind: 'chunks' });
            },
            onRetry: () => {
              recordUploadError();
              if (!verifying) {
                retryAttempt++;
                setPhase({ kind: 'retrying', attempt: retryAttempt });
              }
            },
          });
        } finally {
          untrack();
        }
      } else {
        const response = await uploadRequest<AssetMediaResponseDto>({
          url: getBaseUrl() + '/assets' + (queryParams ? `?${queryParams}` : ''),
          data: formData,
          onUploadProgress: (event) => uploadAssetsStore.updateProgress(deviceAssetId, event.loaded, event.total),
        });
        if (![200, 201].includes(response.status)) {
          throw new Error($t('errors.unable_to_upload_file'));
        }
        recordTransfer(assetFile.size);
        responseData = response.data;
      }
    }

    if (responseData.status === AssetMediaStatus.Duplicate) {
      uploadAssetsStore.track('duplicate');
    } else {
      uploadAssetsStore.track('success');
      uploadAssetsStore.updateItem(deviceAssetId, { assetId: responseData.id });
    }

    if (albumId && !authManager.isSharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_adding_to_album') });
      await executeMutation(() => addAssetsToAlbumsMutation({ notify: false }), {
        albumIds: [albumId],
        assetIds: [responseData.id],
      });
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_added_to_album') });
    }

    uploadAssetsStore.updateItem(deviceAssetId, {
      state: responseData.status === AssetMediaStatus.Duplicate ? UploadState.DUPLICATED : UploadState.DONE,
      assetId: responseData.id,
      isTrashed: responseData.isTrashed,
    });

    if (responseData.status !== AssetMediaStatus.Duplicate) {
      setTimeout(() => {
        uploadAssetsStore.removeItem(deviceAssetId);
      }, 1000);
    }

    return responseData.id;
  } catch (error) {
    // If the user store no longer holds a user, it means they have logged out
    // In this case don't bother reporting any errors.
    if (wasInitiallyLoggedIn && !authManager.authenticated) {
      return;
    }

    recordUploadError();
    const errorMessage = handleError(error, $t('errors.unable_to_upload_file'));
    uploadAssetsStore.track('error');
    uploadAssetsStore.updateItem(deviceAssetId, { state: UploadState.ERROR, error: errorMessage });
    return;
  }
}
