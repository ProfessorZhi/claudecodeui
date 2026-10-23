#!/usr/bin/env bash
# serve-scoped.sh start|stop|restart|status — run the :3001 server as its own systemd user service.
#
# Two modes, chosen by QUAY_SERVER_CMD:
#   unset (production)  drive the FIXED unit claudecodeui-server.service that
#                       scripts/install-server-unit.sh installs from scripts/systemd/. Restart policy,
#                       heap ceiling and log path live in that unit file, not here. This script no
#                       longer passes any PATH: node/claude come from the user manager's environment
#                       (~/.config/environment.d/995-nvm-node.conf). The old `--setenv=PATH="$PATH"`
#                       copied the starting shell's PATH into the unit and froze old plugin bin dirs.
#   set (test seam)     start a throwaway TRANSIENT unit running that command line, as before, with the
#                       properties below — what scripts/serve-scoped-check.sh drives. It passes no
#                       PATH either; the unit inherits the user manager's.
#
# Why: `setsid nohup npm run server &` from a tmux pane leaves the server in that pane's
# `tmux-spawn-<uuid>.scope` cgroup. Anything else that OOMs in the pane (a runaway vitest) takes
# the server with it, and server.log just stops with no crash line. A transient service has its
# own cgroup, so it is only killed for its own memory use. There is deliberately NO MemoryMax
# here — see the cgroup paragraph below. Cap the tests instead (scripts/with-memory-cap.sh).
#
# Restart and the heap ceiling (2026-09-25, the other half of that incident): isolation alone
# leaves the server DOWN and unnoticed when it does die — server.log simply ended, and the only
# detector was a person happening to look. So the unit now carries
#   Restart=on-failure  RestartSec=5  StartLimitBurst=5  StartLimitIntervalSec=60
# and the server runs with a V8 heap ceiling, `NODE_OPTIONS=--max-old-space-size=<MB>`
# (default 2048, `QUAY_SERVER_HEAP_MB` overrides, `off` omits it). A leak then ends as a
# non-zero exit at a predictable point and Restart= picks the server up, instead of growing until
# the HOST thrashes — this machine has 252G of RAM and 14.7G of its 16G swap already in use, so an
# uncapped server on a leak path is a host-wide problem, not a server problem. A caller's own
# `NODE_OPTIONS` is APPENDED to, never replaced.
#
# A clean `stop` is not a failure and must never trigger a restart; the five-restarts-in-60s burst
# limit is what keeps a genuinely crash-looping server from spinning forever — it is left visibly
# failed instead.
#
# Still NO MemoryMax on this unit: a cgroup cap would make the server the OOM victim again rather
# than a bystander, which is the opposite of what the incident needed. The heap ceiling is a
# *process* limit that only the server can trip. 2048 is a conservative default taken before any
# long soak reading existed (measured: ~224MB RSS just after boot) — tighten it once there is one;
# docs/operations/process-isolation-and-memory-caps.md records that.
#
# Env (same names the server reads):
#   HOST                  bind address (default 0.0.0.0)
#   SERVER_PORT           port (default 3001)
#
# Test seams — the defaults ARE the production behaviour; these exist so the script can be driven
# without touching :3001 or the real unit (see scripts/serve-scoped-check.sh):
#   QUAY_SERVER_UNIT      unit name (default claudecodeui-server)
#   QUAY_SERVER_CMD       managed command LINE, word-split; setting it selects the transient mode
#   QUAY_SERVER_LOG       log file (transient mode; the fixed unit's is in its drop-in)
#   QUAY_SERVER_HEAP_MB   heap ceiling in MB (transient mode; default 2048; `off` or `0` omits it —
#                         the fixed unit's ceiling is Environment=NODE_OPTIONS in its unit file)
#
# Do NOT run `stop`/`restart` from a session the server hosts: sessions are its child processes
# and the whole cgroup is stopped, so the caller is killed mid-command. Run it from a tmux pane.
set -eu

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${QUAY_SERVER_UNIT:-claudecodeui-server}"
HOST="${HOST:-0.0.0.0}"
SERVER_PORT="${SERVER_PORT:-3001}"
SERVER_CMD="${QUAY_SERVER_CMD:-}"   # empty = the fixed unit (production)
LOG_FILE="${QUAY_SERVER_LOG:-$ROOT_DIR/server.log}"
HEAP_MB="${QUAY_SERVER_HEAP_MB:-2048}"

# Fail loudly when there is no usable systemd user manager, rather than letting `systemd-run` say
# something cryptic or — worse — silently starting an unscoped server. The probe is a real scope
# that really starts a process: `command -v` alone would pass on a host where the user manager is
# present but unreachable (no session bus), and service-not-found and command-not-found are
# indistinguishable by exit code alone.
require_systemd() {
  if ! command -v systemd-run >/dev/null 2>&1 || ! command -v systemctl >/dev/null 2>&1; then
    no_systemd "systemd-run/systemctl are not on PATH"
  fi
  if ! systemd-run --user --scope --quiet true >/dev/null 2>&1; then
    no_systemd "systemd-run --user cannot start a scope (no user manager / no session bus)"
  fi
}

no_systemd() {
  echo "serve-scoped: no usable systemd user manager ($1), so the server cannot be run as its own unit; refusing rather than starting it unscoped" >&2
  exit 3
}

# Fixed-unit start. `daemon-reload` first: a same-named transient unit (the pre-fixed-unit way of
# running the server) has precedence over the installed file until it is stopped and collected, and
# only a reload makes the installed file visible afterwards. Refuses — rather than starting something
# else — when the installed unit is missing or is still the transient one.
start_fixed() {
  systemctl --user daemon-reload
  local frag
  frag="$(systemctl --user show "$UNIT.service" --value -p FragmentPath 2>/dev/null)"
  case "$frag" in
    ""|/run/*) echo "serve-scoped: $UNIT.service is not installed as a fixed unit (FragmentPath='${frag:-none}'); run scripts/install-server-unit.sh first" >&2; exit 4 ;;
  esac
  systemctl --user start "$UNIT.service"
  echo "started $UNIT.service from $frag"
}

is_active() { systemctl --user is-active --quiet "$UNIT.service" 2>/dev/null; }

# The NODE_OPTIONS the unit is started with: the caller's own, with the heap ceiling appended. An
# empty result means "do not pass NODE_OPTIONS at all" — passing an empty one would be a different
# thing (`NODE_OPTIONS=` set in the unit's environment).
compose_node_options() {
  local opts="${NODE_OPTIONS:-}"
  case "$HEAP_MB" in
    off|0) ;;
    *) opts="${opts:+$opts }--max-old-space-size=$HEAP_MB" ;;
  esac
  printf '%s' "$opts"
}

case "${1:-}" in
  start)
    require_systemd
    if is_active; then echo "$UNIT already running" >&2; exit 1; fi
    if [ -z "$SERVER_CMD" ]; then start_fixed; exit 0; fi
    NODE_OPTS="$(compose_node_options)"
    SETENV=(
      --setenv=HOST="$HOST"
      --setenv=SERVER_PORT="$SERVER_PORT"
    )
    if [ -n "$NODE_OPTS" ]; then SETENV+=(--setenv=NODE_OPTIONS="$NODE_OPTS"); fi
    # shellcheck disable=SC2086  # SERVER_CMD is a command LINE: `node foo.mjs` is a valid value.
    systemd-run --user --quiet --collect --unit="$UNIT" \
      --working-directory="$ROOT_DIR" \
      "${SETENV[@]}" \
      --property=StandardOutput=append:"$LOG_FILE" \
      --property=StandardError=append:"$LOG_FILE" \
      --property=Restart=on-failure \
      --property=RestartSec=5 \
      --property=StartLimitBurst=5 \
      --property=StartLimitIntervalSec=60 \
      -- $SERVER_CMD
    echo "started $UNIT.service on $HOST:$SERVER_PORT (log: $LOG_FILE)"
    ;;
  stop)
    require_systemd
    systemctl --user stop "$UNIT.service"
    ;;
  restart)
    require_systemd
    systemctl --user stop "$UNIT.service" 2>/dev/null || true
    exec "$0" start
    ;;
  status)
    require_systemd
    # `status` alone shows neither the restart count nor the memory accounting, which are exactly
    # the two readings that tell "quietly crash-looping" apart from "up the whole time".
    systemctl --user status "$UNIT.service" --no-pager || true
    echo "── $UNIT.service counters ──"
    systemctl --user show "$UNIT.service" --no-pager \
      -p LoadState -p ActiveState -p SubState -p MainPID \
      -p NRestarts -p MemoryCurrent -p MemoryPeak || true
    ;;
  *)
    echo "usage: serve-scoped.sh start|stop|restart|status" >&2
    exit 2
    ;;
esac
