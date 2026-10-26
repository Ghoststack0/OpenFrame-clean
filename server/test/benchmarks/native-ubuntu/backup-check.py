import gzip, json, os, subprocess, time, urllib.request
from pathlib import Path

root = Path.home() / "openframe-native-validation-20261026"
assert (root / "env").exists()
credentials = json.loads((root / "fixtures/admin.json").read_text())
base = "http://127.0.0.1:2287/api"


def request(path, body=None, token=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = "Bearer " + token
    with urllib.request.urlopen(
        urllib.request.Request(base + path, data=data, headers=headers), timeout=30
    ) as r:
        return r.read()


token = json.loads(request("/auth/login", credentials))["accessToken"]
previous = {
    b["filename"]
    for b in json.loads(request("/admin/database-backups", token=token))["backups"]
}
request("/jobs", {"name": "backup-database"}, token)
for attempt in range(120):
    backups = json.loads(request("/admin/database-backups", token=token))["backups"]
    new = [b for b in backups if b["filename"] not in previous]
    if new:
        break
    time.sleep(0.5)
else:
    raise AssertionError("Backup job did not complete")
backup = request("/admin/database-backups/" + new[0]["filename"], token=token)
sql = gzip.decompress(backup)
assert b"CREATE TABLE" in sql
(root / "logs/application-backup.sql.gz").write_bytes(backup)
bin = root / "local/pgsql/bin"
env = {**os.environ, "PGPASSFILE": str(root / "pgpass")}
common = ["-h", "127.0.0.1", "-p", "25432", "-U", "ofv_admin", "-v", "ON_ERROR_STOP=1"]
subprocess.run(
    [bin / "psql", *common, "-d", "postgres"],
    input="CREATE DATABASE ofv_restore OWNER ofv_user;",
    text=True,
    env=env,
    check=True,
    stdout=subprocess.DEVNULL,
)
with (root / "logs/restore.log").open("wb") as log:
    subprocess.run(
        [bin / "psql", *common, "-d", "ofv_restore", "--single-transaction"],
        input=sql,
        env=env,
        check=True,
        stdout=log,
        stderr=log,
    )
query = "SELECT count(*), string_agg(id::text,',' ORDER BY id) FROM asset;"
counts = []
for db in ["ofv_native", "ofv_restore"]:
    counts.append(
        subprocess.check_output(
            [bin / "psql", *common, "-d", db, "-Atc", query], env=env, text=True
        ).strip()
    )
assert counts[0] == counts[1] and int(counts[0].split("|")[0]) >= 7, (
    "Restored asset IDs differ"
)
check = subprocess.check_output(
    [
        bin / "psql",
        *common,
        "-d",
        "ofv_restore",
        "-Atc",
        "SELECT '[1,2,3]'::vector <=> '[1,2,3]'::vector;",
    ],
    env=env,
    text=True,
).strip()
assert check == "0"
result = {
    "applicationBackup": True,
    "gzipBytes": len(backup),
    "sqlBytes": len(sql),
    "restoreSingleTransaction": True,
    "assetCount": int(counts[0].split("|")[0]),
    "allAssetIdsMatch": True,
    "restoredVectorQuery": True,
}
(root / "logs/backup-restore.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
