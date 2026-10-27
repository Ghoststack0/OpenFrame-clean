import { AssetMediaStatus, AssetVisibility, defaults } from '@immich/sdk';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadFiles } from 'src/commands/asset.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDefaults = { ...defaults };
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('CLI resumable uploads', () => {
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cli-resume-'));
  defaults.baseUrl = 'https://example.com/api';
  defaults.headers = { 'x-api-key': 'key' };
});
afterEach(async () => {
  Object.assign(defaults, originalDefaults);
  await rm(directory, { recursive: true, force: true });
});

  it('uploads bounded chunks, resumes a lost response and includes sidecars and API credentials', async () => {
    const filepath = join(directory, 'large.mp4');
    const file = await open(filepath, 'w');
    await file.truncate(50 * 1024 * 1024);
    await file.close();
    await writeFile(`${filepath}.xmp`, '<xmp/>');
    let offset = 0;
    let shouldDrop = true;
    const chunkSizes: number[] = [];
    defaults.fetch = vi.fn(async (url, init) => {
      expect(new Headers(init?.headers).get('x-api-key')).toBe('key');
      if (init?.method === 'HEAD') {
        return new Response(undefined, { headers: { 'Upload-Offset': String(offset) } });
      }
      if (init?.method === 'PATCH') {
        expect(Number(new Headers(init.headers).get('Upload-Offset'))).toBe(offset);
        if (!(init.body instanceof Blob)) {
          throw new TypeError('Expected blob chunk');
        }
        chunkSizes.push(init.body.size);
        offset += init.body.size;
        if (shouldDrop) {
          shouldDrop = false;
          throw new TypeError('lost response');
        }
        return json({ id: 'session', offset });
      }
      if (String(url).endsWith('/finalize')) {
        if (!(init?.body instanceof FormData)) {
          throw new TypeError('Expected multipart finalization');
        }
        const sidecar = init.body.get('sidecarData');
        if (!(sidecar instanceof Blob)) {
          throw new TypeError('Expected sidecar');
        }
        expect(await sidecar.text()).toBe('<xmp/>');
        return json({ id: 'asset', status: AssetMediaStatus.Created });
      }
      expect(typeof init?.body).toBe('string');
      const metadata: unknown = JSON.parse(String(init?.body));
      expect(metadata).toMatchObject({
        filename: 'large.mp4',
        size: 50 * 1024 * 1024,
        visibility: AssetVisibility.Hidden,
        checksum: expect.stringMatching(/^[a-f0-9]{40}$/),
      });
      return json({ id: 'session', offset: 0, size: 50 * 1024 * 1024, chunkSize: 8 * 1024 * 1024 }, 201);
    });
    await expect(
      uploadFiles([filepath], { concurrency: 1, visibility: AssetVisibility.Hidden, configDirectory: directory }),
    ).resolves.toEqual([{ filepath, id: 'asset' }]);
    expect(chunkSizes).toEqual([8_388_608, 8_388_608, 8_388_608, 8_388_608, 8_388_608, 8_388_608, 2_097_152]);
  }, 30_000);
});
