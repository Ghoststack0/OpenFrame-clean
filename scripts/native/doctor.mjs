import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { ConfigRepository } from "../../server/dist/repositories/config.repository.js";
import {
  POSTGRES_VERSION_RANGE,
  VECTOR_VERSION_RANGE,
  VECTORCHORD_VERSION_RANGE,
} from "../../server/dist/constants.js";

const require = createRequire(
  new URL("../../server/package.json", import.meta.url),
);
const { createPostgres } = require("@immich/sql-tools");
const Redis = require("ioredis").default;
const sharp = require("sharp");
const semver = require("semver");
const env = new ConfigRepository().getEnv();
const timeout = setTimeout(() => {
  console.error("Native dependency check timed out after 20 seconds.");
  process.exit(1);
}, 20_000);
const db = createPostgres({
  connection: env.database.config,
  maxConnections: 1,
});
const redis = new Redis({
  ...env.redis,
  lazyConnect: true,
  connectTimeout: 5000,
  retryStrategy: () => null,
});
redis.on("error", () => {});
try {
  const codecRoot = process.env.OPENFRAME_CODECS;
  assert(
    codecRoot,
    "Run doctor through scripts/native/openframe with source-built codecs",
  );
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../server/test/benchmarks/native-ubuntu/codecs/manifest.json",
        import.meta.url,
      ),
    ),
  );
  const policy = await readFile(
    join(codecRoot, "prefix/etc/ImageMagick-7/policy.xml"),
  );
  assert.equal(
    createHash("sha256").update(policy).digest("hex"),
    manifest.extraFiles.find((file) => file.path === "policy.xml").sha256,
    "ImageMagick policy differs from the pinned upstream policy",
  );
  const tiffLibraries = execFileSync(
    "ldd",
    [join(codecRoot, "prefix/lib/libtiff.so.6")],
    { encoding: "utf8", timeout: 5000 },
  );
  assert(
    tiffLibraries.includes(
      `libjpeg.so.62 => ${join(codecRoot, "prefix/lib/libjpeg.so.62")}`,
    ) && !tiffLibraries.includes("not found"),
    "Native TIFF must load the source-built jpegli ABI 62 decoder and all dependencies",
  );
  const magick = join(codecRoot, "prefix/bin/magick");
  const policies = execFileSync(magick, ["-list", "policy"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert(
    policies.includes(
      `Path: ${join(codecRoot, "prefix/etc/ImageMagick-7/policy.xml")}`,
    ),
    "Pinned ImageMagick policy is not loaded",
  );
  assert.throws(
    () =>
      execFileSync(magick, ["label:OpenFrame", "null:"], {
        timeout: 5000,
        stdio: "pipe",
      }),
    (error) => error.status > 0,
    "ImageMagick must reject the forbidden LABEL coder",
  );
  for (const format of ["heif", "magick", "svg", "jxl"]) {
    assert(
      sharp.format[format]?.input.buffer,
      `Missing ${format} buffer loader; rebuild native codecs`,
    );
  }
  const svg = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
    ),
  )
    .raw()
    .toBuffer();
  assert.deepEqual([...svg.subarray(0, 3)], [255, 0, 0]);
  for (const format of ["jpeg", "png", "webp", "jxl"]) {
    const encoded = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .toFormat(format)
      .toBuffer();
    const decoded = await sharp(encoded)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 2);
    assert.equal(decoded.info.height, 2);
  }
  console.log(
    `Sharp/libvips ${sharp.versions.vips}: JPEG, PNG, WebP and JPEG XL encode/decode, SVG decode and pinned policy passed.`,
  );
  console.warn(
    `Codec parity UNVERIFIED: HEIC input=${Boolean(sharp.format.heif?.input.file)}. The HEIF flag does not prove HEVC decoding. Camera RAW and HDR compatibility require sample tests. Validate representative library files before migration; retain Docker.`,
  );
  const video = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=size=16x16:rate=1",
      "-frames:v",
      "1",
      "-c:v",
      "libx264",
      "-f",
      "matroska",
      "pipe:1",
    ],
    { timeout: 5000 },
  );
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", "pipe:0"],
      { input: video, timeout: 5000, encoding: "utf8" },
    ),
  );
  assert.equal(probe.streams[0].codec_name, "h264");
  assert.equal(probe.streams[0].width, 16);
  console.log(
    "FFmpeg/ffprobe: H.264 encode and probe passed; other codecs and hardware acceleration remain unverified.",
  );

  const [version] = await db`SHOW server_version`;
  assert(
    semver.satisfies(
      semver.coerce(version.server_version),
      POSTGRES_VERSION_RANGE,
    ),
    "Unsupported PostgreSQL version",
  );
  const major = semver.coerce(version.server_version).major;
  const binDirectory =
    env.database.binDirectory ?? `/usr/lib/postgresql/${major}/bin`;
  for (const binary of ["pg_dump", "pg_dumpall", "psql"]) {
    const path = `${binDirectory}/${binary}`;
    await access(path, constants.X_OK);
    const output = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(
      semver.coerce(output)?.major,
      major,
      `${binary} must match PostgreSQL major ${major}`,
    );
  }
  const extensions = await db`SELECT extname, extversion FROM pg_extension`;
  const available = await db`SELECT name FROM pg_available_extensions`;
  for (const name of [
    "uuid-ossp",
    "unaccent",
    "cube",
    "earthdistance",
    "pg_trgm",
  ]) {
    assert(
      available.some((item) => item.name === name),
      `Missing PostgreSQL extension files for ${name}`,
    );
  }
  const vector =
    env.database.vectorExtension ??
    (extensions.some((item) => item.extname === "vchord")
      ? "vchord"
      : "vector");
  for (const name of new Set(["vector", vector, "earthdistance"])) {
    const installed = extensions.find((item) => item.extname === name);
    assert(
      installed,
      `Missing PostgreSQL extension ${name}; install it in the configured database`,
    );
    if (name !== "earthdistance") {
      assert(
        semver.satisfies(
          installed.extversion,
          name === "vector" ? VECTOR_VERSION_RANGE : VECTORCHORD_VERSION_RANGE,
        ),
        `Unsupported ${name} version`,
      );
    }
  }
  await db`SELECT '[1,2,3]'::vector <=> '[1,2,3]'::vector`;
  console.log(
    `PostgreSQL ${version.server_version}: authenticated; vector operation and extensions checked.`,
  );
  await redis.connect();
  assert.equal(await redis.ping(), "PONG");
  const info = await redis.info("server");
  const redisVersion = /^redis_version:(.+)\r?$/m.exec(info)?.[1].trim();
  assert(
    redisVersion && semver.gte(semver.coerce(redisVersion), "6.2.0"),
    "Redis 6.2 or newer is required",
  );
  console.log(`Redis ${redisVersion}: authenticated PING passed.`);
} catch (error) {
  // Connection errors can contain credentials; report the category without serializing the connection.
  console.error(
    `Native dependency check failed: ${error instanceof assert.AssertionError ? error.message : (error.code ?? error.name)}`,
  );
  process.exitCode = 1;
} finally {
  redis.disconnect();
  await db.end({ timeout: 1 });
  clearTimeout(timeout);
}
