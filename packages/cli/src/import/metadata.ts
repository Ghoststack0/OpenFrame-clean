import { AssetVisibility, UpdateAssetDto } from '@immich/sdk';
// The package's UMD main breaks under ESM interop; import its ESM build directly.
import exifr from 'exifr/dist/full.esm.mjs';
import { open } from 'node:fs/promises';
import path from 'node:path';

export type Problem = { file: string; message: string };
export type Metadata = {
  update: UpdateAssetDto;
  trashed: boolean;
  partner: boolean;
};
export type Sidecar = Metadata & { id: string; name: string; title?: string; invalid?: string };

// Takeout's photoTakenTime is a bare UTC instant. Applying it over an embedded capture date would replace the
// photo's local time zone with UTC, so callers keep the embedded date when one exists.
export const hasEmbeddedCaptureDate = async (filename: string) => {
  try {
    // exifr's own file reader fails on current Node; read the head ourselves, where JPEG/HEIC keep these tags.
    const handle = await open(filename, 'r');
    let head: Buffer;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const tags = await exifr.parse(head, { pick: ['DateTimeOriginal', 'CreateDate'] });
    return Boolean(tags?.DateTimeOriginal ?? tags?.CreateDate);
  } catch {
    // exifr can't read every format (e.g. most videos); fall back to the sidecar date.
    return false;
  }
};

export const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return Object.fromEntries(Object.entries(value));
};

export const takeoutMetadata = (value: unknown): Omit<Sidecar, 'id' | 'name'> => {
  const data = object(value);
  const update: UpdateAssetDto = {};
  if (data.photoTakenTime !== undefined) {
    const timestamp = object(data.photoTakenTime).timestamp;
    if (typeof timestamp !== 'string' || !/^-?\d+$/.test(timestamp)) {
      throw new Error('Invalid photoTakenTime.timestamp');
    }
    const date = new Date(Number(timestamp) * 1000);
    if (!Number.isFinite(date.getTime())) {
      throw new TypeError('Invalid photoTakenTime.timestamp');
    }
    update.dateTimeOriginal = date.toISOString();
  }
  if (typeof data.description === 'string' && data.description) {
    update.description = data.description;
  }
  if (data.favorited === true || data.favorite === true || data.isFavorite === true) {
    update.isFavorite = true;
  }
  if (data.archived === true || data.isArchived === true) {
    update.visibility = AssetVisibility.Archive;
  }
  for (const field of ['geoData', 'geoDataExif']) {
    if (data[field] === undefined) {
      continue;
    }
    const { latitude, longitude } = object(data[field]);
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      throw new Error(`Invalid ${field} coordinates`);
    }
    if (latitude !== 0 || longitude !== 0) {
      update.latitude = latitude;
      update.longitude = longitude;
      break;
    }
  }
  const origin = data.googlePhotosOrigin === undefined ? {} : object(data.googlePhotosOrigin);
  return {
    title: typeof data.title === 'string' ? data.title : undefined,
    update,
    trashed: data.trashed === true || data.isTrashed === true,
    partner: data.fromPartnerSharing === true || Boolean(origin.fromPartnerSharing),
  };
};

const numberedName = (name: string) => name.replace(/\.(\w+)\((\d+)\)$/, '($2).$1');
const sidecarName = (name: string) =>
  numberedName(
    path.posix
      .basename(name)
      .replace(/\.json$/i, '')
      .replace(/\.(?:supplemental-metadata|supplemental-meta\w*|metadata)(\(\d+\))?$/i, '$1'),
  );
const unedited = (name: string) => name.replace(/-edited(?=\.[^.]+$)/i, '');

export const matchSidecar = (name: string, sidecars: Sidecar[]): Sidecar | 'ambiguous' | undefined => {
  const filename = path.posix.basename(name);
  const original = unedited(filename);
  const scores = sidecars.map((sidecar) => {
    const candidate = sidecarName(sidecar.name);
    let score = 0;
    if (candidate === filename) {
      score = 4;
    } else if (sidecar.title === filename) {
      score = 3;
    } else if (original !== filename && (candidate === original || sidecar.title === original)) {
      score = 2;
    } else {
      const parsed = path.posix.parse(original);
      const truncated = [46, 47].flatMap((length) => [
        original.slice(0, length),
        parsed.name.slice(0, length) + parsed.ext,
      ]);
      if (truncated.includes(candidate) && candidate !== original) {
        score = 1;
      }
    }
    return { sidecar, score };
  });
  const best = Math.max(0, ...scores.map(({ score }) => score));
  const matches = scores.filter(({ score }) => score > 0 && score === best);
  return matches.length > 1 ? 'ambiguous' : matches[0]?.sidecar;
};

export const sidecarMatcher = (sidecars: Sidecar[]) => {
  const index = new Map<string, Sidecar[]>();
  for (const sidecar of sidecars) {
    for (const key of new Set([sidecarName(sidecar.name), sidecar.title])) {
      if (!key) {
        continue;
      }

      const list = index.get(key) ?? [];
      list.push(sidecar);
      index.set(key, list);
    }
  }
  return (name: string) => {
    const filename = path.posix.basename(name);
    const original = unedited(filename);
    const parsed = path.posix.parse(original);
    const keys = [
      filename,
      original,
      ...[46, 47].flatMap((length) => [original.slice(0, length), parsed.name.slice(0, length) + parsed.ext]),
    ];
    return matchSidecar(name, [...new Set(keys.flatMap((key) => index.get(key) ?? []))]);
  };
};

export const takeoutAlbum = (name: string) => {
  const folder = path.posix.basename(path.posix.dirname(name));
  return folder === '.' || /^(Photos from \d{4}|Google Photos|Takeout)$/i.test(folder) ? undefined : folder;
};

export const csvDate = (value: string) => {
  // Apple's export uses ISO dates or YYYY-MM-DD HH:mm:ss [UTC]. Never infer a local timezone.
  const normalized = value
    .trim()
    .replace(/ UTC$/i, 'Z')
    .replace(/^(\d{4}-\d\d-\d\d) /, '$1T');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?$/i.test(normalized)) {
    throw new Error(`Unsupported capture date: ${value}`);
  }
  const date = new Date(/(?:Z|[+-]\d\d:?\d\d)$/i.test(normalized) ? normalized : `${normalized}Z`);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`Invalid capture date: ${value}`);
  }
  const calendar = new Date(`${normalized.slice(0, 10)}T00:00:00Z`);
  if (calendar.toISOString().slice(0, 10) !== normalized.slice(0, 10)) {
    throw new Error(`Invalid capture date: ${value}`);
  }
  return date.toISOString();
};

export const icloudRow = (row: Record<string, string>) => {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [key.toLowerCase().replaceAll(/[^a-z]/g, ''), value]),
  );
  const pick = (...names: string[]) =>
    names
      .map((name) => normalized.get(name))
      .find((value) => value?.trim())
      ?.trim();
  const filename = pick('imgname', 'filename', 'originalfilename', 'photofilename', 'name');
  if (!filename) {
    throw new Error('CSV row has no filename column (imgName, File Name or Original Filename)');
  }
  const update: UpdateAssetDto = {};
  const date = pick(
    'originalcreationdate',
    'phototakendate',
    'datetaken',
    'creationdate',
    'datecreated',
    'capturedate',
  );
  if (date) {
    update.dateTimeOriginal = csvDate(date);
  }
  const favorite = pick('favorite', 'isfavorite', 'favorited');
  if (favorite && /^(yes|true|1)$/i.test(favorite)) {
    update.isFavorite = true;
  }
  return { filename: filename.replaceAll('\\', '/'), update, album: pick('albumname', 'album') };
};
