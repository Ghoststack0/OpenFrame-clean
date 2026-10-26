import os, secrets, subprocess
from pathlib import Path

root = Path.home() / "openframe-native-validation-20261026"
os.umask(0o077)
assert root.is_dir()
assert not (root / "env").exists(), "Refusing to replace validation configuration"
admin = secrets.token_hex(24)
password = secrets.token_hex(24)
redis = secrets.token_hex(24)
(root / "pgpass-init").write_text(admin)
(root / "socket").mkdir()
(root / "redis-data").mkdir()
(root / "state").mkdir(exist_ok=True)
bin = root / "local/pgsql/bin"
subprocess.run(
    [
        bin / "initdb",
        "-D",
        root / "pgdata",
        "-U",
        "ofv_admin",
        "--pwfile",
        root / "pgpass-init",
        "--auth=scram-sha-256",
        "--encoding=UTF8",
        "--locale=C.UTF-8",
    ],
    check=True,
)
with (root / "pgdata/postgresql.conf").open("a") as f:
    f.write(
        f"\nlisten_addresses='127.0.0.1'\nport=25432\nunix_socket_directories='{root}/socket'\n"
    )
subprocess.run(
    [
        bin / "pg_ctl",
        "-D",
        root / "pgdata",
        "-l",
        root / "logs/postgres-runtime.log",
        "start",
        "-w",
    ],
    check=True,
)
env = {**os.environ, "PGPASSWORD": admin}
subprocess.run(
    [
        bin / "psql",
        "-h",
        "127.0.0.1",
        "-p",
        "25432",
        "-U",
        "ofv_admin",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
    ],
    input=f"CREATE ROLE ofv_user LOGIN PASSWORD '{password}';\nCREATE DATABASE ofv_native OWNER ofv_user;\n",
    text=True,
    env=env,
    check=True,
    stdout=subprocess.DEVNULL,
)
subprocess.run(
    [
        bin / "psql",
        "-h",
        "127.0.0.1",
        "-p",
        "25432",
        "-U",
        "ofv_admin",
        "-d",
        "ofv_native",
        "-v",
        "ON_ERROR_STOP=1",
    ],
    input="CREATE EXTENSION vector; CREATE EXTENSION earthdistance CASCADE;",
    text=True,
    env=env,
    check=True,
    stdout=subprocess.DEVNULL,
)
(root / "redis.conf").write_text(
    f"bind 127.0.0.1\nport 26379\nprotected-mode yes\nrequirepass {redis}\ndir {root}/redis-data\nappendonly yes\nappendfsync everysec\ndaemonize yes\npidfile {root}/redis.pid\nlogfile {root}/logs/redis-runtime.log\n"
)
subprocess.run([root / "local/redis/bin/redis-server", root / "redis.conf"], check=True)
(root / "env").write_text(f"""DB_HOSTNAME=127.0.0.1
DB_PORT=25432
DB_DATABASE_NAME=ofv_native
DB_USERNAME=ofv_user
DB_PASSWORD={password}
DB_VECTOR_EXTENSION=pgvector
DB_BIN_DIRECTORY={bin}
REDIS_HOSTNAME=127.0.0.1
REDIS_PORT=26379
REDIS_PASSWORD={redis}
IMMICH_HOST=127.0.0.1
IMMICH_PORT=2287
IMMICH_MACHINE_LEARNING_URL=http://127.0.0.1:3003
""")
(root / "pgpass").write_text(
    f"127.0.0.1:25432:*:ofv_admin:{admin}\n127.0.0.1:25432:*:ofv_user:{password}\n"
)
(root / "run-env").write_text(f"""export OPENFRAME_CONFIG={root}/env
export OPENFRAME_STATE={root}/state
export PATH={root}/local/node-v24.13.1-linux-x64/bin:{root}/local/ffmpeg:{root}/local/pgsql/bin:$PATH
""")
print(
    "Isolated authenticated PostgreSQL and Redis initialized; private configuration saved."
)
