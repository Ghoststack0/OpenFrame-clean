#!/usr/bin/env python3
"""Check system-library preparation with real archives, without network or apt."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CodecPrepareTest(unittest.TestCase):
    def test_system_libraries_skip_ubuntu_packages_and_verify_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            script = folder / 'prepare.py'
            script.write_text((ROOT / 'server/test/benchmarks/native-ubuntu/codecs/prepare.py').read_text())
            archive = folder / 'input.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                data = b'codec source\n'
                entry = tarfile.TarInfo('source/configure')
                entry.size = len(data)
                stream.addfile(entry, io.BytesIO(data))
            manifest = {
                'baseImagesCommit': 'unused',
                'ubuntuPackages': [{'package': 'must-not-download', 'version': '1',
                                    'file': 'missing.deb', 'sha256': 'invalid'}],
                'sources': [{'name': 'example', 'archive': 'source.tar.gz',
                             'url': archive.as_uri(),
                             'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}],
                'patches': [],
            }
            (folder / 'manifest.json').write_text(json.dumps(manifest))
            codecs = folder / 'codecs'
            env = dict(os.environ, OPENFRAME_CODECS=str(codecs))
            # Any accidental attempt to call apt or dpkg must fail.
            empty_path = folder / 'bin'
            empty_path.mkdir()
            env['PATH'] = str(empty_path)
            python = os.sys.executable
            result = subprocess.run([python, str(script), '--system-libs'],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((codecs / 'sources/example/configure').read_bytes(), data)
            self.assertTrue((codecs / 'system-libs').is_file())
            self.assertFalse((codecs / 'sysroot').exists())
            result = subprocess.run([python, str(script), '--system-libs', '--verify'],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            (codecs / 'sources/source.tar.gz').write_bytes(b'corrupted')
            result = subprocess.run([python, str(script), '--system-libs', '--verify'],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('SHA256 mismatch', result.stderr)


    def test_parallel_downloads_verify_before_extracting(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            script = folder / 'prepare.py'
            script.write_text((ROOT / 'server/test/benchmarks/native-ubuntu/codecs/prepare.py').read_text())
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w:gz') as stream:
                entry = tarfile.TarInfo('source/configure')
                entry.size = 6
                stream.addfile(entry, io.BytesIO(b'source'))
            payload = data.getvalue()
            barrier = threading.Barrier(4)

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_GET(self):
                    try:
                        barrier.wait(timeout=5)
                    except threading.BrokenBarrierError:
                        self.send_error(500, 'Downloads did not run concurrently')
                        return
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(payload)

            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                manifest = {
                    'baseImagesCommit': 'unused', 'ubuntuPackages': [], 'patches': [],
                    'sources': [
                        {'name': f'codec{i}', 'archive': f'codec{i}.tar.gz',
                         'url': f'http://127.0.0.1:{server.server_port}/{i}',
                         'sha256': hashlib.sha256(payload).hexdigest()}
                        for i in range(4)
                    ],
                }
                manifest_path = folder / 'manifest.json'
                manifest_path.write_text(json.dumps(manifest))
                codecs = folder / 'codecs'
                env = dict(os.environ, OPENFRAME_CODECS=str(codecs))
                result = subprocess.run([os.sys.executable, str(script), '--system-libs'],
                                        env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                for i in range(4):
                    self.assertEqual((codecs / f'sources/codec{i}/configure').read_bytes(), b'source')
                # Every archive is verified on a resume, even when sources exist.
                (codecs / 'sources/codec3.tar.gz').write_bytes(b'corrupted')
                result = subprocess.run([os.sys.executable, str(script), '--system-libs'],
                                        env=env, capture_output=True, text=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('SHA256 mismatch', result.stderr)
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_partial_source_extraction_is_replaced_and_complete_tree_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            script = folder / 'prepare.py'
            script.write_text((ROOT / 'server/test/benchmarks/native-ubuntu/codecs/prepare.py').read_text())
            archive = folder / 'input.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                entry = tarfile.TarInfo('source/configure')
                entry.size = 8
                stream.addfile(entry, io.BytesIO(b'complete'))
            manifest = {
                'baseImagesCommit': 'unused', 'ubuntuPackages': [], 'patches': [],
                'sources': [{'name': 'example', 'archive': 'source.tar.gz',
                             'url': archive.as_uri(),
                             'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}],
            }
            (folder / 'manifest.json').write_text(json.dumps(manifest))
            codecs = folder / 'codecs'
            target = codecs / 'sources/example'
            target.mkdir(parents=True)
            (target / 'configure').write_bytes(b'partial')
            env = dict(os.environ, OPENFRAME_CODECS=str(codecs))
            command = [os.sys.executable, str(script), '--system-libs']
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((target / 'configure').read_bytes(), b'complete')
            (target / 'compiled-output').touch()
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((target / 'compiled-output').exists())
            self.assertFalse(list(target.parent.glob('.extract-*')))

    def test_ubuntu_packages_are_verified_but_not_reextracted_on_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            script = folder / 'prepare.py'
            script.write_text((ROOT / 'server/test/benchmarks/native-ubuntu/codecs/prepare.py').read_text())
            codecs = folder / 'codecs'
            packages = codecs / 'packages'
            packages.mkdir(parents=True)
            package = packages / 'example.deb'
            package.write_bytes(b'package')
            manifest = {
                'baseImagesCommit': 'unused', 'sources': [], 'patches': [],
                'ubuntuPackages': [{'package': name, 'version': '1', 'file': f'{name}.deb',
                                    'sha256': hashlib.sha256(package.read_bytes()).hexdigest()}
                                   for name in ('example', 'second')],
            }
            (packages / 'second.deb').write_bytes(package.read_bytes())
            (folder / 'manifest.json').write_text(json.dumps(manifest))
            commands = folder / 'bin'
            commands.mkdir()
            dpkg = commands / 'dpkg-deb'
            dpkg.write_text('#!/bin/sh\n/bin/mkdir -p "$3"\necho extraction >> "$OPENFRAME_CODECS/count"\n')
            dpkg.chmod(0o755)
            env = dict(os.environ, OPENFRAME_CODECS=str(codecs), PATH=str(commands))
            for _ in range(2):
                result = subprocess.run([os.sys.executable, str(script)], env=env,
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((codecs / 'count').read_text(), 'extraction\n' * 2)
            shutil.rmtree(codecs / 'sysroot')
            result = subprocess.run([os.sys.executable, str(script)], env=env,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((codecs / 'count').read_text(), 'extraction\n' * 4)
            package.write_bytes(b'corrupted')
            result = subprocess.run([os.sys.executable, str(script)], env=env,
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('SHA256 mismatch', result.stderr)


if __name__ == '__main__':
    unittest.main()
