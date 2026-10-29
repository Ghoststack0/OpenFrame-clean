"""Fetch/verify the pinned inputs for this disposable Ubuntu codec experiment."""

from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import http.client
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

if platform.machine() != "x86_64":
    raise SystemExit("Only the recorded Ubuntu x86-64 build is supported")
root = Path(os.environ.get("OPENFRAME_CODECS", Path.home() / "openframe-native-validation-20261026/codec-build"))
manifest = json.loads(Path(__file__).with_name("manifest.json").read_text())
arguments = set(sys.argv[1:])
if arguments - {"--verify", "--system-libs"}:
    raise SystemExit("Usage: prepare.py [--verify] [--system-libs]")
verify_only = "--verify" in arguments
system_libs = "--system-libs" in arguments


if not verify_only:
    root.mkdir(parents=True, exist_ok=True)
    lock = (root / "build.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another native codec operation is running")


def verify(path, expected):
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
            raise ValueError(f"SHA256 mismatch: {path}")


def fetch(url, path, expected):
    if not path.exists() and not verify_only:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".part")
        # GitHub generates source archives on the fly and sometimes drops them
        # mid-transfer, occasionally as a clean but early end of file, so a
        # checksum mismatch is retried too. The timeout stops a stalled connection.
        for attempt in range(5):
            try:
                with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as stream:
                    shutil.copyfileobj(response, stream, 1 << 20)
                verify(temporary, expected)
                break
            except (OSError, ValueError, http.client.HTTPException) as error:
                code = getattr(error, "code", None)
                permanent = code is not None and 400 <= code < 500 and code != 429
                if permanent or attempt == 4:
                    raise
                print(f"Retrying {path.name} after: {error}", file=sys.stderr)
                time.sleep(2 ** attempt)
        temporary.replace(path)
    verify(path, expected)


# Arch supplies development libraries through pacman, not Ubuntu .deb archives.
if system_libs:
    if (root / "sysroot").exists():
        raise SystemExit("Use a new codec directory when switching from Ubuntu to system libraries")
    if not verify_only:
        (root / "system-libs").touch()
elif (root / "system-libs").exists():
    raise SystemExit("This codec directory requires --system-libs")

packages = root / "packages"
packages.mkdir(parents=True, exist_ok=True)
missing = [
    f"{p['package']}={p['version']}"
    for p in ([] if system_libs else manifest["ubuntuPackages"])
    if not (packages / p["file"]).exists()
]
if missing and not verify_only:
    subprocess.run(["apt-get", "download", *missing], cwd=packages, check=True)
sysroot_missing = not (root / "sysroot").is_dir()
for package in ([] if system_libs else manifest["ubuntuPackages"]):
    path = packages / package["file"]
    verify(path, package["sha256"])
    extracted = path.with_suffix(path.suffix + ".extracted")
    if not verify_only and (sysroot_missing or not extracted.exists()
                            or extracted.read_text() != package["sha256"]):
        extracted.unlink(missing_ok=True)
        subprocess.run(["dpkg-deb", "-x", path, root / "sysroot"], check=True)
        extracted.write_text(package["sha256"])

# Reject incomplete development packages before compiling any native library.
if not system_libs:
    dangling = sorted(str(p.relative_to(root / "sysroot"))
                      for p in (root / "sysroot").rglob("*.so")
                      if p.is_symlink() and not p.exists())
    if dangling:
        raise SystemExit("Missing shared runtime targets in sysroot:\n" + "\n".join(dangling))

base = f"https://raw.githubusercontent.com/immich-app/base-images/{manifest['baseImagesCommit']}/server/sources/"
downloads = [(s["url"], root / "sources" / s["archive"], s["sha256"]) for s in manifest["sources"]]
downloads += [(base + p["path"], root / p["path"], p["sha256"]) for p in manifest["patches"]]
downloads += [(e["url"], root / e["path"], e["sha256"]) for e in manifest.get("extraFiles", [])]
with ThreadPoolExecutor(max_workers=8) as pool:
    futures = [pool.submit(fetch, *download) for download in downloads]
    for future in futures:
        future.result()

for source in manifest["sources"]:
    archive = root / "sources" / source["archive"]
    destination = {
        "libde265": "libde265-1.1.3",
        "libjpeg-turbo": "jpegli/third_party/libjpeg-turbo",
        "highway": "jpegli/third_party/highway",
        "skcms": "libjxl/third_party/skcms",
    }.get(source["name"], source["name"])
    target = root / "sources" / destination
    extracted = target / ".openframe-source-sha256"
    if not verify_only and (not extracted.exists() or extracted.read_text() != source["sha256"]):
        target.parent.mkdir(parents=True, exist_ok=True)
        # Publish only complete trees so an interrupted extraction can be resumed.
        with tempfile.TemporaryDirectory(prefix=".extract-", dir=target.parent) as temporary:
            staged = Path(temporary) / "source"
            staged.mkdir()
            with tarfile.open(archive) as stream:
                for member in stream.getmembers():
                    member.name = "/".join(member.name.split("/")[1:])
                    if member.name:
                        stream.extract(member, staged, filter="data")
            (staged / extracted.name).write_text(source["sha256"])
            if target.exists():
                shutil.rmtree(target)
            staged.replace(target)

if not verify_only:
    for path in (root / "sysroot").rglob("*.pc"):
        text = path.read_text()
        if str(root) not in text:
            path.write_text(text.replace("/usr", str(root / "sysroot/usr")))
print("All pinned codec source and patch checksums passed." if system_libs else "All pinned codec source, patch and Ubuntu package checksums passed.")
