import { DeviceTransferAction, type DeviceTransferResponseDto } from '@immich/sdk';
import { get } from 'svelte/store';
import { deviceTransferStore } from '$lib/stores/device-transfer.store';

const payload: DeviceTransferResponseDto = {
  id: 'transfer-1',
  sourceSessionId: 'source',
  targetSessionId: 'target',
  assetIds: ['asset-1', 'asset-2'],
  action: DeviceTransferAction.Open,
  sentAt: '2026-10-28T00:00:00.000Z',
};

describe('deviceTransferStore', () => {
  beforeEach(() => deviceTransferStore.clear());

  it('exposes incoming transfers in arrival order', () => {
    deviceTransferStore.receive(payload);
    deviceTransferStore.receive({ ...payload, id: 'transfer-2', action: DeviceTransferAction.Download });
    expect(get(deviceTransferStore)).toEqual([
      payload,
      { ...payload, id: 'transfer-2', action: DeviceTransferAction.Download },
    ]);
  });

  it('dismisses only the selected transfer', () => {
    deviceTransferStore.receive(payload);
    deviceTransferStore.receive({ ...payload, id: 'transfer-2' });
    deviceTransferStore.dismiss(payload.id);
    expect(get(deviceTransferStore)).toEqual([{ ...payload, id: 'transfer-2' }]);
  });

  it('clears pending data', () => {
    deviceTransferStore.receive(payload);
    deviceTransferStore.clear();
    expect(get(deviceTransferStore)).toEqual([]);
  });
});
