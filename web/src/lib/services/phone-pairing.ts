import {
  createPairing,
  getPairingStatus,
  PairingState,
  type PairingResponseDto,
  type PairingStatusDto,
} from '@immich/sdk';

/** The QR is a bearer credential. Keep it in memory and never put it in page URLs or logs. */
export const buildPairingPayload = (
  pairing: Pick<PairingResponseDto, 'code' | 'serverUrls'>,
  format: 'uri' | 'json' = 'uri',
): string => {
  if (format === 'json') {
    return JSON.stringify({ version: 1, serverUrls: pairing.serverUrls, code: pairing.code });
  }
  const url = new URL('openframe://pair');
  url.searchParams.set('v', '1');
  for (const server of pairing.serverUrls) {
    url.searchParams.append('server', server);
  }
  url.searchParams.set('code', pairing.code);
  return url.href;
};

export const createPhonePairing = async () => {
  const pairing = await createPairing();
  return { ...pairing, payload: buildPairingPayload(pairing), jsonPayload: buildPairingPayload(pairing, 'json') };
};

/** Stops on redemption, expiry, lockout, abort, or a request error. */
export const waitForPhonePairing = async (
  pairing: Pick<PairingResponseDto, 'id' | 'expiresAt'>,
  signal: AbortSignal,
): Promise<PairingStatusDto['status']> => {
  while (true) {
    signal.throwIfAborted();
    const { status } = await getPairingStatus({ id: pairing.id }, { signal });
    if (status !== 'pending') {
      return status;
    }
    if (Date.now() >= Date.parse(pairing.expiresAt)) {
      return PairingState.Expired;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 1000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  }
};
