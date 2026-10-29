import { createPairing, getPairingStatus, PairingState } from '@immich/sdk';
import { buildPairingPayload, createPhonePairing, waitForPhonePairing } from './phone-pairing';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  createPairing: vi.fn(),
  getPairingStatus: vi.fn(),
}));

const pairing = {
  id: '11111111-1111-4111-8111-111111111111',
  code: `11111111-1111-4111-8111-111111111111.${'A'.repeat(43)}`,
  expiresAt: '2099-01-01T00:00:00.000Z',
  serverUrls: ['https://photos.example.com/base', 'http://192.168.1.9:2283'],
};

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('builds versioned URI and JSON with all candidate URLs', () => {
  const uri = new URL(buildPairingPayload(pairing));
  expect(uri.protocol).toBe('openframe:');
  expect(uri.hostname).toBe('pair');
  expect(uri.searchParams.get('v')).toBe('1');
  expect(uri.searchParams.getAll('server')).toEqual(pairing.serverUrls);
  expect(uri.searchParams.get('code')).toBe(pairing.code);
  expect(JSON.parse(buildPairingPayload(pairing, 'json'))).toEqual({
    version: 1,
    code: pairing.code,
    serverUrls: pairing.serverUrls,
  });
});

it('creates the code through the authenticated SDK', async () => {
  vi.mocked(createPairing).mockResolvedValue(pairing);
  await expect(createPhonePairing()).resolves.toMatchObject({ ...pairing, payload: buildPairingPayload(pairing) });
});

it('polls until redeemed', async () => {
  vi.useFakeTimers();
  vi.mocked(getPairingStatus)
    .mockResolvedValueOnce({ status: PairingState.Pending })
    .mockResolvedValueOnce({ status: PairingState.Redeemed });
  const result = waitForPhonePairing(pairing, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toBe(PairingState.Redeemed);
  expect(getPairingStatus).toHaveBeenCalledTimes(2);
});

it.each([PairingState.Expired, PairingState.Locked])('stops on %s', async (status) => {
  vi.mocked(getPairingStatus).mockResolvedValue({ status });
  await expect(waitForPhonePairing(pairing, new AbortController().signal)).resolves.toBe(status);
  expect(getPairingStatus).toHaveBeenCalledTimes(1);
});

it('stops when the response is still pending but the local deadline passed', async () => {
  vi.mocked(getPairingStatus).mockResolvedValue({ status: PairingState.Pending });
  await expect(
    waitForPhonePairing({ ...pairing, expiresAt: '2000-01-01T00:00:00.000Z' }, new AbortController().signal),
  ).resolves.toBe(PairingState.Expired);
});

it('cancels the wait and releases its timer', async () => {
  vi.useFakeTimers();
  vi.mocked(getPairingStatus).mockResolvedValue({ status: PairingState.Pending });
  const controller = new AbortController();
  const result = waitForPhonePairing(pairing, controller.signal);
  const assertion = expect(result).rejects.toThrow('Cancelled');
  await vi.advanceTimersByTimeAsync(0);
  controller.abort(new Error('Cancelled'));
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates request errors', async () => {
  vi.mocked(getPairingStatus).mockRejectedValue(new Error('Unauthorized'));
  await expect(waitForPhonePairing(pairing, new AbortController().signal)).rejects.toThrow('Unauthorized');
});
