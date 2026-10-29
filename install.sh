#!/usr/bin/env bash
set -euo pipefail
umask 077
shopt -s extglob

# fd 6 is the user's terminal (stdout) and fd 4 is stderr. Once building starts,
# fd 1 and 2 go to a private log so tool output never scribbles over the screen.
exec 4>&2 6>&1

# ── Look and feel ────────────────────────────────────────────────────────────
# Same design language as the also.codes CLI: a braille-dot wordmark, a rail of
# ┌ │ ◆ ◇ └ steps and one accent colour. Piped output (CI, tests) stays plain.
fancy=false
if [[ -t 6 && "${TERM:-dumb}" != dumb ]]; then
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) fancy=true ;; esac
fi
truecolor=false
[[ "${COLORTERM:-}" != @(truecolor|24bit) ]] || truecolor=true
tone() { if "$truecolor"; then printf '\033[38;2;%sm' "$1"; else printf '\033[38;5;%sm' "$2"; fi; }
if "$fancy" && [[ -z "${NO_COLOR:-}" ]]; then
  # Ink is the terminal's own foreground so light and dark themes both stay readable.
  ink=$'\033[39m' mute="$(tone '163;158;150' 247)" faint="$(tone '92;88;83' 240)"
  accent="$(tone '239;90;0' 202)" good="$(tone '70;201;125' 78)" danger="$(tone '255;106;77' 203)"
  bold=$'\033[1m' unbold=$'\033[22m' off=$'\033[0m'
  if "$truecolor"; then pill_on=$'\033[48;2;239;90;0;38;2;11;11;12;1m'; else pill_on=$'\033[48;5;202;38;5;232;1m'; fi
else
  ink='' mute='' faint='' accent='' good='' danger='' bold='' unbold='' off='' pill_on=''
fi
if "$fancy"; then
  g_bar='│' g_top='┌' g_end='└' g_act='◆' g_done='◇' g_fail='▲' g_wait='○' g_ok='✓' g_warn='!'
  spinner='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
else
  g_bar='' g_top='' g_end='' g_act='>' g_done='ok' g_fail='FAILED' g_wait='-' g_ok='ok' g_warn='!'
  spinner='-'
fi
cols=80
measure() {
  if "$fancy"; then
    cols="$(tput cols 2>/dev/null || echo 80)"
  fi
  return 0
}
measure

# "openframe" in the pixel letterforms of the also.codes wordmark (Geist Pixel
# Square), drawn in braille dots. Columns 0-27 spell "open", the rest "frame".
WORDMARK=(
  '                               ⣾⠟⠃'
  '⢀⣴⠶⠶⣦⡀ ⢰⣆⠴⠶⢶⣄  ⢀⣴⠶⠶⣦⡀ ⢰⣦⠶⠶⢦⣄ ⠰⠶⣿⠶⠆ ⣶⡴⠶⠆ ⣠⡴⠶⠶⣤  ⣶⡴⠶⣦⡤⠶⢶⣄  ⣠⡶⠶⢶⣄'
  '⣾⠁  ⠈⣷ ⢸⡏   ⢹⡆ ⣾⣁⣀⣀⣈⣷ ⢸⡇   ⣿   ⣿   ⣿    ⠉⢀⣀⣀⣼⡇ ⣿  ⢸⡇  ⣿ ⢰⣏⣀⣀⣀⣹⡆'
  '⢿⡀  ⢀⡿ ⢸⣇   ⣸⠇ ⢿⡉⠉⠉⠉⣉ ⢸⡇   ⣿   ⣿   ⣿    ⣾⠋⠉⠉⢸⡇ ⣿  ⢸⡇  ⣿ ⠸⣏⠉⠉⠉⢉⡁'
  '⠈⠻⠶⠶⠟⠁ ⢸⡏⠲⠶⠾⠋  ⠈⠻⠶⠶⠞⠋ ⠸⠇   ⠿   ⠿   ⠿    ⠙⠶⠶⠖⠙⠇ ⠿  ⠸⠇  ⠿  ⠙⠷⠶⠶⠛⠁'
  '       ⠸⠇'
)
say() { printf '%s\n' "$*" >&6; }
rail() {
  local text="${1:-}" plain width=$((cols - 6)) cut lead=''
  if [[ -z "$g_bar" ]]; then
    if [[ -n "$text" ]]; then say "  $text"; fi
    return 0
  fi
  plain="${text//$'\033'\[*([0-9;])m/}"
  if ((${#plain} <= width)) || [[ "$plain" == *$'\033'* ]]; then
    say "  $faint$g_bar$off${text:+  $text}"
    return 0
  fi
  # Too wide for this terminal: word-wrap the text under the rail in its leading colour.
  if [[ "$text" =~ ^($'\033'\[[0-9\;]*m)+ ]]; then lead="${BASH_REMATCH[0]}"; fi
  while ((${#plain} > width)); do
    cut="${plain:0:width}"
    if [[ "$cut" == *' '* ]]; then cut="${cut% *}"; fi
    say "  $faint$g_bar$off  $lead$cut$off"
    plain="${plain:${#cut}}"
    plain="${plain# }"
  done
  say "  $faint$g_bar$off  $lead$plain$off"
}
step_line() { say "  $1$off  $bold$2$unbold${3:+  $mute$3$off}"; }
key_hint() { printf '%s%s%s %s%s%s' "$ink" "$1" "$off" "$faint" "$2" "$off"; }
pill() { if [[ -n "$pill_on" ]]; then printf '%s  %s  %s' "$pill_on" "$1" "$off"; else printf '[ %s ]' "$1"; fi; }
clean() {
  # One printable line for the dashboard: no escape sequences, no control bytes.
  local s="${1//$'\033'\[*([0-9;?])[A-Za-z]/}"
  s="${s//[$'\001'-$'\037'$'\177']/}"
  printf '%s' "$s"
}
fit() { local s="$1" n="$2"; if ((n <= 1)); then printf ''; elif ((${#s} > n)); then printf '%s…' "${s:0:n-1}"; else printf '%s' "$s"; fi; }
tilde() { if [[ "$1" == "$HOME"/* ]]; then printf '~%s' "${1#"$HOME"}"; else printf '%s' "$1"; fi; }
duration() {
  local s=$1
  if ((s >= 3600)); then printf '%dh %02dm' $((s / 3600)) $((s % 3600 / 60))
  elif ((s >= 60)); then printf '%dm %02ds' $((s / 60)) $((s % 60))
  else printf '%ds' "$s"; fi
}
clock() { printf '%d:%02d' $(($1 / 60)) $(($1 % 60)); }
cursor() { if "$fancy"; then printf '\033[?25%s' "$1" >&6; fi; }

intro() {
  say ''
  if "$fancy" && ((cols >= 70)); then
    local paint line
    if [[ -n "$off" ]]; then
      cursor l
      for paint in "$faint" "$mute"; do
        for line in "${WORDMARK[@]}"; do say "  $paint$line$off"; done
        printf '\033[%dA' "${#WORDMARK[@]}" >&6
        sleep 0.07
      done
      cursor h
    fi
    for line in "${WORDMARK[@]}"; do say "  $ink${line:0:28}$accent${line:28}$off"; done
  else
    say "  $bold${ink}open$accent${bold}frame$off"
  fi
  say ''
  say "  ${mute}Your own photo library, on your own computer.$off"
  say ''
}

# ── Errors ───────────────────────────────────────────────────────────────────
fail_reason=()
fail() {
  local title="$1" line
  shift
  # During the build, the exit handler prints one combined report.
  if "$installing"; then fail_reason=("$title" "$@"); exit 1; fi
  if [[ -n "$g_bar" ]]; then
    printf '  %s%s%s  %s%s%s\n' "$danger" "$g_fail" "$off" "$bold" "$title" "$unbold" >&4
    for line in "$@"; do printf '  %s%s%s  %s%s%s\n' "$faint" "$g_bar" "$off" "$mute" "$line" "$off" >&4; done
    printf '  %s%s%s\n\n' "$faint" "$g_end" "$off" >&4
  else
    printf 'Error: %s\n' "$title" >&4
    for line in "$@"; do printf '  %s\n' "$line" >&4; done
  fi
  exit 1
}
need() { command -v "$1" >/dev/null || fail "Missing command: $1" 'See scripts/native/README.md for native prerequisites.'; }
valid_path() {
  [[ "$1" != *[\'\\\$\`\"%]* && "$1" != *$'\n'* && "$1" != *$'\r'* ]] ||
    fail 'Paths cannot contain quotes, backslashes, dollar signs, backticks, percent signs, or line breaks.'
}

# ── Questions ────────────────────────────────────────────────────────────────
interactive=false
prompt() {
  local answer
  if [[ -n "$g_bar" ]]; then
    printf '  %s%s%s  %s %s%s%s %s›%s ' "$faint" "$g_bar" "$off" "$2" "$faint" "${4:-$3}" "$off" "$accent" "$off" >&6
  else
    printf '  %s [%s]: ' "$2" "${4:-$3}" >&2
  fi
  IFS= read -r answer <&3 || fail 'Input closed. Setup cancelled.'
  printf -v "$1" '%s' "${answer:-$3}"
}
read_key() {
  local key rest=''
  IFS= read -rsn1 key <&3 || key=q
  if [[ "$key" == $'\033' ]]; then IFS= read -rsn2 -t 0.05 rest <&3 || true; fi
  case "$key$rest" in
    $'\033[A'|k) printf up ;;
    $'\033[B'|j) printf down ;;
    ''|$'\n'|$'\r') printf enter ;;
    $'\033'|q|Q|n|N) printf quit ;;
    *) printf '%s' "${key,,}" ;;
  esac
}
# Arrow-key menu on a terminal; returns the chosen index in $choice.
menu() {
  local title="$1" hints="$2" selected=0 i key count drawn=false
  shift 2
  count=$#
  local -a options=("$@")
  cursor l
  while true; do
    if "$drawn"; then printf '\033[%dA' $((count + 4)) >&6; fi
    printf '\r\033[K' >&6; step_line "$accent$g_act" "$title"
    for ((i = 0; i < count; i++)); do
      printf '\r\033[K' >&6
      if ((i == selected)); then rail "$accent●$off $bold${options[i]}$unbold"
      else rail "$faint○ ${options[i]}$off"; fi
    done
    printf '\r\033[K' >&6; rail
    printf '\r\033[K' >&6; rail "$hints"
    printf '\r\033[K' >&6; rail
    drawn=true
    key="$(read_key)"
    case "$key" in
      up) selected=$(((selected + count - 1) % count)) ;;
      down) selected=$(((selected + 1) % count)) ;;
      enter) break ;;
      quit) selected=$((count - 1)); break ;;
      y|i) selected=0; break ;;
      c) if ((count > 2)); then selected=1; break; fi ;;
    esac
  done
  # Collapse the menu into a single answered step, like the also.codes CLI.
  printf '\033[%dA\033[J' $((count + 4)) >&6
  step_line "$good$g_done" "$title" "${options[selected]}"
  rail
  cursor h
  choice=$selected
}

# ── Live dashboard ───────────────────────────────────────────────────────────
ids=(tools database web codecs ml resources services)
declare -A name=(
  [tools]='System tools' [database]='Private database' [web]='Web app & server'
  [codecs]='Photo & RAW codecs' [ml]='Smart search' [resources]='Maps & places' [services]='Start OpenFrame'
)
# Rough first-install durations in seconds, only used to move the progress bar.
# Measured cold on a 12-thread laptop; slower machines scale the bar, not the order.
declare -A expect=([tools]=90 [database]=5 [web]=150 [codecs]=320 [ml]=140 [resources]=50 [services]=30)
declare -A state=() began=() ended=() detail=()
for id in "${ids[@]}"; do state[$id]=pending; done
tips=(
  'The first account you create becomes the administrator.'
  'Everything stays on this computer. No cloud account is needed.'
  'Smart search finds photos from a description, like “dog on a beach”.'
  'Your phone can back up photos to OpenFrame over Wi-Fi.'
  'Run  openframe status  any time to check that everything is running.'
  'The first build is the slow one. Running the installer again skips finished work.'
)
install_log='' install_dir='' progress_dir='' dashboard_live=false drawn_lines=0 frame=0
started_at=$SECONDS last_detail_refresh=-1 resized=false installing=false services_created=false
trap 'resized=true' WINCH

set_state() {
  local id="$1" new="$2"
  [[ "${state[$id]}" != "$new" ]] || return 0
  state[$id]="$new"
  case "$new" in
    running) began[$id]=$SECONDS ;;
    done|skipped|failed) began[$id]="${began[$id]:-$SECONDS}"; ended[$id]=$SECONDS ;;
  esac
  if ! "$fancy"; then
    case "$new" in
      running) say "  $g_act ${name[$id]}" ;;
      done) say "  $g_done ${name[$id]} ($(duration $((ended[$id] - began[$id]))))" ;;
      skipped) say "  $g_done ${name[$id]} (already done)" ;;
      failed) say "  $g_fail ${name[$id]}" ;;
    esac
  fi
}
read_tasks() {
  local id value
  [[ -n "$progress_dir" ]] || return 0
  for id in web codecs ml resources; do
    if [[ -f "$progress_dir/$id.status" ]]; then
      IFS= read -r value < "$progress_dir/$id.status" || value=''
      case "$value" in pending|running|done|skipped|failed) set_state "$id" "$value" ;; esac
    fi
  done
}
refresh_details() {
  local id line
  for id in "${ids[@]}"; do
    [[ "${state[$id]}" == running ]] || { detail[$id]=''; continue; }
    line=''
    if [[ -n "$progress_dir" && -s "$progress_dir/$id.detail" ]]; then
      IFS= read -r line < "$progress_dir/$id.detail" || true
    elif [[ -n "$progress_dir" && -s "$progress_dir/$id.log" ]]; then
      line="$(tail -n 1 "$progress_dir/$id.log" 2>/dev/null || true)"
    elif [[ "$id" != @(web|codecs|ml|resources) && -s "$install_log" ]]; then
      line="$(tail -n 1 "$install_log" 2>/dev/null || true)"
    fi
    detail[$id]="$(clean "$line")"
  done
}
percent() {
  local id total=0 done_weight=0 weight elapsed part
  for id in "${ids[@]}"; do
    weight=${expect[$id]} total=$((total + weight))
    case "${state[$id]}" in
      done|skipped) done_weight=$((done_weight + weight)) ;;
      running)
        elapsed=$((SECONDS - began[$id])) part=$((weight * elapsed / ${expect[$id]}))
        ((part < weight * 95 / 100)) || part=$((weight * 95 / 100))
        done_weight=$((done_weight + part)) ;;
    esac
  done
  printf '%d' $((done_weight * 100 / total))
}
row() {
  local id="$1" glyph time='' text width=$((cols - 41))
  case "${state[$id]}" in
    pending) glyph="$faint$g_wait" ;;
    running) glyph="$accent${spinner:frame % ${#spinner}:1}"; time="$(clock $((SECONDS - began[$id])))" ;;
    done) glyph="$good$g_done"; time="$(duration $((ended[$id] - began[$id])))" ;;
    skipped) glyph="$good$g_done"; time='done' ;;
    failed) glyph="$danger$g_fail"; time="$(duration $((ended[$id] - began[$id])))" ;;
  esac
  text="$(printf '%-20s' "${name[$id]}")"
  if [[ "${state[$id]}" == pending ]]; then text="$faint$text$off"; else text="$ink$text$off"; fi
  local note=''
  if [[ "${state[$id]}" == running ]]; then note="$(fit "${detail[$id]:-}" "$width")"; fi
  printf '  %s%s%s  %s%s  %s%s%6s%s   %s%s%s' "$faint" "$g_bar" "$off" "$glyph" "$off" "$text" \
    "$faint" "$time" "$off" "$faint" "$note" "$off"
}
draw_dashboard() {
  "$fancy" || return 0
  local -a out=()
  local id pct width filled bar elapsed=$((SECONDS - started_at)) tip
  if "$resized"; then
    resized=false; measure
    printf '\033[H\033[2J' >&6
    step_line "$accent$g_act" 'Installing OpenFrame'; rail "${faint}build log$off $mute$(tilde "$install_log")$off"
    drawn_lines=0
  fi
  if ((SECONDS != last_detail_refresh)); then refresh_details; last_detail_refresh=$SECONDS; fi
  frame=$((frame + 1))
  out+=("  $faint$g_bar$off")
  for id in "${ids[@]}"; do out+=("$(row "$id")"); done
  out+=("  $faint$g_bar$off")
  pct="$(percent)"
  width=$((cols - 30))
  ((width <= 40)) || width=40
  ((width >= 10)) || width=10
  filled=$((width * pct / 100))
  printf -v bar '%*s' "$filled" ''; bar="${bar// /━}"
  local rest; printf -v rest '%*s' $((width - filled)) ''; rest="${rest// /─}"
  out+=("  $faint$g_bar$off  $accent$bar$faint$rest$off  $bold$pct%$unbold  $faint$(clock "$elapsed")$off")
  tip="${tips[elapsed / 8 % ${#tips[@]}]}"
  out+=("  $faint$g_bar$off  ${faint}tip$off  $mute$(fit "$tip" $((cols - 12)))$off")
  if ((drawn_lines > 0)); then printf '\033[%dA' "$drawn_lines" >&6; fi
  local line
  for line in "${out[@]}"; do printf '\r%s\033[K\n' "$line" >&6; done
  drawn_lines=${#out[@]}
}
start_dashboard() {
  if "$fancy"; then
    step_line "$accent$g_act" 'Installing OpenFrame'; rail "${faint}build log$off $mute$(tilde "$install_log")$off"
    cursor l
  else
    say "Installing OpenFrame. Build log: $install_log"
  fi
  dashboard_live=true
  draw_dashboard
}
finish_dashboard() {
  "$dashboard_live" || return 0
  dashboard_live=false
  if "$fancy"; then
    refresh_details
    draw_dashboard
    # Drop the tip and progress lines; the rows are the record of what happened.
    printf '\033[3A\033[J' >&6
    cursor h
  fi
}
phase() { local id; for id in "${ids[@]}"; do [[ "${state[$id]}" != running || "$id" == "$1" ]] || set_state "$id" 'done'; done; set_state "$1" running; draw_dashboard; }
watch() {
  # Animate the dashboard while a background command runs; returns its status.
  local pid=$1 status=0 tick=0
  while kill -0 "$pid" 2>/dev/null; do
    read_tasks
    draw_dashboard
    sleep 0.1
    tick=$((tick + 1))
  done
  wait "$pid" || status=$?
  read_tasks
  draw_dashboard
  return "$status"
}
run() { "$@" & watch $!; }
kill_tree() {
  local child
  if command -v pgrep >/dev/null; then
    for child in $(pgrep -P "$1" 2>/dev/null || true); do kill_tree "$child"; done
  fi
  kill -TERM "$1" 2>/dev/null || true
}

on_interrupt() {
  local job
  for job in $(jobs -p); do kill_tree "$job"; done
  if "$dashboard_live"; then finish_dashboard; fi
  cursor h
  exec 1>&6 2>&4
  rail
  say "  $faint$g_end$off  ${mute}Cancelled. Run the installer again to pick up where you left off.$off"
  say ''
  trap - EXIT
  exit 130
}
on_exit() {
  local status=$? id failed='' log line
  cursor h
  ((status != 0)) && "$installing" || return 0
  for id in "${ids[@]}"; do
    if [[ "${state[$id]}" == failed ]]; then failed=$id; fi
  done
  if [[ -z "$failed" ]]; then
    for id in "${ids[@]}"; do if [[ "${state[$id]}" == running ]]; then failed=$id; fi; done
    if [[ -n "$failed" ]]; then set_state "$failed" failed; fi
  fi
  finish_dashboard
  # The failure report goes to stderr, which is the same terminal.
  exec 1>&6 2>&4 6>&4
  log="$install_log"
  if [[ -n "$failed" && -n "$progress_dir" && -s "$progress_dir/$failed.log" ]]; then log="$progress_dir/$failed.log"; fi
  rail
  if [[ -n "$failed" ]]; then
    step_line "$danger$g_fail" "${name[$failed]} failed" "after $(duration $((ended[$failed] - began[$failed])))"
  else
    step_line "$danger$g_fail" "${fail_reason[0]:-Setup stopped}"
  fi
  if [[ -n "$failed" && -n "${fail_reason[0]:-}" ]]; then rail "$ink${fail_reason[0]}$off"; fi
  for line in "${fail_reason[@]:1}"; do rail "$mute$line$off"; done
  if [[ -s "$log" ]]; then
    rail "${mute}Last lines of its log:$off"
    while IFS= read -r line; do
      rail "  $faint$(fit "$(clean "$line")" $((cols - 9)))$off"
    done < <(tail -n 12 "$log")
  fi
  rail
  rail "$(printf '%s%-10s%s %s' "$faint" 'Full log' "$off" "$log")"
  if "$services_created"; then
    rail "$(printf '%s%-10s%s %s' "$faint" 'Services' "$off" 'journalctl --user -u openframe -u openframe-ml -u openframe-db -u openframe-redis')"
  elif [[ -f "$install_dir/.openframe-docker" ]]; then
    rail "Files are kept in $(tilde "$install_dir"). Resume with --docker --dir '$install_dir'."
  elif [[ -f "$install_dir/env" && -f "$install_dir/postgres/PG_VERSION" && -f "$install_dir/redis.conf" ]]; then
    rail "$(printf '%s%-10s%s Files are kept in %s.' "$faint" 'Resume' "$off" "$(tilde "$install_dir")")"
    rail "$(printf '%-10s Fix the problem, then run the installer again with %s--dir %s%s.' '' "$bold" "$(tilde "$install_dir")" "$unbold")"
    rail "$(printf '%-10s %sFinished work is skipped.%s' '' "$mute" "$off")"
  elif [[ -n "$install_dir" && -d "$install_dir" ]]; then
    rail "$(printf '%s%-10s%s Files are kept in %s. Remove that folder before trying again.' "$faint" 'Retry' "$off" "$(tilde "$install_dir")")"
  fi
  say "  $faint$g_end$off  ${bold}Setup stopped.$unbold"
  say ''
}

usage() {
  cat <<'HELP'
OpenFrame installer

Usage
  bash install.sh                 Guided setup (recommended)
  bash install.sh --yes           Accept defaults, no questions

Options
  --dir PATH     Installation folder (default: ~/openframe)
  --port PORT    Web port, 1024-65535 (default: 2283)
  --docker       Use Docker and Compose (fast image downloads)
  --native       Build and run directly on the host
  --resume       Resume an interrupted install (detected automatically)
  --with-ml      Install ML and preload models in the background
  --without-ml   Disable ML (default)
  --yes          Use defaults without prompts
  --help         Show this help

Supports Ubuntu 24.04 and Arch/Omarchy on x86-64.
Docker with Compose v2+ is recommended. Native mode: No Docker required.
Docker mode downloads pinned OpenFrame images, building locally if unavailable.
Native mode builds from source and runs systemd user services with private PostgreSQL and Valkey/Redis instances on loopback ports 5433 and 6380.
Prerequisites: scripts/native/README.md
HELP
}
port_free() {
  python3 - "$@" <<'PORTS'
import socket
import sys
for port in map(int, sys.argv[1:]):
    sock = socket.socket()
    try:
        sock.bind(("0.0.0.0", port))
    except OSError:
        sys.exit(f"Port {port} is already in use")
    finally:
        sock.close()
PORTS
}
copy_text() {
  local tool
  for tool in wl-copy 'xclip -selection clipboard' 'xsel --clipboard --input'; do
    if command -v "${tool%% *}" >/dev/null && printf '%s' "$1" | $tool >/dev/null 2>&1; then return 0; fi
  done
  # OSC 52 asks the terminal itself to set the clipboard.
  printf '\033]52;c;%s\a' "$(printf '%s' "$1" | base64 | tr -d '\n')" >&6
}

docker_usable() {
  command -v docker >/dev/null &&
    docker compose version --short 2>/dev/null | grep -Eq '^v?([2-9]|[1-9][0-9]+)\.' &&
    docker info >/dev/null 2>&1
}
docker_compose() { docker compose --project-directory "$install_dir" "$@"; }
docker_install() {
  local tag project attempt ready=false
  docker_usable || fail 'Docker is unavailable.' 'Install Docker with Compose v2+ and grant your user access, or use --native.'
  for action in git curl python3 od tr; do need "$action"; done
  # shellcheck disable=SC2015 # fail exits
  [[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] && ((port >= 1024 && port <= 65535)) || fail 'Port must be a number from 1024 to 65535.'
  install_dir="$(realpath -m -- "$install_dir")"
  valid_path "$install_dir"
  if [[ -f "$install_dir/.openframe-docker" && -f "$install_dir/.env" && -f "$install_dir/compose.yml" ]]; then
    resume=true
    port="$(sed -n 's/^OPENFRAME_PORT=//p' "$install_dir/.env")"
  else
    "$resume" && fail 'Cannot resume: this is not a Docker installation.'
    [[ ! -e "$install_dir" && ! -L "$install_dir" ]] || fail "Folder already exists: $install_dir" 'Existing files are never overwritten.'
    port_free "$port" || fail "Port $port is already in use"
  fi
  rail "Docker installation: $(tilde "$install_dir") at http://localhost:$port"
  rail 'A few minutes downloading published images. Unpublished images build locally and take longer.'
  if ! "$yes" && ! "$decided"; then
    if "$interactive"; then
      menu 'Ready when you are' "$(key_hint enter install)" 'Install OpenFrame' 'Cancel'
      ((choice == 0)) || exit 0
    else
      prompt reply 'Install OpenFrame?' Y 'Y/n'
      [[ "$reply" == [yY]* ]] || exit 0
    fi
  fi
  ids=(check pull build start health)
  name=([check]='Check Docker' [pull]='Pull images' [build]='Local image fallback' [start]='Start OpenFrame' [health]='Wait for health')
  expect=([check]=5 [pull]=180 [build]=600 [start]=10 [health]=60)
  for action in "${ids[@]}"; do state[$action]=pending; done
  install_log="$(mktemp "${TMPDIR:-/tmp}/openframe-install.XXXXXXXX.log")"
  exec >>"$install_log" 2>&1
  installing=true
  trap on_exit EXIT
  start_dashboard
  phase check
  mkdir -p -- "$install_dir"
  source_dir="$script_dir"
  [[ -f "$source_dir/server/Dockerfile" ]] || fail 'Docker fallback requires a full source checkout.'
  if ! "$resume"; then
    tag="commit-$(git -C "$source_dir" rev-parse HEAD)"
    project="openframe-$(printf %s "$install_dir" | sha256sum | cut -c1-12)"
    cp "$source_dir/docker/openframe/compose.yml" "$install_dir/compose.yml"
    cp "$source_dir/docker/openframe/build.yml" "$install_dir/build.yml"
    password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ ${#password} == 64 ]] || fail 'Could not generate a database password.'
    cat > "$install_dir/.env" <<ENV
COMPOSE_PROJECT_NAME=$project
OPENFRAME_SERVER_IMAGE=ghcr.io/ghoststack0/openframe-server:$tag
OPENFRAME_ML_IMAGE=ghcr.io/ghoststack0/openframe-machine-learning:$tag
OPENFRAME_PORT=$port
OPENFRAME_SOURCE='$source_dir'
DB_HOSTNAME=database
DB_PORT=5432
DB_USERNAME=postgres
DB_DATABASE_NAME=immich
DB_PASSWORD=$password
REDIS_HOSTNAME=redis
IMMICH_MACHINE_LEARNING_ENABLED=$with_ml
IMMICH_MACHINE_LEARNING_URL=http://immich-machine-learning:3003
ENV
    chmod 600 "$install_dir/.env"
    touch "$install_dir/.openframe-docker"
  fi
  run docker_compose config --quiet
  phase pull
  # Compose emits layer byte counts even when stderr is redirected; the dashboard
  # displays the last line of this log as its live row detail. One pull command
  # downloads every image side by side.
  local -a unavailable=()
  if ! run docker_compose --progress plain pull immich-server database redis; then
    run docker_compose --progress plain pull database redis
    # CI publishes an exact-commit image a few minutes after each push. Until then
    # the newest main build beats a local build by many minutes.
    if ! "$resume" && grep -q '^OPENFRAME_SERVER_IMAGE=.*:commit-' "$install_dir/.env"; then
      sed -i 's/^\(OPENFRAME_[A-Z]*_IMAGE=.*\):commit-[0-9a-f]*$/\1:main/' "$install_dir/.env"
      run docker_compose --progress plain pull immich-server || true
    fi
    docker image inspect "$(sed -n 's/^OPENFRAME_SERVER_IMAGE=//p' "$install_dir/.env")" >/dev/null 2>&1 ||
      unavailable+=(immich-server)
  fi
  set_state pull 'done'
  if ((${#unavailable[@]})); then
    phase build
    say '  Published OpenFrame image unavailable; building locally from this checkout.'
    run docker_compose --progress plain -f "$install_dir/compose.yml" -f "$install_dir/build.yml" build "${unavailable[@]}"
    set_state build 'done'
  else
    set_state build skipped
  fi
  phase start
  run docker_compose up -d --pull never --no-build
  phase health
  for ((attempt=0; attempt<180; attempt++)); do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/api/server/ping" >/dev/null; then ready=true; break; fi
    run sleep 2
  done
  "$ready" || fail 'OpenFrame did not become healthy.' "Inspect: docker compose --project-directory '$install_dir' logs"
  cp "$source_dir/scripts/docker/openframe-docker" "$install_dir/openframe"
  chmod 700 "$install_dir/openframe"
  if "$with_ml"; then
    nohup "$install_dir/openframe" ml-setup > "$install_dir/ml-setup.log" 2>&1 </dev/null 4>&- 6>&- &
    disown
  fi
  cli_hint="$install_dir/openframe"
  mkdir -p "$HOME/.local/bin"
  # Never replace a native installation's management command.
  if [[ ! -e "$HOME/.local/bin/openframe" && ! -L "$HOME/.local/bin/openframe" ]]; then
    ln -s "$install_dir/openframe" "$HOME/.local/bin/openframe"
    cli_hint="$HOME/.local/bin/openframe"
  fi
  set_state health 'done'
  finish_dashboard
  trap - EXIT
  installing=false
  exec 1>&6 2>&4
}

main() {
  local with_ml=false ml_explicit=false
  local mode='' decided=false cli_hint
  local port=2283 yes=false resume=false reply script_dir='' source_dir platform platform_name
  local redis_server pg_bin password lan_ip='' server_url unit_dir action free_kb parent missing='' choice=0
  local -a checks=() packages=() required_ports=()
  install_dir="$HOME/openframe"
  while (($#)); do
    case "$1" in
      --dir|--port)
        [[ $# -ge 2 && -n "$2" ]] || fail "Missing value for $1"
        case "$1" in --dir) install_dir="$2" ;; --port) port="$2" ;; esac
        shift 2 ;;
      --docker|--native)
        [[ -z "$mode" || "$mode" == "${1#--}" ]] || fail 'Choose only one of --docker and --native.'
        mode="${1#--}"; shift ;;
      --resume) resume=true; shift ;;
      --with-ml) with_ml=true; ml_explicit=true; shift ;;
      --without-ml) with_ml=false; ml_explicit=true; shift ;;
      --yes|-y) yes=true; shift ;;
      --help|-h) usage; return ;;
      *) fail "Unknown option: $1" 'Run bash install.sh --help for usage.' ;;
    esac
  done
  if ! "$ml_explicit"; then
    for config in "$install_dir/env" "$install_dir/.env"; do
      if [[ -f "$config" ]] && grep -qx 'IMMICH_MACHINE_LEARNING_ENABLED=true' "$config"; then with_ml=true; fi
    done
  fi
  [[ "$(uname -s)" == Linux ]] || fail 'Setup requires Linux.'
  case "$(uname -m)" in
    x86_64|aarch64|arm64) ;;
    *) fail 'Setup requires 64-bit x86 or ARM Linux.' ;;
  esac
  # shellcheck source=/dev/null
  platform="$(. /etc/os-release; printf '%s:%s' "$ID" "${VERSION_ID:-}")"
  case "$platform" in
    ubuntu:24.04) platform=ubuntu platform_name='Ubuntu 24.04' ;;
    arch:*) platform=arch platform_name='Arch Linux' ;;
    omarchy:*) platform=arch platform_name='Omarchy' ;;
    *) platform_name="$platform" ;;
  esac
  ((EUID != 0)) || fail 'Run the installer as your normal user, not root.' 'It asks for sudo only when system packages are missing.'
  if ! "$yes"; then
    exec 3</dev/tty || fail 'No terminal available for questions.' 'Run again with --yes to accept the defaults.'
    if "$fancy" && [[ -t 3 ]]; then interactive=true; fi
  fi
  if ! "$yes" && ! "$ml_explicit"; then
    prompt reply "Install smart search and face recognition in the background?" n
    [[ "$reply" != [yY]* ]] || with_ml=true
  fi
  trap on_interrupt INT TERM
  intro
  say "  $faint$g_top$off  ${bold}Install OpenFrame$unbold"
  rail

  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  # Existing native installs keep their mode even if Docker was added later.
  if [[ -z "$mode" && -f "$install_dir/env" ]]; then mode=native; fi
  if [[ -z "$mode" && -f "$install_dir/.openframe-docker" ]]; then mode=docker; fi
  if [[ -z "$mode" ]] && docker_usable; then
    rail "Folder: $(tilde "$install_dir")   Address: http://localhost:$port"
    if "$yes"; then mode=docker
    elif "$interactive"; then
      menu 'Choose your install' "$(key_hint '↑↓' choose)   $(key_hint enter install)" \
        'Fast install with Docker (recommended, a few minutes)' 'Build natively (about 5-15 minutes)' 'Cancel'
      case "$choice" in 0) mode=docker ;; 1) mode=native ;; *) return ;; esac
      decided=true
    else
      prompt reply 'Install OpenFrame? Docker recommended; n builds natively, q cancels' d 'D/n/q'
      case "$reply" in d|D|y|Y) mode=docker ;; n|N) mode=native ;; *) return ;; esac
      decided=true
    fi
  elif [[ -z "$mode" ]] && command -v docker >/dev/null; then
    # Usually the user is not in the docker group yet; say so instead of silently building.
    rail "${mute}Docker is installed but $(id -un) cannot use it, so OpenFrame will build natively.$off"
    rail "${mute}For the faster Docker install, cancel and run: sudo usermod -aG docker $(id -un), then log in again.$off"
    rail
  fi
  mode="${mode:-native}"
  if [[ "$mode" == docker ]]; then
    docker_install
    ready_screen
    return
  fi

  [[ "$(uname -m)" == x86_64 ]] || fail 'Native builds require x86-64. Use --docker on ARM64.'
  case "$platform" in
    ubuntu|arch) ;;
    *) fail "Unsupported native system: $platform" 'Native setup supports Ubuntu 24.04 and Arch/Omarchy. Use --docker on other Linux systems.' ;;
  esac

  # Everything up to the confirmation is read-only, so declining leaves no trace.
  while true; do
    # shellcheck disable=SC2015 # fail exits, so it only runs when a check is false
    [[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] && ((port >= 1024 && port <= 65535)) || fail 'Port must be a number from 1024 to 65535.'
    [[ "$port" != 5433 && "$port" != 6380 && "$port" != 3003 ]] || fail "Port $port is reserved for OpenFrame's database, cache or machine learning." 'Choose another web port.'
    [[ "$install_dir" == /* ]] || install_dir="$PWD/$install_dir"
    valid_path "$install_dir"
    if ! "$resume" && [[ -d "$install_dir" && ! -L "$install_dir" && -f "$install_dir/env" && -f "$install_dir/postgres/PG_VERSION" && -f "$install_dir/redis.conf" ]]; then
      resume=true
    fi
    if "$resume"; then
      [[ -f "$install_dir/env" && -f "$install_dir/postgres/PG_VERSION" && -f "$install_dir/redis.conf" ]] ||
        fail 'Cannot resume: this is not a prepared native installation.' "Folder: $install_dir"
      # Resume only configuration created by this installer, never reinitialize its database.
      set -a
      # shellcheck source=/dev/null
      source "$install_dir/env"
      set +a
      [[ "${DB_HOSTNAME:-}" == 127.0.0.1 && "${DB_PORT:-}" == 5433 && "${DB_USERNAME:-}" == openframe && "${DB_DATABASE_NAME:-}" == openframe && "${REDIS_PORT:-}" == 6380 && -n "${DB_PASSWORD:-}" ]] ||
        fail 'Cannot resume: database configuration does not match this installer.'
      port="$IMMICH_PORT"
      step_line "$accent$g_act" 'Found an earlier installation' 'picking up where it left off'
      rail "${mute}Its photos, database, settings and port are kept. Finished work is skipped.$off"
      rail
    else
      [[ ! -e "$install_dir" && ! -L "$install_dir" ]] ||
        fail "Folder already exists: $install_dir" 'Existing files are never overwritten. Choose another folder with --dir PATH.'
    fi

    checks=("$good$g_ok$off $mute$platform_name on x86-64$off")
    systemctl --user show-environment >/dev/null 2>&1 || fail 'No working systemd user session.' 'OpenFrame runs as systemd user services. Log in to a normal desktop or SSH session and try again.'
    checks+=("$good$g_ok$off ${mute}Background services (systemd) available$off")
    for action in openframe openframe-ml openframe-db openframe-redis; do
      if systemctl --user cat "$action.service" >/dev/null 2>&1; then
        fail "Service $action already exists." 'Existing installations are never overwritten.' "Check it with: systemctl --user status $action"
      fi
    done
    required_ports=("$port" 5433 6380)
    if "$with_ml"; then required_ports+=(3003); fi
    if command -v python3 >/dev/null; then
      port_free "${required_ports[@]}" 2>/dev/null || fail "$(port_free "${required_ports[@]}" 2>&1 | tail -n 1)" \
        "OpenFrame needs ports ${required_ports[*]} on this machine." 'Stop whatever uses it, or pick another web port with --port.'
      checks+=("$good$g_ok$off ${mute}Ports ${required_ports[*]} are free$off")
    fi
    parent="$install_dir"
    while [[ ! -d "$parent" ]]; do parent="$(dirname -- "$parent")"; done
    free_kb="$(df -Pk -- "$parent" 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
    if [[ "$free_kb" =~ ^[0-9]+$ ]]; then
      if ((free_kb < 15 * 1024 * 1024)); then
        checks+=("$accent$g_warn$off ${ink}Only $((free_kb / 1024 / 1024)) GB free in $(tilde "$parent")$off ${mute}· about 15 GB is needed, plus room for photos$off")
      else
        checks+=("$good$g_ok$off $mute$((free_kb / 1024 / 1024)) GB free in $(tilde "$parent")$off")
      fi
    fi
    if [[ "$platform" == arch ]]; then
      packages=(base-devel mise postgresql pgvector valkey autoconf-archive cmake meson ninja
        libvips libraw libheif libjxl aom dav1d libarchive brotli libcgif libdeflate libexif
        expat libffi glib2 glib2-devel highway jbigkit libjpeg-turbo lcms2 xz pcre2 libpng
        libspng libtiff libwebp zstd zlib librsvg curl unzip git python uv qrencode ccache)
      missing="$(pacman -T "${packages[@]}" || true)"
      if [[ -n "$missing" ]]; then
        checks+=("$accent$g_warn$off $ink$(wc -w <<<"$missing" | tr -d ' ') system packages to install$off ${mute}· asks for your password once$off")
      else
        checks+=("$good$g_ok$off ${mute}System packages are installed$off")
      fi
    fi
    step_line "$good$g_done" 'Your computer is ready' "$platform_name"
    for action in "${checks[@]}"; do rail "$action"; done
    rail

    step_line "$good$g_done" "Here's the plan"
    rail "$faint$(printf '%-9s' Folder)$off $(tilde "$install_dir")"
    rail "$faint$(printf '%-9s' Address)$off http://localhost:$port  ${mute}also reachable from your phone$off"
    rail "$faint$(printf '%-9s' Time)$off about 5-15 minutes  ${mute}the first build compiles from source, more on fewer CPU cores$off"
    rail
    rail "${mute}OpenFrame is built on this computer and then runs quietly in the background. You can leave it alone while it works.$off"
    rail
    if "$yes" || "$decided"; then break; fi
    if "$interactive"; then
      if "$resume"; then
        menu 'Ready when you are' "$(key_hint '↑↓' choose)   $(key_hint enter confirm)   $(key_hint q cancel)" \
          'Continue installing' 'Cancel'
        ((choice == 0)) && break
      else
        menu 'Ready when you are' "$(key_hint '↑↓' choose)   $(key_hint enter confirm)   $(key_hint c 'change folder')   $(key_hint q cancel)" \
          'Install OpenFrame' 'Change folder or port' 'Cancel'
        ((choice == 0)) && break
      fi
      if ((choice == 1)) && ! "$resume"; then reply=c; else reply=n; fi
    elif "$resume"; then
      prompt reply 'Continue installation?' Y 'Y/n'
    else
      prompt reply 'Install OpenFrame?' Y 'Y/n, c to change folder or port'
    fi
    case "$reply" in
      y|Y|yes|YES|Yes) break ;;
      c|C)
        if "$resume"; then rail 'An interrupted install keeps its folder and port.'; rail; continue; fi
        prompt install_dir 'Install folder' "$(tilde "$install_dir")"
        install_dir="${install_dir/#\~/$HOME}"
        prompt port 'Web port' "$port"
        rail ;;
      *)
        say "  $faint$g_end$off  ${mute}Setup cancelled. Nothing was changed.$off"
        say ''
        return ;;
    esac
  done

  install_log="$(mktemp "${TMPDIR:-/tmp}/openframe-install.XXXXXXXX.log")"
  exec >>"$install_log" 2>&1
  installing=true
  trap on_exit EXIT
  if [[ -n "$missing" ]]; then
    # Ask for the password before the dashboard takes over the screen.
    if ! sudo -n true 2>/dev/null; then
      step_line "$accent$g_act" 'Your password, please' 'to install system packages'
      # The redirects are for sudo's own password prompt, not for privileged files.
      # shellcheck disable=SC2024
      sudo -v < /dev/tty >&6 2>&4
      rail
    fi
  fi
  start_dashboard

  phase tools
  if [[ -n "$missing" ]]; then
    sudo -n pacman -S --noconfirm --needed "${packages[@]}" &
    local pacman_pid=$!
  fi
  if command -v mise >/dev/null; then
    local -a tools=(node@24.22.1 pnpm@12.14.0 github:extism/cli@1.6.3
      github:webassembly/binaryen@version_124 github:extism/js-pdk@v1.7.0
      github:jellyfin/jellyfin-ffmpeg@7.1.3-6)
    # Tool downloads go to ~/.local/share/mise, so they overlap with pacman.
    MISE_JOBS="$(nproc 2>/dev/null || echo 4)" run mise install --yes "${tools[@]}"
  fi
  if [[ -n "${pacman_pid:-}" ]]; then watch "$pacman_pid"; fi
  if command -v mise >/dev/null && [[ -n "${tools+x}" ]]; then
    local tool_env
    tool_env="$(mise env --shell bash "${tools[@]}")"
    eval "$tool_env"
  fi
  for action in node pnpm uv extism-js extism wasm-opt ffmpeg ffprobe python3 curl unzip git systemctl pg_config od tr awk cmake make cc c++ autoconf automake libtoolize pkg-config perl gzip flock; do need "$action"; done
  [[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || fail 'Node 24 is required.' 'Install mise, or select Node 24 with your version manager.'
  if [[ "$platform" == ubuntu ]]; then need apt-get; need dpkg-deb; fi
  redis_server="$(command -v valkey-server || command -v redis-server || true)"
  [[ -n "$redis_server" ]] || fail 'Valkey or Redis is required.' 'Ubuntu: sudo apt install redis-server'
  pg_bin="$(pg_config --bindir)"
  for action in initdb pg_ctl postgres psql pg_dump pg_dumpall; do
    [[ -x "$pg_bin/$action" ]] || fail "Missing $pg_bin/$action." 'Install the PostgreSQL server and client tools.'
  done
  [[ -f "$(pg_config --sharedir)/extension/vector.control" ]] || fail 'pgvector is not installed.' 'Install the pgvector package matching your PostgreSQL version.'
  port_free "${required_ports[@]}" || fail 'A required port was taken during setup.' "Ports: ${required_ports[*]}"
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  fi

  phase database
  mkdir -p -- "$(dirname -- "$install_dir")"
  if ! "$resume"; then mkdir -- "$install_dir"; fi
  install_dir="$(cd -- "$install_dir" && pwd)"
  valid_path "$install_dir"
  if "$resume" && [[ -x "$install_dir/source/scripts/native/openframe" ]]; then
    source_dir="$install_dir/source"
  elif [[ -x "$script_dir/scripts/native/openframe" ]]; then
    source_dir="$script_dir"
  else
    run git clone --depth 1 https://github.com/Ghoststack0/OpenFrame-clean.git "$install_dir/source"
    source_dir="$install_dir/source"
  fi
  valid_path "$source_dir"
  export OPENFRAME_STATE="$install_dir/state" OPENFRAME_CONFIG="$install_dir/env"
  if ! "$resume"; then
    "$source_dir/scripts/native/openframe" init
    password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ ${#password} -eq 64 ]] || fail 'Could not generate a database password.'
    cat > "$OPENFRAME_CONFIG" <<ENV
DB_HOSTNAME=127.0.0.1
DB_PORT=5433
DB_USERNAME=openframe
DB_PASSWORD='$password'
DB_DATABASE_NAME=openframe
DB_VECTOR_EXTENSION=pgvector
DB_BIN_DIRECTORY='$pg_bin'
REDIS_HOSTNAME=127.0.0.1
REDIS_PORT=6380
REDIS_PASSWORD='$password'
IMMICH_HOST=0.0.0.0
IMMICH_PORT=$port
IMMICH_MACHINE_LEARNING_ENABLED=$with_ml
IMMICH_MACHINE_LEARNING_URL=http://127.0.0.1:3003
OPENFRAME_CODECS='$install_dir/codecs'
ENV
    "$pg_bin/initdb" -D "$install_dir/postgres" -U "$(id -un)" --auth-host=scram-sha-256 --auth-local=peer
    cat >> "$install_dir/postgres/postgresql.conf" <<PG
listen_addresses = '127.0.0.1'
port = 5433
unix_socket_directories = '$install_dir'
PG
    mkdir "$install_dir/redis"
    cat > "$install_dir/redis.conf" <<REDIS
bind 127.0.0.1
port 6380
protected-mode yes
requirepass $password
dir "$install_dir/redis"
save ""
appendonly no
REDIS
  else
    password="$DB_PASSWORD"
  fi
  set_state database 'done'

  # The web app, codecs, machine learning and map data build side by side.
  progress_dir="$OPENFRAME_STATE/progress"
  mkdir -p "$progress_dir"
  rm -f -- "$progress_dir"/*.status "$progress_dir"/*.detail
  local -a prepare=("$source_dir/scripts/native/openframe" prepare)
  if "$resume"; then prepare+=(--resume); fi
  run "${prepare[@]}"

  phase services
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  # systemd needs the same pinned tools used for the build, including FFmpeg.
  valid_path "$PATH"
  for action in db redis ml server; do
    local unit_name command
    case "$action" in
      db) unit_name=openframe-db; command="\"$pg_bin/postgres\" -D \"$install_dir/postgres\"" ;;
      redis) unit_name=openframe-redis; command="\"$redis_server\" \"$install_dir/redis.conf\"" ;;
      ml) unit_name=openframe-ml; command="\"$source_dir/scripts/native/openframe\" ml" ;;
      server) unit_name=openframe; command="\"$source_dir/scripts/native/openframe\" start" ;;
    esac
    cat > "$unit_dir/$unit_name.service" <<UNIT
[Unit]
Description=OpenFrame native $action
After=network.target

[Service]
Type=simple
Environment="PATH=$PATH"
Environment="OPENFRAME_CONFIG=$OPENFRAME_CONFIG"
Environment="OPENFRAME_STATE=$OPENFRAME_STATE"
ExecStart=$command
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
UNIT
  done
  services_created=true
  systemctl --user daemon-reload
  systemctl --user enable --now openframe-db openframe-redis
  local ready=false
  for ((attempt = 0; attempt < 30; attempt++)); do
    if "$pg_bin/psql" -h "$install_dir" -p 5433 -U "$(id -un)" -d postgres -c 'SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
    run sleep 1
  done
  "$ready" || fail 'PostgreSQL did not start.' 'Inspect: journalctl --user -u openframe-db'
  "$pg_bin/psql" -h "$install_dir" -p 5433 -U "$(id -un)" -d postgres -v ON_ERROR_STOP=1 <<SQL
-- Idempotent, so a folder kept by \`openframe uninstall --keep-data\` reinstalls cleanly.
SELECT 'CREATE ROLE openframe LOGIN PASSWORD ''$password''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openframe')\\gexec
SELECT 'CREATE DATABASE openframe OWNER openframe' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openframe')\\gexec
SQL
  "$pg_bin/psql" -h "$install_dir" -p 5433 -U "$(id -un)" -d openframe -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS earthdistance CASCADE;'
  run "$source_dir/scripts/native/openframe" doctor
  systemctl --user enable --now openframe
  if "$with_ml"; then systemctl --user enable --now --no-block openframe-ml; fi
  ready=false
  for ((attempt = 0; attempt < 60; attempt++)); do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/api/server/ping" >/dev/null; then ready=true; break; fi
    run sleep 1
  done
  "$ready" || fail 'Services did not become healthy.' 'Inspect: journalctl --user -u openframe -u openframe-ml'

  # A small wrapper so `openframe status|logs|restart` works from any shell.
  local bin_dir="$HOME/.local/bin"
  cli_hint="$source_dir/scripts/native/openframe"
  if mkdir -p "$bin_dir" && { [[ ! -e "$bin_dir/openframe" ]] || grep -q '^# Created by the OpenFrame installer' "$bin_dir/openframe"; }; then
    cat > "$bin_dir/openframe" <<WRAPPER
#!/usr/bin/env bash
# Created by the OpenFrame installer. Safe to delete.
export OPENFRAME_CONFIG='$OPENFRAME_CONFIG' OPENFRAME_STATE='$OPENFRAME_STATE' PATH='$PATH'
exec '$source_dir/scripts/native/openframe' "\$@"
WRAPPER
    chmod 700 "$bin_dir/openframe"
    cli_hint="$(tilde "$bin_dir/openframe")"
    case ":${PATH_BEFORE_INSTALL:-}:" in *":$bin_dir:"*) cli_hint=openframe ;; esac
  fi
  set_state services 'done'
  finish_dashboard
  trap - EXIT
  exec 1>&6 2>&4

  ready_screen
}

ready_screen() {
  if command -v ip >/dev/null; then
    lan_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)"
  fi
  server_url="http://${lan_ip:-localhost}:$port"
  rail
  step_line "$good$g_done" 'Installed' "in $(duration $((SECONDS - started_at)))"
  rail
  step_line "$accent$g_act" 'OpenFrame is ready'
  rail "${mute}Open this address in your browser to create your account:$off"
  rail
  rail "$(pill "$server_url")"
  rail
  rail "${faint}1$off  Create your account. ${mute}The first one becomes the administrator.$off"
  rail "${faint}2$off  Follow the short setup in the browser."
  rail "${faint}3$off  Get the app on your phone and sign in with the same address."
  if [[ -n "$lan_ip" ]] && command -v qrencode >/dev/null; then
    rail
    rail "${mute}Or scan this with your phone camera (same Wi-Fi):$off"
    local qr
    while IFS= read -r qr; do rail "$qr"; done < <(qrencode -t ANSIUTF8 "$server_url" || printf 'Open the address above instead.\n')
  fi
  rail
  rail "${faint}MANAGE$off"
  local width=$((${#cli_hint} + 10)) entry
  for entry in 'status|Check that everything is running' 'update|Get the latest version' 'logs|Follow live logs' \
    'uninstall|Remove OpenFrame, keeping or erasing your photos' 'help|All commands'; do
    rail "  $ink$(printf '%-*s' "$width" "$cli_hint ${entry%%|*}")$off$mute${entry#*|}$off"
  done
  rail
  rail "$faint$(printf '%-8s' DATA)$off$(tilde "$install_dir")  ${mute}photos, database and settings · back this up$off"
  if [[ "$mode" == native ]]; then
    rail "$faint$(printf '%-8s' SOURCE)$off$(tilde "$source_dir")  ${mute}keep it here, OpenFrame runs from it$off"
  else
    rail "$faint$(printf '%-8s' SOURCE)$off$(tilde "$source_dir")  ${mute}used for local image builds$off"
  fi
  if [[ "$mode" == native ]]; then
    rail "$faint$(printf '%-8s' BOOT)$off${mute}to start without logging in: sudo loginctl enable-linger $(id -un)$off"
  fi
  rail
  if "$interactive" && command -v xdg-open >/dev/null && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    local key notice=''
    cursor l
    while true; do
      printf '\r\033[K  %s%s%s  %s%s' "$faint" "$g_bar" "$off" \
        "${notice:-$(key_hint enter 'open in browser')   $(key_hint c 'copy link')   $(key_hint q 'done')}" "$off" >&6
      key="$(read_key)"
      case "$key" in
        enter|o) xdg-open "$server_url" >/dev/null 2>&1 & notice="${good}Opened in your browser$off"; break ;;
        c) if copy_text "$server_url"; then notice="${good}Link copied$off"; else notice="${mute}No clipboard found, copy the address above$off"; fi ;;
        quit) notice=''; break ;;
      esac
    done
    printf '\r\033[K' >&6
    cursor h
    if [[ -n "$notice" ]]; then rail "$notice"; fi
  fi
  say "  $faint$g_end$off  ${bold}You're all set.$unbold"
  say ''
}
PATH_BEFORE_INSTALL="$PATH"
main "$@"
