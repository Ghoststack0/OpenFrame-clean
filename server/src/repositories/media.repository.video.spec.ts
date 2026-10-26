import { setFfmpegPath, setFfprobePath } from 'fluent-ffmpeg';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaults } from 'src/dtos/config.dto.js';
import { Colorspace, TranscodeTarget } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { ThumbnailConfig } from 'src/utils/media.js';
import { automock } from 'test/utils.js';

// Run with MEDIA_FFMPEG_PATH and MEDIA_FFPROBE_PATH pointing to the pinned Jellyfin binaries.
describe.skipIf(!process.env.MEDIA_FFMPEG_PATH)('video thumbnail output equivalence', () => {
  let sut: MediaRepository;
  let folder: string;
  const run = promisify(execFile);
  const binary = process.env.MEDIA_FFMPEG_PATH ?? 'ffmpeg';

  beforeAll(async () => {
    setFfmpegPath(binary);
    setFfprobePath(process.env.MEDIA_FFPROBE_PATH ?? 'ffprobe');
    folder = await mkdtemp(join(tmpdir(), 'media-video-equivalence-'));
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
    const generate = (output: string, options: string[]) =>
      run(binary, ['-y', '-v', 'error', ...options, join(folder, output)]);

    await generate('sdr.mp4', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=24',
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '24',
      '-threads',
      '2',
    ]);
    await generate('rotated.mp4', ['-i', join(folder, 'sdr.mp4'), '-c', 'copy', '-metadata:s:v:0', 'rotate=90']);
    await generate('sdr.ts', ['-i', join(folder, 'sdr.mp4'), '-c', 'copy']);
    await generate('hdr.mp4', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=24',
      '-t',
      '3',
      '-pix_fmt',
      'yuv420p10le',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'pools=2:frame-threads=1:keyint=24',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
    ]);
    await generate('multiple.mp4', [
      '-f',
      'lavfi',
      '-i',
      'color=red:size=320x240:rate=12',
      '-i',
      join(folder, 'sdr.mp4'),
      '-map',
      '0:v',
      '-map',
      '1:v',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      '-disposition:v:0',
      '0',
      '-disposition:v:1',
      'default',
    ]);
    await generate('animated.gif', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12', '-t', '3', '-threads', '2']);
  }, 60_000);

  afterAll(async () => {
    if (folder) {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.each(['sdr.mp4', 'rotated.mp4', 'sdr.ts', 'hdr.mp4', 'multiple.mp4', 'animated.gif'])(
    'preserves encoded previews, thumbnails and thumbhash for %s',
    async (filename) => {
      const input = join(folder, filename);
      const { videoStreams, format } = await sut.probe(input);
      // Deliberately use the first stream's metadata for the multi-stream case. Automatic selection must stay intact.
      const video = videoStreams.find((stream) => stream.index === 0)!;
      for (const extensions of [
        ['jpeg', 'webp'],
        ['webp', 'jpeg'],
      ]) {
        const outputs = [1440, 250].map((size, index) => ({
          path: join(folder, `baseline-${index}.${extensions[index]}`),
          options: ThumbnailConfig.create({ ...defaults.ffmpeg, targetResolution: String(size) }).getCommand(
            TranscodeTarget.Video,
            video,
            undefined,
            format,
          ),
        }));
        const [preview, thumbnail] = outputs;
        await sut.transcode(input, preview.path, preview.options);
        await sut.transcode(input, thumbnail.path, thumbnail.options);
        const candidatePreview = { ...preview, path: join(folder, `candidate-preview.${extensions[0]}`) };
        const candidateThumbnail = { ...thumbnail, path: join(folder, `candidate-thumbnail.${extensions[1]}`) };
        await sut.transcodeThumbnails(input, [candidatePreview, candidateThumbnail]);
        for (const [baseline, candidate] of [
          [preview, candidatePreview],
          [thumbnail, candidateThumbnail],
        ]) {
          const expected = await readFile(baseline.path);
          expect(expected.equals(await readFile(candidate.path))).toBe(true);
          const options = { colorspace: Colorspace.P3, processInvalidImages: false };
          const before = await sut.decodeImage(baseline.path, options);
          const after = await sut.decodeImage(candidate.path, options);
          expect(after.info).toEqual(before.info);
          expect(after.data.equals(before.data)).toBe(true);
          expect(await sut.generateThumbhash(after, options)).toEqual(await sut.generateThumbhash(before, options));
        }
      }
    },
    30_000,
  );

  it('rejects an unwritable second output instead of reporting success', async () => {
    const input = join(folder, 'sdr.mp4');
    const {
      videoStreams: [video],
      format,
    } = await sut.probe(input);
    const options = ThumbnailConfig.create(defaults.ffmpeg).getCommand(TranscodeTarget.Video, video, undefined, format);
    await expect(
      sut.transcodeThumbnails(input, [
        { path: join(folder, 'preview.jpeg'), options },
        { path: join(folder, 'missing', 'thumbnail.webp'), options },
      ]),
    ).rejects.toThrow();
  });
});
