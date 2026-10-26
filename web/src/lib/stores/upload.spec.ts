import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { getUploadProgress, uploadAssetsStore } from '$lib/stores/upload';
import { UploadState, type UploadAsset } from '$lib/types';

const file = (size: number) => new File([new Uint8Array(size)], `file-${size}`);
const asset = (id: string, size: number, overrides: Partial<UploadAsset> = {}): UploadAsset => ({
  id,
  file: file(size),
  ...overrides,
});

describe('getUploadProgress', () => {
  it('returns zero for an empty queue', () => {
    expect(getUploadProgress([])).toEqual({ loaded: 0, total: 0, speed: 0, percent: 0 });
  });

  it('weights progress by file size', () => {
    const progress = getUploadProgress([
      asset('small', 100, { state: UploadState.DONE }),
      asset('large', 900, { state: UploadState.STARTED, progress: 50, speed: 40 }),
    ]);

    expect(progress).toEqual({ loaded: 550, total: 1000, speed: 40, percent: 55 });
  });

  it('counts failed and skipped files as processed but pending files as not started', () => {
    const progress = getUploadProgress([
      asset('error', 100, { state: UploadState.ERROR }),
      asset('duplicate', 100, { state: UploadState.DUPLICATED }),
      asset('pending', 200, { state: UploadState.PENDING }),
    ]);

    expect(progress).toMatchObject({ loaded: 200, total: 400, percent: 50 });
  });

  it('includes files that were already cleared from the list', () => {
    expect(getUploadProgress([asset('pending', 100, { state: UploadState.PENDING })], 300)).toMatchObject({
      loaded: 300,
      total: 400,
      percent: 75,
    });
  });
});

describe('uploadAssetsStore.progress', () => {
  beforeEach(() => uploadAssetsStore.reset());

  it('does not move backwards when a finished upload is removed', () => {
    uploadAssetsStore.addItem(asset('a', 100));
    uploadAssetsStore.addItem(asset('b', 100));
    uploadAssetsStore.updateItem('a', { state: UploadState.DONE });
    expect(get(uploadAssetsStore.progress).percent).toBe(50);

    uploadAssetsStore.removeItem('a');
    expect(get(uploadAssetsStore.progress)).toMatchObject({ loaded: 100, total: 200, percent: 50 });
  });

  it('keeps dismissed errors in the total and clears everything on reset', () => {
    uploadAssetsStore.addItem(asset('a', 100));
    uploadAssetsStore.addItem(asset('b', 300));
    uploadAssetsStore.updateItem('a', { state: UploadState.ERROR });
    uploadAssetsStore.dismissErrors();
    expect(get(uploadAssetsStore.progress)).toMatchObject({ loaded: 100, total: 400, percent: 25 });

    uploadAssetsStore.reset();
    expect(get(uploadAssetsStore.progress)).toEqual({ loaded: 0, total: 0, speed: 0, percent: 0 });
  });
});
