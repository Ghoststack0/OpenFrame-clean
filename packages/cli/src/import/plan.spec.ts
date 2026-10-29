import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { buildPlan } from 'src/import/plan.js';
import { logicalName, readSources, resolveSources } from 'src/import/source.js';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const test = { directory: '' };
beforeEach(async () => {
  test.directory = await mkdtemp(path.join(os.tmpdir(), 'import-plan-test-'));
});
afterEach(async () => {
  await rm(test.directory, { recursive: true, force: true });
});

const file = async (name: string, data = 'synthetic media') => {
  const filename = path.join(test.directory, 'Google Photos', name);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, data);
  return filename;
};

describe('streamed exports', () => {
  it('reads compressed ZIP entries without extracting and matches metadata from another part', async () => {
    const sources = [path.join(fixtures, 'media.zip'), path.join(fixtures, 'metadata.zip')];
    const plan = await buildPlan(sources, 'takeout');
    expect(plan.summary).toEqual({
      media: 1,
      eligible: 1,
      skippedTrashed: 0,
      skippedPartner: 0,
      matchedSidecars: 1,
      unmatchedSidecars: 0,
      mediaWithoutSidecars: 0,
      albums: ['Trip'],
      livePhotos: 0,
    });
    expect(plan.items[0].update).toEqual({ dateTimeOriginal: '2021-01-01T00:00:00.000Z', isFavorite: true });
    let png: Buffer | undefined;
    for await (const entry of readSources([sources[0]])) {
      if (!entry.name.endsWith('.png')) {
        continue;
      }

      png = await buffer(await entry.open());
      expect(entry.size).toBe(68);
    }
    expect(png).toEqual(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQ0AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    expect(plan.problems).toEqual([]);
  });

  it('streams tgz, drains unwanted entries and rejects corrupted archives', async () => {
    const archive = path.join(test.directory, 'part.tgz');
    const tar = pack();
    tar.entry({ name: 'ignored.txt' }, 'ignore me');
    tar.entry({ name: 'Takeout/Google Photos/Photos from 2021/IMG.jpg' }, 'synthetic');
    tar.entry(
      { name: 'Takeout/Google Photos/Photos from 2021/IMG.jpg.json' },
      JSON.stringify({ photoTakenTime: { timestamp: '0' } }),
    );
    tar.finalize();
    await pipeline(tar, createGzip(), createWriteStream(archive));
    const plan = await buildPlan([archive], 'takeout');
    expect(plan.summary.matchedSidecars).toBe(1);
    expect(plan.summary.albums).toEqual([]);
    expect(plan.items[0].update.dateTimeOriginal).toBe('1970-01-01T00:00:00.000Z');
    await writeFile(path.join(test.directory, 'broken.tgz'), 'not gzip');
    await expect(buildPlan([path.join(test.directory, 'broken.tgz')], 'takeout')).rejects.toThrow();
    await writeFile(path.join(test.directory, 'broken.zip'), 'not zip');
    await expect(buildPlan([path.join(test.directory, 'broken.zip')], 'takeout')).rejects.toThrow();
  });

  it('rejects traversal paths and ignores filesystem symlinks', async () => {
    await expect(buildPlan([path.join(fixtures, 'unsafe.zip')], 'takeout')).rejects.toThrow();
    for (const name of ['../photo.jpg', '/photo.jpg', 'C:/photo.jpg', 'a/../photo.jpg']) {
      expect(() => logicalName(name)).toThrow('Unsafe');
    }
    expect(logicalName(String.raw`Takeout\Google Photos\Trip\a.jpg`)).toBe('Trip/a.jpg');
    const filename = await file('Trip/a.jpg');
    await symlink(filename, path.join(test.directory, 'Google Photos', 'Trip', 'alias.jpg'));
    const plan = await buildPlan([test.directory], 'takeout');
    expect(plan.summary.media).toBe(1);
  });

  it('validates inputs and refuses archives for iCloud', async () => {
    expect(await resolveSources([test.directory, test.directory], 'icloud')).toEqual([test.directory]);
    await expect(resolveSources([], 'takeout')).rejects.toThrow('At least');
    await expect(resolveSources([path.join(fixtures, 'media.zip')], 'icloud')).rejects.toThrow('folder');
    await expect(resolveSources([path.join(test.directory, 'missing')], 'takeout')).rejects.toThrow();
  });
});

describe('import planning', () => {
  it('skips trash and partner shares by default, supports opt-in and preserves album titles', async () => {
    for (const [name, data] of [
      ['trash', { trashed: true }],
      ['partner', { googlePhotosOrigin: { fromPartnerSharing: {} } }],
      ['normal', {}],
    ] as const) {
      await file(`Trip/${name}.jpg`);
      await file(`Trip/${name}.jpg.json`, JSON.stringify(data));
    }
    await file('Trip/metadata.json', JSON.stringify({ title: 'Summer vacation' }));
    const plan = await buildPlan([test.directory], 'takeout');
    expect(plan.summary.eligible).toBe(1);
    expect(plan.summary.skippedTrashed).toBe(1);
    expect(plan.summary.skippedPartner).toBe(1);
    expect(plan.summary.albums).toEqual(['Summer vacation']);
    const all = await buildPlan([test.directory], 'takeout', { includeTrashed: true, includePartner: true });
    expect(all.summary.eligible).toBe(3);
  });

  it('reports unmatched and invalid JSON, skips ambiguous or invalid matching sidecars', async () => {
    await file('Trip/a.jpg');
    await file('Trip/a.jpg.json', '{}');
    await file('Trip/a.jpg.metadata.json', '{}');
    await file('Trip/b.jpg');
    await file('Trip/b.jpg.json', 'invalid JSON');
    await file('Trip/c.jpg');
    await file('Trip/missing.jpg.json', '{}');
    const plan = await buildPlan([test.directory], 'takeout');
    expect(plan.items.map((item) => path.posix.basename(item.name))).toEqual(['c.jpg']);
    expect(plan.summary.mediaWithoutSidecars).toBe(1);
    expect(plan.problems.map((problem) => problem.message).join('\n')).toContain('Ambiguous');
    expect(plan.problems.map((problem) => problem.message).join('\n')).toContain('Invalid matching sidecar');
    expect(plan.problems.map((problem) => problem.message).join('\n')).toContain('Unmatched sidecar');
  });

  it('pairs unambiguous image/video names, including Motion Photo names', async () => {
    for (const name of [
      'IMG.jpg',
      'IMG.MOV',
      'motion.jpg',
      'motion.jpg.mp4',
      'ambiguous.jpg',
      'ambiguous.heic',
      'ambiguous.mov',
    ]) {
      await file(`Trip/${name}`);
    }
    const plan = await buildPlan([test.directory], 'takeout');
    expect(plan.pairs.map((pair) => [path.basename(pair.image), path.basename(pair.video)])).toEqual([
      ['IMG.jpg', 'IMG.MOV'],
      ['motion.jpg', 'motion.jpg.mp4'],
    ]);
    expect(plan.problems.some((problem) => problem.message.includes('Ambiguous Live Photo'))).toBe(true);
  });

  it('reads quoted/BOM/multiline iCloud CSVs and album CSVs, falling back for absent metadata', async () => {
    await file('Photos/a.jpg');
    await file('Photos/b.heic');
    await file(
      'Photo Details.csv',
      '\u{FEFF}imgName,originalCreationDate,favorite,caption\r\n"a.jpg","2021-01-02 03:04:05 UTC",yes,"line 1\nline 2"\r\n',
    );
    await file('Albums/Trip.csv', 'File Name,Album Name\n"a.jpg","Trip, abroad"\n');
    const plan = await buildPlan([test.directory], 'icloud');
    expect(plan.summary.albums).toEqual(['Trip, abroad']);
    expect(plan.items[0].update).toEqual({ dateTimeOriginal: '2021-01-02T03:04:05.000Z', isFavorite: true });
    expect(plan.items[1].update).toEqual({});
    expect(plan.problems).toEqual([]);
  });

  it('reports ambiguous iCloud basenames, malformed rows and unknown dates', async () => {
    await file('One/a.jpg');
    await file('Two/a.jpg');
    await file('Photos/b.jpg');
    await file('Photo Details.csv', 'imgName,originalCreationDate\na.jpg,\nb.jpg,unclear\nmissing.jpg,\n');
    const plan = await buildPlan([test.directory], 'icloud');
    expect(plan.problems.map((problem) => problem.message).join('\n')).toContain('Ambiguous CSV filename');
    expect(plan.problems.map((problem) => problem.message).join('\n')).toContain('Unsupported capture date');
    expect(plan.problems.map((problem) => problem.message).join('\n')).toContain('Unmatched CSV filename');
    expect(await readFile(path.join(test.directory, 'Google Photos', 'Photo Details.csv'), 'utf8')).toContain(
      'unclear',
    );
  });
});
