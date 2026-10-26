# Isolated Ubuntu native validation, 2026-10-26

The requested 2–5x end-to-end gain is not established. This run tests the native deployment on `yvm@192.168.1.9`, an Ubuntu 24.04.5 x86-64 host with two AMD A4-9125 CPU cores and 6.7 GiB RAM. Its existing applications, databases, Docker deployments and `~/openframe-bench-20261026` were not changed. All candidate services bind to loopback. No system configuration, sudo, Docker runtime, durability setting, media quality or job concurrency setting was used to obtain these results.

The disposable installation is `~/openframe-native-validation-20261026`. This is validation evidence, not a production installation or migration approval. PostgreSQL 16.6 and Redis 7.4.2 were selected as small available source archives for this isolated test; use maintained patched releases for deployment.

## Installed dependencies and startup

| Dependency               | Method                                                                                            | Result                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Node 24.13.1 x86-64      | Official Linux tarball; SHA256 checked against upstream SHASUMS256.txt                            | Runs directly on Ubuntu                                               |
| PostgreSQL 16.6          | Source build, `--without-readline --without-icu`, user-local prefix                               | SCRAM-authenticated TCP; fsync remains enabled                        |
| pgvector 0.8.0           | Source build against this PostgreSQL's `pg_config`                                                | Authenticated vector operation passed                                 |
| PostgreSQL contrib       | Built cube, earthdistance, uuid-ossp, unaccent and pg_trgm                                        | Normal application migrations passed                                  |
| Redis 7.4.2              | Source build with libc allocator, user-local prefix                                               | Password-authenticated; loopback; AOF with default every-second fsync |
| Jellyfin FFmpeg 7.1.3-6  | Pinned portable archive, checksum matches `mise.lock`                                             | H.264 encode/probe and playback passed                                |
| uv 0.9.6 / Python 3.13.9 | uv portable archive and managed Python                                                            | Frozen CPU ML dependencies installed                                  |
| Core plugin              | Built on x86-64 development host using pinned Extism JS PDK 1.7.0, Extism CLI 1.6.3, Binaryen 124 | Native runtime imported 14 methods and loaded worker host functions   |
| Web client               | Existing source built without edits and copied into isolated build directory                      | UI source unchanged                                                   |

PostgreSQL is on `127.0.0.1:25432`, Redis on `127.0.0.1:26379`, API on `127.0.0.1:2287`, and ML on `127.0.0.1:3003`. Test credentials were generated locally and remain in private files under the validation directory. The application database role is not a PostgreSQL superuser. Do not publish the environment, password files, SQL backup or fixture `admin.json`.

`doctor` passed authenticated PostgreSQL/Redis checks, vector operations, matching `pg_dump`/`pg_dumpall`/`psql`, JPEG/PNG/WebP round trips and H.264 encoding/probing. A deliberately wrong-major `pg_dump` was rejected with `pg_dump must match PostgreSQL major 16`.

The API and normal microservices worker both started in production mode. The core plugin loaded, and 229,248 geodata records imported. ML started through Python/Gunicorn without Docker. The CLIP visual/textual, Buffalo face detection/recognition and PP-OCRv5 detection/recognition models loaded on CPU. Authenticated text smart search returned an uploaded asset, and all background queues drained with zero failed jobs after the ML warmup.

## Native parity checks

`native-http.mjs` creates disposable users in this isolated instance and uploads six persistent 4000×3000 noise JPEG fixtures plus a generated ten-second 1280×720 H.264 MP4. It verifies:

- Every original download has the same SHA256 as its uploaded fixture.
- Unauthenticated original downloads return 401.
- Authenticated original ranges return 206, exact `Content-Range`, and the requested bytes.
- ETag conditional requests return 304 with an empty body. The harness uses fetch `cache: 'no-cache'` to avoid fetch's implicit `Cache-Control: no-cache` header when a conditional header is supplied.
- Previews become available and decode, metadata search finds each image, compatible H.264 playback preserves original bytes, and video ranges return the requested bytes.
- Text smart search returns an uploaded asset, queues drain, and no background jobs failed.

Unsatisfiable ranges currently return 404 because the existing shared sendFile error handler maps the error to NotFoundException. Both the baseline and candidate retain this behavior. This is a known HTTP limitation, not a passing 416 check.

The application's backup job produced a 18,918,683-byte gzip file containing 53,248,711 bytes of SQL. It restored successfully into a second isolated database, `ofv_restore`, inside one transaction. All nine asset IDs matched and a vector query passed after restore. See `results/native-ubuntu-backup-restore.json`. This does not exercise the interactive maintenance restore flow, an existing-library migration, or a restore to another host.

## Paired HTTP measurements

All three alternating pairs completed successfully. `results/native-ubuntu-http.jsonl` retains warmups and every timed sample. Run `python3 native-ubuntu/analyze.py results/native-ubuntu-http.jsonl results/native-ubuntu-http-summary.json` from this directory to reproduce the analysis.

Across 18 paired samples per metric, upload response improved by a paired geometric mean of 1.096x, upload-to-preview readiness by 1.019x, and video transfer by 1.167x. Candidate readiness was slower in 10 of 18 samples, and its median was 3380.86 ms versus 3366.15 ms for baseline. These results do not establish a 2–5x end-to-end gain or a Docker-to-native gain. Both variants used the same native stack. All paired encoded photo preview hashes matched, and every run passed search and queue checks. Detailed medians and unfavorable sample counts are in `NATIVE-PERFORMANCE-RESULTS.md`.

### Repeat with source-built codecs

After the source codec checks, the same runner completed three new alternating pairs with the source-built Sharp package selected. `results/native-ubuntu-http-source-pairs.jsonl` retains all 78 timed and parity rows. Reproduce its summary with `python3 native-ubuntu/analyze.py results/native-ubuntu-http-source-pairs.jsonl results/native-ubuntu-http-source-summary.json`.

| Metric                      | Baseline median | Candidate median | Paired geometric mean speedup | Slower candidate samples |
| --------------------------- | --------------- | ---------------- | ----------------------------- | ------------------------ |
| Photo upload response       | 278.20 ms       | 229.29 ms        | 1.283x                        | 3/18                     |
| Upload to available preview | 3749.32 ms      | 3552.37 ms       | 1.069x                        | 4/18                     |
| Video transfer              | 143.54 ms       | 80.70 ms         | 1.567x                        | 5/18                     |

Every paired fixture and preview hash matched. All six runs passed smart search, queue drain and zero failed jobs. These measurements compare the three optimizations within one native codec stack. They do not compare Docker performance with native performance, and do not establish RAW parity or a 2–5x end-to-end gain. The earlier bundled-codec samples remain separate and unchanged.

## Codec regression gate

`native-codecs.mjs` calls the real repository decode/thumbnail path and compares encoded JPEG SHA256 with the original transform. Bundled Sharp 0.35.5/libvips 8.18.7 fails two representative upstream fixtures:

| Fixture                               | Result                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `formats/heic/IMG_2682.heic`          | Metadata readable, actual decode fails because HEVC/libde265 support was not built in |
| `formats/raw/Canon/EOS_30D.CR2`       | Falls into TIFF loader; preview fails with unsupported old-style JPEG compression     |
| `formats/avif/10bit-HDR-P3-nclx.avif` | Preview succeeds and encoded bytes exactly match the original transform               |

Raw errors, dimensions, dependency versions and source/output hashes are retained in `results/native-ubuntu-codecs.json`. A successful HDR preview comparison establishes equality to the original transform with the same native codec stack; it does not establish equality to Docker codecs or preservation of an HDR display output. One camera RAW and one HDR sample do not establish library-wide compatibility.

Samples came from `immich-app/test-assets` commit `ec56cc6c1d76c45bc9615dc6ea232470a2b0a3a1`. Download individual files from `https://raw.githubusercontent.com/immich-app/test-assets/<commit>/<path>` and check their hashes against the result file. Large sample files are not committed here.

The upstream Docker recipe at `immich-app/base-images` commit `ffeb230c5ade36f0e603aecfaef62e943309640b` builds libheif with libde265, builds libraw and patches libvips loader order. Its libvips build disables TIFF. It also uses jpegli rather than bundled Sharp's mozjpeg. Relevant files are `server/Dockerfile`, `server/sources/libheif.sh`, `server/sources/libraw.sh`, `server/sources/libvips.sh`, and `server/sources/libvips-patches/0001-put-other-loaders-ahead-of-dcrawload.patch`. Reusing only its Debian binaries on Ubuntu would not establish ABI compatibility. The user-local source experiment below now decodes all three fixtures. Its RAW output still differs from Docker, so retain Docker installation, comparison and e2e assets.

### Docker codec reference

A one-shot, network-disabled, read-only invocation of the cached `openframe-bench:20261026` image successfully decoded all three samples through the repository path. Image ID is `sha256:0bb71185d49546fd049b5c6d33d3c08184ba7385bd4d4adb02229580f5689a27`. Only the sample directory and codec harness were mounted read-only; temporary previews used a 256 MiB tmpfs. No application service, database, credentials, network or existing media directory was attached. `results/native-ubuntu-codecs-docker-reference.json` retains the output.

The image's `/build/build-lock.json` confirms the libvips, libraw, libheif and jpegli revisions above. All three previews match the baseline transform within that Docker codec stack. The Docker HDR JPEG SHA256 differs from the bundled native Sharp result, so baseline equality inside the bundled stack cannot substitute for Docker codec parity.

### User-local source codec build

`native-ubuntu/codecs/` reproduces the fixed Ubuntu experiment without sudo. Its manifest pins source archives, upstream patches, the ImageMagick policy and extracted Ubuntu packages by SHA256. The source trees, archives, compiler logs and libraries remain under `~/openframe-native-validation-20261026/codec-build`. This is an experiment, not a production installer or a fresh-machine installation test.

The final build uses libvips 8.18.7 with the upstream loader patch and TIFF disabled, libheif 1.23.6 with the upstream `release-noplugins` preset, libde265 1.1.3, the pinned libraw revision, patched jpegli with libjpeg ABI 62, Highway 1.2.0, and ImageMagick 7.1.2-21. The libraw source identifies itself as 0.22.0 despite the upstream lock's 0.22.2-1 label. Exact revisions are in `native-ubuntu/codecs/manifest.json`. The custom codec libraries were built on this Ubuntu host. Extracted dependencies are pinned Ubuntu packages.

Sharp 0.35.5 was rebuilt as a separate package. The checks temporarily select that package and restore the original application symlink on exit. At this checkpoint the native CLI still used bundled Sharp by default. The integration described below replaces that behavior. No production media source or UI source changed in this experiment.

| Fixture           | Source build versus original transform    | Source build versus Docker       |
| ----------------- | ----------------------------------------- | -------------------------------- |
| HEVC HEIC         | Encoded preview SHA256 identical          | Encoded preview SHA256 identical |
| Canon EOS_30D.CR2 | Decodes; encoded preview SHA256 identical | Encoded preview differs          |
| HDR AVIF          | Encoded preview SHA256 identical          | Encoded preview SHA256 identical |

`results/native-ubuntu-codecs-source.json` and `results/native-ubuntu-codec-comparison.json` retain the hashes. The RAW difference begins in the initial decoded pixels, before the repository transform. It changes 524,185 of 5,971,968 channel samples, with maximum difference 6 and PSNR 58.09 dB. The decoded JPEG previews differ in 479,415 samples, with maximum difference 11 and PSNR 56.51 dB. `results/native-ubuntu-raw-pixels.json` records every stage. Matching Highway 1.2.0 and rebuilding libraw cleanly did not remove this difference. These measurements do not approve a quality tradeoff or establish RAW parity.

ImageMagick is required for the buffer-based CR2 path; libraw and the libvips raw loader alone did not detect this input buffer. The failed intermediate build remains in `results/native-ubuntu-codecs-source-before-magick.json`. Earlier RAW mismatch hashes, pixel metrics and HTTP smoke samples also remain in the results directory.

The source build retains the exact upstream ImageMagick security policy. The check confirms the installed policy bytes and loaded policy path, and rejects a forbidden LABEL operation. Libheif links libde265 1.1.3 and references its security-limit API. The source build passed doctor, normal API and worker startup, full HTTP integrity/range/conditional checks, smart search and queue drain with zero failed jobs. Its smoke test stops its own process group. `results/native-ubuntu-http-source-smoke.jsonl` retains that single run; its timings establish no speed gain.

Dedicated SVG and JPEG XL loaders remain absent from this source build. `results/native-ubuntu-codec-formats.json` records capability flags and `results/native-ubuntu-codec-libraries.txt` records loaded libraries. Capability flags and these three samples do not establish compatibility with an entire library. RAW pixel parity, broader format coverage and an existing-library migration remain release gates. `install.sh` remains the legacy Docker installer.

The retained build logs include missing development/runtime metadata, CMake search-path configuration, conflicting Highway headers, an older transitive node-addon-api, and a policy error-message assumption. A lifecycle mistake briefly overlapped two compiler builds. Both were stopped, and Highway was rebuilt from a clean build directory. The native HTTP benchmarks ran after codec compilation stopped. The final recipe pins Highway separately and builds jpegli before a clean libraw build. Preparation, builds and tests now share an exclusive lock that rejects overlapping operations.

## Runtime integration and RAW diagnosis follow-up

The original RAW pixel gate was retained. A direct C probe using ImageMagick's LibRaw parameters produced identical full-resolution 3522×2348 RGB16 data under the Ubuntu and Docker libraries. Both report LibRaw 0.22.0, and both output SHA256 `47d76becdda648eb92565ce90792a617aaea57faa53ffb373d0acba152960065`. Parameters were camera white balance enabled, 16-bit output, zero user flip and the same 8192 MiB raw memory limit. This comparison rules out compiler/SIMD rounding in LibRaw as the cause for this fixture.

`loader-probe.c` identifies `VipsForeignLoadMagick7Buffer` and `magick-format=TIFF` in both stacks. `results/native-ubuntu-raw-root-cause.txt` retains loader, library, source-patch and hash evidence. In contrast, a filename opens through `dcrawload` at 3522×2348. The actual buffer path returns the TIFF-contained 1728×1152 image. Ubuntu ImageMagick's TIFF module loaded Ubuntu libtiff 4.5.1 with `libjpeg.so.8`, the Ubuntu libjpeg-turbo decoder. Docker's TIFF module loaded libtiff 4.7.0 with `libjpeg.so.62`, resolved to the pinned jpegli build. Matching the top-level JPEG library alone had left this transitive decoder unchanged.

The fix rebuilds the same Ubuntu TIFF source against jpegli ABI 62. It retains every patch from Ubuntu `4.5.1+git230720-4ubuntu2.5`, including its security patches. Source and Debian patch archives are checksum-pinned in the manifest. Libvips TIFF remains disabled, the upstream loader patch remains applied, and ImageMagick's upstream security policy is unchanged. No white balance, demosaicing, profiles, quality, interpolation or repository transform options changed.

With only that TIFF dependency corrected, initial decoded pixels, transformed pixels and decoded JPEG pixels all match Docker exactly, with zero differing channel samples. See `results/native-ubuntu-raw-pixels-tiff.json`. Earlier mismatch metrics remain in `results/native-ubuntu-raw-pixels.json`. No numeric tolerance was introduced. `raw-probe.c` and `loader-probe.c` retain the small probes used to isolate the cause.

The CLI now has `openframe codecs`, which reuses these recipes at an explicit `OPENFRAME_CODECS` directory or the XDG data default. Runtime selection uses a synchronous Node preload to resolve Sharp to the separate package, plus library and policy paths inherited by children and workers. It does not replace `server/node_modules/sharp`. Doctor, start and admin require a built codec directory. Missing codecs fail rather than silently selecting packaged Sharp. The self-check covers ESM/CommonJS imports, both ESM/CommonJS workers, rejection of bundled addon fallback and XDG build dispatch. The Sharp build links runtime JavaScript dependencies from the original package through Node resolution and asserts those paths, rather than relying on packages elsewhere in the home directory.

### Final runtime check

The dedicated SVG loader and pinned JPEG XL 0.12.0 loader are restored. JPEG XL uses the original skcms backend and its upstream-pinned submodule revision, `96d9171c94b937a1b5f0293de7309ac16311b722`. The first successful lcms2-backed build and smoke outputs remain separately recorded as `results/native-ubuntu-codecs-runtime-before-skcms.json` and `results/native-ubuntu-http-runtime-before-skcms.jsonl`. The final build restores the original backend rather than accepting fixture equality as permission to change it.

All six representative fixtures have identical metadata, input hashes and encoded preview hashes under Docker and the final native stack: HEIC, CR2, HDR AVIF, 8-bit sRGB JPEG XL, 16-bit HDR P3 JPEG XL and the checkout's SVG icon. Every Docker input/output file, buffer and stream capability flag is retained. See `results/native-ubuntu-codecs-runtime.json`, `results/native-ubuntu-codecs-docker-broader.json`, `results/native-ubuntu-codec-runtime-comparison.json` and the adjacent format/library records. The two JPEG XL fixtures come from the same pinned upstream test-assets commit as the earlier fixtures. Their hashes are in the result files. SVG text and font rendering are not covered by the icon fixture.

The final native CLI doctor passed codec round trips, SVG decoding, TIFF linkage to source-built jpegli ABI 62, exact loaded policy bytes, forbidden LABEL rejection, FFmpeg, authenticated PostgreSQL/vector operations, matching backup tools and Redis. `admin version` returned `v3.3.0`. Normal API/worker startup, authenticated uploads/downloads, original integrity, streaming ranges, conditional requests, playback, smart search and queue drain passed through the production selector with zero failed jobs. `results/native-ubuntu-http-runtime-codecs.jsonl` and `results/native-ubuntu-codec-runtime-check.txt` retain that final smoke run. Its timings are not a paired performance measurement. The existing 404 behavior for unsatisfiable ranges is retained.

The source Sharp build ran using the generic `OPENFRAME_SOURCE` and `OPENFRAME_CODECS` paths, with dependency-resolution assertions. All pinned source/package checksums passed. The local CLI self-check passed configuration, credentials, XDG build dispatch, missing-codec rejection, bundled-addon fallback rejection and import/worker inheritance. The full server regression suite passed 110 files with 2,455 passed tests, one expected failure and two skipped tests. Shell/Node syntax, Python compilation, changed JavaScript formatting and `git diff --check` passed.

The isolated private config now selects its codec directory. Its prior config is retained privately as `env.before-codec-runtime`. The original Sharp dependency link is unchanged. The smoke check stopped its API process group; PostgreSQL 25432, Redis 26379 and ML 3003 remain on loopback for review. No paired benchmarks were repeated after integration. The 2–5x target remains unmet.

The install command and runtime selector are no longer tied to the dated directory, but a fresh-machine build from an empty codec directory has not been run. This validation reused existing source/dependency caches and built the recipe components on Ubuntu. A representative six-file check cannot prove parity for every camera, SVG font, HDR profile or existing library. Existing-library migration, interactive maintenance restore, concurrent load, and a realistic concurrent end-to-end comparison remain outstanding. Keep the legacy installer, Docker deployment and comparison infrastructure.

## Reproduce this isolated installation

These steps deliberately target this dated disposable directory. The initializer refuses to replace its environment or initialize a populated cluster. Do not reuse these scripts for an existing deployment.

1. Create the directory with mode 0700 and subdirectories `downloads`, `src`, `local`, `logs`, and `app`. Check that the four loopback ports above are free and that at least the original 30 GiB disk budget is available. Transfer the checkout's built server, installed Linux x86-64 dependencies with symlinks preserved, plugin-sdk artifacts, native scripts, ML source/README/pyproject/uv.lock, unchanged web build and core plugin artifacts. The server and plugin SDK were built using the installed development-host Node 24.13.1 and pinned pnpm 12.14.0.
2. Extract Node from `https://nodejs.org/dist/v24.13.1/node-v24.13.1-linux-x64.tar.xz` into `local`. Check its SHA256 using that release's `SHASUMS256.txt`. Extract the pinned Jellyfin portable FFmpeg archive into `local/ffmpeg`, verifying the checksum in `mise.lock`.
3. Build PostgreSQL from `https://ftp.postgresql.org/pub/source/v16.6/postgresql-16.6.tar.bz2` in `src/postgresql-16.6`:

   ```sh
   ./configure --prefix="$HOME/openframe-native-validation-20261026/local/pgsql" --without-readline --without-icu
   make -j2
   make install
   make -C contrib/cube install
   make -C contrib/earthdistance install
   make -C contrib/unaccent install
   make -C contrib/pg_trgm install
   ```

   The host lacked UUID development headers. In the validation directory, `apt-get download uuid-dev` downloaded Ubuntu package `2.39.3-9ubuntu6.6` without installing it. `dpkg-deb -x downloads/uuid-dev_*.deb local/uuid` extracted its headers. Build only the UUID extension using those headers and the existing system libuuid runtime:

   ```sh
   make -C src/postgresql-16.6/contrib/uuid-ossp USE_PGXS=1 \
     PG_CONFIG="$PWD/local/pgsql/bin/pg_config" \
     PG_CPPFLAGS="-DHAVE_UUID_E2FS -DHAVE_UUID_UUID_H -I$PWD/local/uuid/usr/include" \
     SHLIB_LINK="-l:libuuid.so.1" install
   ```

4. Extract `https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.0.tar.gz` into `src`. Run `make -C src/pgvector-0.8.0 PG_CONFIG="$PWD/local/pgsql/bin/pg_config" -j2`, then the same command with `install` instead of `-j2`. Extract Redis from `https://download.redis.io/releases/redis-7.4.2.tar.gz`; run `make -C src/redis-7.4.2 -j2 MALLOC=libc BUILD_TLS=no`, then `make -C src/redis-7.4.2 PREFIX="$PWD/local/redis" install`.
5. Extract `https://github.com/astral-sh/uv/releases/download/0.9.6/uv-x86_64-unknown-linux-gnu.tar.gz` into `local`. Install the ML environment:

   ```sh
   XDG_CACHE_HOME="$PWD/cache" UV_CACHE_DIR="$PWD/cache/uv" \
   UV_PYTHON_INSTALL_DIR="$PWD/local/python" \
     local/uv-x86_64-unknown-linux-gnu/uv sync \
       --project app/machine-learning --frozen --extra cpu --no-dev --python 3.13
   ```

   The pinned `watchfiles==0.21.0` required a Rust source build for Python 3.13. In the recorded run its build backend also created `~/.cache/puccinialin` for an isolated Rust toolchain with `--no-modify-path`; no shell configuration changed. `XDG_CACHE_HOME` above keeps that download inside the validation directory for a fresh run.

6. Copy `native-ubuntu/initialize.py`, `make-baseline.py`, `backup-check.py`, and `run-pairs.py` to the validation root. Run `python3 initialize.py` once. Set `OPENFRAME_CONFIG` to the generated absolute `env` path and `OPENFRAME_STATE` to `state`; run `app/scripts/native/openframe resources`. Place web/plugin artifacts in the normal `state/build` locations. Run `source ./run-env`, then `app/scripts/native/openframe doctor`. Start `openframe ml` and `openframe start` in separate processes, retaining their PIDs and private logs.
7. Run the HTTP warmup, backup check, and comparison:

   ```sh
   node app/server/test/benchmarks/native-http.mjs \
     http://127.0.0.1:2287 "$PWD/fixtures" candidate-ml-warmup "$PWD/logs/native-http.jsonl"
   python3 backup-check.py
   python3 make-baseline.py
   # Stop the warmup server with Ctrl+C in its terminal before comparing.
   python3 run-pairs.py
   ```

   The baseline copies the same built server and reverts only the upload buffer, video read buffer and unchanged-size image transform. Both variants retain authenticated services, normal workers, ML, fsync, codec/quality settings and database schema. The runner alternates three baseline/candidate pairs, uses a fresh user for each run to prevent duplicate-upload shortcuts, waits for ML/queues to settle, and stops its own process group between runs. It refuses to start while another application is listening on the test port. It leaves PostgreSQL, Redis and ML running until explicitly stopped. All samples, including warmups, remain in the JSONL output.

Initial failures remain in private logs: a missing ML README in the transfer, a timed-out Binaryen download resumed with `curl -C -`, missing contrib files at first startup, an HTTP attempt before the listener started, two accidentally overlapping harness startups causing duplicate admin signup, the conditional-fetch cache behavior, and the existing invalid-range 404, and an initial comparison lifecycle error where signaling only the supervisor left its API child listening. The comparison runner now creates and stops an isolated process group. These are not omitted from the deployment record or counted as successful parity checks.

## Rejected image decode/resize fusion

A development-host experiment fused the full-resolution decode and linear resize into one Sharp pipeline. `image-fusion-experiment.mjs` compares the actual encoded previews and their decoded pixels. The first diagnostic JPEG output was identical, but the HDR AVIF changed 4,165,126 of 9,452,160 channel samples, with a maximum difference of 16 and PSNR 47.72 dB. The intermediate color conversion/quantization is therefore observable. This optimization was rejected and no production media code changed. `results/image-fusion-rejected.json` retains a repeat using the HTTP fixture and HDR sample. Its single baseline-first timings are diagnostic only and establish no speed gain.

## Final checks and service state

The native CLI self-check, shell syntax checks, Node 24 syntax checks, Python syntax checks, changed-file formatting and result JSON parsing passed. The pinned input verifier passed with Python optimization enabled and rejected an intentionally wrong checksum. Preparation and all four build/test commands rejected an overlapping operation while the shared lock was held. The image-fusion diagnostic reproduced the exact rejected HDR mismatch. The production TypeScript source did not change in this continuation, so the previously passing 2,446-test unit suite was not rerun.

Every test API process group stopped, and the application's original bundled Sharp symlink was restored. The pre-existing isolated PostgreSQL, Redis and ML services remain on loopback ports 25432, 26379 and 3003 for review. Port 2287 is closed. About 22 GiB remains free. No existing application or database outside the isolated validation directory was changed. No push or PR was requested or created.
