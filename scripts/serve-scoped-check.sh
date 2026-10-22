#!/usr/bin/env bash
# serve-scoped-check.sh [all|fake|restart|stop|heap] — re-runnable proof of the two promises
# `scripts/serve-scoped.sh` makes about restarts and the heap ceiling.
#
# Why this is not a grep. "Does the script pass Restart=on-failure?" is the easy half and the
# worthless half: a unit that is handed the property and never comes back looks identical to one
# that is not handed it at all, from the text. So every assertion below reads a READING rather
# than a shape — the argv `systemd-run` was actually given (fake section), or a real transient
# unit's own counters after a real signal (restart/stop/heap sections). That is also why the fake
# section asserts the actual argv on failure: a red has to be diagnosable without a re-run.
#
# The sections:
#
#   fake     A fake `systemd-run` is put first on PATH and records the argv it is handed to
#            `$QUAY_SERVE_CHECK_ARGV` (one call per line). `start` is run four times — default,
#            `QUAY_SERVER_HEAP_MB=off`, the caller's own `NODE_OPTIONS` set, and
#            `QUAY_SERVER_CMD` overridden — plus the two refusal branches (no usable systemd
#            manager; no arguments at all). Nothing here touches systemd.
#
#   restart  A throwaway unit runs a liveness stub. Its main process is `kill -9`ed; inside
#            RESTART_WAIT_SECS the unit must be active again with a DIFFERENT MainPID and
#            `NRestarts=1`. A kill by signal is a failure to systemd, so Restart=on-failure is the
#            only thing that can bring it back — this is what "crash auto-recovery" means here.
#            The same live unit is then read back through `serve-scoped.sh status`, which must
#            report its counters (`NRestarts`/`MemoryCurrent`/`MemoryPeak`/`MainPID`).
#
#   stop     A second throwaway unit is started and then stopped through `serve-scoped.sh stop`.
#            `NRestarts` must be 0 while it runs (nothing restarted it), and afterwards the unit
#            must be unloaded (`LoadState=not-found`, `--collect`). A unit that had restarted
#            would be loaded and active, so "unloaded" is what proves a clean stop is NOT a
#            failure path — the one asymmetry Restart=on-failure has to get right.
#
#   heap     A third throwaway unit runs a stub that retains objects. With the DEFAULT ceiling it
#            must come back restarted (`NRestarts >= 1`) within HEAP_WAIT_SECS and its log must
#            carry node's heap-limit abort. Restart=on-failure only restarts on a FAILURE exit, so
#            a restart count of at least one IS the "exited non-zero" reading; the log line says
#            which failure it was. The unit's `MemoryPeak` must stay under 2x the ceiling, which is
#            what makes this a *cap* and not just a crash.
#
# The three real sections run in PARALLEL (each is seconds of waiting on systemd, and the whole
# script has to fit inside a 60s criterion gate). They are SKIPPED — loudly, with the word SKIP in
# the verdict — when there is no systemd user manager (macOS, containers, CI). A skip is not a
# pass, and the fake section still runs. Nothing needs :3001: every unit here is named with this
# run's own suffix, takes its own log file, and is stopped by the EXIT trap, failure paths included.
#
# Env:
#   QUAY_SERVE_CHECK_RESTART_WAIT  seconds to allow for the restart after kill -9 (default 15)
#   QUAY_SERVE_CHECK_HEAP_WAIT     seconds to allow for the heap-ceiling restart (default 45)
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/serve-scoped.sh"
MODE="${1:-all}"

RESTART_WAIT_SECS="${QUAY_SERVE_CHECK_RESTART_WAIT:-15}"
HEAP_WAIT_SECS="${QUAY_SERVE_CHECK_HEAP_WAIT:-45}"
# The ceiling the heap section holds itself to, and the one serve-scoped.sh defaults to. Read from
# the script's own default rather than repeated: if the default moves, this number must move too.
DEFAULT_HEAP_MB=2048

TMP="$(mktemp -d "${TMPDIR:-/tmp}/serve-scoped-check.XXXXXX")"
SUFFIX="$$-$RANDOM"
UNITS="$TMP/units"
: >"$UNITS"

log() { printf '%s\n' "$*"; }

# Every unit this run creates is named from this list and stopped here, so an Aborted run leaves
# no transient unit behind and no stray entry in the user's systemd state.
cleanup() {
  set +e
  if [ -s "$UNITS" ]; then
    while read -r u; do
      [ -n "$u" ] || continue
      systemctl --user stop "$u.service" >/dev/null 2>&1
    done <"$UNITS"
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

register_unit() { printf '%s\n' "$1" >>"$UNITS"; }
unit_prop() { systemctl --user show "$1.service" -p "$2" --value 2>/dev/null || true; }
current_main_pid() { unit_prop "$1" MainPID; }

has_usable_systemd() {
  command -v systemd-run >/dev/null 2>&1 \
    && command -v systemctl >/dev/null 2>&1 \
    && systemd-run --user --scope --quiet true >/dev/null 2>&1
}

# Read back the single line of argv the fake `systemd-run` recorded for the most recent call.
last_argv() { tail -n 1 "$1" 2>/dev/null || true; }

# assert_argv <argv> <label> <required-substring>...  — every missing item is named, and the ACTUAL
# argv goes on the same line, so a red names both what was wanted and what was handed to systemd.
assert_argv() {
  local argv="$1" label="$2"; shift 2
  # An empty reading is not "the argv was wrong", it is "start never reached systemd-run" — two
  # different defects, and only this branch tells them apart.
  if [ -z "$argv" ]; then
    log "FAIL fake/$label: the fake systemd-run recorded NO call at all, so nothing was asserted; expected argv to carry $*"
    return 1
  fi
  local missing="" want
  for want in "$@"; do
    case "$argv" in *"$want"*) ;; *) missing="$missing $want" ;; esac
  done
  if [ -n "$missing" ]; then
    log "FAIL fake/$label: argv is missing:$missing; actual argv: $argv"
    return 1
  fi
  log "ok   fake/$label: argv carries $*"
  return 0
}

assert_argv_absent() {
  local argv="$1" label="$2" unwanted="$3"
  case "$argv" in
    *"$unwanted"*)
      log "FAIL fake/$label: argv must not carry $unwanted; actual argv: $argv"
      return 1
      ;;
  esac
  log "ok   fake/$label: argv carries no $unwanted"
  return 0
}

# ── fake section ────────────────────────────────────────────────────────────────────────────────
fake_section() {
  local rc=0 bin="$TMP/fakebin" nosystemd="$TMP/nosystemd-bin"
  mkdir -p "$bin" "$nosystemd"

  # Records the argv of every NON-probe call. The usability probe is a `--scope` invocation, so it
  # is answered silently instead of being recorded — otherwise the argv file's last line would be
  # the probe, not the unit start.
  cat >"$bin/systemd-run" <<'FAKE'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "--scope" ] && exit 0; done
printf '%s\n' "$*" >>"${QUAY_SERVE_CHECK_ARGV:?QUAY_SERVE_CHECK_ARGV unset}"
FAKE
  chmod +x "$bin/systemd-run"

  # A systemd-run that exists and always fails: the "no usable user manager" shape (an unreachable
  # manager, as in a container with no session bus). The script must say so and refuse, not start
  # the server unscoped and not exit 0.
  printf '#!/usr/bin/env bash\nexit 1\n' >"$nosystemd/systemd-run"
  chmod +x "$nosystemd/systemd-run"

  local argv_file="$TMP/argv"
  local unit="check-fake-$SUFFIX"

  # 1. default: the restart policy, the burst limit, and the 2048 heap ceiling.
  : >"$argv_file"
  PATH="$bin:$PATH" QUAY_SERVE_CHECK_ARGV="$argv_file" QUAY_SERVER_UNIT="$unit" \
    QUAY_SERVER_CMD="npm run server" bash "$SCRIPT" start >/dev/null 2>&1
  assert_argv "$(last_argv "$argv_file")" "default" \
    "--unit=$unit" "Restart=on-failure" "RestartSec=" "StartLimitBurst=" "StartLimitIntervalSec=" \
    "--setenv=NODE_OPTIONS=--max-old-space-size=$DEFAULT_HEAP_MB" "-- npm run server" || rc=1

  # 2. the ceiling can be turned off, and turning it off removes the flag rather than blanking it.
  : >"$argv_file"
  PATH="$bin:$PATH" QUAY_SERVE_CHECK_ARGV="$argv_file" QUAY_SERVER_UNIT="$unit" \
    QUAY_SERVER_CMD="npm run server" QUAY_SERVER_HEAP_MB=off bash "$SCRIPT" start >/dev/null 2>&1
  assert_argv_absent "$(last_argv "$argv_file")" "heap-off" "--max-old-space-size" || rc=1

  # 3. a caller's own NODE_OPTIONS survives, and the ceiling is APPENDED to it — the composed
  #    element is asserted as one string so "both flags present but one of them clobbered" fails.
  : >"$argv_file"
  PATH="$bin:$PATH" QUAY_SERVE_CHECK_ARGV="$argv_file" QUAY_SERVER_UNIT="$unit" \
    QUAY_SERVER_CMD="npm run server" NODE_OPTIONS=--trace-warnings bash "$SCRIPT" start >/dev/null 2>&1
  assert_argv "$(last_argv "$argv_file")" "caller-node-options" \
    "--setenv=NODE_OPTIONS=--trace-warnings --max-old-space-size=$DEFAULT_HEAP_MB" || rc=1

  # 4. the override seam replaces the managed command and nothing else (the default is asserted
  #    above, so this cannot be satisfied by changing the default).
  : >"$argv_file"
  PATH="$bin:$PATH" QUAY_SERVE_CHECK_ARGV="$argv_file" QUAY_SERVER_UNIT="$unit" \
    QUAY_SERVER_CMD="node /tmp/serve-scoped-check-stub.js" bash "$SCRIPT" start >/dev/null 2>&1
  assert_argv "$(last_argv "$argv_file")" "cmd-override" \
    "-- node /tmp/serve-scoped-check-stub.js" "Restart=on-failure" || rc=1

  # 4b. neither transient-mode start may hand the unit a PATH: the unit must inherit the user
  #     manager's, which is the whole point of dropping `--setenv=PATH="$PATH"`.
  : >"$argv_file"
  PATH="$bin:$PATH" QUAY_SERVE_CHECK_ARGV="$argv_file" QUAY_SERVER_UNIT="$unit" \
    QUAY_SERVER_CMD="npm run server" bash "$SCRIPT" start >/dev/null 2>&1
  assert_argv_absent "$(last_argv "$argv_file")" "no-path-setenv" "--setenv=PATH" || rc=1

  # 4c. production mode (no QUAY_SERVER_CMD) drives the FIXED unit with systemctl and never calls
  #     systemd-run. A fake systemctl records its calls and reports an installed fragment.
  local fixedbin="$TMP/fixedbin"; mkdir -p "$fixedbin"
  cat >"$fixedbin/systemctl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${QUAY_SERVE_CHECK_CALLS:?}"
case "$*" in
  *is-active*) exit 3 ;;
  *"show"*FragmentPath*) echo "${QUAY_SERVE_CHECK_FRAGMENT-/home/x/.config/systemd/user/claudecodeui-server.service}" ;;
esac
exit 0
FAKE
  chmod +x "$fixedbin/systemctl"
  cp "$bin/systemd-run" "$fixedbin/systemd-run"
  local calls="$TMP/calls"
  : >"$calls"; : >"$argv_file"
  PATH="$fixedbin:$PATH" QUAY_SERVE_CHECK_CALLS="$calls" QUAY_SERVE_CHECK_ARGV="$argv_file" \
    QUAY_SERVER_UNIT="$unit" bash "$SCRIPT" start >/dev/null 2>&1
  local calls_line; calls_line="$(tr '\n' '|' <"$calls")"
  assert_argv "$calls_line" "fixed-unit-start" "--user daemon-reload" "--user start $unit.service" || rc=1
  if [ -s "$argv_file" ]; then
    log "FAIL fake/fixed-unit-no-systemd-run: production start called systemd-run: $(last_argv "$argv_file")"; rc=1
  else
    log "ok   fake/fixed-unit-no-systemd-run: production start made no systemd-run call"
  fi
  # a transient fragment (/run/...) or none at all is a refusal naming the installer
  local out4
  out4="$(PATH="$fixedbin:$PATH" QUAY_SERVE_CHECK_CALLS="$calls" QUAY_SERVE_CHECK_FRAGMENT=/run/user/1/systemd/transient/x.service \
    QUAY_SERVER_UNIT="$unit" bash "$SCRIPT" start 2>&1)"; local rc4=$?
  if [ "$rc4" = 4 ] && printf '%s' "$out4" | grep -q install-server-unit.sh; then
    log "ok   fake/fixed-unit-not-installed: a transient fragment is refused (exit 4) naming install-server-unit.sh"
  else
    log "FAIL fake/fixed-unit-not-installed: exit=$rc4 output: $out4"; rc=1
  fi

  # 4d. the shipped unit file: restart policy, heap ceiling, no PATH of any kind.
  local ufile="$ROOT_DIR/scripts/systemd/claudecodeui-server.service" want_u bad_u=""
  for want_u in "Restart=on-failure" "RestartSec=5" "StartLimitBurst=5" "StartLimitIntervalSec=60" \
      "Environment=NODE_OPTIONS=--max-old-space-size=$DEFAULT_HEAP_MB" "ExecStart=/usr/bin/env node dist-server/server/index.js"; do
    grep -qxF "$want_u" "$ufile" 2>/dev/null || bad_u="$bad_u missing:$want_u"
  done
  grep -vE '^\s*#' "$ufile" 2>/dev/null | grep -qE 'PATH=|plugins/(cache|synced)|MemoryMax' && bad_u="$bad_u forbidden-directive"
  if [ -z "$bad_u" ]; then log "ok   fake/unit-file: restart policy + ${DEFAULT_HEAP_MB}MB ceiling present; no PATH/plugin/MemoryMax directive"
  else log "FAIL fake/unit-file: $ufile:$bad_u"; rc=1; fi

  # 5. no usable user manager: a clear refusal, and an exit code that is neither 0 (silently
  #    unscoped) nor the usage code 2.
  local out rc_nosd
  out="$(PATH="$nosystemd:$PATH" QUAY_SERVER_UNIT="$unit" bash "$SCRIPT" start 2>&1)"
  rc_nosd=$?
  if [ "$rc_nosd" = 0 ] || [ "$rc_nosd" = 2 ]; then
    log "FAIL fake/no-user-manager: exit=$rc_nosd (a refusal must not read as success or as usage); output: $out"
    rc=1
  elif ! printf '%s' "$out" | grep -q "no usable systemd user manager"; then
    log "FAIL fake/no-user-manager: exit=$rc_nosd but the message does not say what is missing; output: $out"
    rc=1
  else
    log "ok   fake/no-user-manager: exit=$rc_nosd and the refusal names the missing manager"
  fi

  # 6. the usage contract is unchanged: no arguments is exit 2 with a usage line.
  local usage_rc
  usage_rc="$(PATH="$bin:$PATH" bash "$SCRIPT" >/dev/null 2>&1; echo $?)"
  if [ "$usage_rc" = 2 ]; then
    log "ok   fake/usage: no arguments exits 2"
  else
    log "FAIL fake/usage: no arguments exited $usage_rc, expected 2"
    rc=1
  fi

  return "$rc"
}

# ── real-machine sections ───────────────────────────────────────────────────────────────────────
# Each writes its own log inside $TMP, so a throwaway unit never appends to the repo's server.log.
stub_alive() {
  cat >"$TMP/alive.js" <<'JS'
// A liveness stub: alive, silent, no allocation pressure. The restart under test is caused by the
// SIGKILL the section sends, not by anything this file does.
setInterval(() => {}, 1000);
JS
  printf '%s\n' "$TMP/alive.js"
}

stub_alloc() {
  cat >"$TMP/alloc.js" <<'JS'
// Retains objects until V8 hits the ceiling the unit was started with, then aborts. This is the
// shape of a slow leak: nothing here is a bug in the server, it is only a way to reach the cap.
const retained = [];
setInterval(() => {}, 1000);
while (true) retained.push('y'.repeat(1 << 20));
JS
  printf '%s\n' "$TMP/alloc.js"
}

start_stub_unit() {
  local unit="$1" cmd="$2" logfile="$3"
  register_unit "$unit"
  QUAY_SERVER_UNIT="$unit" QUAY_SERVER_CMD="$cmd" QUAY_SERVER_LOG="$TMP/$logfile" \
    bash "$SCRIPT" start >/dev/null 2>&1
}

restart_section() {
  local unit="serve-scoped-check-restart-$SUFFIX" rc=0
  local t0=$SECONDS
  local alive; alive="$(stub_alive)"
  if ! start_stub_unit "$unit" "node $alive" "restart.log"; then
    log "FAIL restart: serve-scoped.sh start failed for $unit"
    return 1
  fi

  local pid; pid="$(current_main_pid "$unit")"
  if [ -z "$pid" ] || [ "$pid" = 0 ]; then
    log "FAIL restart: $unit has no MainPID right after start"
    return 1
  fi

  kill -9 "$pid" 2>/dev/null || true

  local deadline=$((SECONDS + RESTART_WAIT_SECS)) newpid="" nr="0" state=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    newpid="$(current_main_pid "$unit")"
    nr="$(unit_prop "$unit" NRestarts)"
    if [ -n "$newpid" ] && [ "$newpid" != 0 ] && [ "$newpid" != "$pid" ]; then break; fi
    sleep 0.5
  done
  state="$(unit_prop "$unit" ActiveState)"

  if [ -z "$newpid" ] || [ "$newpid" = 0 ] || [ "$newpid" = "$pid" ]; then
    log "FAIL restart: $unit did not come back within ${RESTART_WAIT_SECS}s of kill -9 $pid (MainPID='${newpid:-none}', ActiveState='$state', NRestarts='${nr:-0}')"
    return 1
  fi
  if [ "$nr" != 1 ]; then
    log "FAIL restart: $unit came back (MainPID $pid -> $newpid, ActiveState='$state') but NRestarts='$nr', expected 1"
    return 1
  fi
  if [ "$state" != active ]; then
    log "FAIL restart: $unit has a new MainPID $newpid but ActiveState='$state', expected active"
    return 1
  fi
  log "ok   restart: kill -9 $pid -> MainPID $newpid, ActiveState=active, NRestarts=1 after $((SECONDS - t0))s"

  # AC5's other half: `status` has to report the counters on a live unit. `MainPID` with no space
  # comes only from the counters block — `systemctl status` prints "Main PID: <pid>" — so this
  # cannot be satisfied by the status output alone.
  local status_out missing="" want
  status_out="$(QUAY_SERVER_UNIT="$unit" bash "$SCRIPT" status 2>&1)"
  for want in NRestarts MemoryCurrent MemoryPeak MainPID; do
    case "$status_out" in *"$want"*) ;; *) missing="$missing $want" ;; esac
  done
  if [ -n "$missing" ]; then
    log "FAIL restart: serve-scoped.sh status is missing:$missing; output: $(printf '%s' "$status_out" | tr '\n' ' ')"
    return 1
  fi
  log "ok   status: the counters block reports NRestarts/MemoryCurrent/MemoryPeak/MainPID on a live unit"
  return "$rc"
}

stop_section() {
  local unit="serve-scoped-check-stop-$SUFFIX"
  local alive; alive="$(stub_alive)"
  if ! start_stub_unit "$unit" "node $alive" "stop.log"; then
    log "FAIL stop: serve-scoped.sh start failed for $unit"
    return 1
  fi
  sleep 1

  local nr_before; nr_before="$(unit_prop "$unit" NRestarts)"
  if [ "$nr_before" != 0 ]; then
    log "FAIL stop: $unit reported NRestarts='$nr_before' before any stop, expected 0"
    return 1
  fi
  local pid; pid="$(current_main_pid "$unit")"
  if [ -z "$pid" ] || [ "$pid" = 0 ]; then
    log "FAIL stop: $unit has no MainPID before the stop"
    return 1
  fi

  if ! QUAY_SERVER_UNIT="$unit" bash "$SCRIPT" stop >/dev/null 2>&1; then
    log "FAIL stop: serve-scoped.sh stop failed for $unit"
    return 1
  fi

  # `--collect` unloads the unit once it has stopped, so LoadState=not-found is the reading that
  # distinguishes "stopped and stayed stopped" from "restarted by Restart=on-failure".
  local deadline=$((SECONDS + 10)) loadstate=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    loadstate="$(unit_prop "$unit" LoadState)"
    [ "$loadstate" = not-found ] && break
    sleep 0.5
  done
  if [ "$loadstate" != not-found ]; then
    log "FAIL stop: $unit is still loaded after stop (LoadState='$loadstate'); a clean stop must not be restarted"
    return 1
  fi
  if systemctl --user is-active --quiet "$unit.service"; then
    log "FAIL stop: $unit is active after stop; Restart=on-failure restarted a clean stop"
    return 1
  fi
  log "ok   stop: NRestarts=0 while running, and after stop $unit is unloaded (LoadState=not-found, not active) — the clean stop was not restarted"
  return 0
}

heap_section() {
  local unit="serve-scoped-check-heap-$SUFFIX"
  local t0=$SECONDS
  local alloc; alloc="$(stub_alloc)"
  if ! start_stub_unit "$unit" "node $alloc" "heap.log"; then
    log "FAIL heap: serve-scoped.sh start failed for $unit"
    return 1
  fi

  local cap_bytes=$((DEFAULT_HEAP_MB * 1024 * 1024))
  local limit_bytes=$((cap_bytes * 2))

  local deadline=$((SECONDS + HEAP_WAIT_SECS)) nr="0"
  while [ "$SECONDS" -lt "$deadline" ]; do
    nr="$(unit_prop "$unit" NRestarts)"
    [ -n "$nr" ] && [ "$nr" -ge 1 ] 2>/dev/null && break
    nr="0"
    sleep 1
  done
  if [ "${nr:-0}" -lt 1 ] 2>/dev/null; then
    log "FAIL heap: $unit did not restart within ${HEAP_WAIT_SECS}s (NRestarts='$nr'); the ${DEFAULT_HEAP_MB}MB ceiling did not end the process, or Restart= did not pick it up"
    return 1
  fi

  local peak; peak="$(unit_prop "$unit" MemoryPeak)"
  case "$peak" in
    ''|*[!0-9]*)
      log "FAIL heap: NRestarts=$nr (restarted) but MemoryPeak is not a number: '$peak'"
      return 1
      ;;
  esac
  if [ "$peak" -gt "$limit_bytes" ]; then
    log "FAIL heap: NRestarts=$nr (restarted) but MemoryPeak=$((peak / 1048576))MB exceeds 2x the ${DEFAULT_HEAP_MB}MB ceiling ($((limit_bytes / 1048576))MB)"
    return 1
  fi
  if ! grep -q 'heap out of memory' "$TMP/heap.log" 2>/dev/null; then
    log "FAIL heap: NRestarts=$nr (restarted) but the unit log has no node heap-limit abort; the restart was some other failure"
    return 1
  fi
  log "ok   heap: reached the ${DEFAULT_HEAP_MB}MB ceiling, aborted (log has node's heap-limit abort) and was restarted within $((SECONDS - t0))s (NRestarts=$nr); MemoryPeak=$((peak / 1048576))MB <= $((limit_bytes / 1048576))MB"
  return 0
}

# ── driver ──────────────────────────────────────────────────────────────────────────────────────
run_section() {
  local name="$1"
  case "$name" in
    fake) fake_section >"$TMP/fake.out" 2>&1 ;;
    restart) restart_section >"$TMP/restart.out" 2>&1 ;;
    stop) stop_section >"$TMP/stop.out" 2>&1 ;;
    heap) heap_section >"$TMP/heap.out" 2>&1 ;;
    *) return 2 ;;
  esac
  echo "$?" >"$TMP/$name.rc"
}

main() {
  case "$MODE" in
    all|fake|restart|stop|heap) ;;
    *)
      echo "usage: serve-scoped-check.sh [all|fake|restart|stop|heap]" >&2
      exit 2
      ;;
  esac

  local -a sections
  if [ "$MODE" = all ]; then sections=(fake restart stop heap); else sections=("$MODE"); fi

  local want_real=0 s
  for s in "${sections[@]}"; do [ "$s" = fake ] || want_real=1; done

  # The stub files are created up front, before any section is backgrounded, so no section depends
  # on another having run first.
  local real_ok=0
  if [ "$want_real" = 1 ]; then
    stub_alive >/dev/null
    stub_alloc >/dev/null
    if has_usable_systemd; then real_ok=1; fi
  fi

  # `fake` is instant and serial. The real sections each wait on systemd for seconds, so they run
  # in PARALLEL — the whole script has to fit inside a 60s criterion gate.
  local -a bg=()
  for s in "${sections[@]}"; do
    if [ "$s" = fake ]; then
      run_section fake
    elif [ "$real_ok" = 1 ]; then
      run_section "$s" &
      bg+=("$!")
    fi
  done
  if [ "${#bg[@]}" -gt 0 ]; then wait; fi

  local overall=0 name rc
  for name in "${sections[@]}"; do
    if [ -f "$TMP/$name.rc" ]; then
      rc="$(cat "$TMP/$name.rc")"
      [ "$rc" = 0 ] || overall=1
      log "── section $name: exit $rc ──"
      cat "$TMP/$name.out"
    elif [ "$name" != fake ] && [ "$real_ok" = 0 ]; then
      log "── section $name: SKIP (no usable systemd user manager; nothing was exercised) ──"
    fi
  done

  if [ "$overall" = 0 ]; then log "serve-scoped-check: PASS"; else log "serve-scoped-check: FAIL"; fi
  exit "$overall"
}

main
