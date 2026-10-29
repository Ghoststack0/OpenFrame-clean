import {
  AssetMediaStatus,
  AssetUploadAction,
  checkBulkUpload,
  RESUMABLE_UPLOAD_THRESHOLD,
  uploadResumable,
  type AssetMediaResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState, type UploadPhase } from '$lib/types';
import * as utils from '$lib/utils';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { fileUploadHandler, uploadExecutionQueue } from './file-uploader';

vi.mock('@immich/sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@immich/sdk')>();
  return { ...sdk, checkBulkUpload: vi.fn(), uploadResumable: vi.fn() };
});

describe('fileUploader error handling', () => {
  const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
  const mockUserObject = { id: 'user-123', email: 'test@example.com' } as UserAdminResponseDto;
  const mockError = new Error('Upload failed');
  const mockUploadResponse = { id: 'mock-id', status: AssetMediaStatus.Created } as AssetMediaResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    uploadAssetsStore.reset();
    authManager.reset();
  });

  for (const [name, mockUser] of [
    ['logged-in users', true],
    ['anonymous users', false],
  ] as const) {
    describe(`for ${name}`, () => {
      beforeEach(() => {
        if (mockUser) {
          authManager.setUser(mockUserObject);
        }
      });

      it(`should transition successful uploads to done`, async () => {
        vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 200, data: mockUploadResponse });

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.DONE);
      });

      it('should capture errors', async () => {
        vi.spyOn(utils, 'uploadRequest').mockRejectedValue(mockError);

        await fileUploadHandler({ files: [mockFile] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.ERROR);
      });
    });
  }

  it('should suppress errors on logout', async () => {
    authManager.setUser(mockUserObject);
    authManager.setPreferences(preferencesFactory.build());
    vi.spyOn(utils, 'uploadRequest').mockImplementationOnce(() => {
      authManager.reset();
      return Promise.reject(mockError);
    });

    await fileUploadHandler({ files: [mockFile] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.STARTED);
  });
});

class HashWorker {
  private listeners: Array<(event: MessageEvent) => void> = [];

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') {
      this.listeners.push(listener);
    }
  }

  postMessage() {
    for (const listener of this.listeners) {
      listener({ data: { result: 'a'.repeat(40) } } as MessageEvent);
    }
  }

  terminate() {}
}

describe('fileUploader resumable uploads', () => {
  const MiB = 1024 * 1024;
  const largeFile = new File([new Uint8Array(RESUMABLE_UPLOAD_THRESHOLD)], 'large.mp4', { type: 'video/mp4' });
  const phaseOf = () => get(uploadAssetsStore)[0]?.phase;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uploadResumable).mockReset();
    vi.stubGlobal('Worker', HashWorker);
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.mp4']);
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [{ id: 'large.mp4', action: AssetUploadAction.Accept }],
    });
    uploadAssetsStore.reset();
    authManager.setUser({ id: 'user-123', email: 'test@example.com' } as UserAdminResponseDto);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    authManager.reset();
  });

  it('reports each step of a chunked upload on the item', async () => {
    const seen: Array<UploadPhase | undefined> = [];
    const record = () => {
      seen.push(phaseOf());
    };
    vi.mocked(uploadResumable).mockImplementation((options) => {
      record();
      options.onProgress?.(16 * MiB, RESUMABLE_UPLOAD_THRESHOLD);
      record();
      options.onChunk?.(8 * MiB);
      record();
      options.onRetry?.();
      options.onRetry?.();
      record();
      options.onChunk?.(8 * MiB);
      options.onProgress?.(RESUMABLE_UPLOAD_THRESHOLD, RESUMABLE_UPLOAD_THRESHOLD);
      record();
      options.onRetry?.();
      record();
      return Promise.resolve({ id: 'asset-1', status: AssetMediaStatus.Created });
    });

    await fileUploadHandler({ files: [largeFile] });

    expect(seen).toEqual([
      { kind: 'chunks' },
      { kind: 'resumed', from: 16 * MiB },
      { kind: 'chunks' },
      { kind: 'retrying', attempt: 2 },
      { kind: 'verifying' },
      { kind: 'verifying' },
    ]);
    const [item] = get(uploadAssetsStore);
    expect(item.state).toBe(UploadState.DONE);
    expect(item.resumable).toBe(true);
    expect(get(uploadAssetsStore.concurrency)).toBe(uploadExecutionQueue.concurrency);
  });

  it('keeps a failed chunked upload marked as resumable', async () => {
    vi.mocked(uploadResumable).mockRejectedValue(new Error('Network down'));

    await fileUploadHandler({ files: [largeFile] });

    const [item] = get(uploadAssetsStore);
    expect(item.state).toBe(UploadState.ERROR);
    expect(item.resumable).toBe(true);
  });
});
