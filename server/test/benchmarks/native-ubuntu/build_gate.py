"""Build actual upstream and candidate sources with the same pinned dependencies."""

import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path

UPSTREAM = "256eb55dbe92ac77e02794442f9487e88ffed2b1"
ARCHIVE_SHA256 = "705052bd70ab8e676c378653c049f8c88e67190cb515a9636f2510caec567474"


def tree_hash(directory):
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            digest.update(str(path.relative_to(directory)).encode() + b"\0")
            digest.update(path.read_bytes())
    return digest.hexdigest()


def dist_hash(directory):
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        if path.is_file() and path.name != "gate-build.json":
            digest.update(str(path.relative_to(directory)).encode() + b"\0")
            digest.update(path.read_bytes())
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New absolute build directory")
    parser.add_argument("--archive", type=Path, help="Reuse the checksum-pinned upstream archive")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[4]
    output = args.output.resolve()
    assert not output.exists(), "Build output must be a new directory"
    assert not subprocess.check_output(["git", "status", "--porcelain", "--", "server/src", "server/package.json", "pnpm-lock.yaml", "packages/plugin-sdk", "machine-learning"], cwd=repo), "Commit production source before recording a build"
    node = shutil.which("node")
    version = subprocess.check_output([node, "-p", "process.versions.node"], text=True).strip()
    assert version.startswith("24."), "Use Node 24"
    output.mkdir(parents=True)
    archive = args.archive or output / "upstream.tar.gz"
    if args.archive is None:
        urllib.request.urlretrieve(f"https://codeload.github.com/immich-app/immich/tar.gz/{UPSTREAM}", archive)
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == ARCHIVE_SHA256
    upstream = output / "upstream-source"
    with tarfile.open(archive) as stream:
        for member in stream.getmembers():
            member.name = "/".join(member.name.split("/")[1:])
            if member.name:
                stream.extract(member, upstream, filter="data")
    for path in ["pnpm-lock.yaml", "server/package.json", "server/helmet.json", "packages/plugin-sdk/package.json"]:
        assert (upstream / path).read_bytes() == (repo / path).read_bytes(), f"Dependency drift: {path}"
    for path in ["packages/plugin-sdk/src", "machine-learning/immich_ml"]:
        assert tree_hash(upstream / path) == tree_hash(repo / path), f"Shared runtime source differs from upstream: {path}"
    for name in ["package.json", "helmet.json"]:
        shutil.copy2(repo / "server" / name, output / name)
    candidate = output / "candidate-source/server"
    candidate.mkdir(parents=True)
    shutil.copytree(repo / "server/src", candidate / "src")
    for name in ["package.json", "tsconfig.json", "tsconfig.build.json", "nest-cli.json"]:
        shutil.copy2(repo / "server" / name, candidate / name)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    compiler = repo / "server/node_modules/@nestjs/cli/bin/nest.js"
    for name, source, revision in [("baseline", upstream / "server", UPSTREAM), ("candidate", candidate, commit)]:
        (source / "node_modules").symlink_to(repo / "server/node_modules", target_is_directory=True)
        with (output / f"build-{name}.log").open("wb") as log:
            subprocess.run([node, compiler, "build"], cwd=source, stdout=log, stderr=log, check=True)
        target = output / f"dist-{name}"
        shutil.copytree(source / "dist", target)
        manifest = {"version": 1, "variant": name, "sourceCommit": revision, "node": version, "sourceTreeSha256": tree_hash(source / "src"), "distSha256": dist_hash(target), "runtimePackageSha256": hashlib.sha256((output / "package.json").read_bytes()).hexdigest(), "runtimeHelmetSha256": hashlib.sha256((output / "helmet.json").read_bytes()).hexdigest(), "lockSha256": hashlib.sha256((repo / "pnpm-lock.yaml").read_bytes()).hexdigest(), "upstreamArchiveSha256": ARCHIVE_SHA256, "baselinePolicy": "Unmodified upstream server source, same locked dependencies, source codecs, native platform, normal workers and CPU ML. No optimization reverts or decoder-policy changes."}
        (target / "gate-build.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"Built {name}: {revision}", flush=True)


if __name__ == "__main__":
    main()
