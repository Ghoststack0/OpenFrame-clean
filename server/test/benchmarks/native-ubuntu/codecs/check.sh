#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/openframe-native-validation-20261026"
root="$PWD/codec-build"
exec 9>"$root/build.lock"
flock -n 9 || { echo 'Another native codec operation is running' >&2; exit 1; }
# run-env is generated on the benchmark host.
# shellcheck disable=SC1091
source ./run-env
export OPENFRAME_CODECS="$root"
export NODE_OPTIONS="--require $PWD/app/scripts/native/codecs.cjs"
export LD_LIBRARY_PATH="$root/prefix/lib:$root/sysroot/usr/lib/x86_64-linux-gnu"
export MAGICK_CONFIGURE_PATH="$root/prefix/etc/ImageMagick-7"
link="$PWD/app/server/node_modules/sharp"
[[ -L "$link" && -d "$root/sharp-native" ]]
original=$(readlink "$link")

node -e 'process.stdout.write(JSON.stringify(require("sharp").format, null, 2) + "\n")' > logs/codecs-runtime-formats.json
status=0
cmp -- "$root/policy.xml" "$root/prefix/etc/ImageMagick-7/policy.xml"
"$root/prefix/bin/magick" -list policy > logs/codec-runtime-policy-list.txt
grep -Fq "Path: $root/prefix/etc/ImageMagick-7/policy.xml" logs/codec-runtime-policy-list.txt
if "$root/prefix/bin/magick" label:OpenFrame null: > logs/codec-runtime-policy-denial.log 2>&1; then
 echo 'ImageMagick accepted a forbidden LABEL coder' >&2
 exit 1
fi
node app/server/test/benchmarks/native-codecs.mjs logs/codecs-runtime.json \
  samples/IMG_2682.heic samples/EOS_30D.CR2 samples/10bit-HDR-P3-nclx.avif samples/8bit-sRGB.jxl samples/16bit-HDR-P3-nclx.jxl samples/openframe-icon.svg || status=$?
app/scripts/native/openframe doctor || status=1
ldd "$root/prefix/lib/libvips.so" "$root/prefix/lib/vips-modules-8.18/"*.so > logs/codecs-runtime-libraries.txt
python3 "$root/smoke.py" || status=1
[[ "$(readlink "$link")" == "$original" ]] || status=1
exit "$status"
