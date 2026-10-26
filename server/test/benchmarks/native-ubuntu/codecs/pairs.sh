#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/openframe-native-validation-20261026"
root="$PWD/codec-build"
exec 9>"$root/build.lock"
flock -n 9 || { echo 'Another native codec operation is running' >&2; exit 1; }
source ./run-env
export LD_LIBRARY_PATH="$root/prefix/lib:$root/sysroot/usr/lib/x86_64-linux-gnu"
export MAGICK_CONFIGURE_PATH="$root/prefix/etc/ImageMagick-7"
link="$PWD/app/server/node_modules/sharp"
[[ -L "$link" && -d "$root/sharp-native" ]]
original=$(readlink "$link")
trap 'ln -sfn -- "$original" "$link"' EXIT
ln -sfn -- "$root/sharp-native" "$link"
sed -e 's@logs/server-@logs/server-source-@g' \
  -e 's@logs/http-@logs/http-source-@g' \
  -e 's@logs/native-http.jsonl@logs/native-http-source-pairs.jsonl@g' \
  run-pairs.py > "$root/run-source-pairs.py"
python3 "$root/run-source-pairs.py"
