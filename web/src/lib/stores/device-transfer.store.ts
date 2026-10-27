import type { DeviceTransferResponseDto } from '@immich/sdk';
import { writable } from 'svelte/store';

const pending = writable<DeviceTransferResponseDto[]>([]);

export const deviceTransferStore = {
  subscribe: pending.subscribe,
  receive: (payload: DeviceTransferResponseDto) => {
    pending.update((items) => [...items, payload]);
  },
  dismiss: (id: string) => pending.update((items) => items.filter((item) => item.id !== id)),
  clear: () => pending.set([]),
};
