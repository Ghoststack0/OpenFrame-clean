import { UpdateAssetDto } from '@immich/sdk';
import { parse } from 'csv-parse';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  icloudRow,
  Metadata,
  object,
  Problem,
  Sidecar,
  sidecarMatcher,
  takeoutAlbum,
  takeoutMetadata,
} from 'src/import/metadata.js';
import { ImportEntry, readSources, readText } from 'src/import/source.js';

export type ImportItem = Omit<ImportEntry, 'open'> & Metadata & { albums: string[] };
export type ImportPlan = {
  items: ImportItem[];
  pairs: { image: string; video: string }[];
  problems: Problem[];
  summary: {
    media: number;
    eligible: number;
    skippedTrashed: number;
    skippedPartner: number;
    matchedSidecars: number;
    unmatchedSidecars: number;
    mediaWithoutSidecars: number;
    albums: string[];
    livePhotos: number;
  };
};

// shortcut: offline dry-runs use known media extensions; live imports also check server support before uploading.
export const mediaExtension =
  /\.(3fr|ari|arw|cap|cin|cr2|cr3|crw|dcr|dng|erf|fff|iiq|k25|kdc|mrw|nef|nrw|orf|ori|pef|psd|raf|raw|rw2|rwl|sr2|srf|srw|x3f|avif|bmp|gif|jfif|jpe?g|png|webp|heic|heif|hif|insp|jp2|jpe|jxl|mpo|svg|tiff?|3g2|3gp|avi|flv|m2t|m2ts|m4v|mkv|mts|mov|mp4|mpe?g|mpv|mxf|vob|webm|wmv)$/i;

async function readCsv(entry: ImportEntry) {
  const parser = parse({ columns: true, bom: true, trim: true, skip_empty_lines: true, max_record_size: 1024 * 1024 });
  // eslint-disable-next-line unicorn/prefer-await -- observe pipeline rejection while consuming its output
  const pumping = pipeline(await entry.open(), parser).catch((error: unknown) => error);
  const rows: Record<string, string>[] = [];
  try {
    for await (const value of parser) {
      const row = object(value);
      const fields: Record<string, string> = {};
      for (const [key, field] of Object.entries(row)) {
        if (typeof field !== 'string') {
          throw new TypeError(`Invalid CSV field: ${key}`);
        }
        fields[key] = field;
      }
      rows.push(fields);
    }
    const error = await pumping;
    if (error) {
      throw error;
    }
    return rows;
  } finally {
    parser.destroy();
    await pumping;
  }
}

export const buildPlan = async (
  sources: string[],
  format: 'takeout' | 'icloud',
  { includePartner = false, includeTrashed = false } = {},
): Promise<ImportPlan> => {
  const media: Omit<ImportEntry, 'open'>[] = [];
  const sidecars = new Map<string, Sidecar[]>();
  const csvRows: { file: string; row: Record<string, string> }[] = [];
  const problems: Problem[] = [];
  const albumTitles = new Map<string, string>();
  for await (const entry of readSources(sources)) {
    if (mediaExtension.test(entry.name)) {
      media.push({ id: entry.id, name: entry.name, size: entry.size, modified: entry.modified });
    } else if (format === 'takeout' && /\.json$/i.test(entry.name)) {
      try {
        const data = object(JSON.parse(await readText(entry)));
        if (
          path.posix.basename(entry.name) === 'metadata.json' &&
          typeof data.title === 'string' &&
          !data.photoTakenTime
        ) {
          albumTitles.set(path.posix.dirname(entry.name), data.title);
          continue;
        }
        const sidecar = { ...takeoutMetadata(data), id: entry.id, name: entry.name };
        const directory = path.posix.dirname(entry.name);
        const list = sidecars.get(directory) ?? [];
        list.push(sidecar);
        sidecars.set(directory, list);
      } catch (error) {
        problems.push({ file: entry.id, message: `Invalid sidecar: ${String(error)}` });
        const directory = path.posix.dirname(entry.name);
        const list = sidecars.get(directory) ?? [];
        list.push({
          id: entry.id,
          name: entry.name,
          invalid: String(error),
          update: {},
          trashed: false,
          partner: false,
        });
        sidecars.set(directory, list);
      }
    } else if (format === 'icloud' && /\.csv$/i.test(entry.name)) {
      try {
        for (const row of await readCsv(entry)) {
          csvRows.push({ file: entry.name, row });
        }
      } catch (error) {
        problems.push({ file: entry.id, message: `Invalid CSV: ${String(error)}` });
      }
    }
  }
  const matched = new Set<string>();
  let mediaWithoutSidecars = 0;
  let skippedTrashed = 0;
  let skippedPartner = 0;
  const items: ImportItem[] = [];
  const sidecarMatchers = new Map([...sidecars].map(([directory, list]) => [directory, sidecarMatcher(list)]));
  const mediaMatches = new Map<string, Sidecar | 'ambiguous' | undefined>();
  const sidecarUsers = new Map<string, Set<string>>();
  if (format === 'takeout') {
    for (const entry of media) {
      const sidecar = sidecarMatchers.get(path.posix.dirname(entry.name))?.(entry.name);
      mediaMatches.set(entry.id, sidecar);
      if (!sidecar || sidecar === 'ambiguous') {
        continue;
      }
      const users = sidecarUsers.get(sidecar.id) ?? new Set<string>();
      users.add(entry.name.replace(/-edited(?=\.[^.]+$)/i, ''));
      sidecarUsers.set(sidecar.id, users);
    }
  }
  const exactMedia = new Map<string, typeof media>();
  for (const entry of media) {
    const parts = entry.name.split('/');
    for (let index = 0; index < parts.length; index++) {
      const key = parts.slice(index).join('/');
      const list = exactMedia.get(key) ?? [];
      list.push(entry);
      exactMedia.set(key, list);
    }
  }
  const csvMetadata = new Map<string, { update: UpdateAssetDto; albums: Set<string> }>();
  for (const { file, row } of csvRows) {
    try {
      const parsed = icloudRow(row);
      const candidates = exactMedia.get(parsed.filename) ?? [];
      if (candidates.length !== 1) {
        problems.push({
          file,
          message: `${candidates.length === 0 ? 'Unmatched' : 'Ambiguous'} CSV filename: ${parsed.filename}`,
        });
        continue;
      }
      const id = candidates[0].id;
      const previous = csvMetadata.get(id) ?? { update: {}, albums: new Set<string>() };
      Object.assign(previous.update, parsed.update);
      const isDetails = /^photo[ _-]*details$/i.test(path.posix.parse(file).name);
      const album = parsed.album ?? (isDetails ? undefined : path.posix.parse(file).name);
      if (album) {
        previous.albums.add(album);
      }
      csvMetadata.set(id, previous);
    } catch (error) {
      problems.push({ file, message: String(error) });
    }
  }
  for (const entry of media) {
    let metadata: Metadata = { update: {}, trashed: false, partner: false };
    const albums: string[] = [];
    if (format === 'takeout') {
      const directory = path.posix.dirname(entry.name);
      const sidecar = mediaMatches.get(entry.id);
      if (sidecar === 'ambiguous' || (sidecar && (sidecarUsers.get(sidecar.id)?.size ?? 0) > 1)) {
        problems.push({ file: entry.id, message: 'Ambiguous sidecars; metadata was not guessed' });
        continue;
      }
      if (sidecar) {
        metadata = { update: sidecar.update, trashed: sidecar.trashed, partner: sidecar.partner };
        matched.add(sidecar.id);
        if (sidecar.invalid) {
          problems.push({ file: entry.id, message: 'Invalid matching sidecar; media skipped' });
          continue;
        }
      } else {
        mediaWithoutSidecars++;
        problems.push({ file: entry.id, message: 'No matching sidecar; using embedded metadata' });
      }
      const folderAlbum = takeoutAlbum(entry.name);
      const album = folderAlbum ? (albumTitles.get(directory) ?? folderAlbum) : undefined;
      if (album) {
        albums.push(album);
      }
    } else {
      const csv = csvMetadata.get(entry.id);
      if (csv) {
        metadata.update = csv.update;
        albums.push(...csv.albums);
      }
    }
    if (metadata.trashed && !includeTrashed) {
      skippedTrashed++;
      continue;
    }
    if (metadata.partner && !includePartner) {
      skippedPartner++;
      continue;
    }
    items.push({ ...entry, ...metadata, albums });
  }
  const allSidecars = sidecars.values().toArray().flat();
  for (const sidecar of allSidecars) {
    if (!matched.has(sidecar.id)) {
      problems.push({ file: sidecar.id, message: 'Unmatched sidecar' });
    }
  }
  const pairs: ImportPlan['pairs'] = [];
  const groups = new Map<string, ImportItem[]>();
  for (const item of items) {
    const parsed = path.posix.parse(item.name);
    const key = `${parsed.dir}/${parsed.name.replace(/\.(heic|jpe?g)$/i, '').replace(/(?:_HVEC|_HEVC|_motion)$/i, '')}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const images = group.filter((item) => /\.(heic|heif|jpe?g)$/i.test(item.name));
    const videos = group.filter((item) => /\.(mov|mp4)$/i.test(item.name));
    if (images.length === 1 && videos.length === 1) {
      pairs.push({ image: images[0].id, video: videos[0].id });
    } else if (images.length > 0 && videos.length > 0) {
      problems.push({ file: group[0].name, message: 'Ambiguous Live Photo pair; kept as separate assets' });
    }
  }
  return {
    items,
    pairs,
    problems,
    summary: {
      media: media.length,
      eligible: items.length,
      skippedTrashed,
      skippedPartner,
      matchedSidecars: matched.size,
      unmatchedSidecars: allSidecars.length - matched.size,
      mediaWithoutSidecars,
      albums: [...new Set(items.flatMap((item) => item.albums))].toSorted(),
      livePhotos: pairs.length,
    },
  };
};
