import { AssetVisibility } from '@immich/sdk';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  csvDate,
  hasEmbeddedCaptureDate,
  icloudRow,
  matchSidecar,
  Sidecar,
  sidecarMatcher,
  takeoutAlbum,
  takeoutMetadata,
} from 'src/import/metadata.js';
import { describe, expect, it } from 'vitest';

const sidecar = (name: string, title?: string): Sidecar => ({
  id: name,
  name,
  title,
  update: {},
  trashed: false,
  partner: false,
});

describe('Takeout sidecar matching', () => {
  const long = 'a'.repeat(60);
  it.each([
    ['IMG.jpg', 'IMG.jpg.json'],
    ['IMG(1).jpg', 'IMG.jpg(1).json'],
    ['IMG(12).jpg', 'IMG(12).jpg.json'],
    ['IMG.jpg', 'IMG.jpg.supplemental-metadata.json'],
    ['IMG(1).jpg', 'IMG.jpg.supplemental-metadata(1).json'],
    ['IMG.jpg', 'IMG.jpg.supplemental-metadat.json'],
    ['IMG.jpg', 'IMG.jpg.metadata.json'],
    ['IMG-edited.jpg', 'IMG.jpg.json'],
    ['IMG(1)-edited.jpg', 'IMG.jpg(1).json'],
    ['IMG-edited.jpg', 'IMG-edited.jpg.supplemental-metadata.json'],
    [`${long}.jpg`, `${long.slice(0, 46)}.json`],
    [`${long}.jpg`, `${long.slice(0, 47)}.json`],
    [`${long}.jpg`, `${long.slice(0, 46)}.jpg.json`],
    [`${long}.jpg`, `${long.slice(0, 47)}.jpg.supplemental-metadata.json`],
    ['IMG.jpg', 'odd-export-name.json', 'IMG.jpg'],
  ])('matches %s to %s', (media, json, title?: string) => {
    const candidate = sidecar(json, title);
    expect(matchSidecar(media, [candidate])).toBe(candidate);
    expect(sidecarMatcher([candidate])(media)).toBe(candidate);
  });

  it('prefers exact edited metadata and numbering over title fallback', () => {
    const original = sidecar('IMG.jpg.json', 'IMG.jpg');
    const edited = sidecar('IMG-edited.jpg.json', 'IMG.jpg');
    const numbered = sidecar('IMG.jpg(1).json', 'IMG.jpg');
    expect(matchSidecar('IMG-edited.jpg', [original, edited])).toBe(edited);
    expect(matchSidecar('IMG(1).jpg', [original, numbered])).toBe(numbered);
  });

  it('does not guess between equal matches or match an unrelated file', () => {
    expect(matchSidecar('IMG.jpg', [sidecar('IMG.jpg.json'), sidecar('IMG.jpg.metadata.json')])).toBe('ambiguous');
    expect(matchSidecar('OTHER.jpg', [sidecar('IMG.jpg.json')])).toBeUndefined();
    expect(sidecarMatcher([sidecar('IMG.jpg.json'), sidecar('IMG.jpg.metadata.json')])('IMG.jpg')).toBe('ambiguous');
  });
});

describe('metadata mapping', () => {
  it('maps capture time, description, favorite, archive and real GPS', () => {
    expect(
      takeoutMetadata({
        title: 'photo.jpg',
        photoTakenTime: { timestamp: '1609459200' },
        creationTime: { timestamp: '0' },
        description: 'A test',
        favorited: true,
        archived: true,
        trashed: true,
        geoData: { latitude: 0, longitude: 0 },
        geoDataExif: { latitude: 12.3, longitude: -45.6 },
        googlePhotosOrigin: { fromPartnerSharing: {} },
      }),
    ).toEqual({
      title: 'photo.jpg',
      update: {
        dateTimeOriginal: '2021-01-01T00:00:00.000Z',
        description: 'A test',
        isFavorite: true,
        visibility: AssetVisibility.Archive,
        latitude: 12.3,
        longitude: -45.6,
      },
      trashed: true,
      partner: true,
    });
  });

  it('does not erase existing metadata with absent or false values, or use export creation time', () => {
    expect(
      takeoutMetadata({
        creationTime: { timestamp: '0' },
        favorited: false,
        archived: false,
        geoData: { latitude: 0, longitude: 0 },
      }).update,
    ).toEqual({});
  });

  it('keeps genuine coordinates on the equator and before-epoch timestamps', () => {
    expect(
      takeoutMetadata({ photoTakenTime: { timestamp: '-1' }, geoData: { latitude: 0, longitude: 10 } }).update,
    ).toEqual({ dateTimeOriginal: '1969-12-31T23:59:59.000Z', latitude: 0, longitude: 10 });
  });

  it.each([
    undefined,
    [],
    { photoTakenTime: { timestamp: 'oops' } },
    { photoTakenTime: { timestamp: '99999999999999999999' } },
    { geoData: { latitude: 91, longitude: 0 } },
    { geoData: { latitude: 0, longitude: NaN } },
  ])('rejects malformed metadata %#', (data) => {
    expect(() => takeoutMetadata(data)).toThrow();
  });

  it.each([
    ['2021-01-02 03:04:05 UTC', '2021-01-02T03:04:05.000Z'],
    ['2021-01-02 03:04:05', '2021-01-02T03:04:05.000Z'],
    ['2021-01-02T03:04:05+05:30', '2021-01-01T21:34:05.000Z'],
  ])('parses iCloud date %s without using the host timezone', (input, expected) => {
    expect(csvDate(input)).toBe(expected);
  });

  it('maps Apple and human-readable CSV column variants', () => {
    expect(
      icloudRow({
        imgName: 'IMG.HEIC',
        originalCreationDate: '2021-01-02 03:04:05 UTC',
        favorite: 'yes',
        albumName: 'Trip',
      }),
    ).toEqual({
      filename: 'IMG.HEIC',
      update: { dateTimeOriginal: '2021-01-02T03:04:05.000Z', isFavorite: true },
      album: 'Trip',
    });
    expect(
      icloudRow({ 'File Name': 'IMG.JPG', 'Date Taken': '2021-01-02T03:04:05Z', 'Is Favorite': '1' }).update.isFavorite,
    ).toBe(true);
    expect(() => icloudRow({ bad: 'columns' })).toThrow('filename');
    expect(() => csvDate('01/02/03')).toThrow('Unsupported');
    expect(() => csvDate('2021-02-30 00:00:00')).toThrow('Invalid');
  });
});

describe('Takeout albums', () => {
  it.each([
    ['Trip/photo.jpg', 'Trip'],
    ['Photos from 2021/photo.jpg', undefined],
    ['Photos from 1999/photo.jpg', undefined],
    ['photo.jpg', undefined],
    ['Google Photos/photo.jpg', undefined],
    ['Photos from childhood/photo.jpg', 'Photos from childhood'],
  ])('%s => %s', (filename, album) => {
    expect(takeoutAlbum(filename)).toBe(album);
  });
});

// Minimal little-endian JPEG: SOI, APP1 Exif with IFD0 -> Exif IFD -> DateTimeOriginal, EOI.
const jpegWithCaptureDate = (date: string) => {
  const tiff = Buffer.alloc(8 + 18 + 18 + 20);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x87_69, 10); // ExifIFDPointer
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(0x90_03, 28); // DateTimeOriginal
  tiff.writeUInt16LE(2, 30);
  tiff.writeUInt32LE(20, 32);
  tiff.writeUInt32LE(44, 36);
  tiff.writeUInt32LE(0, 40);
  tiff.write(`${date}\0`, 44, 'ascii');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, payload, Buffer.from([0xff, 0xd9])]);
};

describe('hasEmbeddedCaptureDate', () => {
  it('detects an embedded capture date and ignores files without one', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'import-exif-test-'));
    try {
      const withDate = path.join(directory, 'with-date.jpg');
      const withoutDate = path.join(directory, 'without-date.mp4');
      await writeFile(withDate, jpegWithCaptureDate('2021:01:01 09:00:00'));
      await writeFile(withoutDate, 'synthetic video');
      await expect(hasEmbeddedCaptureDate(withDate)).resolves.toBe(true);
      await expect(hasEmbeddedCaptureDate(withoutDate)).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
