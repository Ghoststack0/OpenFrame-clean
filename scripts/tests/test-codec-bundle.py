#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('bundle', ROOT / 'scripts/native/codecs-bundle.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleTests(unittest.TestCase):
    def test_recipe(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            shutil.copytree(ROOT / bundle.RECIPE, repo / bundle.RECIPE)
            self.assertEqual(bundle.recipe_key(), bundle.recipe_key(repo))
            (repo / bundle.RECIPE / 'jobs.sh').write_text('changed')
            self.assertNotEqual(bundle.recipe_key(), bundle.recipe_key(repo))

    def test_relocation(self):
        old, new = b'/long/build/placeholder', b'/opt/codecs'
        self.assertEqual(bundle.relocate_bytes(old + b'/lib\n' + old + b'/etc', old, new), new + b'/lib\n' + new + b'/etc')
        original = b'\x7fELF\0' + old + b'/lib/modules\0after\0'
        result = bundle.relocate_bytes(original, old, new)
        self.assertEqual(len(result), len(original))
        self.assertIn(new + b'/lib/modules\0', result)
        self.assertEqual(original.index(b'after'), result.index(b'after'))
        self.assertNotIn(old, result)
        with self.assertRaisesRegex(ValueError, 'longer'):
            bundle.relocate_bytes(original, old, old + b'x')

    def test_missing_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = Path(directory) / 'pin.json'
            metadata.write_text('{}')
            with self.assertRaisesRegex(ValueError, 'No pinned'):
                bundle.select_entry(metadata)

    def test_sha_mismatch_preserves_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'codecs'
            target.mkdir()
            (target / 'system-libs').touch()
            entry = dict(recipe_key=bundle.recipe_key(), sha256='a'*64, size=3, url='https://example.com/test')
            cache = root / 'cache'; cache.mkdir()
            (cache / (entry['sha256'] + '.tar.gz')).write_bytes(b'bad')
            with patch.object(bundle, 'select_entry', return_value=entry), patch.object(bundle.subprocess, 'run'):
                with self.assertRaisesRegex(ValueError, 'SHA256'):
                    bundle.install(target, root / 'pin', cache)
            self.assertTrue((target / 'system-libs').exists())
            self.assertFalse(list(cache.iterdir()))

    def test_closure_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lib = root / 'prefix/lib'; lib.mkdir(parents=True)
            (lib / 'sample').touch()
            with patch.object(bundle, 'needed', return_value=['libc.so.6', 'libstdc++.so.6', 'libgcc_s.so.1']):
                bundle.closure(root)
            with patch.object(bundle, 'needed', return_value=['libnotbundled.so.1']):
                with self.assertRaisesRegex(ValueError, 'Unresolved'):
                    bundle.closure(root)
            with patch.object(bundle, 'needed', return_value=['/tmp/absolute.so']):
                with self.assertRaisesRegex(ValueError, 'Absolute'):
                    bundle.closure(root)

    def test_real_elf_relocation_and_closure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lib = root / 'source/sysroot/usr/lib/x86_64-linux-gnu'
            lib.mkdir(parents=True)
            (root / 'helper.c').write_text('int answer(void) { return 42; }')
            subprocess.run(['cc', '-shared', '-fPIC', '-Wl,-soname,libbundle-test.so.1',
                            str(root / 'helper.c'), '-o', str(lib / 'libbundle-test.so.1')], check=True)
            (lib / 'libbundle-test.so').symlink_to('libbundle-test.so.1')
            old = bundle.PLACEHOLDER
            (root / 'main.c').write_text('#include <stdio.h>\nextern int answer(void);\nint main(void) { printf("%s %d\\n", "' + old + '/modules", answer()); }')
            stage = root / 'stage'; (stage / 'prefix/bin').mkdir(parents=True)
            binary = stage / 'prefix/bin/probe'
            subprocess.run(['cc', str(root / 'main.c'), '-L' + str(lib), '-lbundle-test', '-o', str(binary)], check=True)
            (stage / 'prefix/lib').mkdir()
            bundle.closure(stage, root / 'source')
            bundle.closure(stage)
            binary.write_bytes(bundle.relocate_bytes(binary.read_bytes(), old.encode(), str(stage).encode()))
            output = subprocess.check_output([str(binary)], env=bundle.runtime_env(stage), text=True)
            self.assertEqual(output, str(stage) + '/modules 42\n')
            self.assertTrue((stage / 'sysroot/usr/lib/x86_64-linux-gnu/libbundle-test.so').is_file())

    def test_shell_source_fallback(self):
        source = (ROOT / 'scripts/native/openframe').read_text()
        start = source.index('build_codecs() (')
        end = source.index('\ndownload_resources()', start)
        function = source[start:end]
        # Exercise the actual integration with fake tools; the source build must run.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            recipe = path / 'recipe'; recipe.mkdir()
            (recipe / 'build.sh').write_text('echo source-built >> "$EVENTS"')
            (recipe / 'sharp.sh').write_text('echo sharp-built >> "$EVENTS"; [[ -z "${TEST_FAIL_SHARP:-}" ]]')
            script = '''set -euo pipefail
need() { :; }
node() { echo 24; }
codec_env() { recipe="$TEST_RECIPE"; }
phase() { :; }
input_key() { echo key; }
codec_libraries_present() { return 0; }
python3() { case "$*" in *' install '*) return 1;; esac; mkdir -p "$OPENFRAME_CODECS"; }
''' + function + '\nbuild_codecs\n'
            target = path / 'codecs'; target.mkdir()
            env = dict(os.environ, ROOT=str(ROOT), OPENFRAME_CODECS=str(target), TEST_RECIPE=str(recipe), EVENTS=str(path / 'events'))
            subprocess.run(['bash', '-c', script], env=env, check=True, capture_output=True)
            self.assertEqual((path / 'events').read_text().splitlines(), ['source-built', 'sharp-built'])
            (target / 'libraries.stamp').unlink()
            (target / 'bundle.json').write_text('original bundle')
            result = subprocess.run(['bash', '-c', script], env=dict(env, TEST_FAIL_SHARP='1'), capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((target / 'bundle.json').read_text(), 'original bundle')


if __name__ == '__main__':
    unittest.main()
