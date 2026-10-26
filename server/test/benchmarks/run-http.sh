#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
# Use the directory prepared for the microbenchmark so upstream-release.json and host.json already exist.
test -f upstream-release.json
test -f host.json
docker image inspect immich-perf:local --format '{{.Id}}' > candidate-base-image.txt
docker build --network none --pull=false \
  --build-arg SOURCE_REVISION="$(python3 -c 'import json; print(json.load(open("candidate-build.json"))["head"] + "-working-tree")')" \
  --build-arg SOURCE_SHA256="$(python3 -c 'import json; print(json.load(open("candidate-build.json"))["sourceTreeSha256"])')" \
  -f http-candidate.Dockerfile -t openframe-bench:20261026 .
python3 http-upload.py "$@"
if [[ ${1:-} == --controlled ]]; then
  python3 analyze-http.py http-upload-controlled.json
fi

if [[ ${1:-} == --media-ready ]]; then
  python3 analyze-media-ready.py http-upload-media-ready.json
fi
