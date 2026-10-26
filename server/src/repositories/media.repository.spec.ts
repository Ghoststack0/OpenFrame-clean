import { mkdtempDisposableSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto.js';
import { Colorspace, ImageFormat } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { automock } from 'test/utils.js';

const getPixelColor = async (buffer: Buffer, x: number, y: number) => {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width!;
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * width + x) * 4;
  return {
    r: data[idx],
    g: data[idx + 1],
    b: data[idx + 2],
  };
};

const buildTestQuadImage = async () => {
  // build a 4 quadrant image for testing mirroring
  const base = sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png();

  const tl = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();

  const tr = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  const bl = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer();

  const br = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 255, g: 255, b: 0 } },
  })
    .png()
    .toBuffer();

  const image = base.composite([
    { input: tl, left: 0, top: 0 }, // top-left
    { input: tr, left: 500, top: 0 }, // top-right
    { input: bl, left: 0, top: 500 }, // bottom-left
    { input: br, left: 500, top: 500 }, // bottom-right
  ]);

  return image.png().toBuffer();
};

describe(MediaRepository.name, () => {
  let sut: MediaRepository;

  beforeEach(() => {
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
  });

  describe('edit (single actions)', () => {
    it('should apply crop edit correctly', async () => {
      const result = sut['edit'](
        sharp({
          create: {
            width: 1000,
            height: 1000,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 },
          },
        }).png(),
        [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 100,
              y: 200,
              width: 700,
              height: 300,
            },
          },
        ],
      );

      const metadata = await result.toBuffer().then((buf) => sharp(buf).metadata());
      expect(metadata.width).toBe(700);
      expect(metadata.height).toBe(300);
    });
    it('should apply rotate edit correctly', async () => {
      const result = sut['edit'](
        sharp({
          create: {
            width: 500,
            height: 1000,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 0.5 },
          },
        }).png(),
        [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      );

      const metadata = await result.toBuffer().then((buf) => sharp(buf).metadata());
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);
    });

    it('should apply mirror edit correctly', async () => {
      const resultHorizontal = sut['edit'](sharp(await buildTestQuadImage()), [
        {
          action: AssetEditAction.Mirror,
          parameters: {
            axis: MirrorAxis.Horizontal,
          },
        },
      ]);

      const bufferHorizontal = await resultHorizontal.toBuffer();
      const metadataHorizontal = await resultHorizontal.metadata();
      expect(metadataHorizontal.width).toBe(1000);
      expect(metadataHorizontal.height).toBe(1000);

      expect(await getPixelColor(bufferHorizontal, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 990, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 10, 990)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(bufferHorizontal, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });

      const resultVertical = sut['edit'](sharp(await buildTestQuadImage()), [
        {
          action: AssetEditAction.Mirror,
          parameters: {
            axis: MirrorAxis.Vertical,
          },
        },
      ]);

      const bufferVertical = await resultVertical.toBuffer();
      const metadataVertical = await resultVertical.metadata();
      expect(metadataVertical.width).toBe(1000);
      expect(metadataVertical.height).toBe(1000);

      // top-left should now be bottom-left (blue)
      expect(await getPixelColor(bufferVertical, 10, 10)).toEqual({ r: 0, g: 0, b: 255 });
      // top-right should now be bottom-right (yellow)
      expect(await getPixelColor(bufferVertical, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      // bottom-left should now be top-left (red)
      expect(await getPixelColor(bufferVertical, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      // bottom-right should now be top-right (blue)
      expect(await getPixelColor(bufferVertical, 990, 990)).toEqual({ r: 0, g: 255, b: 0 });
    });
  });

  describe('edit (multiple sequential edits)', () => {
    it('should apply horizontal mirror then vertical mirror (equivalent to 180° rotation)', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply rotate 90° then horizontal mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 255, b: 0 });
    });

    it('should apply 180° rotation', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply 270° rotations', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [{ action: AssetEditAction.Rotate, parameters: { angle: 270 } }]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should apply crop then rotate 90°', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 500 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(500);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('should apply rotate 90° then crop', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 1000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 0, b: 255 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply vertical mirror then horizontal mirror then rotate 90°', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Vertical } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 0, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 255, g: 255, b: 0 });
      expect(await getPixelColor(buffer, 10, 990)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 990)).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should apply crop to single quadrant then mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 500 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(500);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 490, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 10, 490)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 490, 490)).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should apply all operations: crop, rotate, mirror', async () => {
      const imageBuffer = await buildTestQuadImage();
      const result = sut['edit'](sharp(imageBuffer), [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 500, height: 1000 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]);

      const buffer = await result.png().toBuffer();
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(500);

      expect(await getPixelColor(buffer, 10, 10)).toEqual({ r: 255, g: 0, b: 0 });
      expect(await getPixelColor(buffer, 990, 10)).toEqual({ r: 0, g: 0, b: 255 });
    });
  });

  describe('transform', () => {
    it.each([1, 2, 3, 4] as const)(
      'matches the original transform for %i channels and both resize fits',
      async (channels) => {
        const data = Buffer.from(Array.from({ length: 48 * 32 * channels }, (_, index) => index % 256));
        const image = await sharp(data, { raw: { width: 48, height: 32, channels } })
          .raw()
          .toBuffer({ resolveWithObject: true });
        for (const fit of ['inside', 'outside'] as const) {
          for (const size of [16, 32, 48, 100]) {
            const expected = await sharp(image.data, { raw: image.info })
              .pipelineColorspace('scrgb')
              .resize(size, size, { fit, withoutEnlargement: true })
              .raw()
              .toBuffer({ resolveWithObject: true });
            const actual = await sut['transform'](image, { size, fit });
            expect(actual.info.width).toBe(expected.info.width);
            expect(actual.info.height).toBe(expected.info.height);
            expect(actual.info.channels).toBe(expected.info.channels);
            expect(actual.data).toEqual(expected.data);
          }
        }
      },
    );
  });

  describe('decodeImage', () => {
    it('supports the opt-out and keeps small JPEGs at their original dimensions', async () => {
      using directory = mkdtempDisposableSync(join(tmpdir(), 'media-jpeg-toggle-'));
      const input = join(directory.path, 'input.jpg');
      await sharp({ create: { width: 64, height: 48, channels: 3, background: '#376fa0' } })
        .jpeg()
        .toFile(input);
      const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };
      const decoded = await sut['getImageDecodingPipeline'](input, options).raw().toBuffer({ resolveWithObject: true });
      try {
        for (const enabled of ['false', 'true']) {
          vi.stubEnv('IMMICH_SRGB_JPEG_LINEAR_FUSION', enabled);
          for (const size of [16, 1440]) {
            const expected = await sut['transform'](decoded, { size });
            const actual = await sut.decodeImage(input, { ...options, size });
            expect(actual.info.width).toBe(expected.info.width);
            expect(actual.info.height).toBe(expected.info.height);
            expect(actual.data.equals(expected.data)).toBe(true);
          }
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
      'preserves SDR JPEG orientation %i and all derived output bytes',
      async (orientation) => {
        using directory = mkdtempDisposableSync(join(tmpdir(), 'media-jpeg-fusion-'));
        const data = Buffer.from(Array.from({ length: 801 * 601 * 3 }, (_, index) => (index * 31) % 256));
        const input = join(directory.path, 'input.jpg');
        await sharp(data, { raw: { width: 801, height: 601, channels: 3 } })
          .withExif({ IFD0: { Orientation: String(orientation) } })
          .jpeg()
          .toFile(input);
        const options = { colorspace: Colorspace.Srgb, processInvalidImages: false, size: 256 };
        const decoded = await sut['getImageDecodingPipeline'](input, options)
          .raw()
          .toBuffer({ resolveWithObject: true });
        const expected = await sut['transform'](decoded, options);
        const actual = await sut.decodeImage(input, options);
        expect(actual.info.width).toBe(expected.info.width);
        expect(actual.info.height).toBe(expected.info.height);
        expect(actual.data.equals(expected.data)).toBe(true);
        expect(await sut.generateThumbhash(actual, options)).toEqual(await sut.generateThumbhash(expected, options));
        for (const format of [ImageFormat.Jpeg, ImageFormat.Webp]) {
          for (const size of [256, 32]) {
            const output = { ...options, format, size, quality: 80 };
            const before = join(directory.path, `before.${format}`);
            const after = join(directory.path, `after.${format}`);
            await sut.generateThumbnail(expected, output, before);
            await sut.generateThumbnail(actual, output, after);
            expect(readFileSync(after).equals(readFileSync(before))).toBe(true);
          }
        }
      },
    );

    it('preserves the current path for profiles, grayscale, CMYK, progressive JPEG, XMP and fullsize', async () => {
      using directory = mkdtempDisposableSync(join(tmpdir(), 'media-jpeg-fallback-'));
      const data = Buffer.from(Array.from({ length: 321 * 241 * 3 }, (_, index) => (index * 31) % 256));
      const raw = { width: 321, height: 241, channels: 3 } as const;
      const variants = [
        await sharp(data, { raw }).withIccProfile('p3').jpeg().toBuffer(),
        await sharp(data, { raw }).withIccProfile('srgb').jpeg().toBuffer(),
        await sharp(data, { raw }).toColourspace('b-w').jpeg().toBuffer(),
        await sharp(data, { raw }).toColourspace('cmyk').jpeg().toBuffer(),
        await sharp(data, { raw }).jpeg({ progressive: true }).toBuffer(),
        await sharp(data, { raw }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">HDR</x:xmpmeta>').jpeg().toBuffer(),
        await sharp(data, { raw }).ensureAlpha(0.5).png().toBuffer(),
      ];
      for (const [index, buffer] of variants.entries()) {
        const input = join(directory.path, `${index}.jpg`);
        writeFileSync(input, buffer);
        const options = { colorspace: Colorspace.P3, processInvalidImages: false, size: 64 };
        for (const colorspace of [Colorspace.Srgb, Colorspace.P3]) {
          const decoded = await sut['getImageDecodingPipeline'](input, { ...options, colorspace })
            .raw()
            .toBuffer({ resolveWithObject: true });
          for (const transform of [{ size: 64 }, { size: undefined }]) {
            const expected = await sut['transform'](decoded, transform);
            const actual = await sut.decodeImage(input, { ...options, ...transform, colorspace });
            expect(actual.info).toEqual(expected.info);
            expect(actual.data.equals(expected.data)).toBe(true);
          }
        }
      }
    });

    it.each([3, 4] as const)(
      'preserves %i-channel pixels when resizing would not change dimensions',
      async (channels) => {
        const data = Buffer.from(Array.from({ length: 48 * 32 * channels }, (_, index) => index % 256));
        const input = await sharp(data, { raw: { width: 48, height: 32, channels } })
          .png()
          .toBuffer();
        const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };
        const decoded = await sut.decodeImage(input, options);
        for (const size of [32, 100]) {
          const result = await sut.decodeImage(input, { ...options, size });
          expect(result.info.width).toBe(48);
          expect(result.info.height).toBe(32);
          expect(result.data).toEqual(decoded.data);
        }
        const resized = await sut.decodeImage(input, { ...options, size: 16 });
        expect(resized.info.width).toBe(24);
        expect(resized.info.height).toBe(16);
      },
    );
  });

  describe('generateThumbnail', () => {
    it('should process random Authentik thumbnail image', async () => {
      const response = await fetch(
        'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NHB4IiBoZWlnaHQ9IjY0cHgiIHZpZXdCb3g9IjAgMCA2NCA2NCIgdmVyc2lvbj0iMS4xIj48cmVjdCBmaWxsPSIjMzc3YjM3IiBjeD0iMzIiIGN5PSIzMiIgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByPSIzMiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBzdHlsZT0iY29sb3I6ICNmZmY7IGxpbmUtaGVpZ2h0OiAxOyBmb250LWZhbWlseTogJ1JlZEhhdFRleHQnLCdPdmVycGFzcycsb3ZlcnBhc3MsaGVsdmV0aWNhLGFyaWFsLHNhbnMtc2VyaWY7ICIgZmlsbD0iI2ZmZiIgYWxpZ25tZW50LWJhc2VsaW5lPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtc2l6ZT0iMjgiIGZvbnQtd2VpZ2h0PSI0MDAiIGR5PSIuMWVtIj5BQTwvdGV4dD48L3N2Zz4=',
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      const dir = mkdtempDisposableSync(join(tmpdir(), 'media-repository-'));
      const file = join(dir.path, 'test.webp');
      const decoded = await sut.decodeImage(buffer, { colorspace: Colorspace.P3, processInvalidImages: false });
      await sut.generateThumbnail(
        decoded,
        { colorspace: Colorspace.P3, quality: 80, format: ImageFormat.Webp, processInvalidImages: false },
        file,
      );

      expect(statSync(file).blksize).toBeGreaterThan(0);
    });
  });
});
