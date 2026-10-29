import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const STATE_FILE = '.openframe-sync.json';
export const DEFAULT_TEMPLATE = 'YYYY/MM/{originalFileName}';

export interface SyncEntry {
  path: string;
  checksum: string;
  assetId: string;
  size: number;
  mtimeMs: number;
}

export interface SyncState {
  version: 1;
  serverUrl: string;
  userId: string;
  entries: SyncEntry[];
}

export const isMissing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const relativePath = (value: string) => {
  if (
    !value ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.openframe-sync'))
  ) {
    throw new Error(`Unsafe sync path: ${value}`);
  }
  return value;
};

// Check every ancestor too: a safe relative path can still escape through a symlink.
export const localPath = async (root: string, relative: string, shouldCreateParents = false) => {
  relativePath(relative);
  const parts = relative.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const isParent = index < parts.length - 1;
    if (isParent && shouldCreateParents) {
      try {
        await mkdir(current);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
          throw error;
        }
      }
    }
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || (isParent ? !stats.isDirectory() : !stats.isFile())) {
        throw new Error(`Sync refuses symlinks and non-file destinations: ${current}`);
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
  return current;
};

export const parseState = (input: unknown, serverUrl: string, userId: string): SyncState => {
  if (
    !input ||
    typeof input !== 'object' ||
    !('version' in input) ||
    input.version !== 1 ||
    !('serverUrl' in input) ||
    input.serverUrl !== serverUrl ||
    !('userId' in input) ||
    input.userId !== userId ||
    !('entries' in input) ||
    !Array.isArray(input.entries)
  ) {
    throw new Error('Invalid sync state, or this folder belongs to another server/account. State was not changed.');
  }
  const paths = new Set<string>();
  const entries = input.entries.map((entry: unknown): SyncEntry => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('path' in entry) ||
      typeof entry.path !== 'string' ||
      !('checksum' in entry) ||
      typeof entry.checksum !== 'string' ||
      !/^[a-f\d]{40}$/.test(entry.checksum) ||
      !('assetId' in entry) ||
      typeof entry.assetId !== 'string' ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(entry.assetId) ||
      !('size' in entry) ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      Math.sign(entry.size) === -1 ||
      !('mtimeMs' in entry) ||
      typeof entry.mtimeMs !== 'number' ||
      !Number.isFinite(entry.mtimeMs)
    ) {
      throw new Error('Invalid sync state entry. State was not changed.');
    }
    relativePath(entry.path);
    if (paths.has(entry.path)) {
      throw new Error(`Duplicate sync state path: ${entry.path}`);
    }
    paths.add(entry.path);
    return {
      path: entry.path,
      checksum: entry.checksum,
      assetId: entry.assetId,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    };
  });
  return { version: 1, serverUrl, userId, entries };
};

export const loadState = async (root: string, serverUrl: string, userId: string): Promise<SyncState> => {
  const filename = path.join(root, STATE_FILE);
  try {
    const stats = await lstat(filename);
    if (!stats.isFile()) {
      throw new Error('Sync state must be a regular file.');
    }
    const input: unknown = JSON.parse(await readFile(filename, 'utf8'));
    return parseState(input, serverUrl, userId);
  } catch (error) {
    if (isMissing(error)) {
      return { version: 1, serverUrl, userId, entries: [] };
    }
    throw error;
  }
};

export const saveState = async (root: string, state: SyncState) => {
  const temporary = path.join(root, `.openframe-sync-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(state, undefined, 2) + '\n');
    await file.sync();
    await file.close();
    await rename(temporary, path.join(root, STATE_FILE));
  } finally {
    await file.close();
    try {
      await unlink(temporary);
    } catch (error) {
      if (!isMissing(error)) {
        console.error(`Could not clean up sync state temporary file ${temporary}: ${error}`);
      }
    }
  }
};

const safeName = (value: string) => {
  const name = [...value]
    .map((character) => ((character.codePointAt(0) ?? 0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character))
    .join('')
    .replaceAll(/[. ]+$/g, '');
  return !name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) || name.startsWith('.openframe-sync')
    ? `asset-${name}`
    : name;
};

export const downloadPath = (
  asset: { id: string; originalFileName: string; fileCreatedAt: string },
  template = DEFAULT_TEMPLATE,
) => {
  const date = new Date(asset.fileCreatedAt);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`Invalid asset date: ${asset.fileCreatedAt}`);
  }
  const tokens: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()).padStart(4, '0'),
    MM: String(date.getUTCMonth() + 1).padStart(2, '0'),
    DD: String(date.getUTCDate()).padStart(2, '0'),
    '{originalFileName}': safeName(asset.originalFileName),
    '{assetId}': safeName(asset.id),
  };
  const result = template.replaceAll(/\{[^}]*\}|YYYY|MM|DD/g, (token) => {
    const value = tokens[token];
    if (value === undefined) {
      throw new Error(`Unknown download template token: ${token}`);
    }
    return value;
  });
  return relativePath(result);
};

export const collisionPath = (relative: string, assetId: string, attempt: number) => {
  if (attempt === 0) {
    return relative;
  }
  const parsed = path.posix.parse(relative);
  return relativePath(
    path.posix.join(parsed.dir, `${parsed.name}-${safeName(assetId)}${attempt > 1 ? `-${attempt}` : ''}${parsed.ext}`),
  );
};
