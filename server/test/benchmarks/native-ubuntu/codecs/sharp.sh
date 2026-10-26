#!/usr/bin/env bash
set -euo pipefail
cd "${OPENFRAME_SOURCE:-$HOME/openframe-native-validation-20261026}"
app="${OPENFRAME_SOURCE:-$PWD/app}"
root="${OPENFRAME_CODECS:-$PWD/codec-build}"
exec 9>"$root/build.lock"
flock -n 9 || { echo 'Another native codec operation is running' >&2; exit 1; }
export PATH="$PWD/local/node-v24.13.1-linux-x64/bin:$root/sysroot/usr/bin:$PATH"
export LD_LIBRARY_PATH="$root/prefix/lib:$root/sysroot/usr/lib/x86_64-linux-gnu"
export PKG_CONFIG_PATH="$root/prefix/lib/pkgconfig:$root/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$root/sysroot/usr/share/pkgconfig"
export SHARP_FORCE_GLOBAL_LIBVIPS=1
export npm_config_devdir="$root/node-gyp"
export XDG_CACHE_HOME="$root/cache"
export NODE_PATH="$app/node_modules/.pnpm/node-gyp@13.1.0/node_modules:$app/node_modules/.pnpm/node-addon-api@8.9.2/node_modules"
mkdir -p "$root/bin"
ln -sfn "$app/node_modules/.pnpm/node-gyp@13.1.0/node_modules/node-gyp/bin/node-gyp.js" "$root/bin/node-gyp"
export PATH="$root/bin:$PATH"
original=$(readlink -f "$app/server/node_modules/sharp")
if [[ ! -d "$root/sharp-native" ]]; then
 mkdir "$root/sharp-native"
 cp -a "$original"/. "$root/sharp-native/"
fi
rm -rf -- "$root/sharp-native/node_modules"
mkdir -p "$root/sharp-native/node_modules"
# pnpm keeps runtime dependencies beside the original package, not inside it.
node - "$original" "$root/sharp-native" <<'JS'
const assert = require('node:assert/strict');
const { mkdirSync, symlinkSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const [original, target] = process.argv.slice(2);
const source = createRequire(join(original, 'package.json'));
const native = createRequire(join(target, 'package.json'));
for (const name of Object.keys(source('./package.json').dependencies)) {
  const link = join(target, 'node_modules', name);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(dirname(source.resolve(`${name}/package.json`)), link);
  assert.equal(native.resolve(name), source.resolve(name));
}
JS
ln -sfn "$app/node_modules/.pnpm/node-addon-api@8.9.2/node_modules/node-addon-api" "$root/sharp-native/node_modules/node-addon-api"
cd "$root/sharp-native"
node install/build.js
