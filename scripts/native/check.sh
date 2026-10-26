#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
export OPENFRAME_CONFIG="$tmp/config/env" OPENFRAME_STATE="$tmp/state" OPENFRAME_CODECS="$tmp/codecs"
mkdir -p "$OPENFRAME_CODECS/sharp-native" "$OPENFRAME_CODECS/prefix/etc/ImageMagick-7"
printf '{"main":"index.cjs"}\n' > "$OPENFRAME_CODECS/sharp-native/package.json"
touch "$OPENFRAME_CODECS/prefix/etc/ImageMagick-7/policy.xml"
mkdir -p "$tmp/repo/scripts/native" "$tmp/repo/server/bin" "$tmp/repo/server/dist"
cp "$root/scripts/native/openframe" "$tmp/repo/scripts/native/"
cp "$root/server/bin/start.sh" "$root/server/bin/get-cpus.sh" "$tmp/repo/server/bin/"
touch "$tmp/repo/server/dist/main.js"
cli="$tmp/repo/scripts/native/openframe"
bash -n "$cli"
"$cli" --help >/dev/null
if "$cli" doctor >/dev/null 2>&1; then echo 'doctor accepted missing config' >&2; exit 1; fi
"$cli" init >/dev/null
[[ -f "$OPENFRAME_CONFIG" && -d "$OPENFRAME_STATE/media" ]]
[[ "$(stat -c %a "$OPENFRAME_CONFIG")" == 600 ]]
cp "$OPENFRAME_CONFIG" "$tmp/original"
if "$cli" init >/dev/null 2>&1; then echo 'init overwrote configuration' >&2; exit 1; fi
cmp "$OPENFRAME_CONFIG" "$tmp/original"
if "$cli" invalid >/dev/null 2>&1; then echo 'unknown command accepted' >&2; exit 1; fi
mkdir "$tmp/bin"
cat > "$tmp/bin/node" <<'MOCK'
#!/bin/sh
printf '%s\n' "$PWD" "$@" "$IMMICH_MEDIA_LOCATION" "$IMMICH_BUILD_DATA" "$DB_HOSTNAME" "$REDIS_HOSTNAME" > "$OPENFRAME_STATE/invocation"
MOCK
printf '#!/bin/sh\nuname -m\n' > "$tmp/bin/arch"
chmod +x "$tmp/bin/node" "$tmp/bin/arch"
PATH="$tmp/bin:$PATH" "$cli" admin version >/dev/null
grep -Fx "$tmp/repo/server/dist/main.js" "$OPENFRAME_STATE/invocation" >/dev/null
grep -Fx immich-admin "$OPENFRAME_STATE/invocation" >/dev/null
grep -Fx version "$OPENFRAME_STATE/invocation" >/dev/null
grep -Fx "$OPENFRAME_STATE/media" "$OPENFRAME_STATE/invocation" >/dev/null
grep -Fx 127.0.0.1 "$OPENFRAME_STATE/invocation" >/dev/null
printf 'file-secret' > "$tmp/password"
printf '\nDB_PASSWORD_FILE=%q\n' "$tmp/password" >> "$OPENFRAME_CONFIG"
cat > "$tmp/bin/node" <<'MOCK'
#!/usr/bin/env bash
[[ "$DB_PASSWORD" == file-secret && -z "${DB_PASSWORD_FILE:-}" ]]
MOCK
PATH="$tmp/bin:$PATH" "$cli" admin version >/dev/null
echo 'Native CLI self-check passed.'
# Exercise the real Node loader for ESM, CommonJS and inherited worker startup.
printf 'module.exports = { nativeCodecCheck: true };\n' > "$tmp/codecs/sharp-native/index.cjs"
OPENFRAME_CODECS="$tmp/codecs" NODE_OPTIONS="--require $root/scripts/native/codecs.cjs" node <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
assert.equal(sharp.nativeCodecCheck, true);
assert.equal(createRequire(import.meta.url)('sharp'), sharp);
assert.throws(() => createRequire(import.meta.url)('@img/sharp-linux-x64/sharp.node'), /bundled fallback is disabled/);
const worker = new Worker(new URL("data:text/javascript,import { parentPort } from 'node:worker_threads'; import sharp from 'sharp'; parentPort.postMessage(sharp.nativeCodecCheck)"));
assert.deepEqual(await once(worker, 'message'), [true]);
const commonjsWorker = new Worker("require('node:worker_threads').parentPort.postMessage(require('sharp').nativeCodecCheck)", { eval: true });
assert.deepEqual(await once(commonjsWorker, 'message'), [true]);
JS
printf '\nOPENFRAME_CODECS=%q\n' "$tmp/codecs" >> "$OPENFRAME_CONFIG"
cp "$root/scripts/native/codecs.cjs" "$tmp/repo/scripts/native/"
cat > "$tmp/bin/node" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == -p ]]; then exec "$REAL_NODE" "$@"; fi
[[ "$LD_LIBRARY_PATH" == "$OPENFRAME_CODECS/prefix/lib:"* ]]
[[ "$MAGICK_CONFIGURE_PATH" == "$OPENFRAME_CODECS/prefix/etc/ImageMagick-7" ]]
[[ "$NODE_OPTIONS" == *--require*codecs.cjs* ]]
MOCK
REAL_NODE="$(command -v node)" PATH="$tmp/bin:$PATH" "$cli" admin version >/dev/null
rm "$tmp/codecs/sharp-native/package.json"
if REAL_NODE="$(command -v node)" PATH="$tmp/bin:$PATH" "$cli" admin version >/dev/null 2>&1; then
  echo 'admin accepted missing selected codecs' >&2; exit 1
fi
echo 'Native codec selection self-check passed.'
# Check the default build location without downloading or compiling dependencies.
sed -i '/^OPENFRAME_CODECS=/d' "$OPENFRAME_CONFIG"
cat > "$tmp/bin/python3" <<'MOCK'
#!/bin/bash
[[ "$OPENFRAME_CODECS" == "$XDG_DATA_HOME/openframe/codecs" && "$OPENFRAME_SOURCE" == "$EXPECTED_SOURCE" ]]
printf '%s\n' "$1" >> "$OPENFRAME_STATE/codec-build-steps"
MOCK
cp "$tmp/bin/python3" "$tmp/bin/bash"
cat > "$tmp/bin/node" <<'MOCK'
#!/bin/sh
exec "$REAL_NODE" "$@"
MOCK
chmod +x "$tmp/bin/python3" "$tmp/bin/bash"
env -u OPENFRAME_CODECS REAL_NODE="$(command -v node)" XDG_DATA_HOME="$tmp/xdg-data" EXPECTED_SOURCE="$tmp/repo" PATH="$tmp/bin:$PATH" /bin/bash "$cli" codecs >/dev/null
[[ "$(wc -l < "$OPENFRAME_STATE/codec-build-steps")" == 3 ]]
echo 'Native codec build dispatch and XDG default self-check passed.'
