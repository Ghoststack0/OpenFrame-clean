#!/usr/bin/env bash
# Run as root in a disposable Ubuntu 24.04 container: the placeholder prefix lives
# under root-owned /opt. CI installs build tools separately.
set -euo pipefail
# shellcheck source=/dev/null
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo 'Build on Ubuntu 24.04 to enforce the glibc floor' >&2; exit 1; }
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
tool="$repo/scripts/native/codecs-bundle.py"
output="${1:?Usage: build-codecs-bundle.sh OUTPUT_DIRECTORY}"
mkdir -p "$output"
output="$(realpath "$output")"
work="$(mktemp -d)"
placeholder="$(python3 "$tool" placeholder)"
[[ ! -e "$placeholder" ]] || { echo "Build placeholder already exists: $placeholder" >&2; exit 1; }
trap 'rm -rf -- "$work" "$placeholder"' EXIT
export OPENFRAME_SOURCE="$repo"
recipe="$repo/server/test/benchmarks/native-ubuntu/codecs"
start=$SECONDS
export OPENFRAME_CODECS="$placeholder"
python3 "$recipe/prepare.py"
bash "$recipe/build.sh"
python3 "$tool" pack "$placeholder" "$output/codecs.tar.gz" > "$output/metadata.log"
printf 'CI placeholder build and pack: %s seconds\n' "$((SECONDS-start))" | tee "$output/timing.txt"
# Compare a separately built normal prefix against the relocated distribution.
export OPENFRAME_CODECS="$work/normal"
python3 "$recipe/prepare.py"
bash "$recipe/build.sh"
mkdir "$work/relocated"
tar -xzf "$output/codecs.tar.gz" -C "$work/relocated"
python3 "$tool" relocate "$work/relocated" "$work/relocated"
python3 "$tool" check "$work/relocated" | tee "$output/closure.txt"
# Remove the build prefix before tracing; successful opens must never depend on it.
rm -rf -- "$placeholder"
strace -f -e trace=openat -o "$output/openat.log" python3 "$repo/scripts/native/codec-parity.py" "$work/normal" "$work/relocated" "$output/parity" > "$output/parity.log"
if grep -F "$placeholder" "$output/openat.log"; then
  echo 'Runtime tried to access the build placeholder' >&2; exit 1
fi
cat "$output/codecs.tar.gz.json"
