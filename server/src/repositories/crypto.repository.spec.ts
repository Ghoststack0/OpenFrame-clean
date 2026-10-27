import { setImmediate } from 'node:timers/promises';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';

describe(CryptoRepository.name, () => {
  const sut = new CryptoRepository();
  let hash: string;

  beforeAll(async () => {
    hash = await sut.hashBcrypt('password', 10);
  });

  it('computes a hexadecimal HMAC-SHA256 identity proof', () => {
    expect(sut.hmacSha256('The quick brown fox jumps over the lazy dog', 'key')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('should verify strings and buffers and reject incorrect passwords', async () => {
    await expect(sut.compareBcrypt('password', hash)).resolves.toBe(true);
    await expect(sut.compareBcrypt(Buffer.from('password'), hash)).resolves.toBe(true);
    await expect(sut.compareBcrypt('incorrect', hash)).resolves.toBe(false);
    await expect(sut.compareBcrypt('password', 'invalid-hash')).resolves.toBe(false);
  });

  it('should allow other requests to run during password verification', async () => {
    let served = false;
    const request = setImmediate().then(() => {
      served = true;
    });

    const valid = await sut.compareBcrypt('password', hash);
    const servedDuringVerification = served;
    await request;

    expect(valid).toBe(true);
    expect(servedDuringVerification).toBe(true);
  });
});
