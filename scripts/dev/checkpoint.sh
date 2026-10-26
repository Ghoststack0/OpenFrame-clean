#!/usr/bin/env bash
# Local checkpoints only. This never pushes.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

checkpoint() {
  for state in MERGE_HEAD rebase-merge rebase-apply index.lock; do
    [[ ! -e "$(git rev-parse --git-path "$state")" ]] || return 0
  done
  git add --all
  if ! git diff --cached --quiet; then
    git commit -m "checkpoint: backend work in progress $(date -u +%FT%TZ)"
  fi
}

if [[ "${1:-}" == --once ]]; then
  checkpoint
else
  [[ $# == 0 ]] || { echo 'Usage: checkpoint.sh [--once]' >&2; exit 2; }
  exec 9>"$(git rev-parse --git-path openframe-checkpoint.lock)"
  flock -n 9 || exit 0
  while true; do
    sleep 900
    checkpoint || echo 'Checkpoint failed; retrying in 15 minutes.' >&2
  done
fi
