#!/usr/bin/env bash
#
# PayeTam local development supervisor.
#
# The Makefile is the interface — `make dev`, `make stop`, `make status`. This file
# is where the process handling lives, because the same logic written as Make
# recipes is one shell per line, `$$` in front of every variable, and no functions.
#
# Three properties shape everything below.
#
# **It never kills a process it did not start.** Every managed process is launched
# through `setsid`, so it is a session leader and its PID is also its process-group
# id; the PID is recorded in .dev/pids/<name>.pid alongside the command line and the
# working directory it was started with. `stop` signals the *process group* of a PID
# that is still alive, still a group leader, still running that command and still in
# that directory — and skips anything that is not. A stale PID file whose number has
# since been recycled by an unrelated process therefore stops nothing: it is deleted
# instead.
#
# **It never starts a second copy of something already running.** A service whose
# port is taken is not started, and neither is one whose process is found running
# without a PID file — an ad-hoc `pnpm dev` in another terminal, say. Duplicates are
# not harmless: two workers consume the same BullMQ queues and every job is done
# twice, and two API processes fight over the port.
#
# **The bot is not a process.** Inbound Telegram is a webhook served by the API and
# outbound Telegram is the worker's queue consumer (ADR-0004, ADR-0005). There is
# nothing else to run, and a third process here would be a third thing to explain.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$ROOT/.dev"
PID_DIR="$DEV_DIR/pids"
LOG_DIR="$DEV_DIR/logs"
STATE_DIR="$DEV_DIR/state"

# Services in start order. `stop` walks this list backwards, so the API goes down
# before the compiler that feeds it.
APP_SERVICES="tsc api worker miniapp-build miniapp admin"
TUNNEL_SERVICES="tunnel-api tunnel-miniapp"

# Log files are rotated rather than truncated: the interesting log is usually the one
# from the run that just died.
MAX_LOG_BYTES=$((5 * 1024 * 1024))

# setWebhook against a tunnel opened seconds ago races Telegram's own DNS lookup.
WEBHOOK_ATTEMPTS=6
WEBHOOK_RETRY_SECONDS=10

# ── output ────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_CYAN=''
fi

step() { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail() { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*"; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# ── environment ───────────────────────────────────────────────────────────────

# Reads one variable out of .env without sourcing it. Sourcing would execute
# whatever is in there, and .env holds credentials, not code.
env_get() {
  [ -f "$ROOT/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ROOT/.env" | tail -n 1 |
    sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" | tr -d '\r'
}

API_PORT="$(env_get API_PORT)"; API_PORT="${API_PORT:-3000}"
MINIAPP_PORT="${MINIAPP_PORT:-5173}"
# The admin panel (M19). Its own port, and deliberately never tunnelled: it is
# opened by a person in a browser and has no reason to be publicly reachable.
ADMIN_PORT="${ADMIN_PORT:-5174}"
API_BASE="http://127.0.0.1:$API_PORT"
MINIAPP_BASE="http://127.0.0.1:$MINIAPP_PORT"
ADMIN_BASE="http://127.0.0.1:$ADMIN_PORT"

# dev = Vite's dev server with HMR, for working on the Mini App in a browser.
# preview = `vite build --watch` feeding `vite preview`, which is the bundle a
# phone actually downloads. Telegram testing uses preview: the unbundled dev server
# ships hundreds of module requests over a tunnel and is unusable on a real device.
miniapp_mode() {
  if [ -n "${MINIAPP_MODE:-}" ]; then printf '%s\n' "$MINIAPP_MODE"; return; fi
  if [ -f "$STATE_DIR/miniapp.mode" ]; then cat "$STATE_DIR/miniapp.mode"; return; fi
  printf 'dev\n'
}

require_env_file() {
  [ -f "$ROOT/.env" ] || die ".env not found. Run 'make setup' first — it writes one with generated local secrets."
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed or not on PATH.${2:+ $2}"; }

# ── process bookkeeping ───────────────────────────────────────────────────────

pid_file() { printf '%s/%s.pid' "$PID_DIR" "$1"; }
cmd_file() { printf '%s/%s.cmd' "$PID_DIR" "$1"; }
dir_file() { printf '%s/%s.dir' "$PID_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$LOG_DIR" "$1"; }

# What each service is, in one place.
#   SVC_DIR   working directory, relative to the repo root (cwd matters: the api
#             loads ../../.env and writes uploads relative to itself)
#   SVC_PORT  the port it listens on, or empty for the ones that listen on nothing
#   SVC_SIG   a substring that must still appear in the process's command line for
#             the recorded PID to be believed
#   SVC_COMM  the executable it ends up being, so a shell that merely mentions the
#             signature on its command line is not mistaken for the service
#   SVC_ARGV  the command
svc_spec() {
  SVC_DIR='.'; SVC_PORT=''; SVC_SIG=''; SVC_COMM='node'; SVC_ARGV=()
  case "$1" in
    tsc)
      # The one watch process for the whole TypeScript graph (ADR-0013): the Nest
      # apps run compiled output under `node --watch`, so something has to compile.
      SVC_SIG='tsc -b --watch'
      SVC_ARGV=(pnpm exec tsc -b --watch --preserveWatchOutput)
      ;;
    api)
      SVC_DIR='apps/api'; SVC_PORT="$API_PORT"; SVC_SIG='dist/main.js'
      SVC_ARGV=(node --watch --env-file=../../.env dist/main.js)
      ;;
    worker)
      SVC_DIR='apps/worker'; SVC_SIG='dist/main.js'
      SVC_ARGV=(node --watch --env-file=../../.env dist/main.js)
      ;;
    miniapp-build)
      SVC_DIR='apps/miniapp'; SVC_SIG='vite build --watch'
      SVC_ARGV=(pnpm exec vite build --watch)
      ;;
    miniapp)
      SVC_DIR='apps/miniapp'; SVC_PORT="$MINIAPP_PORT"
      if [ "$(miniapp_mode)" = 'preview' ]; then
        SVC_SIG='vite preview'
        SVC_ARGV=(pnpm exec vite preview --port "$MINIAPP_PORT" --strictPort)
      else
        SVC_SIG='vite --port'
        SVC_ARGV=(pnpm exec vite --port "$MINIAPP_PORT" --strictPort)
      fi
      ;;
    admin)
      # Always the dev server. The Mini App has a preview mode because Telegram
      # downloads its bundle over a tunnel on a phone; the panel is loaded from
      # localhost on a desk, where HMR is the only thing that matters.
      SVC_DIR='apps/admin'; SVC_PORT="$ADMIN_PORT"
      SVC_SIG='vite --port'
      SVC_ARGV=(pnpm exec vite --port "$ADMIN_PORT" --strictPort)
      ;;
    # The signature carries the port: two cloudflared processes with the same
    # working directory and the same executable are told apart by nothing else.
    tunnel-api)
      SVC_SIG="--url http://localhost:$API_PORT"; SVC_COMM='cloudflared'
      SVC_ARGV=(cloudflared tunnel --no-autoupdate --url "http://localhost:$API_PORT")
      ;;
    tunnel-miniapp)
      SVC_SIG="--url http://localhost:$MINIAPP_PORT"; SVC_COMM='cloudflared'
      SVC_ARGV=(cloudflared tunnel --no-autoupdate --url "http://localhost:$MINIAPP_PORT")
      ;;
    *) die "unknown service: $1" ;;
  esac
}

# Prints the PID if the recorded process is alive *and* is still the process this
# script started. Deletes the PID file and fails otherwise, which is the whole of
# "handle stale PID files safely": a recycled PID is not ours, and is left alone.
running_pid() {
  local name="$1" pf pid pgid args sig dir cwd
  pf="$(pid_file "$name")"
  [ -f "$pf" ] || return 1
  pid="$(cat "$pf" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) rm -f "$pf"; return 1 ;; esac

  if ! kill -0 "$pid" 2>/dev/null; then rm -f "$pf"; return 1; fi

  # Started under setsid, so it leads its own process group. Almost nothing else
  # on a desktop does, which makes this a cheap and very effective PID-reuse guard.
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  if [ "$pgid" != "$pid" ]; then rm -f "$pf"; return 1; fi

  sig="$(cat "$(cmd_file "$name")" 2>/dev/null || true)"
  args="$(ps -ww -o args= -p "$pid" 2>/dev/null || true)"
  if [ -n "$sig" ] && [[ "$args" != *"$sig"* ]]; then rm -f "$pf"; return 1; fi

  # api and worker run the identical command line; the directory is what tells them
  # apart if a PID is ever recycled into the other one.
  dir="$(cat "$(dir_file "$name")" 2>/dev/null || true)"
  if [ -n "$dir" ] && [ -r "/proc/$pid/cwd" ]; then
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [ -n "$cwd" ] && [ "$cwd" != "$dir" ]; then rm -f "$pf"; return 1; fi
  fi

  printf '%s\n' "$pid"
}

# PIDs that look like this service but were not started by us: an ad-hoc `pnpm dev`
# in another terminal, or one of ours orphaned by a deleted PID file. Matched on the
# command-line signature *and* the working directory, so another checkout — or the
# api when we are asking about the worker — does not count.
#
# They are reported and never signalled. `stop` touches only what make recorded, so
# the honest thing to do with a process we do not own is refuse to add a second one
# and say whose it is.
matching_pids() {
  local name="$1" pid ppid cwd want candidates='' top=''
  svc_spec "$name"
  [ -n "$SVC_SIG" ] || return 0
  want="$(cd "$ROOT/$SVC_DIR" && pwd)"

  for pid in $(pgrep -f -- "$SVC_SIG" 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    if [ -r "/proc/$pid/comm" ] && [ "$(cat "/proc/$pid/comm" 2>/dev/null)" != "$SVC_COMM" ]; then continue; fi
    if [ -r "/proc/$pid/cwd" ]; then
      cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      if [ -n "$cwd" ] && [ "$cwd" != "$want" ]; then continue; fi
    fi
    candidates="$candidates $pid"
  done

  # `node --watch` and `pnpm exec` both match alongside the child they spawned.
  # Reporting the top of each tree keeps "already running (pid N)" a single number.
  for pid in $candidates; do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    case " $candidates " in *" $ppid "*) continue ;; esac
    top="$top $pid"
  done
  printf '%s\n' "${top# }"
}

port_listener_pids() {
  ss -ltnpH 2>/dev/null | awk -v p=":$1\$" '$4 ~ p' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

port_in_use() { [ -n "$(ss -ltnH 2>/dev/null | awk -v p=":$1\$" '$4 ~ p')" ]; }

uptime_of() { ps -o etime= -p "$1" 2>/dev/null | tr -d ' '; }

rotate_log() {
  local lf="$1" size
  [ -f "$lf" ] || return 0
  size="$(stat -c %s "$lf" 2>/dev/null || echo 0)"
  [ "$size" -gt "$MAX_LOG_BYTES" ] && mv -f "$lf" "$lf.old"
  return 0
}

# ── start / stop ──────────────────────────────────────────────────────────────

start_svc() {
  local name="$1" pid lf holder
  svc_spec "$name"
  lf="$(log_file "$name")"

  if pid="$(running_pid "$name")"; then
    ok "$name already running (pid $pid)"
    return 0
  fi

  if [ -n "$SVC_PORT" ] && port_in_use "$SVC_PORT"; then
    holder="$(port_listener_pids "$SVC_PORT" | tr '\n' ' ')"
    warn "$name not started: port $SVC_PORT is already in use${holder:+ by pid ${holder% }}"
    warn "  nothing was duplicated. 'make stop' then 'make dev' if that process is a stale one of ours."
    return 0
  fi

  # The port check above cannot see the worker, the compiler or the bundler: they
  # listen on nothing. Two workers on the same queues is the failure this prevents.
  local foreign; foreign="$(matching_pids "$name")"
  if [ -n "$foreign" ]; then
    warn "$name not started: a matching process is already running (pid ${foreign// /, }) that make did not start"
    warn "  left alone rather than duplicated: 'make stop' does not touch what it did not start."
    warn "  kill ${foreign%% *} yourself if it is a leftover, then 'make dev' again."
    return 0
  fi

  mkdir -p "$PID_DIR" "$LOG_DIR" "$STATE_DIR"
  rotate_log "$lf"
  printf '\n===== %s started %s =====\n' "$name" "$(date -Is)" >>"$lf"
  printf '%s\n' "$SVC_SIG" >"$(cmd_file "$name")"
  printf '%s\n' "$(cd "$ROOT/$SVC_DIR" && pwd)" >"$(dir_file "$name")"
  rm -f "$(pid_file "$name")"

  # The wrapper writes its own PID and then execs, so the recorded number is the
  # process itself however `setsid` chose to get there (it forks when it is already
  # a group leader, and does not otherwise). Detached from this shell's job table
  # with a subshell, and from the terminal with </dev/null, so `make dev` returning
  # does not take the stack with it.
  (
    cd "$ROOT/$SVC_DIR"
    PAYETAM_PID_FILE="$(pid_file "$name")" \
      setsid bash -c 'echo $$ >"$PAYETAM_PID_FILE"; exec "$@"' bash "${SVC_ARGV[@]}" \
      >>"$lf" 2>&1 </dev/null &
  )

  local waited=0
  while [ ! -s "$(pid_file "$name")" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1; waited=$((waited + 1))
  done

  if pid="$(running_pid "$name")"; then
    ok "$name started (pid $pid)${SVC_PORT:+, port $SVC_PORT}"
  else
    fail "$name failed to start — see $(printf '%s' "$lf" | sed "s|$ROOT/||")"
    tail -n 15 "$lf" | sed 's/^/      /'
    return 1
  fi
}

stop_svc() {
  local name="$1" pid waited=0
  if ! pid="$(running_pid "$name")"; then
    rm -f "$(pid_file "$name")" "$(cmd_file "$name")" "$(dir_file "$name")"
    return 0
  fi

  # The group, not the PID: `node --watch` and `pnpm exec` both run the real work in
  # a child, and signalling only the parent leaves that child holding the port.
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 100 ]; do
    sleep 0.1; waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "$name did not exit on SIGTERM after 10s — sending SIGKILL"
    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    sleep 0.3
  fi
  rm -f "$(pid_file "$name")" "$(cmd_file "$name")" "$(dir_file "$name")"
  ok "$name stopped (pid $pid)"
}

# ── readiness ─────────────────────────────────────────────────────────────────

log_tail() { tail -n 25 "$(log_file "$1")" 2>/dev/null | sed 's/^/      /'; }

# Only the lines this run of the service wrote.
#
# Logs are appended across restarts, and both readiness ("Worker started") and the
# tunnel hostname are one-off lines: matched against the whole file, the *previous*
# run answers for the current one. That is not theoretical — it handed out a dead
# quick-tunnel hostname, and Cloudflare answered 1033 for a tunnel that had been
# killed a minute earlier.
current_run_log() {
  local lf; lf="$(log_file "$1")"
  [ -f "$lf" ] || return 0
  awk '/^===== .* started /{ buf = ""; next } { buf = buf $0 "\n" } END { printf "%s", buf }' "$lf"
}

wait_http() {
  local url="$1" label="$2" timeout="${3:-90}" waited=0
  while [ "$waited" -lt "$((timeout * 2))" ]; do
    if curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; then
      ok "$label responding at $url"
      return 0
    fi
    sleep 0.5; waited=$((waited + 1))
  done
  fail "$label did not respond at $url within ${timeout}s"
  return 1
}

wait_log() {
  local name="$1" needle="$2" label="$3" timeout="${4:-120}" waited=0
  while [ "$waited" -lt "$((timeout * 2))" ]; do
    if current_run_log "$name" | grep -qF "$needle"; then ok "$label"; return 0; fi
    running_pid "$name" >/dev/null || { fail "$name exited before $label"; return 1; }
    sleep 0.5; waited=$((waited + 1))
  done
  warn "$label not observed within ${timeout}s (process is alive; see 'make logs')"
  return 0
}

wait_container_healthy() {
  local container="$1" timeout="${2:-120}" waited=0 state
  while [ "$waited" -lt "$((timeout * 2))" ]; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    case "$state" in
      healthy|running) ok "$container is $state"; return 0 ;;
    esac
    sleep 0.5; waited=$((waited + 1))
  done
  fail "$container did not become healthy within ${timeout}s"
  return 1
}

# ── the steps `dev` is made of ────────────────────────────────────────────────

cmd_docker_up() {
  require_cmd docker
  step "Starting Postgres and Redis"
  (cd "$ROOT" && docker compose up -d)
  wait_container_healthy payetam-postgres
  wait_container_healthy payetam-redis
}

cmd_deps() {
  if [ ! -d "$ROOT/node_modules" ]; then
    step "Installing dependencies (node_modules is missing)"
    (cd "$ROOT" && pnpm install)
  fi
}

cmd_db() {
  step "Prisma client and migrations"
  # Generated, never committed — a fresh clone has no client until this runs.
  (cd "$ROOT" && pnpm -s db:generate)
  ok "prisma client generated"
  (cd "$ROOT" && pnpm -s db:migrate:deploy)
  ok "migrations applied"
}

cmd_build() {
  step "Building the TypeScript project graph (tsc -b)"
  # Before the watch, not instead of it: `node --watch dist/main.js` has nothing to
  # run on a clean checkout until the graph has been built once.
  (cd "$ROOT" && pnpm exec tsc -b)
  ok "workspace built"
}

# Keeps the Mini App's processes consistent with the requested mode. Switching mode
# with the old server still up would leave port 5173 held by the wrong thing.
reconcile_miniapp_mode() {
  local want previous
  want="$(miniapp_mode)"
  case "$want" in dev|preview) ;; *) die "MINIAPP_MODE must be 'dev' or 'preview' (got '$want')" ;; esac
  previous="$(cat "$STATE_DIR/miniapp.mode" 2>/dev/null || true)"

  if [ -n "$previous" ] && [ "$previous" != "$want" ]; then
    step "Switching the Mini App from $previous to $want mode"
    stop_svc miniapp
    stop_svc miniapp-build
  fi
  if [ "$want" = 'dev' ] && running_pid miniapp-build >/dev/null 2>&1; then
    # `vite build --watch` belongs to preview mode only.
    stop_svc miniapp-build
  fi
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$want" >"$STATE_DIR/miniapp.mode"
}

start_miniapp() {
  local mode; mode="$(miniapp_mode)"
  if [ "$mode" = 'preview' ]; then
    step "Mini App (preview: the built bundle, which is what a phone downloads)"
    start_svc miniapp-build
    # `vite preview` serves a directory. Starting it before the first bundle exists
    # gives a 404 on the one URL Telegram is about to open.
    wait_log miniapp-build 'built in' 'first production bundle written to dist' 180
    start_svc miniapp
  else
    step "Mini App (dev server, HMR)"
    start_svc miniapp
  fi
}

# ── commands ──────────────────────────────────────────────────────────────────

cmd_dev() {
  require_env_file
  require_cmd pnpm
  mkdir -p "$PID_DIR" "$LOG_DIR" "$STATE_DIR"

  cmd_deps
  cmd_docker_up
  cmd_db
  cmd_build

  step "Starting the stack"
  reconcile_miniapp_mode
  start_svc tsc
  start_svc api
  start_svc worker
  start_miniapp
  start_svc admin

  step "Waiting for the stack to answer"
  # Every check runs even if an earlier one failed, and the tail of the offending
  # log is printed with it: one `make dev` should tell you everything that is wrong,
  # not the first thing.
  local failed=0
  wait_log tsc 'Watching for file changes' 'tsc is watching' 180 || failed=1
  wait_http "$API_BASE/health" 'API /health' 90 || { failed=1; log_tail api; }
  wait_http "$API_BASE/ready" 'API /ready' 60 || { failed=1; log_tail api; }
  wait_http "$MINIAPP_BASE/" 'Mini App' 120 || { failed=1; log_tail miniapp; }
  wait_http "$ADMIN_BASE/" 'Admin panel' 120 || { failed=1; log_tail admin; }
  # The worker serves nothing, so its readiness is its own startup line.
  wait_log worker 'Worker started' 'worker started' 60 || { failed=1; log_tail worker; }

  echo
  cmd_status
  echo
  printf '%sMini App%s   %s   (mode: %s)\n' "$C_BOLD" "$C_RESET" "$MINIAPP_BASE" "$(miniapp_mode)"
  printf '%sAdmin%s      %s\n' "$C_BOLD" "$C_RESET" "$ADMIN_BASE"
  printf '%sAPI%s        %s\n' "$C_BOLD" "$C_RESET" "$API_BASE"
  printf '%sLogs%s       make logs         %sone service:%s make logs SERVICE=api\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '%sTelegram%s   make tunnel       %sthen make webhook%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"

  if [ "$failed" -ne 0 ]; then
    echo
    die "the stack came up incomplete — see the failures above and 'make logs'."
  fi
}

cmd_stop() {
  step "Stopping processes started by make"
  local name
  for name in $TUNNEL_SERVICES; do stop_svc "$name"; done
  # Reverse of start order.
  for name in $(echo "$APP_SERVICES" | tr ' ' '\n' | tac | tr '\n' ' '); do stop_svc "$name"; done
  rm -f "$STATE_DIR"/tunnel-*.url
  ok "Postgres and Redis are still up — 'make down' stops those."
}

cmd_restart() { cmd_stop; echo; cmd_dev; }

svc_status_line() {
  local name="$1" pid
  svc_spec "$name"
  if pid="$(running_pid "$name")"; then
    printf '  %s%-14s%s %srunning%s  pid %-7s up %-10s %s\n' \
      "$C_BOLD" "$name" "$C_RESET" "$C_GREEN" "$C_RESET" "$pid" "$(uptime_of "$pid")" \
      "${SVC_PORT:+port $SVC_PORT}"
  else
    local extra='' foreign
    if [ -n "$SVC_PORT" ] && port_in_use "$SVC_PORT"; then
      extra="port $SVC_PORT held by pid $(port_listener_pids "$SVC_PORT" | tr '\n' ' ')(not ours)"
    fi
    foreign="$(matching_pids "$name")"
    if [ -n "$foreign" ]; then extra="${extra:+$extra; }untracked twin running (pid ${foreign// /, })"; fi
    printf '  %s%-14s%s %sstopped%s  %s\n' "$C_BOLD" "$name" "$C_RESET" "$C_DIM" "$C_RESET" "$extra"
  fi
}

cmd_status() {
  printf '%sContainers%s\n' "$C_BOLD" "$C_RESET"
  local c state
  for c in payetam-postgres payetam-redis; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo 'not created')"
    printf '  %-16s %s\n' "$c" "$state"
  done

  printf '%sProcesses%s  %s(mode: %s)%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$(miniapp_mode)" "$C_RESET"
  local name
  for name in $APP_SERVICES; do
    # miniapp-build exists only in preview mode; listing it as "stopped" in dev mode
    # would report a problem that is not one.
    if [ "$name" = 'miniapp-build' ] && [ "$(miniapp_mode)" != 'preview' ]; then continue; fi
    svc_status_line "$name"
  done
  for name in $TUNNEL_SERVICES; do
    running_pid "$name" >/dev/null 2>&1 && svc_status_line "$name"
  done

  printf '%sEndpoints%s\n' "$C_BOLD" "$C_RESET"
  local body
  body="$(curl -fsS --max-time 3 "$API_BASE/health" 2>/dev/null || true)"
  printf '  %-16s %s\n' "$API_BASE/health" "${body:-unreachable}"
  body="$(curl -fsS --max-time 5 "$API_BASE/ready" 2>/dev/null || true)"
  printf '  %-16s %s\n' "$API_BASE/ready" "${body:-unreachable}"
  body="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$MINIAPP_BASE/" 2>/dev/null || true)"
  printf '  %-16s %s\n' "$MINIAPP_BASE/" "HTTP ${body:-unreachable}"
  body="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$ADMIN_BASE/" 2>/dev/null || true)"
  printf '  %-16s %s\n' "$ADMIN_BASE/" "HTTP ${body:-unreachable}"

  local f
  if compgen -G "$STATE_DIR/tunnel-*.url" >/dev/null 2>&1; then
    printf '%sTunnels%s\n' "$C_BOLD" "$C_RESET"
    for f in "$STATE_DIR"/tunnel-*.url; do
      name="$(basename "$f" .url)"
      if running_pid "$name" >/dev/null 2>&1; then
        printf '  %-16s %s\n' "${name#tunnel-}" "$(cat "$f")"
      else
        printf '  %-16s %s(down)%s\n' "${name#tunnel-}" "$C_DIM" "$C_RESET"
      fi
    done
  fi
}

cmd_logs() {
  local service="${1:-}"
  mkdir -p "$LOG_DIR"
  if [ -n "$service" ]; then
    [ -f "$(log_file "$service")" ] || die "no log for '$service'. Known: $APP_SERVICES $TUNNEL_SERVICES"
    tail -n 200 -F "$(log_file "$service")"
    return
  fi
  if ! compgen -G "$LOG_DIR/*.log" >/dev/null 2>&1; then
    die "no logs yet — run 'make dev' first."
  fi
  # -F rather than -f: `node --watch` and `vite build --watch` replace files, and a
  # plain -f would silently stop following after the first rebuild.
  tail -n 40 -F "$LOG_DIR"/*.log
}

# ── tunnels ───────────────────────────────────────────────────────────────────

tunnel_url() {
  local name="$1" waited=0 url=''
  while [ "$waited" -lt 120 ]; do
    url="$(current_run_log "$name" | grep -ohE 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' | tail -n 1 || true)"
    [ -n "$url" ] && { printf '%s\n' "$url"; return 0; }
    running_pid "$name" >/dev/null || return 1
    sleep 0.5; waited=$((waited + 1))
  done
  return 1
}

cmd_tunnel() {
  require_env_file
  require_cmd cloudflared "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"

  running_pid api >/dev/null 2>&1 || port_in_use "$API_PORT" ||
    die "the API is not running. 'make dev' first — a tunnel to nothing is just a 502."

  # Telegram must be handed the built bundle. The dev server works in a browser on
  # this machine and is unusable through a tunnel on a phone: every module is its
  # own request.
  if [ "$(miniapp_mode)" != 'preview' ]; then
    step "Telegram testing needs the built bundle — switching the Mini App to preview mode"
    export MINIAPP_MODE=preview
    reconcile_miniapp_mode
    start_miniapp
    wait_http "$MINIAPP_BASE/" 'Mini App (preview)' 120
  fi

  step "Opening Cloudflare quick tunnels"
  start_svc tunnel-api
  start_svc tunnel-miniapp

  local api_url miniapp_url
  api_url="$(tunnel_url tunnel-api || true)"
  miniapp_url="$(tunnel_url tunnel-miniapp || true)"
  [ -n "$api_url" ] || { fail "the API tunnel produced no URL — see 'make logs SERVICE=tunnel-api'"; return 1; }
  [ -n "$miniapp_url" ] || { fail "the Mini App tunnel produced no URL — see 'make logs SERVICE=tunnel-miniapp'"; return 1; }

  mkdir -p "$STATE_DIR"
  printf '%s\n' "$api_url" >"$STATE_DIR/tunnel-api.url"
  printf '%s\n' "$miniapp_url" >"$STATE_DIR/tunnel-miniapp.url"
  ok "api      $api_url"
  ok "miniapp  $miniapp_url"

  echo
  printf '%sTelegram setup%s\n' "$C_BOLD" "$C_RESET"
  printf '  1. BotFather → /mybots → your bot → Bot Settings → Menu Button / Web App URL:\n'
  printf '       %s%s%s\n' "$C_CYAN" "$miniapp_url" "$C_RESET"
  printf '     The Mini App proxies /api to this machine, so no API origin is baked into the bundle.\n'
  printf '  2. Point the bot webhook at the API tunnel:\n'
  printf '       %smake webhook%s        (registers %s/telegram/webhook/<secret>)\n' "$C_CYAN" "$C_RESET" "$api_url"
  printf '  3. %smake webhook-info%s to confirm Telegram accepted it.\n' "$C_CYAN" "$C_RESET"
  printf '\n  Quick-tunnel hostnames change on every restart. Re-run both steps after %smake restart%s.\n' "$C_DIM" "$C_RESET"
}

# ── Telegram webhook registration ─────────────────────────────────────────────
#
# Separate from `tunnel` on purpose: this is the one command here that reaches out
# and changes something on Telegram's side, for a real bot, so it is run
# deliberately rather than as a side effect of opening a tunnel.

telegram_call() {
  local method="$1"; shift
  local token; token="$(env_get TELEGRAM_BOT_TOKEN)"
  [ -n "$token" ] || die "TELEGRAM_BOT_TOKEN is not set in .env (get one from @BotFather)."
  # --fail-with-body so Telegram's own explanation is still readable, and every
  # line filtered so the token cannot reach the terminal by way of a curl error
  # message: it is full control of the bot.
  curl -sS --fail-with-body "https://api.telegram.org/bot$token/$method" "$@" 2>&1 |
    sed "s|$token|<BOT-TOKEN>|g"
}

cmd_webhook() {
  require_env_file
  local url path secret
  url="$(cat "$STATE_DIR/tunnel-api.url" 2>/dev/null || true)"
  [ -n "$url" ] || die "no API tunnel URL recorded. Run 'make tunnel' first."
  running_pid tunnel-api >/dev/null 2>&1 || die "the API tunnel is not running. Run 'make tunnel' first."

  path="$(env_get TELEGRAM_WEBHOOK_SECRET_PATH)"
  secret="$(env_get TELEGRAM_WEBHOOK_SECRET_TOKEN)"
  [ -n "$path" ] || die "TELEGRAM_WEBHOOK_SECRET_PATH is not set in .env."
  [ -n "$secret" ] || die "TELEGRAM_WEBHOOK_SECRET_TOKEN is not set in .env."

  # Telegram resolves the hostname itself while registering, and a failed
  # setWebhook *clears* whatever webhook the bot had. So the tunnel is proved
  # reachable from the public internet first, and only then is the bot's
  # configuration touched.
  step "Waiting for the tunnel hostname to resolve"
  wait_http "$url/health" 'the API tunnel' 180 ||
    die "the tunnel is not answering publicly yet. Nothing was changed on Telegram's side; try again, or 'make tunnel-stop && make tunnel' for a fresh hostname."

  step "Registering the webhook with Telegram"

  # Retried, because the first attempt against a brand-new quick tunnel loses a
  # race with DNS: Telegram resolves the host itself while registering, and
  # answers `Failed to resolve host` for a hostname that works seconds later.
  # A failed setWebhook also *clears* the previous one, so giving up on the first
  # error would leave the bot with no webhook at all.
  local attempt=1 body
  while :; do
    # allowed_updates is exactly what packages/telegram's parseUpdate understands.
    # Anything else Telegram might send is dropped on arrival anyway; not
    # subscribing to it saves the round trip.
    body="$(telegram_call setWebhook \
      --data-urlencode "url=$url/telegram/webhook/$path" \
      --data-urlencode "secret_token=$secret" \
      --data-urlencode 'allowed_updates=["message","edited_message","callback_query","my_chat_member"]' || true)"

    case "$body" in
      *'"ok":true'*)
        ok "webhook → $url/telegram/webhook/<secret path>"
        return 0
        ;;
    esac

    if [ "$attempt" -ge "$WEBHOOK_ATTEMPTS" ]; then
      printf '  %s\n' "$body"
      warn "Telegram can reject a hostname it looked up too early for as long as its"
      warn "  negative cache holds. 'make tunnel-stop && make tunnel' gets a fresh one."
      die "Telegram refused the webhook $WEBHOOK_ATTEMPTS times. The bot now has no webhook — fix this and run 'make webhook' again."
    fi
    warn "attempt $attempt/$WEBHOOK_ATTEMPTS refused: $body"
    warn "  a fresh tunnel hostname can take a minute to reach Telegram's resolver; retrying"
    sleep "$WEBHOOK_RETRY_SECONDS"
    attempt=$((attempt + 1))
  done
}

cmd_webhook_info() {
  require_env_file
  step "Telegram getWebhookInfo"
  # The response contains the webhook URL, secret path and all. It is printed
  # because that is the point of the command, and it is your own terminal.
  telegram_call getWebhookInfo
  echo
}

cmd_webhook_delete() {
  require_env_file
  step "Removing the webhook"
  telegram_call deleteWebhook --data-urlencode 'drop_pending_updates=false'
  echo
}

# ── dispatch ──────────────────────────────────────────────────────────────────

case "${1:-}" in
  dev)            cmd_dev ;;
  stop)           cmd_stop ;;
  restart)        cmd_restart ;;
  status)         cmd_status ;;
  logs)           shift; cmd_logs "${1:-}" ;;
  tunnel)         cmd_tunnel ;;
  tunnel-stop)    for n in $TUNNEL_SERVICES; do stop_svc "$n"; done; rm -f "$STATE_DIR"/tunnel-*.url ;;
  webhook)        cmd_webhook ;;
  webhook-info)   cmd_webhook_info ;;
  webhook-delete) cmd_webhook_delete ;;
  docker-up)      cmd_docker_up ;;
  *) die "usage: $(basename "$0") {dev|stop|restart|status|logs [service]|tunnel|tunnel-stop|webhook|webhook-info|webhook-delete|docker-up}" ;;
esac
