import { AssetMediaStatus, defaults, uploadResumable } from '@immich/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = { id: 'session', offset: 0, size: 6, chunkSize: 3, expiresAt: '2026-10-29T00:00:00.000Z' };
const metadata = {
  filename: 'video.mp4',
  size: 6,
  checksum: '0'.repeat(40),
  fileCreatedAt: '2026-10-28T00:00:00.000Z',
  fileModifiedAt: '2026-10-28T00:00:00.000Z',
};
const json = (body: unknown) => Response.json(body, { headers: { 'Content-Type': 'application/json' } });
const originalFetch = defaults.fetch;

describe('resumable upload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    defaults.fetch = originalFetch;
  });

  it('queries committed bytes after a lost response and retries finalization', async () => {
    let offset = 0;
    let lostChunkResponse = true;
    let lostFinalResponse = true;
    const chunks: string[] = [];
    const progress: number[] = [];
    const onRetry = vi.fn();
    defaults.fetch = vi.fn(async (_url, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { headers: { 'Upload-Offset': String(offset) } });
      }
      if (init?.method === 'PATCH') {
        const headers = new Headers(init.headers);
        expect(Number(headers.get('Upload-Offset'))).toBe(offset);
        if (!(init.body instanceof Blob)) {
          throw new TypeError('Expected blob');
        }
        chunks.push(await init.body.text());
        offset += init.body.size;
        if (lostChunkResponse) {
          lostChunkResponse = false;
          throw new TypeError('network dropped');
        }
        return json({ ...session, offset });
      }
      if (String(_url).endsWith('/finalize')) {
        if (lostFinalResponse) {
          lostFinalResponse = false;
          throw new TypeError('response lost');
        }
        return json({ id: 'asset', status: AssetMediaStatus.Created });
      }
      return json(session);
    });
    const result = uploadResumable({
      file: new Blob(['abcdef']),
      metadata,
      onProgress: (offset) => {
        progress.push(offset);
      },
      onRetry,
    });
    const expectation = expect(result).resolves.toEqual({ id: 'asset', status: AssetMediaStatus.Created });
    await vi.runAllTimersAsync();
    await expectation;
    expect(chunks).toEqual(['abc', 'def']);
    expect(progress).toEqual([0, 6]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('resumes a saved session without creating another one', async () => {
    const onSession = vi.fn();
    defaults.fetch = vi.fn((url, init) => {
      if (init?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { headers: { 'Upload-Offset': '6' } }));
      }
      expect(String(url)).toContain('/session/finalize');
      return Promise.resolve(json({ id: 'asset', status: AssetMediaStatus.Duplicate }));
    });
    await expect(
      uploadResumable({ file: new Blob(['abcdef']), metadata, sessionId: 'session', onSession }),
    ).resolves.toEqual({ id: 'asset', status: AssetMediaStatus.Duplicate });
    expect(onSession).toHaveBeenCalledWith(undefined);
  });

  it('does not retry permission failures or checksum errors', async () => {
    for (const status of [401, 403, 422]) {
      const onRetry = vi.fn();
      defaults.fetch = vi.fn(() =>
        Promise.resolve(new Response('{}', { status, headers: { 'Content-Type': 'application/json' } })),
      );
      await expect(uploadResumable({ file: new Blob(['abcdef']), metadata, onRetry })).rejects.toMatchObject({
        status,
      });
      expect(onRetry).not.toHaveBeenCalled();
    }
  });

  it('stops promptly when cancelled during backoff', async () => {
    const controller = new AbortController();
    const onRetry = vi.fn(() => controller.abort());
    defaults.fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
    const result = uploadResumable({ file: new Blob(['abcdef']), metadata, signal: controller.signal, onRetry });
    const expectation = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.runAllTimersAsync();
    await expectation;
  });
});
