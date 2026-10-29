import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { openPromise } from 'yauzl';

export type ImportEntry = {
  id: string;
  name: string;
  size: number;
  modified: Date;
  open: () => Promise<Readable>;
};

export const logicalName = (name: string) => {
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.includes('..') || name.startsWith('/') || /^[a-z]:/i.test(name)) {
    throw new Error(`Unsafe export path: ${name}`);
  }
  const root = parts.findIndex((part) => /^(google photos|icloud photos)$/i.test(part));
  return parts
    .slice(root === -1 ? 0 : root + 1)
    .filter((part) => part && part !== '.')
    .join('/');
};

export const resolveSources = async (inputs: string[], format: 'takeout' | 'icloud') => {
  const sources = [...new Set(await Promise.all(inputs.map((input) => realpath(input))))];
  if (sources.length === 0) {
    throw new Error('At least one export path is required');
  }
  for (const source of sources) {
    const stats = await lstat(source);
    if (!stats.isDirectory() && (format === 'icloud' || !/\.(zip|tgz|tar\.gz)$/i.test(source))) {
      throw new Error(`Expected ${format === 'icloud' ? 'a folder' : 'a folder, .zip, .tgz or .tar.gz'}: ${source}`);
    }
  }
  return sources;
};

async function* folderEntries(source: string, directory = source): AsyncGenerator<ImportEntry> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* folderEntries(source, filename);
    } else if (entry.isFile()) {
      const stats = await lstat(filename);
      yield {
        id: filename,
        name: logicalName(`${path.basename(source)}/${path.relative(source, filename)}`),
        size: stats.size,
        modified: stats.mtime,
        open: async () => createReadStream(filename),
      };
    }
    // Symlinks are deliberately not followed outside the selected export.
  }
}

export async function* readSources(sources: string[]): AsyncGenerator<ImportEntry> {
  for (const source of sources) {
    const stats = await lstat(source);
    if (stats.isDirectory()) {
      yield* folderEntries(source);
    } else if (/\.zip$/i.test(source)) {
      const zip = await openPromise(source, { lazyEntries: true, autoClose: false });
      try {
        for await (const entry of zip.eachEntry()) {
          const name = logicalName(entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0o17_0000;
          if (entry.fileName.endsWith('/') || (mode !== 0 && mode !== 0o10_0000)) {
            continue;
          }
          yield {
            id: `${source}!${entry.fileName}`,
            name,
            size: entry.uncompressedSize,
            modified: entry.getLastModDate(),
            open: () => zip.openReadStreamPromise(entry),
          };
        }
      } finally {
        zip.close();
      }
    } else {
      const tar = extract();
      // Attach the rejection handler immediately; iteration also propagates stream failures.
      // eslint-disable-next-line unicorn/prefer-await -- observe pipeline rejection while iterating tar entries
      const pumping = pipeline(createReadStream(source), createGunzip(), tar).catch((error: unknown) => error);
      try {
        for await (const entry of tar) {
          const name = logicalName(entry.header.name);
          if (entry.header.type === 'file') {
            yield {
              id: `${source}!${entry.header.name}`,
              name,
              size: entry.header.size ?? 0,
              modified: entry.header.mtime ?? new Date(0),
              open: async () => Readable.from(entry),
            };
          }
          for await (const chunk of entry) {
            void chunk;
            // Drain entries that the caller did not need.
          }
        }
        const error = await pumping;
        if (error) {
          throw error;
        }
      } finally {
        tar.destroy();
        await pumping;
      }
    }
  }
}

export const readText = async (entry: ImportEntry, limit = 16 * 1024 * 1024) => {
  if (entry.size > limit) {
    throw new Error(`Metadata exceeds ${limit} bytes: ${entry.name}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await entry.open()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      throw new Error(`Metadata exceeds ${limit} bytes: ${entry.name}`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
};
