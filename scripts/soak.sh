#!/usr/bin/env bash
# soak.sh — the manual entry point of the server soak harness (gap-server-soak-harness).
#
#   bash scripts/soak.sh --duration <seconds> [--report <file>] [--keep] [--burst-mb <n>]
#   bash scripts/soak.sh --duration <seconds> --burst-mb <n> --slow-client-drains
#   bash scripts/soak.sh --self-test
#
# THE SLOW-CLIENT HYPOTHESIS IS ANSWERED BY A PAIR OF RUNS, not by one. `--slow-client-drains` runs
# the control arm of the slow-client leg (soak-driver.mjs): the same socket, handshake, subscribe and
# window, but the bytes ARE read. A single arm cannot separate "the server retained the unread
# frames" from "the workload simply grew", so the conclusion is read from the DIFFERENCE between
#   bash scripts/soak.sh --duration 120 --burst-mb 500 --report hyp.json
#   bash scripts/soak.sh --duration 120 --burst-mb 500 --slow-client-drains --report ctl.json
# The control arm's `slowClientDrainedBytes` is the positive control that the server really pushed
# the burst (a stalled socket the server never wrote to proves nothing); the hypothesis arm's RSS
# trajectory is the reading. `--burst-mb` must exceed what the kernel socket buffers can absorb
# (~4MiB send + a few MiB receive on loopback, see net.ipv4.tcp_wmem), otherwise the burst never
# reaches the server's user-space send queue and the leg tests nothing — and it should exceed the
# workload's own churn, or the two arms are indistinguishable above noise. The mock gateway streams
# its reply frame by frame under backpressure, so the gateway's own memory does NOT scale with
# `--burst-mb`; it can be raised to the hundreds of MiB the differential needs — but not past 500:
# the reply is ONE assistant message, the `claude` CLI writes it as ONE `stream-json` line, and
# `--burst-mb 512` is 536,870,912 characters against V8's `2**29 - 24` maximum string length, so the
# server's `readline` dies with `RangeError: Invalid string length` at t~42s in BOTH arms. The
# largest drivable burst is bracketed to (500MiB, 512MiB]; past that the ceiling is the CLI's
# protocol hop, not this harness (see docs/operations/process-isolation-and-memory-caps.md).
#
# MANUAL BY CONSTRUCTION. Nothing in this repo calls this script: not scripts/test.sh, not
# `npm test`, not a quay routine. package.json exposes it as `npm run soak`, and the task's own AC
# greps to keep it that way. That is deliberate — a soak starts a REAL server and runs for minutes,
# which is something an operator asks for, never something a fan-in does on every change.
#
# WHAT IT DOES, in order (see scripts/soak-driver.mjs for the agitator and sampler themselves):
#
#   1. A private working directory: temp HOME, temp DATABASE_PATH, temp transcript directory, temp
#      diagnostics directory. The real ~/.claude and the real auth.db are never read or written —
#      HOME is redirected for the server, and the Claude CLI derives its config dir from HOME.
#   2. A mock Anthropic endpoint on 127.0.0.1 (scripts/soak-driver.mjs mock-gateway), so the REAL
#      `claude` binary can be driven end-to-end with no credentials and no network egress. This is
#      the task's preferred session source: readings from the real binary beat readings from a fake.
#   3. The real server (node --import tsx server/index.ts) in its OWN transient systemd unit, on a
#      free port that is explicitly not 3001. The :3001 server (`claudecodeui-server.service`) and
#      its cgroup are not touched at any point.
#   4. A 30-minute-capped observation token (scripts/mint-token.mjs) against the temp DB. The driver
#      adopts the server's `X-Refreshed-Token` re-issue, so a run longer than the token's TTL stays
#      authenticated (see the header of soak-driver.mjs).
#   5. The driver: agitate + sample every 5s + judge. Its verdict is this script's exit code.
#
# CLEANUP IS NOT OPTIONAL. Every path out of this script — green, red, harness error, Ctrl-C — runs
# the same trap: session scopes owned by OUR server pid are stopped, the soak unit is stopped and
# reset, the mock gateway is killed. The scopes are matched by the owner pid embedded in their unit
# name (`claudecodeui-session-<ownerPid>-<suffix>`, claude-session-scope.service.ts), so a scope
# belonging to the operator's own :3001 session is never a candidate.
#
# Exit codes: 0 = green, 1 = red, 2 = the harness could not run.

set -u -o pipefail

ROOT="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)"
DRIVER="$ROOT/scripts/soak-driver.mjs"
MINT="$ROOT/scripts/mint-token.mjs"
SOAK_ROOT="${SOAK_ROOT:-$HOME/.soak}"

DURATION=""
REPORT=""
SELF_TEST=0
KEEP=0
BURST_MB=4
SLOW_DRAINS=0

# Everything the trap needs, initialised so `set -u` cannot bite on an early exit.
WORK=""
UNIT=""
MOCK_PID=""
SERVER_PID=""
STUB_PIDS=""

usage() {
  cat <<'EOF'
usage:
  bash scripts/soak.sh --duration <seconds> [--report <file>] [--keep]
                        [--burst-mb <n>] [--slow-client-drains]
  bash scripts/soak.sh --self-test

  --duration <s>   drive window length; warm-up (20s) and cool-down (24s) are added around it
  --report <file>  where the JSON report goes (default: <workdir>/soak-report.json)
  --keep           keep the working directory (temp HOME/DB/transcripts/logs) after a green run
  --burst-mb <n>   size of the reply the mock gateway streams for a burst session, and therefore of
                   the payload the slow-client leg subscribes to (default: 4). Raise it well above
                   the kernel socket buffers — and above the run's own churn — when the send-buffer
                   hypothesis is the question; the gateway streams, so its memory is not a ceiling.
  --slow-client-drains
                   run the slow-client leg's CONTROL arm: identical socket, handshake, subscribe and
                   window, but the bytes are read. Pair it with a matching --burst-mb run to answer
                   the send-buffer hypothesis differentially (the header explains the two arms).
  --self-test      run the harness's own positive control: a leaking stub must be judged red
                   (naming RSS) and a steady stub green. No server is started.

  SOAK_ROOT overrides where working directories are created (default: $HOME/.soak).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --duration) DURATION="${2:-}"; shift 2 ;;
    --report) REPORT="${2:-}"; shift 2 ;;
    --burst-mb) BURST_MB="${2:-}"; shift 2 ;;
    --slow-client-drains) SLOW_DRAINS=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    --keep) KEEP=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "soak: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { echo "soak: $*"; }
die() { echo "soak: $*" >&2; exit 2; }

# ---------------------------------------------------------------------------------------------
# Cleanup. Runs on every exit path; each step is best-effort and none of them can fail the script.
# ---------------------------------------------------------------------------------------------

list_session_scopes() {
  systemctl --user list-units 'claudecodeui-session-*' --no-legend --plain 2>/dev/null \
    | awk '{print $1}' | grep -E '^claudecodeui-session-' || true
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM

  if [ -n "$STUB_PIDS" ]; then
    # shellcheck disable=SC2086
    kill $STUB_PIDS 2>/dev/null || true
    # shellcheck disable=SC2086
    wait $STUB_PIDS 2>/dev/null || true
  fi
  if [ -n "$MOCK_PID" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi

  # Session scopes are transient units in the same slice as the server, NOT children of its unit:
  # stopping the unit would leave them behind. They are matched by the owner pid in their name, so
  # only the ones THIS server created are candidates.
  local stopped=0 unit
  if [ -n "$SERVER_PID" ]; then
    for unit in $(list_session_scopes | grep -E "^claudecodeui-session-${SERVER_PID}-" || true); do
      systemctl --user stop "$unit" 2>/dev/null || true
      systemctl --user reset-failed "$unit" 2>/dev/null || true
      stopped=$((stopped + 1))
    done
  fi

  if [ -n "$UNIT" ]; then
    systemctl --user stop "${UNIT}.service" 2>/dev/null || true
    systemctl --user reset-failed "${UNIT}.service" 2>/dev/null || true
  fi

  local leftover_unit="" leftover_scopes=""
  if [ -n "$UNIT" ] && systemctl --user is-active --quiet "${UNIT}.service" 2>/dev/null; then
    leftover_unit="yes"
  fi
  if [ -n "$SERVER_PID" ]; then
    leftover_scopes="$(list_session_scopes | grep -cE "^claudecodeui-session-${SERVER_PID}-" || true)"
  fi
  log "cleanup: stopped ${stopped} session scope(s); unit=$([ -n "$leftover_unit" ] && echo STILL-ACTIVE || echo gone); scopes-of-this-server-left=${leftover_scopes:-0}"

  if [ -n "$WORK" ] && [ "$KEEP" -eq 0 ] && [ "$code" -eq 0 ]; then
    rm -rf "$WORK"
  elif [ -n "$WORK" ]; then
    log "cleanup: working directory kept at $WORK"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------------------------
# Self-test — AC-2. Same sampler, same analyzer, no server: a leak that must be red and a steady
# process that must be green are the two arms that prove the harness measures something.
# ---------------------------------------------------------------------------------------------

run_self_test() {
  WORK="$SOAK_ROOT/self-test-$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$WORK" || die "cannot create $WORK"
  local failures=0

  local kind pid out
  for kind in leak steady; do
    # The leak stub retains one Buffer per second — 32MiB, because the raw-RSS threshold is a churn
    # backstop calibrated on a real run (~10MiB/s of uncollected garbage; see DEFAULT_THRESHOLDS).
    # A 1MiB/s stub would be indistinguishable from that churn, so it would no longer be a positive
    # control: the point of this arm is that the instrument reads a leak it cannot miss.
    node "$DRIVER" stub --kind "$kind" --retain-mb 32 >"$WORK/stub-$kind.log" 2>&1 &
    pid=$!
    STUB_PIDS="$STUB_PIDS $pid"
    sleep 1

    out="$WORK/sample-$kind.log"
    node "$DRIVER" sample --pid "$pid" --warmup 4 --duration 16 --cooldown 6 --sample-interval 500 \
      --label "$kind-stub" --report "$WORK/sample-$kind.json" >"$out" 2>&1
    local code=$?

    if [ "$kind" = "leak" ]; then
      # Both halves are asserted: the verdict must be RED, and it must name RSS. A harness that
      # reds "something" (or greens everything) fails here, which is the point of the control.
      if [ "$code" -ne 1 ]; then
        log "SELF-TEST FAIL: leaking stub did not red (driver exit $code) — see $out"
        failures=$((failures + 1))
      fi
      if ! grep -q 'FAIL series=rss' "$out"; then
        log "SELF-TEST FAIL: leaking stub's verdict does not name RSS — see $out"
        failures=$((failures + 1))
      fi
      log "self-test leak stub: driver exit $code, verdict line: $(grep 'VERDICT' "$out" | tail -1)"
    else
      if [ "$code" -ne 0 ]; then
        log "SELF-TEST FAIL: steady stub was not green (driver exit $code) — see $out"
        failures=$((failures + 1))
      fi
      log "self-test steady stub: driver exit $code, verdict line: $(grep 'VERDICT' "$out" | tail -1)"
    fi
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done

  if [ "$failures" -ne 0 ]; then
    KEEP=1
    die "self-test failed (${failures} assertion(s))"
  fi
  log "self-test passed: leaking stub read red and named RSS; steady stub read green"
}

# ---------------------------------------------------------------------------------------------
# Drive — the real run.
# ---------------------------------------------------------------------------------------------

free_port() {
  node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});'
}

run_drive() {
  [ -n "$DURATION" ] || { usage >&2; die "--duration is required"; }
  case "$DURATION" in ''|*[!0-9]*) die "--duration must be a whole number of seconds";; esac
  [ "$DURATION" -ge 30 ] || die "--duration must be at least 30s (the analyzer needs >=20 in-window samples)"
  case "$BURST_MB" in ''|*[!0-9]*) die "--burst-mb must be a whole number of MiB";; esac
  [ "$BURST_MB" -ge 1 ] || die "--burst-mb must be at least 1"

  WORK="$SOAK_ROOT/run-$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$WORK/home" "$WORK/project" "$WORK/diag" "$WORK/server-transcripts"
  [ -n "$REPORT" ] || REPORT="$WORK/soak-report.json"
  REPORT="$(realpath -m "$REPORT")"

  command -v systemd-run >/dev/null 2>&1 || die "systemd-run is required: the soak server must run in its own unit"
  command -v curl >/dev/null 2>&1 || die "curl is required for the health check"

  # A free port, and a loud refusal to ever be 3001: the operator's server must not be touched.
  local port
  port="$(free_port)" || die "could not pick a free port"
  if [ "$port" = "3001" ]; then
    port="$(free_port)"
  fi
  [ "$port" != "3001" ] || die "refusing to run on 3001"

  # 1. The mock Anthropic endpoint. Started first: the server is pointed at it from its first breath.
  node "$DRIVER" mock-gateway --port-file "$WORK/mock-port" --burst-mb "$BURST_MB" >"$WORK/mock.log" 2>&1 &
  MOCK_PID=$!
  local tries=0
  while [ ! -s "$WORK/mock-port" ] && [ "$tries" -lt 60 ]; do
    sleep 0.5
    tries=$((tries + 1))
  done
  [ -s "$WORK/mock-port" ] || die "mock gateway did not report a port; see $WORK/mock.log"
  local mock_port
  mock_port="$(cat "$WORK/mock-port")"

  # 2a. The CLI the server will spawn, pinned deliberately. `systemd-run` does NOT inherit this
  #     shell's PATH: the unit runs with the systemd user manager's PATH, which on this host has no
  #     nvm bin dir and therefore no `claude`. A server launched that way answers EVERY run with
  #     "Claude Code process exited with code 1" — that message is `systemd-run` exiting 1 on
  #     "Failed to find executable claude", not the CLI failing, and a soak would burn its whole
  #     budget chasing memory growth that never happened. Both halves are pinned: the directory on
  #     PATH (the CLI is a `#!/usr/bin/env node` script, so `node` has to resolve there too) and
  #     CLAUDE_CLI_PATH, which the server forwards to the SDK as the executable path.
  local claude_bin node_bin
  claude_bin="$(command -v claude || true)"
  [ -n "$claude_bin" ] || die "the claude CLI is not on PATH; this harness drives the real CLI, not a stub"
  node_bin="$(command -v node || true)"
  [ -n "$node_bin" ] || die "node is not on PATH"
  local unit_path
  unit_path="$(dirname "$claude_bin"):$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin"

  # 2b. The real server, in its own transient unit. HOME and DATABASE_PATH are redirected, so
  #    neither the operator's ~/.claude nor the real auth.db can be reached from here. No
  #    CLAUDE_CONFIG_DIR is set on purpose: that makes the CLI's transcript directory
  #    ($HOME/.claude/projects) the same directory the server's sessions watcher scans.
  UNIT="claudecodeui-soak-$$"
  systemd-run --user --unit="$UNIT" --collect \
    --working-directory="$ROOT" \
    --property=Type=simple \
    --property="StandardOutput=append:$WORK/server.log" \
    --property="StandardError=append:$WORK/server.log" \
    --setenv=PATH="$unit_path" \
    --setenv=CLAUDE_CLI_PATH="$claude_bin" \
    --setenv=HOME="$WORK/home" \
    --setenv=DATABASE_PATH="$WORK/auth.db" \
    --setenv=SERVER_PORT="$port" \
    --setenv=HOST=127.0.0.1 \
    --setenv=CLAUDE_SESSION_SCOPE_SWEEP=off \
    --setenv=ANTHROPIC_BASE_URL="http://127.0.0.1:$mock_port" \
    --setenv=ANTHROPIC_AUTH_TOKEN=soak-token \
    --setenv=TSX_TSCONFIG_PATH=server/tsconfig.json \
    --setenv=NODE_OPTIONS="--heapsnapshot-signal=SIGUSR1 --diagnostic-dir=$WORK/diag" \
    node --import tsx server/index.ts >"$WORK/systemd-run.log" 2>&1 \
    || die "systemd-run failed to start the soak unit; see $WORK/systemd-run.log"

  tries=0
  while [ "$tries" -lt 240 ]; do
    if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      break
    fi
    if ! systemctl --user is-active --quiet "${UNIT}.service" 2>/dev/null; then
      tail -40 "$WORK/server.log" >&2 || true
      die "the soak server unit died during boot; see $WORK/server.log"
    fi
    sleep 0.5
    tries=$((tries + 1))
  done
  curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 || die "the soak server never became healthy; see $WORK/server.log"
  SERVER_PID="$(systemctl --user show -p MainPID --value "${UNIT}.service" 2>/dev/null)"
  # The slow-client leg's window, and which arm of the pair this run is: both belong on the log line,
  # because "which arm produced this report" is unreadable from the report alone after the fact.
  local slow_seconds=$((DURATION / 3))
  [ "$slow_seconds" -gt 60 ] && slow_seconds=60
  # The gateway's pid is on the log line for the same reason the server's is: it is the process whose
  # OWN peak RSS is the reading that says the burst no longer bounds the instrument (see the DoD), and
  # /proc/<gateway pid> is how a sampler gets it. The gateway also writes it to <port-file>.pid.
  log "server up: unit=$UNIT pid=$SERVER_PID port=$port mock=$mock_port mock-pid=$MOCK_PID work=$WORK"
  log "slow-client arm: burst=${BURST_MB}MiB drains=$SLOW_DRAINS seconds=$slow_seconds"

  # 3. The observation token. JWT_SECRET is explicitly removed: minting a token while the server
  #    verifies with a different secret would produce a token that cannot work.
  if ! env -u JWT_SECRET node "$MINT" mint --db "$WORK/auth.db" --out "$WORK/token" >"$WORK/mint.log" 2>&1; then
    cat "$WORK/mint.log" >&2
    die "mint-token failed; see $WORK/mint.log"
  fi

  # 4. Drive + sample + judge. The driver's exit code is the verdict; the report is kept either way.
  #    `--burst-mb` is passed to BOTH legs: the mock gateway is what streams the multi-megabyte reply,
  #    and the driver is what records how many bytes the slow client was owed.
  local -a slow_args=()
  [ "$SLOW_DRAINS" -eq 1 ] && slow_args+=(--slow-client-drains)
  node "$DRIVER" drive \
    --base-url "http://127.0.0.1:$port" --token-file "$WORK/token" --port "$port" \
    --project-dir "$WORK/project" --transcript-dir "$WORK/home/.claude/projects" \
    --duration "$DURATION" --report "$REPORT" \
    --server-log "$WORK/server.log" --diagnostic-dir "$WORK/diag" \
    --burst-mb "$BURST_MB" --slow-client-seconds "$slow_seconds" "${slow_args[@]+"${slow_args[@]}"}"
  local verdict=$?

  log "report: $REPORT"
  # A red run keeps its working directory, so the log, the temp transcripts and the diagnostics are
  # still there to read. Green runs clean up after themselves unless --keep asked otherwise.
  [ "$verdict" -eq 0 ] || KEEP=1
  exit "$verdict"
}

if [ "$SELF_TEST" -eq 1 ]; then
  run_self_test
  exit 0
fi

run_drive
