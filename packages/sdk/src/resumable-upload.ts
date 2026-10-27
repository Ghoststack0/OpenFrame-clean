import {
  createUpload,
  defaults,
  finalizeUpload,
  headUpload,
  patchUpload,
  type ResumableUploadCreateDto,
} from './fetch-client.js';
import { isHttpError } from './fetch-errors.js';

export const RESUMABLE_UPLOAD_THRESHOLD = 50 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_RETRIES = 4;

type Options = {
  file: Blob;
  metadata: ResumableUploadCreateDto;
  sidecar?: Blob;
  key?: string;
  slug?: string;
  sessionId?: string;
  signal?: AbortSignal;
  onSession?: (id: string | undefined) => void | Promise<void>;
  onProgress?: (offset: number, total: number) => void;
  onChunk?: (bytes: number) => void;
  onRetry?: () => void;
};

export async function uploadResumable({
  file,
  metadata,
  sidecar,
  key,
  slug,
  sessionId,
  signal,
  onSession,
  onProgress,
  onChunk,
  onRetry,
}: Options) {
  const opts = { signal };
  const query = { key, slug };
  const fetchImpl = defaults.fetch ?? globalThis.fetch;
  let id = sessionId;
  let chunkSize = CHUNK_SIZE;

  const retry = async <T>(action: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await action();
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof Error && error.name === 'AbortError') ||
          (isHttpError(error) &&
            error.status !== 409 &&
            error.status !== 429 &&
            error.status < 500) ||
          attempt === MAX_RETRIES
        ) {
          throw error;
        }
        onRetry?.();
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
          };
          const timer = setTimeout(
            () => {
              signal?.removeEventListener('abort', abort);
              resolve();
            },
            500 * 2 ** attempt,
          );
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
    }
  };

  const getOffset = async (uploadId: string) => {
    let value: string | null = null;
    await headUpload(
      { ...query, id: uploadId },
      {
        ...opts,
        fetch: async (input, init) => {
          const response = await fetchImpl(input, init);
          value = response.headers.get('Upload-Offset');
          return response;
        },
      },
    );
    if (
      value === null ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > file.size
    ) {
      throw new Error('Invalid upload offset from server');
    }
    return Number(value);
  };

  if (id) {
    const savedId = id;
    try {
      await retry(() => getOffset(savedId));
    } catch (error) {
      if (!isHttpError(error) || error.status !== 404) {
        throw error;
      }
      id = undefined;
      await onSession?.(undefined);
    }
  }
  if (!id) {
    const session = await retry(() =>
      createUpload({ ...query, resumableUploadCreateDto: metadata }, opts),
    );
    id = session.id;
    chunkSize = Math.min(CHUNK_SIZE, session.chunkSize);
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new Error('Invalid upload chunk size from server');
    }
    await onSession?.(id);
  }

  const uploadId = id;
  let offset = await retry(() => getOffset(uploadId));
  onProgress?.(offset, file.size);
  while (offset < file.size) {
    offset = await retry(async () => {
      const committed = await getOffset(uploadId);
      if (committed === file.size) {
        return committed;
      }
      const end = Math.min(committed + chunkSize, file.size);
      const session = await patchUpload(
        {
          ...query,
          id: uploadId,
          uploadOffset: committed,
          contentType: 'application/offset+octet-stream',
          body: file.slice(committed, end),
        },
        opts,
      );
      if (session.offset !== end) {
        throw new Error('Invalid committed upload offset from server');
      }
      onChunk?.(end - committed);
      return session.offset;
    });
    onProgress?.(offset, file.size);
  }
  const result = await retry(() =>
    finalizeUpload(
      {
        ...query,
        id: uploadId,
        resumableUploadFinalizeDto: { sidecarData: sidecar },
      },
      opts,
    ),
  );
  await onSession?.(undefined);
  return result;
}
