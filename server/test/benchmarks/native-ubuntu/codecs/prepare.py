"""Fetch/verify the pinned inputs for this disposable Ubuntu codec experiment."""

import fcntl
import hashlib
import json
import os
import platform
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

if platform.machine() != "x86_64":
    raise SystemExit("Only the recorded Ubuntu x86-64 build is supported")
root = Path(os.environ.get("OPENFRAME_CODECS", Path.home() / "openframe-native-validation-20261026/codec-build"))
manifest = json.loads(Path(__file__).with_name("manifest.json").read_text())
verify_only = sys.argv[1:] == ["--verify"]
if sys.argv[1:] and not verify_only:
    raise SystemExit("Usage: prepare.py [--verify]")


if not verify_only:
    root.mkdir(parents=True, exist_ok=True)
    lock = (root / "build.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another native codec operation is running")


def verify(path, expected):
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError(f"SHA256 mismatch: {path}")


def fetch(url, path, expected):
    if not path.exists() and not verify_only:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".part")
        urllib.request.urlretrieve(url, temporary)
        verify(temporary, expected)
        temporary.replace(path)
    verify(path, expected)


packages = root / "packages"
packages.mkdir(parents=True, exist_ok=True)
missing = [
    f"{p['package']}={p['version']}"
    for p in manifest["ubuntuPackages"]
    if not (packages / p["file"]).exists()
]
if missing and not verify_only:
    subprocess.run(["apt-get", "download", *missing], cwd=packages, check=True)
for package in manifest["ubuntuPackages"]:
    path = packages / package["file"]
    verify(path, package["sha256"])
    if not verify_only:
        subprocess.run(["dpkg-deb", "-x", path, root / "sysroot"], check=True)

for source in manifest["sources"]:
    archive = root / "sources" / source["archive"]
    fetch(source["url"], archive, source["sha256"])
    destination = {
        "libde265": "libde265-1.1.3",
        "libjpeg-turbo": "jpegli/third_party/libjpeg-turbo",
        "highway": "jpegli/third_party/highway",
        "skcms": "libjxl/third_party/skcms",
    }.get(source["name"], source["name"])
    target = root / "sources" / destination
    if not verify_only and not any(target.glob("*")):
        target.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive) as stream:
            for member in stream.getmembers():
                member.name = "/".join(member.name.split("/")[1:])
                if member.name:
                    stream.extract(member, target, filter="data")

base = f"https://raw.githubusercontent.com/immich-app/base-images/{manifest['baseImagesCommit']}/server/sources/"
for patch in manifest["patches"]:
    fetch(base + patch["path"], root / patch["path"], patch["sha256"])
for extra in manifest.get("extraFiles", []):
    fetch(extra["url"], root / extra["path"], extra["sha256"])
if not verify_only:
    for path in (root / "sysroot").rglob("*.pc"):
        text = path.read_text()
        if str(root) not in text:
            path.write_text(text.replace("/usr", str(root / "sysroot/usr")))
print("All pinned codec source, patch and Ubuntu package checksums passed.")
