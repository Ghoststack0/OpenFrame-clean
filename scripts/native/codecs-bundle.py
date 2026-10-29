#!/usr/bin/env python3
"""Build, verify and relocate the native x86-64 codec distribution."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
RECIPE = Path('server/test/benchmarks/native-ubuntu/codecs')
VERSION = '1'
# These are supplied by every supported glibc host. Never bundle a second libc.
BASE = re.compile(r'^(?:ld-linux-x86-64\.so\.2|lib(?:c|m|dl|rt|pthread|resolv|util)\.so\.[0-9]+|libstdc\+\+\.so\.6|libgcc_s\.so\.1)$')
# Root-owned on every host, so a path relocation misses can never be planted by another user.
PLACEHOLDER = '/opt/openframe-codecs-' + 'p' * 220


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def recipe_key(repo=ROOT):
    paths = [RECIPE / name for name in ('manifest.json', 'build.sh', 'jobs.sh', 'prepare.py')]
    # manifest.json pins the downloaded patch and policy contents by SHA256.
    digest = hashlib.sha256(('codecs-bundle-' + VERSION + '\0').encode())
    digest.update(Path(__file__).read_bytes())
    for path in sorted(set(paths)):
        digest.update(str(path).encode() + b'\0' + (repo / path).read_bytes() + b'\0')
    return digest.hexdigest()


def relocate_bytes(data, old, new):
    if len(new) > len(old):
        raise ValueError('Codec target path is longer than the build placeholder')
    if b'\0' not in data:
        return data.replace(old, new)
    # Preserve offsets of subsequent C strings, including ELF string-table entries.
    return b'\0'.join(part.replace(old, new).ljust(len(part), b'\0')
                       if old in part else part for part in data.split(b'\0'))


def relocate(root, target):
    meta = json.loads((root / 'bundle.json').read_text())
    old, new = meta['prefix'].encode(), os.fsencode(target)
    if len(new) > len(old):
        raise ValueError('Codec target path is longer than the build placeholder')
    for path in root.rglob('*'):
        if path.is_symlink():
            link = os.readlink(path)
            if meta['prefix'] in link:
                path.unlink()
                path.symlink_to(link.replace(meta['prefix'], str(target)))
        elif path.is_file() and path.name != 'bundle.json':
            data = path.read_bytes()
            if old in data:
                path.write_bytes(relocate_bytes(data, old, new))
    meta['prefix'] = str(target)
    (root / 'bundle.json').write_text(json.dumps(meta) + '\n')


def needed(path):
    with path.open('rb') as stream:
        if stream.read(4) != b'\x7fELF':
            return []
    output = subprocess.check_output(['readelf', '-d', str(path)], text=True)
    return re.findall(r'\(NEEDED\).*?\[(.*?)\]', output)


def closure(root, copy_from=None):
    """Resolve under exactly the two LD_LIBRARY_PATH entries used by OpenFrame."""
    dirs = [root / 'prefix/lib', root / 'sysroot/usr/lib/x86_64-linux-gnu']
    sources = [] if copy_from is None else [copy_from / 'sysroot/usr/lib/x86_64-linux-gnu',
        Path('/usr/lib/x86_64-linux-gnu'), Path('/lib/x86_64-linux-gnu')]
    checked = set()
    copied = {}
    while True:
        files = [p for p in root.rglob('*') if p.is_file() and not p.is_symlink() and p not in checked]
        if not files:
            break
        for path in files:
            checked.add(path)
            for name in needed(path):
                if '/' in name:
                    raise ValueError(f'Absolute DT_NEEDED in {path}: {name}')
                if BASE.fullmatch(name) or any((d / name).is_file() for d in dirs):
                    continue
                source = next((d / name for d in sources if (d / name).is_file()), None)
                if source is None:
                    raise ValueError(f'Unresolved dependency: {path}: {name}')
                dirs[1].mkdir(parents=True, exist_ok=True)
                shutil.copy2(source.resolve(), dirs[1] / name)
                copied[source.resolve()] = name
    # Preserve development linker aliases needed by the locally compiled Sharp addon.
    if copy_from is not None:
        for alias in (copy_from / 'sysroot/usr/lib/x86_64-linux-gnu').glob('*.so'):
            name = copied.get(alias.resolve())
            if name and not (dirs[1] / alias.name).exists():
                (dirs[1] / alias.name).symlink_to(name)
    print(f'Dependency closure passed: {len(checked)} files; only glibc, libstdc++, libgcc_s external')


def runtime_env(root):
    return dict(os.environ, LD_LIBRARY_PATH=f'{root}/prefix/lib:{root}/sysroot/usr/lib/x86_64-linux-gnu',
                MAGICK_CONFIGURE_PATH=f'{root}/prefix/etc/ImageMagick-7')


def smoke(root):
    env = runtime_env(root)
    with tempfile.TemporaryDirectory() as directory:
        image = Path(directory) / 'pixel.ppm'
        image.write_bytes(b'P6\n1 1\n255\n\xff\0\x80')
        png = Path(directory) / 'pixel.png'
        subprocess.run([str(root / 'prefix/bin/vips'), 'copy', str(image), str(png)], env=env, check=True)
        subprocess.run([str(root / 'prefix/bin/vips'), 'avg', str(png)], env=env, check=True)


def pack(source, archive):
    if (source / 'system-libs').exists():
        raise ValueError('Portable bundles must be built in Ubuntu sysroot mode')
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        shutil.copytree(source / 'prefix', stage / 'prefix', symlinks=True)
        # Sharp needs these relocated pkg-config files and transitive headers locally.
        for name in ('include', 'lib/x86_64-linux-gnu/pkgconfig', 'share/pkgconfig', 'lib/x86_64-linux-gnu/glib-2.0/include'):
            origin = source / 'sysroot/usr' / name
            if origin.exists():
                shutil.copytree(origin, stage / 'sysroot/usr' / name, symlinks=True)
        closure(stage, source)
        for path in stage.rglob('*'):
            if path.is_symlink() and os.path.isabs(os.readlink(path)):
                resolved = path.resolve()
                if resolved.is_relative_to(source):
                    path.unlink()
                    path.symlink_to(os.path.relpath(stage / resolved.relative_to(source), path.parent))
                else:
                    raise ValueError(f'External bundle symlink: {path}')
        (stage / 'bundle.json').write_text(json.dumps(dict(prefix=str(source), recipe_key=recipe_key(), glibc='2.39')) + '\n')
        with tarfile.open(archive, 'w:gz') as tar:
            for path in sorted(stage.iterdir()):
                tar.add(path, arcname=path.name)
    entry = dict(recipe_key=recipe_key(), url='REPLACE_WITH_RELEASE_ASSET_URL',
                 sha256=sha256(archive), size=archive.stat().st_size)
    print(json.dumps(entry, indent=2))
    Path(str(archive) + '.json').write_text(json.dumps(entry, indent=2) + '\n')
    Path(str(archive) + '.sha256').write_text(entry['sha256'] + '  ' + archive.name + '\n')


def select_entry(metadata):
    entry = json.loads(metadata.read_text())
    if not entry or entry.get('recipe_key') != recipe_key():
        raise ValueError('No pinned bundle matches this codec recipe')
    libc, version = platform.libc_ver()
    if platform.machine() != 'x86_64' or libc != 'glibc' or tuple(map(int, version.split('.'))) < (2, 39):
        raise ValueError('Prebuilt codecs require x86_64 and glibc >= 2.39')
    if not re.fullmatch('[0-9a-f]{64}', entry['sha256']) or not isinstance(entry['size'], int) or entry['size'] <= 0:
        raise ValueError('Invalid pinned codec digest or size')
    return entry


def install(target, metadata, cache):
    entry = select_entry(metadata)
    if not entry['url'].startswith('https://') and not (os.environ.get('OPENFRAME_CODECS_PREBUILT_JSON') and entry['url'].startswith('http://127.0.0.1:')):
        raise ValueError('Codec asset URL must use HTTPS (loopback HTTP allowed with test metadata override)')
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / (entry['sha256'] + '.tar.gz')
    # Hash before reuse, including after an interrupted previous download.
    if archive.exists() and archive.stat().st_size > entry['size']:
        archive.unlink()
    if not archive.exists() or archive.stat().st_size != entry['size']:
        command = ['curl', '--fail', '--location', '--retry', '3', '--retry-delay', '2',
                   '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '60',
                   '--continue-at', '-', '--progress-bar', entry['url'], '-o', str(archive)]
        with subprocess.Popen(command) as download:
            while True:
                try:
                    result = download.wait(timeout=0.5)
                    break
                except subprocess.TimeoutExpired:
                    progress = os.environ.get('OPENFRAME_CODECS_PROGRESS')
                    if progress:
                        detail = Path(progress)
                        temporary = detail.with_name(detail.name + f'.{os.getpid()}.tmp')
                        size = archive.stat().st_size if archive.exists() else 0
                        temporary.write_text(f'Downloading codec bundle: {size * 100 // entry["size"]}%\n')
                        temporary.replace(detail)
            if result:
                raise subprocess.CalledProcessError(result, command)
    if archive.stat().st_size != entry['size'] or sha256(archive) != entry['sha256']:
        archive.unlink()
        raise ValueError('Pinned codec bundle SHA256 or size mismatch')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.codecs-', dir=target.parent) as directory:
        stage = Path(directory) / 'root'
        stage.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(stage, filter='data')
        meta = json.loads((stage / 'bundle.json').read_text())
        if meta['recipe_key'] != entry['recipe_key'] or meta['glibc'] != '2.39':
            raise ValueError('Bundle metadata does not match the pinned recipe')
        relocate(stage, target)
        for name in ('vips', 'heif', 'de265', 'jxl', 'raw', 'jpeg', 'tiff', 'hwy'):
            if not (stage / f'prefix/lib/lib{name}.so').is_file():
                raise ValueError(f'Bundle is missing lib{name}')
        if not (stage / 'prefix/etc/ImageMagick-7/policy.xml').is_file():
            raise ValueError('Bundle is missing ImageMagick policy')
        # Validate before publication. Compiled paths point at target, so use env for plugins.
        smoke(stage)
        # Preserve an existing source build for rollback, including system-libs mode.
        backup = Path(directory) / 'previous'
        if target.exists():
            target.rename(backup)
        try:
            stage.rename(target)
            smoke(target)
        except BaseException:
            if target.exists():
                shutil.rmtree(target)
            if backup.exists():
                backup.rename(target)
            raise
    print('Verified prebuilt codec bundle installed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['key', 'placeholder', 'pack', 'relocate', 'check', 'smoke', 'install'])
    parser.add_argument('paths', nargs='*', type=Path)
    args = parser.parse_args()
    if args.command == 'key': print(recipe_key())
    elif args.command == 'placeholder': print(PLACEHOLDER)
    elif args.command == 'pack': pack(*args.paths)
    elif args.command == 'relocate': relocate(*args.paths)
    elif args.command == 'check': closure(*args.paths)
    elif args.command == 'smoke': smoke(*args.paths)
    else: install(*args.paths)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError, tarfile.TarError) as error:
        print(f'Prebuilt codecs unavailable: {error}', file=sys.stderr)
        sys.exit(1)
