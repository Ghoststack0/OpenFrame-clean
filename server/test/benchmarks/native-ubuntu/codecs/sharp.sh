#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=./jobs.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/jobs.sh"
npm_config_jobs="$(codec_build_jobs)"
export npm_config_jobs
if command -v ccache >/dev/null; then
  export CC="ccache ${CC:-cc}" CXX="ccache ${CXX:-c++}"
fi
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
# Refresh the source on lockfile upgrades; retaining an old Sharp copy is unsafe.
rm -rf -- "$root/sharp-native"
mkdir "$root/sharp-native"
cp -a "$original"/. "$root/sharp-native/"
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
version=$(node -p 'require("./package.json").version')
addon="src/build/Release/sharp-linux-x64-$version.node"
validate_addon() {
  node - "$PWD" "$root" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [dir, root] = process.argv.slice(2);
const sharp = require(dir);
assert.equal(sharp.versions.sharp, require(dir + '/package.json').version);
assert.equal(sharp.versions.vips, '8.18.7');
const maps = fs.readFileSync('/proc/self/maps', 'utf8');
assert(maps.split('\n').some(line => line.includes(root + '/prefix/lib/libvips.so.42')));
sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()
  .catch(error => { console.error(error); process.exitCode = 1; });
JS
}
if [[ -f "$root/sharp/sharp-linux-x64-$version.node" ]]; then
  mkdir -p src/build/Release
  cp "$root/sharp/sharp-linux-x64-$version.node" "$addon"
  if validate_addon; then
    echo "Using bundled Sharp $version addon"
    exit 0
  fi
  echo 'Bundled Sharp addon failed validation; compiling from source' >&2
  rm -f "$addon"
fi
node install/build.js
validate_addon
