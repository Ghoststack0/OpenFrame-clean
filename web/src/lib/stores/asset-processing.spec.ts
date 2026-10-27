import {
  AssetProcessingStage as Stage,
  AssetProcessingState as State,
  getAssetProcessingStatus,
  type AssetProcessingStatusResponseDto,
} from '@immich/sdk';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assetProcessingStore, createAssetProcessingStore } from '$lib/stores/asset-processing';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getAssetProcessingStatus: vi.fn(),
}));

const response = (assetId: string, state = State.Pending): AssetProcessingStatusResponseDto => ({
  assetId,
  stages: Object.values(Stage).map((stage) => ({ stage, state: stage === Stage.Uploaded ? State.Complete : state })),
});
const fetchStatus = vi.mocked(getAssetProcessingStatus);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('asset processing store', () => {
  beforeEach(() => {
    fetchStatus.mockReset();
    fetchStatus.mockResolvedValue([]);
    assetProcessingStore.reset();
    uploadAssetsStore.reset();
  });

  it('batches session uploads and applies the fetched states', async () => {
    const store = createAssetProcessingStore();
    fetchStatus.mockResolvedValue([response('a', State.Complete), response('b', State.Skipped)]);
    store.track('a');
    store.track('b');
    store.track('a');
    expect(get(store).get('a')?.stages[0]).toEqual({ stage: Stage.Uploaded, state: State.Complete });
    await flush();
    expect(fetchStatus).toHaveBeenCalledExactlyOnceWith({ assetProcessingStatusRequestDto: { assetIds: ['a', 'b'] } });
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Metadata, state: State.Complete });
    expect(get(store).get('b')?.stages).toContainEqual({ stage: Stage.Faces, state: State.Skipped });
  });

  it('ignores websocket events for assets outside this session', () => {
    const store = createAssetProcessingStore();
    store.update({ assetId: 'other', stage: Stage.Metadata, state: State.Complete });
    expect(get(store).size).toBe(0);
  });

  it('applies events independently and supports failures followed by retries', () => {
    const store = createAssetProcessingStore();
    store.track('a');
    store.update({ assetId: 'a', stage: Stage.Faces, state: State.Complete });
    store.update({ assetId: 'a', stage: Stage.Metadata, state: State.Failed });
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Metadata, state: State.Failed });
    store.update({ assetId: 'a', stage: Stage.Metadata, state: State.Pending });
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Metadata, state: State.Pending });
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Faces, state: State.Complete });
  });

  it('preserves websocket events arriving during the initial fetch', async () => {
    const store = createAssetProcessingStore();
    const request = Promise.withResolvers<AssetProcessingStatusResponseDto[]>();
    fetchStatus.mockReturnValue(request.promise);
    store.track('a');
    await flush();
    store.update({ assetId: 'a', stage: Stage.Metadata, state: State.Complete });
    request.resolve([response('a')]);
    await flush();
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Metadata, state: State.Complete });
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Thumbnails, state: State.Pending });
  });

  it('ignores an older fetch response after a newer refresh', async () => {
    const store = createAssetProcessingStore();
    const oldRequest = Promise.withResolvers<AssetProcessingStatusResponseDto[]>();
    fetchStatus.mockReturnValueOnce(oldRequest.promise).mockResolvedValue([response('a', State.Complete)]);
    store.track('a');
    await flush();
    await store.refresh();
    oldRequest.resolve([response('a')]);
    await flush();
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Metadata, state: State.Complete });
  });

  it('does not restore dismissed or logged-out assets from in-flight responses', async () => {
    const store = createAssetProcessingStore();
    const request = Promise.withResolvers<AssetProcessingStatusResponseDto[]>();
    fetchStatus.mockReturnValue(request.promise);
    store.track('a');
    store.track('b');
    await flush();
    store.dismiss('a');
    store.reset();
    request.resolve([response('a'), response('b')]);
    await flush();
    expect(get(store).size).toBe(0);
  });

  it('does not apply a dismissed tracking generation to the same ID tracked again', async () => {
    const store = createAssetProcessingStore();
    const request = Promise.withResolvers<AssetProcessingStatusResponseDto[]>();
    fetchStatus.mockReturnValue(request.promise);
    store.track('a');
    await flush();
    store.dismiss('a');
    store.track('a');
    fetchStatus.mockResolvedValue([]);
    request.resolve([response('a', State.Failed)]);
    await flush();
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Metadata, state: State.Pending });
  });

  it('keeps known status on fetch failure and reconciles on refresh', async () => {
    const store = createAssetProcessingStore();
    fetchStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([response('a', State.Complete)]);
    store.track('a');
    await flush();
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Metadata, state: State.Pending });
    await store.refresh();
    expect(get(store).get('a')?.stages).toContainEqual({ stage: Stage.Metadata, state: State.Complete });
  });

  it('limits each fetch to 100 IDs', async () => {
    const store = createAssetProcessingStore();
    for (let i = 0; i < 205; i++) {
      store.track(String(i));
    }
    await flush();
    await flush();
    expect(fetchStatus.mock.calls.map(([request]) => request.assetProcessingStatusRequestDto.assetIds.length)).toEqual([
      100, 100, 5,
    ]);
  });

  it('bounds retained session state to the latest 1,000 assets', async () => {
    const store = createAssetProcessingStore();
    for (let i = 0; i < 1001; i++) {
      store.track(String(i));
    }
    expect(get(store).size).toBe(1000);
    expect(get(store).has('0')).toBe(false);
    expect(get(store).has('1000')).toBe(true);
    await flush();
  });

  it('tracks server IDs as soon as the upload store receives them, before album work finishes', async () => {
    uploadAssetsStore.addItem({ id: 'local', file: new File(['x'], 'image.jpg') });
    uploadAssetsStore.updateItem('local', { assetId: 'server' });
    uploadAssetsStore.removeItem('local');
    expect(get(assetProcessingStore).has('server')).toBe(true);
    await flush();
  });

  it('does not track duplicate uploads or late responses for cleared uploads', async () => {
    uploadAssetsStore.addItem({ id: 'local', file: new File(['x'], 'image.jpg') });
    uploadAssetsStore.updateItem('local', { assetId: 'duplicate', state: UploadState.DUPLICATED });
    uploadAssetsStore.reset();
    uploadAssetsStore.updateItem('local', { assetId: 'late', state: UploadState.DONE });
    expect(get(assetProcessingStore).size).toBe(0);
    await flush();
  });
});
