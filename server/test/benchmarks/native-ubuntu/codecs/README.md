# Ubuntu source codecs

The native CLI reuses these recipes to build its codec installation. The default is `${XDG_DATA_HOME:-$HOME/.local/share}/openframe/codecs`; `OPENFRAME_CODECS` selects another absolute directory. Run `scripts/native/openframe build`, then `scripts/native/openframe codecs`. See the [native installation guide](../../../../../scripts/native/README.md) for prerequisites and runtime commands.

The supported build host is Ubuntu 24.04 x86-64 with Python 3.12+, apt-get, dpkg-deb, a C/C++ compiler, make, CMake, Git, autoconf, automake, libtool and flock. No sudo or system package installation is used. Stop the backend before building or rebuilding codecs. Keep the codec directory and checkout at their build paths.

`prepare.py` downloads exact Ubuntu package versions and extracts them under the codec directory. Missing archived package versions cause failure rather than substitution. The manifest pins source archives, upstream patches, the ImageMagick policy and Ubuntu packages by SHA256. Source revisions follow the cached Docker reference's build lock. The TIFF source retains every patch in the pinned Ubuntu Debian archive and links against jpegli, avoiding a second JPEG decoder through Ubuntu's ABI 8 TIFF library. Dedicated SVG and JPEG XL loaders are required by the libvips build. JPEG XL uses its original skcms backend with the submodule revision pinned by the upstream source tree. ImageMagick retains the upstream security policy, including disabled external delegates and dangerous coders.

`sharp.sh` copies the checkout's existing Sharp source package and reuses its installed build dependencies to build `sharp-native`. Node 24, node-gyp 13.1.0 and node-addon-api 8.9.2 must be available in the pinned dependency installation. Runtime JavaScript dependencies link to the original package's pinned dependencies, with an assert-based resolution check. The script does not change the checkout's Sharp dependency link. Doctor, start and admin select the separate package through `scripts/native/codecs.cjs`, with library and policy paths inherited by children and workers. Missing codec installations fail startup instead of falling back to bundled Sharp.

Preparation, builds and validation share an exclusive lock. A second operation fails before changing the codec installation. These locks prevent overlapping build operations; they do not stop a running application. Source trees, archives, compiler logs and libraries remain available for inspection. A fresh-machine build and an existing-library migration are separate checks; the recorded Ubuntu run reused its source and dependency caches.

## Reproduce the isolated Ubuntu validation

The historical direct-script defaults still target `~/openframe-native-validation-20261026/codec-build`. They do not initialize application services or replace an existing installation. Copy the current scripts and manifest to that directory. The private deployment configuration, fixtures, PostgreSQL, Redis and ML must already exist as described in the [validation record](../../NATIVE-UBUNTU-VALIDATION.md). Keep its API stopped before a check.

```sh
python3 prepare.py
bash build.sh > ../logs/codec-build.log 2>&1
bash sharp.sh > ../logs/codec-sharp.log 2>&1
python3 prepare.py --verify
bash check.sh > ../logs/codec-runtime-check.log 2>&1
```

`check.sh` selects codecs through the production preload. It checks policy enforcement, actual repository previews, doctor and normal API/worker HTTP/ML behavior, then confirms the original Sharp dependency link is unchanged. Its smoke runner stops its own process group. Single-run timings establish no speed gain. The broader fixtures include two JPEG XL files from the pinned upstream test-assets commit and the checkout's SVG icon. Fixture hashes appear in the result files.

`pairs.sh` retains the earlier disposable symlink-based comparison procedure and original three-pair runner for reproducing historical measurements. It is not the installation procedure. Preserve existing outputs before repeating a check or comparison. Analyze `logs/native-http-source-pairs.jsonl` with `native-ubuntu/analyze.py`.

For a decoder mismatch, copy `pixels.mjs` to `app/server/codec-diagnostic.mjs`, whose imports are relative to that deployed server directory. Run it with `INPUT OUTPUT_DIRECTORY` under each codec stack. It writes initial decoded pixels, repository output pixels and decoded JPEG pixels. Compare directories with `python3 compare-pixels.py DOCKER_DIRECTORY NATIVE_DIRECTORY OUTPUT.json`. The metric reports a difference and does not approve a quality tradeoff.

`loader-probe.c` uses `dlopen` to identify the selected buffer loader without requiring libvips headers. Compile with `gcc -Wall -Wextra -Werror loader-probe.c -ldl -o loader-probe`, then run `./loader-probe LIBVIPS_SO INPUT`. `raw-probe.c` isolates LibRaw with the ImageMagick parameters used for this fixture. Compile against the installed LibRaw headers and library, then run `./raw-probe INPUT OUTPUT.rgb16`. Set the stack's library search path for both probes. Their measured outputs and the TIFF diagnosis are in the validation record.
