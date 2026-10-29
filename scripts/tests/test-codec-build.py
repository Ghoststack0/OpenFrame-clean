#!/usr/bin/env python3
"""Check codec scheduling without compiling or changing an installation."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

RECIPE = Path(__file__).resolve().parents[2] / 'server/test/benchmarks/native-ubuntu/codecs'


class CodecBuildTest(unittest.TestCase):
    def test_jobs(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            for name, body in [('nproc', 'echo 12'), ('awk', 'case "$*" in *MemTotal*) echo "$TEST_MEMORY";; esac')]:
                command = path / name
                command.write_text('#!/bin/sh\n' + body + '\n')
                command.chmod(0o755)
            policy = path / 'jobs.sh'
            policy.write_text((RECIPE / 'jobs.sh').read_text().replace('/sys/fs/cgroup', str(path / 'cgroup')))
            for memory, override, expected in [(15*1024**2, '', '12'), (4*1024**2, '', '4'), (2*1024**2, '', '1'), (15*1024**2, '3', '3')]:
                env = dict(os.environ, PATH=f'{path}:' + os.environ['PATH'], TEST_MEMORY=str(memory), OPENFRAME_BUILD_JOBS=override)
                result = subprocess.run(['bash', '-c', 'source "$1"; codec_build_jobs; codec_build_jobs', 'bash', str(policy)], env=env, text=True, capture_output=True, check=True)
                self.assertEqual(result.stdout.splitlines(), [expected, expected])
            (path / 'awk').write_text('#!/bin/sh\ncase "$*" in *MemTotal*) echo "$TEST_MEMORY";; *) echo /nested/child;; esac\n')
            (path / 'cgroup/nested').mkdir(parents=True)
            (path / 'cgroup/nested/memory.max').write_text(str(2 * 1024**3))
            env['OPENFRAME_BUILD_JOBS'] = ''
            result = subprocess.run(['bash', '-c', 'source "$1"; codec_build_jobs', 'bash', str(policy)], env=env, text=True, capture_output=True, check=True)
            self.assertEqual(result.stdout.strip(), '1')
            env['OPENFRAME_BUILD_JOBS'] = 'oops'
            self.assertNotEqual(subprocess.run(['bash', '-c', 'source "$1"', 'bash', str(policy)], env=env, capture_output=True).returncode, 0)

    def test_cmake_generator(self):
        function = re.search(r'codec_ninja_jobserver\(\) \{.*?^\}', (RECIPE / 'build.sh').read_text(), re.S | re.M)[0] + '\n' + re.search(r'codec_cmake\(\) \{.*?^\}', (RECIPE / 'build.sh').read_text(), re.S | re.M)[0]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            for name in ['cmake', 'ninja']:
                command = path / name
                command.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
                command.chmod(0o755)
            (path / 'ninja').write_text('#!/bin/sh\necho 1.13.2\n')
            def configure():
                return subprocess.check_output(['/bin/bash', '-c', function + '\ncodec_cmake -S . -B build'], cwd=path, env=dict(os.environ, PATH=str(path), MAKEFLAGS='--jobserver-auth=fifo:/test'), text=True).splitlines()
            self.assertEqual(configure(), ['-G', 'Ninja', '-S', '.', '-B', 'build'])
            (path / 'ninja').write_text('#!/bin/sh\necho 1.11.1\n')
            self.assertEqual(configure(), ['-G', 'Unix Makefiles', '-S', '.', '-B', 'build'])
            (path / 'build').mkdir()
            (path / 'build/CMakeCache.txt').touch()
            self.assertEqual(configure(), ['-S', '.', '-B', 'build'])
            (path / 'build/CMakeCache.txt').unlink()
            (path / 'ninja').unlink()
            self.assertEqual(configure(), ['-G', 'Unix Makefiles', '-S', '.', '-B', 'build'])

    def test_cached_ninja_build(self):
        helpers = (RECIPE / 'build.sh').read_text().split('codec_ninja_jobserver()', 1)[1].split('autotools_cc=', 1)[0]
        helpers = 'codec_ninja_jobserver()' + helpers
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / 'build').mkdir()
            (path / 'build/build.ninja').touch()
            for name, body in [('cmake', 'printf "%s\\n" "$@"'), ('ninja', 'echo 1.11.1')]:
                command = path / name
                command.write_text('#!/bin/sh\n' + body + '\n')
                command.chmod(0o755)
            def build(flags):
                return subprocess.check_output(['/bin/bash', '-c', helpers + '\ncodec_cmake_build'], cwd=path,
                    env=dict(os.environ, PATH=str(path), MAKEFLAGS=flags), text=True).splitlines()
            self.assertEqual(build('--jobserver-auth=fifo:/test'), ['--build', 'build', '-j1'])
            (path / 'ninja').write_text('#!/bin/sh\necho 1.13.2\n')
            self.assertEqual(build('--jobserver-auth=fifo:/test'), ['--build', 'build'])
            self.assertEqual(build('--jobserver-auth=3,4'), ['--build', 'build', '-j1'])
            (path / 'build/build.ninja').unlink()
            self.assertEqual(build('--jobserver-auth=3,4'), ['--build', 'build'])

    def test_single_job_graph(self):
        result, _ = self.run_graph(budget=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def run_graph(self, fail='', budget=6):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'system-libs').touch()
            (root / 'workers.mk').write_text(".PHONY: all " + " ".join(f"w{i}" for i in range(8)) + "\nall: " + " ".join(f"w{i}" for i in range(8)) + '\n' +
                'w0 w1 w2 w3 w4 w5 w6 w7:\n\t@flock "$$OPENFRAME_CODECS/events.lock" sh -c \'echo start >> "$$OPENFRAME_CODECS/compilers"\'\n\t@sleep 0.05\n\t@flock "$$OPENFRAME_CODECS/events.lock" sh -c \'echo end >> "$$OPENFRAME_CODECS/compilers"\'\n')

            (root / 'jobs.sh').write_text((RECIPE / 'jobs.sh').read_text())
            source = (RECIPE / 'build.sh').read_text()
            def replace(match):
                name = match[1]
                return f'''build_{name}() (
  echo "start {name} 1" >> "$root/events"
  if [[ "${{FAIL_LIBRARY:-}}" == {name} ]]; then sleep 0.05; bash -c 'exit 17'; fi
  make --no-print-directory -f "$root/workers.mk"
  echo "end {name} 1" >> "$root/events"
)
'''
            source = re.sub(r'build_(\w+)\(\) \(\n.*?^\)\n', replace, source, flags=re.S | re.M)
            (root / 'build.sh').write_text(source)
            result = subprocess.run(['bash', str(root / 'build.sh')], env=dict(os.environ, OPENFRAME_CODECS=str(root), OPENFRAME_BUILD_JOBS=str(budget), FAIL_LIBRARY=fail), capture_output=True, text=True, timeout=15)
            events = [line.split() for line in (root / 'events').read_text().splitlines()]
            if not fail:
                active = peak = 0
                for event in (root / 'compilers').read_text().splitlines():
                    active += 1 if event == 'start' else -1
                    peak = max(peak, active)
                    self.assertLessEqual(active, budget)
                self.assertEqual(active, 0)
                self.assertEqual(peak, budget)
            return result, events

    def test_graph_and_budget(self):
        result, events = self.run_graph()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        dependencies = dict(jpegli=['highway'], tiff=['jpegli'], libraw=['jpegli'], libheif=['libde265'], libjxl=['highway'], imagemagick=['tiff', 'libraw', 'libheif', 'libjxl'], libvips=['imagemagick'])
        done, active = set(), 0
        for event, name, jobs in events:
            if event == 'start':
                self.assertTrue(set(dependencies.get(name, [])) <= done)
                active += int(jobs)
                self.assertLessEqual(active, 6)
            else:
                active -= int(jobs)
                done.add(name)
        self.assertEqual(len(done), 9)
        self.assertEqual(active, 0)

    def test_failure_stops_graph(self):
        result, events = self.run_graph('highway')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Codec library failed: highway', result.stderr)
        self.assertFalse(any(event == 'end' for event, _, _ in events))


if __name__ == '__main__':
    unittest.main()
