#!/usr/bin/env bash
set -euo pipefail
# Run on the Linux box from a disposable directory containing the prepared candidate.
cd -- "$(dirname -- "$0")"
image=ghcr.io/immich-app/immich-server:v3.3.5
curl --fail --silent --show-error --location https://api.github.com/repos/immich-app/immich/releases/latest -o upstream-release-full.json
curl --fail --silent --show-error --location https://api.github.com/repos/immich-app/immich/git/ref/tags/v3.3.5 -o upstream-tag.json
python3 - <<'PY'
import json
from pathlib import Path
release = json.loads(Path('upstream-release-full.json').read_text())
tag = json.loads(Path('upstream-tag.json').read_text())
assert tag['object']['sha'] == '8303cb117e197c700332b33b61b45314c9cc5bb4' and tag['object']['type'] == 'commit'
release['commit'] = tag['object']['sha']
assert release['tag_name'] == 'v3.3.5' and not release['prerelease'], 'Latest stable changed; update the pinned baseline and methodology before running'
Path('upstream-release.json').write_text(json.dumps({k: release[k] for k in ('tag_name', 'published_at', 'html_url', 'prerelease', 'commit')}, indent=2) + '\n')
PY
docker image inspect "$image" > upstream-image-full.json
python3 - <<'PY'
import json, platform, subprocess
from pathlib import Path
image = json.loads(Path('upstream-image-full.json').read_text())[0]
labels = image['Config']['Labels']
assert labels['org.opencontainers.image.revision'] == '8303cb117e197c700332b33b61b45314c9cc5bb4'
Path('upstream-image.json').write_text(json.dumps({
 'image': 'ghcr.io/immich-app/immich-server:v3.3.5', 'imageId': image['Id'],
 'repoDigests': image['RepoDigests'], 'labels': labels,
}, indent=2) + '\n')
Path('host.json').write_text(json.dumps({
 'hostname': platform.node(), 'platform': platform.platform(),
 'cpu': subprocess.check_output(['lscpu'], text=True),
 'memory': subprocess.check_output(['free', '-b'], text=True),
 'storage': subprocess.check_output(['df', '-T', '.'], text=True),
 'docker': subprocess.check_output(['docker', 'version', '--format', '{{.Server.Version}}'], text=True).strip(),
}, indent=2) + '\n')
PY
image_id=$(python3 -c 'import json; print(json.load(open("upstream-image.json"))["imageId"])')
docker run --rm --user "$(id -u):$(id -g)" --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$PWD,dst=/bench" \
  --entrypoint node "$image_id" /bench/upload-check.mjs "$@"
