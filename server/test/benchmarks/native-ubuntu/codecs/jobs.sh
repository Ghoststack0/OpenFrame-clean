#!/usr/bin/env bash
# Remember only the caller's override, not a previous automatic calculation.
codec_jobs_override=${OPENFRAME_BUILD_JOBS:-}
[[ -z "$codec_jobs_override" || "$codec_jobs_override" =~ ^[1-9][0-9]*$ ]] || {
  echo 'OPENFRAME_BUILD_JOBS must be a positive integer' >&2
  exit 1
}
codec_build_jobs() {
  if [[ -n "$codec_jobs_override" ]]; then printf '%s\n' "$codec_jobs_override"; return; fi
  local cpus memory_kb limit directory jobs floor
  cpus=$(nproc)
  memory_kb=$(awk '/MemTotal:/ {print $2}' /proc/meminfo)
  # Walk ancestors too: a parent container can impose the effective memory limit.
  directory="/sys/fs/cgroup$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)"
  while [[ "$directory" == /sys/fs/cgroup* ]]; do
    for limit in "$directory/memory.max" "$directory/memory/memory.limit_in_bytes"; do
      [[ -r "$limit" ]] || continue
      limit=$(< "$limit")
      if [[ "$limit" =~ ^[0-9]+$ ]] && ((limit / 1024 < memory_kb)); then memory_kb=$((limit / 1024)); fi
    done
    [[ "$directory" != /sys/fs/cgroup ]] || break
    directory=${directory%/*}
  done
  # Reserve 2 GiB for Node and the OS, then 768 MiB per compiler process.
  # MemAvailable includes transient application peaks; it must not set concurrency.
  jobs=$(( (memory_kb - 2 * 1024 * 1024) / (768 * 1024) ))
  floor=1
  if ((memory_kb >= 4 * 1024 * 1024)); then floor=4; fi
  ((jobs >= floor)) || jobs=$floor
  ((jobs <= cpus)) || jobs=$cpus
  printf '%s\n' "$jobs"
}
