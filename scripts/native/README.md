# Native Linux backend

Experimental source installation. An isolated Ubuntu deployment passed API, CPU ML, search, playback and backup/restore checks. Six representative codec previews now match Docker exactly. Broader library checks and an existing-library migration rehearsal remain release gates; retain the Docker deployment and comparison assets. See the [Ubuntu validation record](../../server/test/benchmarks/NATIVE-UBUNTU-VALIDATION.md).

Run the production Node server and CPU machine learning service directly on Linux. PostgreSQL and Redis remain required services. This path builds the existing web client without changing its source.

This is a source installation, not a data migration tool. Back up the database and media before switching an existing installation. Never start the old server and this server against the same database during migration. Keep the same absolute media paths when importing an existing database; changing only `IMMICH_MEDIA_LOCATION` does not rewrite stored paths.

## Prerequisites

Use Node 24 and the repository's pinned pnpm version from `package.json`. The `mise.toml` tool definitions also provide the Extism compiler and Jellyfin FFmpeg. Install those tools before building. The Extism CLI, Binaryen and `extism-js` must be available for the core plugin build.

On Ubuntu install the native system dependencies:

```sh
sudo apt update
sudo apt install postgresql postgresql-contrib redis-server libgomp1 curl unzip build-essential python3-dev pkg-config perl gzip
```

Install the pgvector extension package matching your PostgreSQL major version, for example `postgresql-16-pgvector` on Ubuntu 24.04 with PostgreSQL 16. Package availability depends on your configured PostgreSQL repositories. Use PostgreSQL 14 or newer and Redis 6.2 or newer. Bind both services to loopback and retain authentication. Do not expose their ports to the Internet.

For a user-local PostgreSQL installation, set `DB_BIN_DIRECTORY` to its absolute `bin` directory in the environment file. Backup and restore use this directory for `pg_dump`, `pg_dumpall`, and `psql`. The doctor requires all three executables to match the database server's major version. Without this setting, the existing `/usr/lib/postgresql/<major>/bin` path is used.

Install `uv`, Python 3.13, and Jellyfin FFmpeg 7.1.3-6 using your normal package/tool manager. Generic distribution FFmpeg packages may lack Immich's required codecs or hardware acceleration. Native runtime commands require the source-built codec package below. They fail if it is missing and do not fall back to packaged Sharp. Check representative RAW, HEIC, HDR, SVG and JPEG XL samples from your own library before migration.

Create a dedicated database role and database, using a password you choose:

```sh
sudo -u postgres psql
```

```sql
CREATE ROLE immich LOGIN PASSWORD 'your-password';
CREATE DATABASE immich OWNER immich;
\connect immich
CREATE EXTENSION vector;
CREATE EXTENSION earthdistance CASCADE;
```

`pgvector` is selected for new native installations. Existing VectorChord databases must retain their extension and `DB_VECTOR_EXTENSION=vectorchord`; do not change extensions as part of changing the runtime.

## Build and run

Run as a dedicated unprivileged account. The checkout must remain at the same path after building.

```sh
scripts/native/openframe init
# Edit ~/.config/openframe/env with your database credentials.
scripts/native/openframe build
scripts/native/openframe codecs
scripts/native/openframe resources
scripts/native/openframe doctor
scripts/native/openframe ml
```

Start the backend in another terminal:

```sh
scripts/native/openframe start
```

`codecs` reuses the pinned [Ubuntu source recipes](../../server/test/benchmarks/native-ubuntu/codecs/README.md). It requires Ubuntu 24.04 x86-64, Python 3.12+, apt-get, dpkg-deb, a C/C++ compiler, make, CMake, Git, autoconf, automake, libtool and flock. It downloads checksum-pinned source archives and Ubuntu development/runtime packages without sudo. Missing pinned archives or package versions fail the build. Run it after `build`, with the backend stopped. Retain build logs and allow substantial build time on small CPUs.

The default codec directory is `${XDG_DATA_HOME:-$HOME/.local/share}/openframe/codecs`. Set `OPENFRAME_CODECS=/absolute/path/codecs` in the private configuration to build or select another directory. The directory includes source-built libraries, extracted Ubuntu libraries, ImageMagick's pinned upstream security policy and a separately built Sharp package. `doctor`, `start` and `admin` select that package through a Node preload and set library/policy paths for child processes and workers. The checkout's Sharp dependency link remains unchanged. Keep the codec directory and checkout at their build paths. Stop services before rebuilding either dependencies or codecs.

The server binds to `127.0.0.1:2283`. Use an authenticated TLS reverse proxy for remote access, or explicitly set `IMMICH_HOST` for a trusted LAN. The server performs its normal database migrations at startup. Stop it with Ctrl+C. `scripts/native/openframe admin --help` exposes the existing administration commands.

`OPENFRAME_CONFIG` selects a trusted Bash environment file. `OPENFRAME_STATE` selects the persistent state directory. Defaults follow XDG, under `~/.config/openframe` and `~/.local/state/openframe`. The environment file is shell code and must only be writable by the service account. Quote passwords that contain shell characters. The CLI never overwrites existing configuration.

Media, generated web/plugin files, geodata and ML caches live under the state directory. Geodata downloads occur only on the explicit `resources` command. They use the upstream GeoNames and Natural Earth datasets and require their attribution and licensing terms. Do not refresh these resources while the server is running.

Machine learning runs on CPU with one normal service process and loads the existing model settings. GPU acceleration requires the corresponding native runtime libraries and ML extra; the CPU command does not install CUDA, ROCm or OpenVINO. Configure the ML URL through the server administration UI if an existing database already has a container hostname saved. The environment default applies to new configurations.

## Start at login with systemd

Create `~/.config/systemd/user/openframe.service`, replacing `/absolute/path/OpenFrame-clean` with this checkout's actual path:

```ini
[Unit]
Description=OpenFrame native backend
After=network.target

[Service]
Type=simple
# Set these directories to the installed Node 24 and Jellyfin FFmpeg locations.
Environment=PATH=/absolute/path/to/node24/bin:/absolute/path/to/jellyfin-ffmpeg/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/absolute/path/OpenFrame-clean/scripts/native/openframe start
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
NoNewPrivileges=true
UMask=0077

[Install]
WantedBy=default.target
```

Create a second unit `openframe-ml.service` with the same contents, changing the description and replacing `start` with `ml`. For a custom config or state directory add `Environment=OPENFRAME_CONFIG=/absolute/path/env` and `Environment=OPENFRAME_STATE=/absolute/path/state` to both units.

```sh
systemctl --user daemon-reload
systemctl --user enable --now openframe-ml openframe
journalctl --user -u openframe -u openframe-ml -f
```

To keep user services running after logout, an administrator can enable lingering with `loginctl enable-linger ACCOUNT`. PostgreSQL and Redis must be enabled separately as system services. The application retries unavailable dependencies through its existing startup behavior; inspect the logs if it restarts.

No CPU governor, global sysctl, concurrency or codec defaults are changed. Tune actual media job concurrency in the existing administration UI after measuring the target hardware. Native deployment alone does not establish a speed or power improvement.

## Checks

```sh
scripts/native/check.sh
curl --fail http://127.0.0.1:2283/api/server/ping
curl --fail http://127.0.0.1:3003/ping
```

The CLI self-check uses temporary state, mock command dispatch and real Node import/worker checks. It checks configuration permissions, overwrite refusal, dispatch, native path defaults and credential-file precedence. `doctor` checks runtime artifacts, authenticates to PostgreSQL and Redis using the server configuration, checks database and vector extension versions, executes a vector operation, checks matching Ubuntu PostgreSQL backup/restore executables, round-trips JPEG/PNG/WebP/JPEG XL with Sharp, decodes SVG, requires HEIF and ImageMagick buffer loaders, verifies TIFF uses the source jpegli decoder, checks the pinned loaded ImageMagick policy and forbidden LABEL denial, and encodes/probes a tiny H.264 video with FFmpeg. It reports HEIC/RAW capability flags but does not prove HEIC/RAW/HDR parity, exercise uploads or measure power. Representative codec parity and an existing-library migration rehearsal remain required before removing the container deployment files.
