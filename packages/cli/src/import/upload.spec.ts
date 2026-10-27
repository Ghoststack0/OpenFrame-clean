import { checkForDuplicates, uploadFiles } from 'src/commands/asset.js';
import { uploadImportFile } from 'src/import/upload.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('src/commands/asset.js');
afterEach(() => vi.resetAllMocks());
describe('import upload adapter', () => {
  it('uses the existing checksum and upload helpers', async () => {
    vi.mocked(checkForDuplicates).mockResolvedValue({ newFiles: ['a.jpg'], duplicates: [] });
    vi.mocked(uploadFiles).mockResolvedValue([{ id: 'new-id', filepath: 'a.jpg' }]);
    expect(await uploadImportFile('a.jpg')).toBe('new-id');
    expect(checkForDuplicates).toHaveBeenCalledWith(['a.jpg'], { concurrency: 1, progress: false });
    expect(uploadFiles).toHaveBeenCalledWith(['a.jpg'], { concurrency: 1, progress: false });
  });
  it('returns the server duplicate ID without uploading bytes', async () => {
    vi.mocked(checkForDuplicates).mockResolvedValue({
      newFiles: [],
      duplicates: [{ id: 'existing-id', filepath: 'a.jpg' }],
    });
    vi.mocked(uploadFiles).mockResolvedValue([]);
    expect(await uploadImportFile('a.jpg')).toBe('existing-id');
    expect(uploadFiles).toHaveBeenCalledWith([], { concurrency: 1, progress: false });
  });
  it('fails rather than marking silently failed checks/uploads complete', async () => {
    vi.mocked(checkForDuplicates).mockResolvedValue({ newFiles: [], duplicates: [] });
    vi.mocked(uploadFiles).mockResolvedValue([]);
    await expect(uploadImportFile('a.jpg')).rejects.toThrow('Upload or checksum check failed');
  });
});
