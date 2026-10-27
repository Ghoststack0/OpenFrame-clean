# OpenFrame CLI

A command-line client for OpenFrame, a fork of [Immich](https://immich.app/).

After building and installing this package, run `openframe --help`. The `immich` command remains available, and existing `IMMICH_*` environment variables and `.config/immich/` credentials continue to work.

Desktop folder sync is available with `openframe sync <folder>`. It watches and uploads recursively; add `--download` for server originals or `--once` for scheduled runs. Deletion propagation requires explicit flags. See [desktop sync documentation](../../docs/docs/features/command-line-interface.md#desktop-folder-sync) for options, state format, and a systemd user service.

The client retains the commands described in the [upstream Immich CLI documentation](https://docs.immich.app/features/command-line-interface).

# For developers

Before building the CLI, you must build the OpenFrame server and the open-api client. You can use the following command:

    $ mise //:open-api

## Run from build

Go to the cli folder and build it:

    $ pnpm install
    $ pnpm run build
    $ node dist/index.js

## Run and Debug from source (VSCode)

With VScode you can run and debug the OpenFrame CLI. Go to the launch.json file, find the Immich CLI config and change this with the command you need to debug

`"args": ["upload", "--help"],`

replace that for the command of your choice.

## Install from build

You can also build and install the CLI using

    $ pnpm run build
    $ pnpm install -g .

---
