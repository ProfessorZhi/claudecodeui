#!/usr/bin/env bash
#
# restart-server-detached.sh — restart the :3001 claudecodeui server (the fixed systemd user unit
# claudecodeui-server.service, via scripts/serve-scoped.sh) from OUTSIDE that unit's cgroup.
#
# Successor to ~/.ccui-restart/restart-3001-unit.sh. The differences that matter:
#   * it NO LONGER reads PATH/HOST/SERVER_PORT out of the live server's /proc/<pid>/environ and hands
#     them to the next one. That copy re-propagated whatever PATH the previous start had — including
#     frozen plugin bin dirs — on every restart. The new server's environment comes from the unit file
#     and the user manager (~/.config/environment.d/995-nvm-node.conf), nothing else.
#   * it works for the FIRST switch too, from the old transient unit to the installed fixed one:
#     serve-scoped.sh restart stops the transient (collected on stop), reloads, starts the fixed unit.
#
# WHY IT MUST RUN DETACHED: a Claude session opened from the web UI is a descendant of the server, i.e.
# inside claudecodeui-server.service's cgroup, so `systemctl stop` kills the session that asked.
# `setsid` does not leave a cgroup. So the launcher re-runs itself as its own transient unit
# (cui-restart-<id>.service) with a cgroup of its own, which survives the stop.
#
# SAFETY: every check that can refuse happens BEFORE the stop. If the start fails after the stop it
# retries once, and the verdict says plainly whether the server is serving.
#
# USAGE  restart-server-detached.sh [--dry-run] [--delay SECONDS]
#   --dry-run  preflight only; touches nothing
#   --delay N  wait N seconds inside the detached unit before stopping (time to end the caller's turn)
# LOG    ~/.ccui-restart/restart-unit.log  (tail it; the VERDICT block is the last thing written)
#
# Test seams (the defaults are production): QUAY_SERVER_UNIT, QUAY_RESTART_PORT, QUAY_RESTART_LOG_DIR,
# QUAY_RESTART_HEALTH_PATH.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${QUAY_SERVER_UNIT:-claudecodeui-server}"
PORT="${QUAY_RESTART_PORT:-3001}"
HEALTH_PATH="${QUAY_RESTART_HEALTH_PATH:-/health}"
RUN_DIR="${QUAY_RESTART_LOG_DIR:-$HOME/.ccui-restart}"
LOG="$RUN_DIR/restart-unit.log"
SERVER_LOG="${QUAY_SERVER_LOG:-$ROOT/server.log}"

MODE=launch DRY=no DELAY=0 RUN_ID="" OLD_PID="" OLD_SINCE="" OFFSET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=yes ;;
    --delay)   shift; DELAY="${1:-0}" ;;
    --exec)    MODE=exec ;;
    --run-id)  shift; RUN_ID="${1:-}" ;;
    --old-pid) shift; OLD_PID="${1:-}" ;;
    --old-since) shift; OLD_SINCE="${1:-}" ;;
    --offset)  shift; OFFSET="${1:-0}" ;;
    *) echo "restart-server-detached: unknown argument '$1'" >&2; exit 64 ;;
  esac
  shift
done
case "$DELAY" in ''|*[!0-9]*) echo "restart-server-detached: --delay wants whole seconds" >&2; exit 64 ;; esac

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
log() { printf '[%s][%s] %s\n' "$(date '+%F %T')" "$RUN_ID" "$*"; }
prop() { systemctl --user show "$UNIT.service" --value -p "$1" 2>/dev/null; }
port_owner() { ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ (p"$")' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
serving() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT$HEALTH_PATH" 2>/dev/null)" = "200" ]; }
wait_serving() { local d=$((SECONDS + 90)); until serving; do [ "$SECONDS" -ge "$d" ] && return 1; sleep 1; done; }

# ---------------------------------------------------------------- detached half
if [ "$MODE" = exec ]; then
  log "detached restarter up (own cgroup: $(sed 's#.*/##' /proc/self/cgroup)); old MainPID=$OLD_PID"
  [ "$DELAY" -gt 0 ] && { log "grace period ${DELAY}s"; sleep "$DELAY"; }

  log "serve-scoped.sh restart"
  bash "$ROOT/scripts/serve-scoped.sh" restart 2>&1 | sed 's/^/  | /'
  if ! wait_serving; then
    log "not serving after 90s — retrying start once"
    [ "$(prop ActiveState)" = active ] || bash "$ROOT/scripts/serve-scoped.sh" start 2>&1 | sed 's/^/  | /'
    wait_serving || true
  fi

  NEW_MAIN="$(prop MainPID)"
  LISTENER="$(port_owner)"
  LENV=""; [ -n "$LISTENER" ] && LENV="$(tr '\0' '\n' < "/proc/$LISTENER/environ" 2>/dev/null)"
  NODE_OPTS="$(printf '%s\n' "$LENV" | grep '^NODE_OPTIONS=' || true)"
  L_PATH="$(printf '%s\n' "$LENV" | sed -n 's/^PATH=//p' | head -1)"
  L_NODE="$(PATH="$L_PATH" command -v node 2>/dev/null || true)"
  FRAG="$(prop FragmentPath)"
  LCG="$(sed 's#.*/##' "/proc/$LISTENER/cgroup" 2>/dev/null)"
  ROOT_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null)"
  BOOT_LINES="$(tail -c +$((OFFSET + 1)) "$SERVER_LOG" 2>/dev/null | grep -cE 'Server URL|Initial session synchronization complete')"

  OK=yes
  serving                                   || OK=no
  [ -n "$NEW_MAIN" ] && [ "$NEW_MAIN" != "0" ] && [ "$NEW_MAIN" != "$OLD_PID" ] || OK=no
  [ "$(prop Restart)" = "on-failure" ]      || OK=no
  case "$NODE_OPTS" in *max-old-space-size*) : ;; *) OK=no ;; esac
  [ "$LCG" = "$UNIT.service" ]              || OK=no
  case "$FRAG" in ""|/run/*) OK=no ;; esac            # still the transient unit, not the installed one
  case "$L_PATH" in ""|*plugins/cache*|*plugins/synced*) OK=no ;; esac
  case "$L_NODE" in ""|/usr/bin/*|/bin/*) OK=no ;; esac
  case ":$L_PATH:" in *":$HOME/.local/bin:"*) ;; *) OK=no ;; esac   # claude-* launchers, gh, go

  {
    log "====================================================================="
    log "VERDICT run=$RUN_ID  ->  $([ "$OK" = yes ] && echo OK || echo FAILED)"
    log "  old MainPID / new MainPID : $OLD_PID / $NEW_MAIN"
    log "  unit ActiveState/SubState : $(prop ActiveState)/$(prop SubState)   since: $(prop ActiveEnterTimestamp)"
    log "  FragmentPath              : ${FRAG:-<none>}   (must be the installed unit, not /run/...)"
    log "  Restart / NRestarts       : $(prop Restart) / $(prop NRestarts)"
    log "  listener :$PORT           : pid=${LISTENER:-<none>} cgroup=${LCG:-<none>}"
    log "  NODE_OPTIONS (listener)   : ${NODE_OPTS:-<absent>}"
    log "  PATH (listener)           : ${L_PATH:-<none>}"
    log "  node on that PATH         : ${L_NODE:-<none>}   (must not be /usr/bin/node; PATH must carry no plugins/cache|synced)"
    log "  GET $HEALTH_PATH, GET /   : $(serving && echo 200 || echo not-200) , ${ROOT_CODE:-<none>}"
    log "  boot lines in server.log  : $BOOT_LINES (Server URL / initial sync)"
    MEMB="$(prop MemoryCurrent)"; case "$MEMB" in ''|*[!0-9]*) MEMB=0 ;; esac
    log "  MemoryCurrent             : $(( MEMB / 1048576 ))M"
    log "  server log / this log     : $SERVER_LOG / $LOG"
    log "====================================================================="
  } | tee -a "$LOG" >/dev/null
  [ "$OK" = yes ]
  exit $?
fi

# --------------------------------------------------------------- launcher half
mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR"
exec > >(tee -a "$LOG") 2>&1
die() { log "REFUSED: $*  — the running service was left untouched."; exit 1; }
log "=== restart requested dry_run=$DRY delay=${DELAY}s unit=$UNIT port=$PORT ==="

# preflight: everything that can refuse, before anything is stopped
command -v systemd-run >/dev/null || die "no systemd-run"
systemd-run --user --scope --quiet true >/dev/null 2>&1 || die "no usable systemd user manager"
[ -f "$ROOT/scripts/serve-scoped.sh" ] || die "$ROOT/scripts/serve-scoped.sh missing"
UNIT_DIR="${QUAY_UNIT_DIR:-$HOME/.config/systemd/user}"
[ -f "$UNIT_DIR/$UNIT.service" ] || die "$UNIT_DIR/$UNIT.service is not installed — run scripts/install-server-unit.sh first"
grep -q 'Restart=on-failure' "$UNIT_DIR/$UNIT.service" || die "the installed unit has no Restart=on-failure; re-run scripts/install-server-unit.sh"
bash "$ROOT/scripts/install-server-unit.sh" --check >/dev/null 2>&1 || die "install-server-unit.sh --check refuses (run it by hand for the reason): the user manager's node/claude/PATH is not what the server needs"
[ -f "$ROOT/dist-server/server/index.js" ] || die "dist-server/server/index.js missing — nothing to run"
[ "$(systemctl --user is-active $UNIT.service 2>/dev/null)" = active ] || die "$UNIT.service is not active — use serve-scoped.sh start instead (this script restarts a running unit)"
OLD_PID="$(prop MainPID)"
[ -n "$OLD_PID" ] && [ "$OLD_PID" != 0 ] || die "unit has no MainPID"
OLD_SINCE="$(prop ActiveEnterTimestamp)"
OWNER="$(port_owner)"
if [ -n "$OWNER" ]; then
  OCG="$(sed 's#.*/##' "/proc/$OWNER/cgroup" 2>/dev/null)"
  [ "$OCG" = "$UNIT.service" ] || die ":$PORT is held by pid $OWNER in cgroup '$OCG', not by $UNIT.service — not touching someone else's listener"
fi
OFFSET="$(stat -c %s "$SERVER_LOG" 2>/dev/null || echo 0)"
log "preflight OK: unit MainPID=$OLD_PID since='$OLD_SINCE' fragment=$(prop FragmentPath) listener=${OWNER:-none} server.log@$OFFSET"
NHOST=$(ps -eo cgroup= 2>/dev/null | grep -c "$UNIT.service")
log "processes in the unit that this restart will stop: $NHOST (includes any Claude session opened from the web UI — the caller's own session dies too)"

if [ "$DRY" = yes ]; then
  log "DRY RUN — would: systemd-run --user --unit=cui-restart-$RUN_ID bash $0 --exec --delay $DELAY ..."
  exit 0
fi

systemd-run --user --quiet --collect --unit="cui-restart-$RUN_ID" \
  --working-directory="$ROOT" \
  --property=StandardOutput=append:"$LOG" --property=StandardError=append:"$LOG" \
  --setenv=QUAY_SERVER_UNIT="$UNIT" --setenv=QUAY_RESTART_PORT="$PORT" \
  --setenv=QUAY_RESTART_HEALTH_PATH="$HEALTH_PATH" --setenv=QUAY_RESTART_LOG_DIR="$RUN_DIR" --setenv=QUAY_SERVER_LOG="$SERVER_LOG" \
  -- bash "$0" --exec --run-id "$RUN_ID" --delay "$DELAY" --old-pid "$OLD_PID" --old-since "$OLD_SINCE" --offset "$OFFSET" \
  || die "could not start the detached restarter"
log "detached restarter launched as cui-restart-$RUN_ID.service; it stops the server in ${DELAY}s. Read the VERDICT with: tail -25 $LOG"
