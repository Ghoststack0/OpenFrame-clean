import { DeviceTransferResponseDto } from 'src/dtos/session.dto.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { automock } from 'test/utils.js';

const socket = (id: string, rooms: string[]) => ({ id, rooms: new Set([id, ...rooms]), emit: vi.fn() });

describe('WebsocketRepository session delivery', () => {
  const payload: DeviceTransferResponseDto = {
    id: 'transfer',
    sourceSessionId: 'source',
    targetSessionId: 'target',
    assetIds: ['asset'],
    action: 'open',
    sentAt: '2026-10-28T00:00:00.000Z',
  };

  let sut: WebsocketRepository;

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    const logger = automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false });
    sut = new WebsocketRepository(
      // eslint-disable-next-line no-sparse-arrays
      automock(EventRepository, { args: [, , logger], strict: false }),
      logger,
    );
  });

  it('derives distinct session presence from sockets in the user room', async () => {
    const sockets = [
      socket('socket-1', ['user', 'target']),
      socket('socket-2', ['user', 'target']),
      socket('socket-3', ['user', 'other']),
    ];
    const inRoom = vi.fn(() => ({ fetchSockets: () => Promise.resolve(sockets) }));
    Reflect.set(sut, 'server', { in: inRoom });
    await expect(sut.getOnlineSessionIds('user')).resolves.toEqual(new Set(['target', 'other']));
    expect(inRoom).toHaveBeenCalledWith('user');
  });

  it('sends only to target sockets within the authenticated user room', async () => {
    const target = socket('socket-1', ['user', 'target']);
    const secondTab = socket('socket-2', ['user', 'target']);
    const source = socket('socket-3', ['user', 'source']);
    const stranger = socket('socket-4', ['stranger', 'target']);
    const sockets = [target, secondTab, source, stranger];
    Reflect.set(sut, 'server', {
      in: (room: string) => ({
        fetchSockets: () => Promise.resolve(sockets.filter((socket) => socket.rooms.has(room))),
      }),
    });

    await expect(sut.sendToSession('user', payload)).resolves.toBe(true);
    expect(target.emit).toHaveBeenCalledExactlyOnceWith('on_device_transfer', payload);
    expect(secondTab.emit).toHaveBeenCalledExactlyOnceWith('on_device_transfer', payload);
    expect(source.emit).not.toHaveBeenCalled();
    expect(stranger.emit).not.toHaveBeenCalled();
  });

  it('reports offline when no matching socket exists', async () => {
    Reflect.set(sut, 'server', {
      in: () => ({ fetchSockets: () => Promise.resolve([socket('socket-1', ['user', 'other'])]) }),
    });
    await expect(sut.sendToSession('user', payload)).resolves.toBe(false);
  });

  it('reports no presence or delivery when the gateway is not initialized', async () => {
    await expect(sut.getOnlineSessionIds('user')).resolves.toEqual(new Set());
    await expect(sut.sendToSession('user', payload)).resolves.toBe(false);
  });
});
