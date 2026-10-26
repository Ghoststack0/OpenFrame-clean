import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { MediaRepository } from './dist/repositories/media.repository.js';
const [input, output] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const bytes = await readFile(input);
const repository = new MediaRepository({ setContext() {} });
const options = { colorspace: 'srgb', processInvalidImages: false, size: 1440, format: 'jpeg', quality: 80 };
const initial = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
const resized = await repository.decodeImage(bytes, options);
await repository.generateThumbnail(resized, options, join(output, 'preview.jpg'));
const decodedPreview = await sharp(join(output, 'preview.jpg')).raw().toBuffer({ resolveWithObject: true });
const stages = {};
for (const [name, image] of Object.entries({ initial, resized, decodedPreview })) {
  await writeFile(join(output, name + '.rgb'), image.data);
  stages[name] = { info: image.info, sha256: createHash('sha256').update(image.data).digest('hex') };
}
await writeFile(join(output, 'stages.json'), JSON.stringify(stages, null, 2) + '\n');
