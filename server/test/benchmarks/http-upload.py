"""Run on the Linux box. Only openframe-bench-http-* Compose projects are changed."""
import base64
import hashlib
import json
import os
import platform
import random
import statistics
import struct
import sys
import subprocess
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
os.chdir(DIRECTORY)
IMAGES = {
    'upstream': 'ghcr.io/immich-app/immich-server:v3.3.5',
    'candidate': 'openframe-bench:20261026',
}
MEDIA_READY = '--media-ready' in sys.argv
CONTROLLED = '--controlled' in sys.argv
assert not (MEDIA_READY and CONTROLLED)
ROUNDS = 6 if CONTROLLED or MEDIA_READY else 3
UPLOADS = 21 if CONTROLLED or MEDIA_READY else 6
OUTPUT = 'http-upload-media-ready.json' if MEDIA_READY else ('http-upload-controlled.json' if CONTROLLED else 'http-upload-result.json')
if MEDIA_READY:
    assert 'BENCH_WORKERS_INCLUDE' not in os.environ, 'Default workers required'
if CONTROLLED:
    os.environ['BENCH_WORKERS_INCLUDE'] = 'api'
PORT = 2297
URL = f'http://127.0.0.1:{PORT}'
CREDENTIALS = {'email': 'bench@example.invalid', 'name': 'Disposable benchmark', 'password': 'Only-disposable-fixtures-2026!'}


def compose(version, *args, capture=False):
    return subprocess.run(
        ['docker', 'compose', '-f', 'http-compose.yaml', '-p', f'openframe-bench-http-{version}', *args],
        env={**os.environ, 'SERVER_IMAGE': IMAGES[version], 'BENCH_PORT': str(PORT)},
        check=True, text=True, stdout=subprocess.PIPE if capture else None,
    ).stdout


def request(path, data=None, headers=None):
    req = urllib.request.Request(URL + '/api' + path, data=data, headers=headers or {})
    started = time.perf_counter()
    try:
        response = urllib.request.urlopen(req, timeout=90)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read(), (time.perf_counter() - started) * 1000


def post(path, data, headers=None):
    status, _, body, elapsed = request(path, json.dumps(data).encode(), {'Content-Type': 'application/json', **(headers or {})})
    assert status in (200, 201), (path, status, body[:500])
    return json.loads(body), elapsed


def png(seed):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    pixels = random.Random(seed).randbytes(512 * 512 * 3)
    scanlines = b''.join(b'\0' + pixels[row * 1536:(row + 1) * 1536] for row in range(512))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 512, 512, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(scanlines)) + chunk(b'IEND', b''))


def upload_body(image, name):
    boundary = 'openframe-deterministic-benchmark'
    body = b''
    for field in ('fileCreatedAt', 'fileModifiedAt'):
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n2026-01-01T00:00:00.000Z\r\n'.encode()
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="{name}.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
    return body + image + f'\r\n--{boundary}--\r\n'.encode(), boundary


# Generate each variant's identical bytes before timing or server startup.
fixtures = {(round_, index): png(round_ * (UPLOADS if CONTROLLED or MEDIA_READY else 10) + index) for round_ in range(ROUNDS) for index in range(UPLOADS)}
image_metadata = {version: json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
                  for version, image in IMAGES.items()}
# Resolve mutable tags once, then use exact local image IDs for every deployment.
IMAGES = {version: metadata['Id'] for version, metadata in image_metadata.items()}
result = {
    'benchmark': 'Isolated HTTP upload and bulk preflight with real PostgreSQL, Redis, and disposable storage',
    'recordedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'host': json.loads(Path('host.json').read_text()),
    'baselineRelease': json.loads(Path('upstream-release.json').read_text()),
    'candidateBuild': json.loads(Path('candidate-build.json').read_text()),
    'images': {version: {'id': metadata['Id'], 'repoDigests': metadata['RepoDigests'], 'labels': metadata['Config']['Labels']}
               for version, metadata in image_metadata.items()},
    'behaviorStatus': 'running',
    'performanceGate': 'not_evaluated',
    'controlled': CONTROLLED,
    'mediaReady': MEDIA_READY,
    'predeclaredGate': {'pairs': 6, 'uploadsPerDeployment': 20, 'budgetPercent': 5, 'metrics': ['elapsedMs', 'mediaReadyMs'], 'method': 'Geometric mean of paired deployment medians; 10000 whole-block bootstrap draws seed 0, exploratory 95% interval. Regression if lower bound >5%; budget met if upper bound <=5%; otherwise inconclusive. Both metrics must meet budget. No added samples after results.'} if MEDIA_READY else None,
    'workload': {'rounds': ROUNDS, 'warmupUploadsPerRound': 1, 'measuredUploadsPerRound': UPLOADS - 1,
                 'workersInclude': os.environ.get('BENCH_WORKERS_INCLUDE', 'api,microservices'),
                 'fixture': '512x512 RGB seeded random PNG, different bytes each round/index, identical between versions',
                 'fixtureSha256': {f'{r}-{i}': hashlib.sha256(data).hexdigest() for (r, i), data in fixtures.items()},
                 'preflight': '1000 entries, alternating existing/new, mixed hex/base64; 3 warmups and 12 measured requests per round'},
    'limitations': 'Loopback HTTP on one shared 2-core host. Sequential requests only; microservices workers run by default and are excluded in controlled mode. ML is disabled in both modes. Fresh per-version volumes at start, then retained between rounds. No WAN/TLS/mobile testing. Upload HTTP completion does not mean all background jobs completed. Existing candidate production dependency/native-codec image reused with freshly built full server dist; web/CLI remain from prior build. Sample counts are specified under workload; sequential small-file measurements are not a capacity test.',
    'controlledLimitations': 'Controlled mode disables microservices workers equally for both builds, leaving real authenticated HTTP, checksum/deduplication, PostgreSQL durability and storage writes enabled. Queued media/geodata work does not execute. This isolates upload request completion and does not measure media-ready throughput.' if CONTROLLED else None,
    'rounds': [],
}
try:
    # Remove only this script's disposable named projects, never existing installations.
    for version in IMAGES:
        compose(version, 'down', '-v', '--remove-orphans')
    for round_ in range(ROUNDS):
        order = ['upstream', 'candidate'] if round_ % 2 == 0 else ['candidate', 'upstream']
        for version in order:
            if MEDIA_READY:
                compose(version, 'down', '-v', '--remove-orphans')
            started = time.perf_counter()
            compose(version, 'up', '-d', '--pull', 'never')
            for attempt in range(180):
                try:
                    if request('/server/ping')[0] == 200:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(1)
            else:
                raise RuntimeError(f'{version} did not become ready within 180 checks')
            startup_ms = (time.perf_counter() - started) * 1000
            readiness = {}
            if MEDIA_READY:
                for attempt in range(600):
                    logs = compose(version, 'logs', '--no-color', 'server', capture=True)
                    if 'Geodata import completed' in logs:
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError('Geodata startup did not finish within 600 checks')
                readiness['geodataReadyMs'] = (time.perf_counter() - started) * 1000
            if round_ == 0 or MEDIA_READY:
                post('/auth/admin-sign-up', CREDENTIALS)
            login, _ = post('/auth/login', {key: CREDENTIALS[key] for key in ('email', 'password')})
            assert login['isAdmin'] is True
            headers = {'Authorization': 'Bearer ' + login['accessToken']}
            samples = []
            for index in range(UPLOADS):
                image = fixtures[round_, index]
                body, boundary = upload_body(image, f'fixture-{round_}-{index}')
                upload_started = time.perf_counter()
                status, _, response, elapsed = request('/assets', body, {**headers, 'Content-Type': 'multipart/form-data; boundary=' + boundary})
                assert status == 201, ('new upload', version, status, response[:500])
                asset = json.loads(response)
                assert asset['status'] == 'created', asset
                media_ready_ms = None
                if MEDIA_READY:
                    for attempt in range(1200):
                        ready = []
                        for size in ('thumbnail', 'preview'):
                            code, media_headers, media, _ = request('/assets/' + asset['id'] + '/thumbnail?size=' + size, headers=headers)
                            ready.append(code == 200 and media_headers.get('Content-Type', '').startswith('image/') and len(media) > 100)
                        if all(ready):
                            break
                        time.sleep(0.05)
                    else:
                        raise RuntimeError('Thumbnail/preview readiness timeout')
                    media_ready_ms = (time.perf_counter() - upload_started) * 1000
                    if index == 0:
                        readiness['warmupMediaReadyMs'] = media_ready_ms
                path = '/assets/' + asset['id'] + '/original'
                status, response_headers, original, _ = request(path, headers=headers)
                assert status == 200 and original == image, ('stored bytes differ', version)
                assert request(path)[0] == 401
                status, _, partial, _ = request(path, headers={**headers, 'Range': 'bytes=0-1023'})
                assert status == 206 and partial == image[:1024]
                status, _, cached, _ = request(path, headers={**headers, 'If-None-Match': response_headers['ETag']})
                assert status == 304 and not cached
                if index:
                    samples.append({'index': index, 'bytes': len(image), 'elapsedMs': elapsed,
                                    'mediaReadyMs': media_ready_ms,
                                    'MiBPerSecond': len(image) / 1048576 / (elapsed / 1000)})
            digest = hashlib.sha1(image).digest()
            checksum = base64.b64encode(digest).decode()
            upload_headers = {**headers, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'x-immich-checksum': checksum}
            duplicate_status, _, duplicate_body, _ = request('/assets', body, upload_headers)
            duplicate = json.loads(duplicate_body)
            assert duplicate_status in (200, 201) and duplicate['id'] == asset['id'] and duplicate['status'] == 'duplicate'
            assets = []
            for i in range(1000):
                value = digest if i % 2 == 0 else hashlib.sha1(f'missing-{i}'.encode()).digest()
                assets.append({'id': str(i), 'checksum': value.hex() if i % 4 < 2 else base64.b64encode(value).decode()})
            bulk_samples = []
            for sample in range(-3, 12):
                response, elapsed = post('/assets/bulk-upload-check', {'assets': assets}, headers)
                expected = [{'id': str(i), 'action': 'reject', 'reason': 'duplicate', 'assetId': asset['id'], 'isTrashed': False}
                            if i % 2 == 0 else {'id': str(i), 'action': 'accept'} for i in range(1000)]
                assert response == {'results': expected}, ('preflight mismatch', version)
                if sample >= 0:
                    bulk_samples.append(elapsed)
            database = compose(version, 'exec', '-T', 'database', 'psql', '-U', 'postgres', '-d', 'immich', '-Atc',
                               "select json_build_object('version',version(),'fsync',current_setting('fsync'),'full_page_writes',current_setting('full_page_writes'),'synchronous_commit',current_setting('synchronous_commit'))", capture=True)
            result['rounds'].append({'round': round_, 'version': version, 'startupMs': startup_ms,
                                     'database': json.loads(database), 'readiness': readiness, 'uploadSamples': samples,
                                     'bulkCheckSamplesMs': bulk_samples, 'behavior': 'upload/download bytes, unauthorized=401, range=206, ETag=304, duplicate upload identity, mixed preflight output passed'})
            Path(OUTPUT).write_text(json.dumps(result, indent=2) + '\n')
            if MEDIA_READY:
                Path(f'media-ready-{round_}-{version}.log').write_text(compose(version, 'logs', '--no-color', capture=True))
                compose(version, 'down', '-v', '--remove-orphans')
            else:
                compose(version, 'stop')
    result['summary'] = {version: {
        'uploadMedianMs': statistics.median(sample['elapsedMs'] for row in result['rounds'] if row['version'] == version for sample in row['uploadSamples']),
        'bulkCheckMedianMs': statistics.median(sample for row in result['rounds'] if row['version'] == version for sample in row['bulkCheckSamplesMs']),
    } for version in IMAGES}
    result['status'] = 'behavior_passed'
    result['behaviorStatus'] = 'passed'
    result['performanceGate'] = 'inconclusive_pending_paired_analysis'
    Path(OUTPUT).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['summary'], indent=2))
except BaseException as error:
    result['status'] = 'behavior_failed'
    result['behaviorStatus'] = 'failed'
    result['error'] = str(error)
    Path(OUTPUT).write_text(json.dumps(result, indent=2) + '\n')
    raise
finally:
    for version in IMAGES:
        logs = compose(version, 'logs', '--no-color', '--tail', '100', capture=True)
        Path(f'http-media-ready-{version}.log' if MEDIA_READY else f'http-{version}.log').write_text(logs)
        compose(version, 'down', '-v', '--remove-orphans')
