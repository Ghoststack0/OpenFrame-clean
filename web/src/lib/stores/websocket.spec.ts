import { DeviceTransferAction, type DeviceTransferResponseDto } from '@immich/sdk';
import type { io } from 'socket.io-client';
import { get } from 'svelte/store';
import { deviceTransferStore } from '$lib/stores/device-transfer.store';
import { closeWebsocketConnection } from '$lib/stores/websocket';

const connection = vi.hoisted<{ socket?: ReturnType<typeof io> }>(() => ({}));

vi.mock('socket.io-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('socket.io-client')>();
  return {
    ...original,
    io: (...args: Parameters<typeof original.io>) => {
      connection.socket = original.io(...args);
      return connection.socket;
    },
  };
});

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { authenticated: false } }));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { emit: vi.fn() } }));
vi.mock('$lib/queries/client', () => ({ queryClient: {} }));
vi.mock('$lib/queries/notification.query', () => ({ getNotificationsQuery: vi.fn() }));
vi.mock('$lib/queries/server.query', () => ({ getServerConfigQuery: vi.fn() }));
vi.mock('$lib/queries/user-admin.query', () => ({ searchUsersAdminQuery: vi.fn() }));

const payload: DeviceTransferResponseDto = {
  id: 'transfer',
  sourceSessionId: 'source',
  targetSessionId: 'target',
  assetIds: ['asset'],
  action: DeviceTransferAction.Open,
  sentAt: '2026-10-28T00:00:00.000Z',
};

describe('device transfer socket listener', () => {
  afterEach(() => closeWebsocketConnection());

  it('places incoming socket payloads in the store', () => {
    const socket = connection.socket;
    if (!socket) {
      throw new Error('Websocket was not initialized');
    }
    for (const listener of socket.listeners('on_device_transfer')) {
      listener(payload);
    }
    expect(get(deviceTransferStore)).toEqual([payload]);
  });

  it('clears pending payloads when the shared connection closes', () => {
    deviceTransferStore.receive(payload);
    closeWebsocketConnection();
    expect(get(deviceTransferStore)).toEqual([]);
  });
});
