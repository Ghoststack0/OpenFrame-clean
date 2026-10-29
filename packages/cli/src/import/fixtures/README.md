# Synthetic import fixtures

These archives contain a generated one-pixel PNG, synthetic JSON metadata, and a text note. They contain no private photos.

- `media.zip`: a deflated PNG and a stored text entry.
- `metadata.zip`: the PNG's JSON sidecar in a separate archive part.
- `unsafe.zip`: the same PNG under `../outside.png`, used to verify traversal rejection.

Tests generate TGZ fixtures in temporary directories with `tar-stream` and Node's gzip implementation.
