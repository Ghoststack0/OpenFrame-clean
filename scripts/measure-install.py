#!/usr/bin/env python3
"""Record an installer command's elapsed time without changing its output.

Example: python3 scripts/measure-install.py --output /tmp/install.json -- \
    bash install.sh --yes --native --dir /tmp/openframe-measured
Run in an isolated environment: this wrapper does not isolate the installer.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command[:1] == ['--']:
        command = command[1:]
    if not command:
        parser.error('provide the installer command after --')
    # Never overwrite a previous measurement.
    with args.output.open('x') as output:
        revision = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True)
        record = {
            'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'revision': revision.stdout.strip() if revision.returncode == 0 else None,
            'architecture': platform.machine(),
            'platform': platform.platform(),
            'cpu_count': os.cpu_count(),
            'scope': 'command wall time; cache state and network are uncontrolled',
        }
        started = time.monotonic()
        try:
            result = subprocess.run(command, check=False)
            record['exit_code'] = result.returncode
        except OSError as error:
            record['error'] = str(error)
            record['exit_code'] = 127
        except KeyboardInterrupt:
            record['exit_code'] = 130
        record['elapsed_seconds'] = round(time.monotonic() - started, 3)
        json.dump(record, output, indent=2)
        output.write('\n')
    return record['exit_code'] if record['exit_code'] >= 0 else 128 - record['exit_code']


if __name__ == '__main__':
    raise SystemExit(main())
