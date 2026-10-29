#!/usr/bin/env python3
"""Test native installer orchestration with isolated command fixtures."""
import shutil
import fcntl
import os
import re
import struct
import termios
import pty
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


# Implements the `openframe prepare` progress contract: one status word per task
# in $OPENFRAME_STATE/progress/<id>.status and the task's output in <id>.log.
MOCK_NATIVE = '''
echo "native $*" >> "$TEST_LOG"
if [[ "$1" == init ]]; then
 mkdir -p "$OPENFRAME_STATE/media"
 touch "$OPENFRAME_CONFIG"
fi
if [[ "$1" == prepare ]]; then
 progress="$OPENFRAME_STATE/progress"
 mkdir -p "$progress"
 for id in web codecs ml resources; do echo pending > "$progress/$id.status"; done
 for id in web codecs ml resources; do
  echo running > "$progress/$id.status"
  echo "building $id" >> "$progress/$id.log"
  if [[ "$id" == "${FAIL_TASK:-never}" ]]; then
   echo "error: $id broke" >> "$progress/$id.log"
   echo failed > "$progress/$id.status"
   echo "failed: $id" >&2
   exit 1
  fi
  if [[ "$*" == *--resume* && "$id" != ml ]]; then echo skipped > "$progress/$id.status"; else echo done > "$progress/$id.status"; fi
 done
fi
[[ "$1" != "${FAIL_NATIVE:-never}" ]]
'''


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'source'
        self.repo.mkdir()
        shutil.copytree(ROOT / 'scripts/docker', self.repo / 'scripts/docker')
        shutil.copytree(ROOT / 'docker/openframe', self.repo / 'docker/openframe')
        (self.repo / 'server').mkdir()
        (self.repo / 'server/Dockerfile').touch()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.target = self.root / 'photos'
        self.log = self.root / 'calls'
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        HOME=str(self.root), XDG_CONFIG_HOME=str(self.root / 'config'),
                        TEST_LOG=str(self.log), TEST_BIN=str(self.bin),
                        TEST_ROOT=str(self.root))
        # Substitute platform detection in the test copy, never in production.
        script = (ROOT / 'install.sh').read_text().replace(
            '$(. /etc/os-release; printf \'%s:%s\' "$ID" "${VERSION_ID:-}")', 'ubuntu:24.04')
        script = script.replace('((EUID != 0))', 'true')
        # Never probe the real host's ports; a running OpenFrame would hold them.
        script = script.replace('port_free() {\n', 'port_free() {\n  for checked_port in "$@"; do [[ "$checked_port" != "${BUSY_PORT:-}" ]] || { echo "Port $BUSY_PORT is already in use" >&2; return 1; }; done\n  return 0\n',1)
        self.script = script
        self.installer = self.repo / 'install.sh'
        self.installer.write_text(script)
        native = self.repo / 'scripts/native'
        native.mkdir(parents=True)
        self.command('openframe', MOCK_NATIVE, native)
        for name in ('pnpm', 'uv', 'extism-js', 'extism', 'wasm-opt', 'ffmpeg',
                     'ffprobe', 'redis-server', 'redis-cli', 'pg_ctl', 'postgres',
                     'pg_dump', 'pg_dumpall', 'cmake', 'make', 'cc', 'c++', 'autoconf',
                     'automake', 'libtoolize', 'pkg-config', 'perl', 'gzip',
                     'flock', 'apt-get', 'dpkg-deb'):
            self.command(name, ':')
        self.command('docker', 'exit 1')
        self.command('node', 'echo 24')
        self.command('mise', 'if [[ \"$1\" == env ]]; then echo :; fi')
        self.command('uname', 'if [[ "$1" == -m ]]; then echo x86_64; else echo Linux; fi')
        self.command('pg_config', 'if [[ "$1" == --bindir ]]; then echo "$TEST_BIN"; else echo "$TEST_ROOT/share"; fi')
        (self.root / 'share/extension').mkdir(parents=True)
        (self.root / 'share/extension/vector.control').touch()
        self.command('initdb', 'mkdir -p "$2"; touch "$2/postgresql.conf"')
        self.command('psql', '''
if [[ "${*: -1}" == ON_ERROR_STOP=1 ]]; then cat >/dev/null; echo "database created" >> "$TEST_LOG"; fi
''')
        self.command('systemctl', '''
echo "systemctl $*" >> "$TEST_LOG"
if [[ "$2" == cat ]]; then exit "${EXISTING_SERVICE:-1}"; fi
''')
        self.command('curl', 'exit 0')
        self.command('ip', "echo '1.1.1.1 dev eth0 src 192.168.1.9'")
        self.command('qrencode', 'echo "QR $*"')

    def command(self, name, body, folder=None):
        path = (folder or self.bin) / name
        path.write_text('#!/usr/bin/env bash\nset -eu\n' + body)
        path.chmod(0o700)

    def run_install(self, *args):
        return subprocess.run(['bash', str(self.installer), *args], env=self.env,
                              capture_output=True, text=True, timeout=10)

    def install(self, *args):
        return self.run_install('--yes', '--dir', str(self.target), *args)

    def mock_docker(self):
        self.command('git', 'echo 0123456789abcdef0123456789abcdef01234567')
        self.command('docker', '\n'.join([
            'echo "docker $*" >> "$TEST_LOG"',
            'if [[ "$1" == info ]]; then exit "${DOCKER_DENIED:-0}"; fi',
            'if [[ "$*" == "compose version --short" ]]; then echo 5.6.1; fi',
            # PULL_FAIL=1: nothing is published. PULL_FAIL=commit: only exact-commit tags are missing.
            'missing() { [[ "${PULL_FAIL:-}" == 1 || ( "${PULL_FAIL:-}" == commit && "$1" == *:commit-* ) ]]; }',
            'if [[ "$1 $2" == "image inspect" ]]; then if missing "$3"; then exit 1; fi; exit 0; fi',
            'if [[ "$*" == *" pull" || "$*" == *"pull immich-"* ]] && missing "$(grep ^OPENFRAME_SERVER_IMAGE= "$3/.env")"; then exit 1; fi',
        ]))

    def test_ml_defaults_disabled(self):
        result = self.install('--native', '--without-ml')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('IMMICH_MACHINE_LEARNING_ENABLED=false', (self.target / 'env').read_text())
        self.assertNotIn('enable --now --no-block openframe-ml', self.log.read_text())

    def test_disabled_ml_does_not_reserve_its_port(self):
        self.env['BUSY_PORT'] = '3003'
        result = self.install('--native', '--without-ml')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_enabled_ml_requires_its_port(self):
        self.env['BUSY_PORT'] = '3003'
        result = self.install('--native', '--with-ml')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.target.exists())

    def test_ml_native_background_service(self):
        result = self.install('--native', '--with-ml')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('IMMICH_MACHINE_LEARNING_ENABLED=true', (self.target / 'env').read_text())
        self.assertIn('enable --now --no-block openframe-ml', self.log.read_text())
        self.assertNotIn('3003/ping', self.script)

    def test_docker_slow_ml_does_not_block_core(self):
        self.mock_docker()
        with (self.bin / 'docker').open('a') as script:
            script.write('\nif [[ "$*" == *"--profile ml pull"* ]]; then sleep 3; fi\n')
        import time
        start = time.monotonic()
        result = self.install('--docker', '--with-ml')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(time.monotonic() - start, 3)
        self.assertIn('OpenFrame is ready', result.stdout)
        self.assertTrue((self.target / 'ml-setup.log').exists())

    def test_docker_flags_conflict(self):
        result = self.install('--docker', '--native')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Choose only one', result.stderr)

    def test_explicit_docker_requires_access(self):
        result = self.install('--docker')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Docker is unavailable', result.stderr)
        self.assertFalse(self.target.exists())

    def test_docker_default_and_bundle(self):
        self.mock_docker()
        result = self.install('--port', '2383')
        self.assertEqual(result.returncode, 0, result.stderr)
        env = (self.target / '.env').read_text()
        self.assertIn('OPENFRAME_PORT=2383', env)
        self.assertIn('ghcr.io/ghoststack0/openframe-server:commit-', env)
        self.assertIn('DB_HOSTNAME=database', env)
        self.assertEqual((self.target / '.env').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.target / 'compose.yml').read_text(), (ROOT / 'docker/openframe/compose.yml').read_text())
        calls = self.log.read_text()
        self.assertIn('up -d --pull never --no-build', calls)
        self.assertNotIn('native prepare', calls)
        self.assertNotIn('systemctl', calls)
        self.assertTrue((self.target / 'openframe').exists())
        self.assertIn('OpenFrame is ready', result.stdout)

    def test_docker_preserves_native_wrapper_and_erases_scratch(self):
        self.mock_docker()
        wrapper = self.root / '.local/bin/openframe'
        wrapper.parent.mkdir(parents=True)
        wrapper.write_text('native command stays')
        result = self.install('--docker')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(wrapper.read_text(), 'native command stays')
        result = subprocess.run([str(self.target / 'openframe'), 'uninstall', '--erase-everything', '--yes'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.target.exists())
        self.assertEqual(wrapper.read_text(), 'native command stays')

    def test_native_flag_overrides_usable_docker(self):
        self.mock_docker()
        result = self.install('--native')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.target / 'env').exists())

    def test_denied_docker_defaults_native(self):
        self.mock_docker()
        self.env['DOCKER_DENIED'] = '1'
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.target / 'env').exists())

    def test_docker_fallback_resume_and_wrapper(self):
        self.mock_docker()
        self.env['PULL_FAIL'] = '1'
        result = self.install('--docker')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Local image fallback', result.stdout)
        self.assertIn('build immich-server', self.log.read_text())
        env = (self.target / '.env').read_bytes()
        self.env.pop('PULL_FAIL')
        result = self.install('--docker', '--resume')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.target / '.env').read_bytes(), env)
        for args in [('status',), ('uninstall', '--keep-data', '--yes')]:
            result = subprocess.run([str(self.target / 'openframe'), *args], env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.target / '.env').exists())

    def test_docker_unpublished_commit_uses_main(self):
        self.mock_docker()
        self.env['PULL_FAIL'] = 'commit'
        result = self.install('--docker')
        self.assertEqual(result.returncode, 0, result.stderr)
        env = (self.target / '.env').read_text()
        self.assertIn('openframe-server:main', env)
        self.assertIn('openframe-machine-learning:main', env)
        self.assertNotIn(':commit-', env)
        self.assertNotIn(' build ', self.log.read_text())

    def test_native_setup(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = (self.target / 'env').read_text()
        self.assertIn('DB_PORT=5433', config)
        self.assertIn('REDIS_PORT=6380', config)
        self.assertEqual((self.target / 'env').stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.target / '.pgpass-init').exists())
        units = self.root / 'config/systemd/user'
        self.assertIn('openframe" start', (units / 'openframe.service').read_text())
        self.assertIn('postgres" -D', (units / 'openframe-db.service').read_text())
        calls = self.log.read_text()
        for action in ('prepare', 'doctor'):
            self.assertIn(f'native {action}', calls)
        progress = self.target / 'state/progress'
        for task in ('web', 'codecs', 'ml', 'resources'):
            self.assertEqual((progress / f'{task}.status').read_text().strip(), 'done')
        self.assertLess(calls.index('database created'), calls.index('native doctor'))
        self.assertIn('enable --now openframe', calls)
        self.assertIn('QR -t ANSIUTF8 http://192.168.1.9:2283', result.stdout)
        self.assertNotIn('docker', calls.lower())
        self.assertIn('Your own photo library', result.stdout)
        self.assertIn('openframe status', result.stdout)
        wrapper = (self.root / '.local/bin/openframe').read_text()
        self.assertIn(f"OPENFRAME_CONFIG='{self.target}/env'", wrapper)

    def test_one_confirmation_and_quiet_build(self):
        self.installer.write_text(self.script.replace('exec 3</dev/tty', 'exec 3<&0'))
        self.command('openframe', 'echo "noisy compiler output"' + MOCK_NATIVE, self.repo / 'scripts/native')
        result = subprocess.run(['bash', str(self.installer), '--dir', str(self.target)],
                                input='n\nY\n', env=self.env, capture_output=True,
                                text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count('Install OpenFrame?'), 1)
        self.assertNotIn('Install folder [', result.stderr)
        self.assertNotIn('Web port [', result.stderr)
        self.assertNotIn('noisy compiler output', result.stdout + result.stderr)
        self.assertIn('ok Photo & RAW codecs', result.stdout)
        self.assertIn('ok Start OpenFrame', result.stdout)

    def run_in_terminal(self, *args, columns=100, **env):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, columns, 0, 0))
        process = subprocess.Popen(['bash', str(self.installer), *args],
                                   env=dict(self.env, TERM='xterm', LANG='C.UTF-8', **env),
                                   stdin=subprocess.DEVNULL, stdout=slave, stderr=slave)
        os.close(slave)
        chunks = []
        # Drain continuously: the live dashboard redraws faster than a pty buffer holds.
        while True:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            chunks.append(chunk)
        os.close(master)
        return process.wait(timeout=30), b''.join(chunks).decode()

    def test_terminal_shows_live_dashboard(self):
        status, raw = self.run_in_terminal('--yes', '--dir', str(self.target))
        output = re.sub(r'\x1b\[[0-9;]*m', '', raw)
        self.assertEqual(status, 0, output[-2000:])
        self.assertIn('\x1b[?25h', raw)  # cursor restored
        self.assertIn('⠸⠇', output)  # braille wordmark
        self.assertIn('┌', output)
        self.assertIn('◇  Photo & RAW codecs', output)
        self.assertIn('◇  Start OpenFrame', output)
        self.assertIn('You\'re all set.', output)
        self.assertIn('OpenFrame is ready', output)

    def test_decline_writes_nothing(self):
        self.installer.write_text(self.script.replace('exec 3</dev/tty', 'exec 3<&0'))
        result = subprocess.run(['bash', str(self.installer)], input='n\nn\n',
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertIn('Nothing was changed', result.stdout)
        self.assertFalse(self.target.exists())
        calls = self.log.read_text() if self.log.exists() else ''
        self.assertNotIn('native', calls)
        self.assertNotIn('enable', calls)
        self.assertFalse((self.root / '.local/bin/openframe').exists())

    def test_customize_folder_and_port(self):
        self.installer.write_text(self.script.replace('exec 3</dev/tty', 'exec 3<&0'))
        other = self.root / 'elsewhere'
        result = subprocess.run(['bash', str(self.installer), '--dir', str(self.target)],
                                input=f'n\nc\n{other}\n8080\ny\n', env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.target.exists())
        self.assertIn('IMMICH_PORT=8080', (other / 'env').read_text())
        self.assertIn('http://192.168.1.9:8080', result.stdout)

    def test_failure_shows_step_and_log_tail(self):
        self.env['FAIL_TASK'] = 'codecs'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Photo & RAW codecs failed', result.stderr)
        self.assertIn('error: codecs broke', result.stderr)
        self.assertIn('progress/codecs.log', result.stderr)
        self.assertNotIn("You're all set", result.stdout)

    def test_omarchy_uses_pacman_and_valkey(self):
        self.installer.write_text(self.script.replace('platform="ubuntu:24.04"', 'platform="omarchy:"'))
        self.command('pacman', 'if [[ "$1" == -T ]]; then echo postgresql; exit 127; fi')
        self.command('sudo', 'echo "sudo $*" >> "$TEST_LOG"')
        self.command('valkey-server', ':')
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('sudo -n pacman -S --noconfirm --needed', self.log.read_text())
        self.assertIn('glib2-devel', self.log.read_text())
        unit = self.root / 'config/systemd/user/openframe-redis.service'
        self.assertIn('valkey-server', unit.read_text())
        self.assertNotIn('Native codecs require Ubuntu', result.stderr)

    def test_existing_install_is_untouched(self):
        self.target.mkdir()
        marker = self.target / 'env'
        marker.write_text('keep me')
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(marker.read_text(), 'keep me')

    def test_existing_service_is_untouched(self):
        self.env['EXISTING_SERVICE'] = '0'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already exists', result.stderr)
        self.assertFalse(self.target.exists())

    def test_invalid_ports_write_nothing(self):
        for port in ('80', '65536', 'abc', '5433', '6380', '3003'):
            result = self.install('--port', port)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.target.exists())

    def test_busy_port_writes_nothing(self):
        self.env['BUSY_PORT'] = '2283'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Port 2283 is already in use', result.stderr)
        self.assertFalse(self.target.exists())

    def test_unsafe_path_is_rejected(self):
        result = self.run_install('--yes', '--dir', str(self.target) + '%name')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Paths cannot contain', result.stderr)
        self.assertFalse(self.target.exists())

    def test_application_database_role_is_not_superuser(self):
        script = (ROOT / 'install.sh').read_text()
        self.assertIn("CREATE ROLE openframe LOGIN PASSWORD", script)
        self.assertNotIn('CREATE ROLE openframe SUPERUSER', script)
        self.assertIn('--native', script)

    def test_resume_preserves_database_and_skips_web_build(self):
        self.check_resume('--resume')

    def test_interrupted_install_resumes_automatically(self):
        self.check_resume()

    def check_resume(self, *args):
        self.env['FAIL_TASK'] = 'codecs'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        config = (self.target / 'env').read_bytes()
        (self.target / 'postgres/PG_VERSION').write_text('18')
        marker = self.target / 'postgres/keep'
        marker.write_text('existing data')
        for path in (self.repo / 'server/dist/main.js',
                     self.target / 'state/build/www/index.html',
                     self.target / 'state/build/plugins/immich-plugin-core/dist/plugin.wasm'):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        self.env.pop('FAIL_TASK')
        self.log.write_text('')
        result = self.install(*args)
        self.assertIn('Found an earlier installation', result.stdout)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.target / 'env').read_bytes(), config)
        self.assertEqual(marker.read_text(), 'existing data')
        calls = self.log.read_text().splitlines()
        self.assertIn('native prepare --resume', calls)
        self.assertEqual((self.target / 'state/progress/web.status').read_text().strip(), 'skipped')
        self.assertNotIn('native init', calls)

    def test_resume_rejects_unprepared_folder(self):
        self.target.mkdir()
        result = self.install('--resume')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Cannot resume', result.stderr)
        self.assertFalse((self.target / 'env').exists())

    def test_build_failure_keeps_configuration(self):
        self.env['FAIL_TASK'] = 'web'
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.target / 'env').is_file())
        self.assertIn('Files are kept', result.stderr)
        self.assertIn('Web app & server failed', result.stderr)
        self.assertNotIn('OpenFrame is ready', result.stdout)
        self.assertFalse((self.root / 'config/systemd/user').exists())

    def test_help(self):
        result = self.run_install('--help')
        self.assertEqual(result.returncode, 0)
        self.assertIn('No Docker required', result.stdout)
        self.assertFalse(self.log.exists())

    def test_missing_argument(self):
        result = self.run_install('--dir')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing value', result.stderr)


if __name__ == '__main__':
    unittest.main()
