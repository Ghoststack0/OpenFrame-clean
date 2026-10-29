import { checkForDuplicates, uploadFiles } from 'src/commands/asset.js';

// Keep the transfer boundary here so resumable uploads can replace it independently of export parsing.
export const uploadImportFile = async (filename: string): Promise<string> => {
  const options = { concurrency: 1, progress: false };
  const { newFiles, duplicates } = await checkForDuplicates([filename], options);
  const assets = [...duplicates, ...(await uploadFiles(newFiles, options))];
  const asset = assets.find((asset) => asset.filepath === filename);
  if (!asset?.id) {
    throw new Error(`Upload or checksum check failed: ${filename}`);
  }
  return asset.id;
};
