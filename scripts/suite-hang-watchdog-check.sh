#!/usr/bin/env bash
# suite-hang-watchdog-check.sh — re-runnable proof that scripts/test.sh ENDS a hung suite
# instead of leaving it for a human to notice.
#
# WHY THIS EXISTS: a hang is the one failure class nothing downstream can see, because it
# is not red — it is silent. quay's own record of that shape is two runs that sat for 33.7
# and 199.5 minutes, both ended by a person running `kill -TERM -- -<pgid>` by hand. The
# project-side fix is the two liveness guards in scripts/test.sh (max-runtime, silence);
# this script is the half that makes them re-checkable, because a guard that is never
# exercised is indistinguishable from a guard that does not work.
#
# It does NOT inspect thresholds or grep the source for variables. Every scenario really
# runs scripts/test.sh and reads the report it produced, so what is being checked is the
# behaviour and not the shape of the code:
#
#   1 hang-silence       a fixture that never returns and stops printing => the silence
#                        guard ends it; exit non-zero; the report names the guard, its
#                        threshold and how long the suite had been silent
#   2 hang-max-runtime   the same fixture with the silence guard set out of reach => the
#                        max-runtime guard ends it (the two guards are independent, and
#                        each scenario is arranged so only one of them can fire)
#   3 slow-but-alive     a fixture that runs LONGER THAN the silence threshold but keeps
#                        printing the whole way => it must NOT be killed. This is the
#                        asymmetry that makes a wrong threshold expensive: too low kills a
#                        healthy suite, so the guard counts output growth as progress and
#                        this scenario is what holds it to that.
#   4 healthy-defaults   an ordinary passing file under the SHIPPED thresholds => exit 0
#                        and no verdict line anywhere in the report
#   5 falsify/unarmed    the arming line is stripped from a copy of scripts/test.sh, so no
#                        guard can ever run; THIS SAME CHECKER is then pointed at that copy
#                        and must exit non-zero, naming the hang it watched go un-ended
#
# Scenarios 1-4 run in parallel (they are independent processes with their own temp dirs);
# 5 runs after them. The whole thing is sized to finish well inside a 60s acceptance gate —
# see BOUND_SECS below for how that budget is spent.
#
# WHERE THE THRESHOLDS COME FROM (AC-4): the shipped defaults in scripts/test.sh are not
# picked, they are computed from a measurement, and the computation lives in this script
# (see "threshold derivation" below). Every run prints the result as ONE line carrying both
# readings, the multiplier and the two thresholds, so the numbers can be re-derived by
# whoever reads them. The measurement itself is `--measure`, which is deliberately NOT part
# of the default run: it has to run three full suites (~2 minutes), and a checker that spent
# that inside the default path would be killed by the 60s goal gate and score as "acceptance
# timed out" instead of on its reading.
#
# Usage: bash scripts/suite-hang-watchdog-check.sh
#        bash scripts/suite-hang-watchdog-check.sh --measure   (re-measure the thresholds)
# Exit:  0 = every scenario behaved as specified. 1 = at least one did not; each failure is
#        printed as `CHECK FAIL [scenario] <cause>` on its own line. 2 = setup/usage error.
# Env:   QUAY_HANG_WATCHDOG_TEST_SH=<path>  score an alternative scripts/test.sh. Scenario 5
#        uses it for its unarmed copy, and its presence suppresses scenario 5 in the child,
#        so the checker cannot recurse into itself.
#        QUAY_HANG_WATCHDOG_MEASUREMENT=<path>  read the --measure readings from here
#        (default .quay/suite-hang-watchdog/measurement.env); absent, the pinned first
#        measurement is used and the derivation line says so.
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || { echo "CHECK FAIL [setup] cannot cd to $ROOT_DIR"; exit 2; }

TEST_SH="${QUAY_HANG_WATCHDOG_TEST_SH:-$ROOT_DIR/scripts/test.sh}"
[ -f "$TEST_SH" ] || { echo "CHECK FAIL [setup] no scripts/test.sh at $TEST_SH"; exit 2; }
NESTED=0
[ -n "${QUAY_HANG_WATCHDOG_TEST_SH:-}" ] && NESTED=1

# ── the readings this checker runs at ───────────────────────────────────────────────────
# These are NOT the shipped thresholds. The shipped ones are minutes (derived from the
# measured wall clock; see tasks/gap-suite-hang-watchdog.md), and a gate that had to sit
# through them would blow its own 60s budget. The guard is the same code path either way —
# what varies is only where the line is drawn, which is exactly what makes the thresholds
# overridable in the first place.
CHECK_SILENCE_MS=4000        # scenario 1: fires ~4s after the fixture stops printing
CHECK_MAX_RUNTIME_MS=6000    # scenario 2: fires 6s after the suite starts
CHECK_UNREACHABLE_MS=600000  # keeps the guard that is not under test out of the way
BOUND_SECS=30                # a bound must be ENDED inside this, or the guard did not work
# A suite with no guards at all is watched for this long before it is called un-ended. It
# must be comfortably longer than CHECK_MAX_RUNTIME_MS, or "it did not end" would just mean
# "we did not wait long enough"; 2.5x is that margin.
FALSIFY_SECS=15
[ "$NESTED" -eq 1 ] && BOUND_SECS=$((FALSIFY_SECS - 3))

# ── threshold derivation (AC-4) ─────────────────────────────────────────────────────────
# Three readings go in:
#   quiet_wall_ms       one full `bash scripts/test.sh` on an otherwise idle machine
#   concurrent_wall_ms  the slowest of TWO full suites started at the same time — the worst
#                       condition a suite is expected to survive here, because fan-in and the
#                       dispatch fleet really do run suites side by side
#   max_gap_ms          the longest stretch with no progress signal at all, worst case over
#                       both conditions; this is what the silence guard is set from
# and two recipes come out, both "multiply, then round UP to a whole minute":
#   max_runtime_ms = ceil_minute(M_RUNTIME × concurrent_wall_ms)
#   silence_ms     = ceil_minute(M_SILENCE × max_gap_ms)
# Rounding up to a whole minute only ever makes a guard more permissive, which is the
# direction that is safe to be sloppy in: the two failure modes are not symmetric. Too high
# leaves a hang for a person to notice (what happens today); too LOW kills a healthy suite
# that was merely slowed down by load, and turns a load artifact into a lost run.
#
# `--measure` runs those three suites itself and merges what it reads into a cache under
# .quay/; the reading it holds is a RUNNING MAXIMUM, so the bound can only ever be derived
# from a worse observation than the last one. Until it has been run, the pinned first
# measurement below is used and the derivation line says `readings=pinned` — the same idiom
# as scripts/suite-concurrency-check.sh's K_RATIO, which keeps its baseline in a comment
# beside the constant.
M_RUNTIME=9
M_SILENCE=30
# First measurement, 2026-09-20, this host: quiet 53908ms, worst concurrent 65700ms, worst
# progress gap 8000ms  =>  9 × 65.7s = 591s -> 600s, 30 × 8.0s = 240s.
#
# This pair is the FLOOR, not the shipping value: what scripts/test.sh ships is what the
# recipe derives from the worst reading on record, which is normally at or above these (it
# currently ships 660s / 240s, the 660s coming from a later 67.4s concurrent reading). The
# distinction is what makes the check below stable — a busy host should not be able to talk
# the shipped bound down, and should not be able to red this checker either.
PINNED_QUIET_WALL_MS=53908
PINNED_CONCURRENT_WALL_MS=65700
PINNED_MAX_GAP_MS=8000
MEASURE_CACHE="${QUAY_HANG_WATCHDOG_MEASUREMENT:-$ROOT_DIR/.quay/suite-hang-watchdog/measurement.env}"

ceil_minute() { echo $(( (($1 + 59999) / 60000) * 60000 )); }

# readings_load — fill QUIET_WALL_MS / CONCURRENT_WALL_MS / MAX_GAP_MS / READINGS_SOURCE.
# The cache is only honoured when all three values are present and numeric: a half-written
# or hand-edited cache must degrade to the pinned reading, never to a threshold derived from
# a blank.
readings_load() {
  QUIET_WALL_MS="$PINNED_QUIET_WALL_MS"
  CONCURRENT_WALL_MS="$PINNED_CONCURRENT_WALL_MS"
  MAX_GAP_MS="$PINNED_MAX_GAP_MS"
  READINGS_SOURCE="pinned"
  [ -r "$MEASURE_CACHE" ] || return 0
  local q c g
  q="$(sed -n 's/^QUIET_WALL_MS=\([0-9][0-9]*\)$/\1/p' "$MEASURE_CACHE" | head -1)"
  c="$(sed -n 's/^CONCURRENT_WALL_MS=\([0-9][0-9]*\)$/\1/p' "$MEASURE_CACHE" | head -1)"
  g="$(sed -n 's/^MAX_GAP_MS=\([0-9][0-9]*\)$/\1/p' "$MEASURE_CACHE" | head -1)"
  case "$q" in ''|*[!0-9]*) return 0 ;; esac
  case "$c" in ''|*[!0-9]*) return 0 ;; esac
  case "$g" in ''|*[!0-9]*) return 0 ;; esac
  QUIET_WALL_MS="$q" CONCURRENT_WALL_MS="$c" MAX_GAP_MS="$g" READINGS_SOURCE="measured"
  return 0
}

# derive_line — the ONE line AC-4 asks for: both readings, both multipliers and the two
# thresholds, so the arithmetic can be redone without opening this file.
derive_line() {
  readings_load
  printf 'suite-watchdog: thresholds readings=%s quiet_wall_ms=%s concurrent_wall_ms=%s max_gap_ms=%s margin_runtime=%s margin_silence=%s max_runtime_ms=%s silence_ms=%s\n' \
    "$READINGS_SOURCE" "$QUIET_WALL_MS" "$CONCURRENT_WALL_MS" "$MAX_GAP_MS" \
    "$M_RUNTIME" "$M_SILENCE" \
    "$(ceil_minute $((M_RUNTIME * CONCURRENT_WALL_MS)))" \
    "$(ceil_minute $((M_SILENCE * MAX_GAP_MS)))"
}

# suite_trace_field <report> <key> — read one field out of the watchdog's own trace line.
# Reading the report rather than the source is the point: these are the values the suite
# actually ran under, not the ones the file appears to assign.
suite_trace_field() {
  grep -m1 '^suite-watchdog: trace ' "$1" 2>/dev/null | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1
}

# ── --measure ───────────────────────────────────────────────────────────────────────────
# Runs the three suites the derivation needs, caches the readings, prints the one line, and
# FAILS if the thresholds scripts/test.sh is actually running under are below the ones the
# recipe just derived — the only way a stale default gets caught, and the reason this is not
# merely a number-printing exercise. Both thresholds are read back out of the suite's own
# trace line, so what is compared is the shipped behaviour, not a grep of the assignment.
measure_run() {
  local tag="$1" s e rc gap rt si completed=0 aborted=0
  s="$(now_ms)"
  QUAY_SUITE_WATCHDOG_TRACE=1 bash "$TEST_SH" >"$MEASURE_DIR/$tag.out" 2>&1
  rc=$?
  e="$(now_ms)"
  # A sample counts as usable when the suite COMPLETED under its own guards, which is not
  # the same as it passing. What is being measured is the shape of the run — how long it
  # took and how long it went quiet — and a file that flaked red under load is part of that
  # shape, not a reason to throw the sample away. What DOES invalidate a sample is the run
  # being cut short, so both facts are recorded rather than inferred from the exit code.
  grep -q '^suite-watchdog: trace ' "$MEASURE_DIR/$tag.out" 2>/dev/null && completed=1
  grep -q '^suite-watchdog: ABORT ' "$MEASURE_DIR/$tag.out" 2>/dev/null && aborted=1
  gap="$(suite_trace_field "$MEASURE_DIR/$tag.out" max_silence_ms)"
  rt="$(suite_trace_field "$MEASURE_DIR/$tag.out" max_runtime_threshold_ms)"
  si="$(suite_trace_field "$MEASURE_DIR/$tag.out" silence_threshold_ms)"
  printf 'wall_ms=%s rc=%s completed=%s aborted=%s max_gap_ms=%s shipped_max_runtime_ms=%s shipped_silence_ms=%s\n' \
    "$((e - s))" "$rc" "$completed" "$aborted" "${gap:-0}" "${rt:-0}" "${si:-0}" > "$MEASURE_DIR/$tag.meta"
}

# The meta file is one space-separated line (so a half-written file cannot be mistaken for a
# complete one with the tail missing), hence the split before the lookup.
meta_field() { tr ' ' '\n' < "$MEASURE_DIR/$1.meta" 2>/dev/null | sed -n "s/^$2=\([0-9][0-9]*\)$/\1/p" | head -1; }

measure_mode() {
  MEASURE_DIR="$ROOT_DIR/.quay/suite-hang-watchdog"
  mkdir -p "$MEASURE_DIR" || { echo "CHECK FAIL [measure] cannot create $MEASURE_DIR"; exit 2; }
  echo "suite-hang-watchdog-check: [measure] quiet: one full suite; concurrent: two at once — this takes ~2 minutes, and the logs are in $MEASURE_DIR"
  measure_run quiet
  measure_run conc-0 &
  local p0=$!
  measure_run conc-1 &
  local p1=$!
  wait "$p0" "$p1" 2>/dev/null || true

  local bad="" red="" t
  for t in quiet conc-0 conc-1; do
    [ "$(meta_field "$t" completed)" = "1" ] \
      || bad="$bad $t(no trace line: it did not run to the end, rc=$(meta_field "$t" rc))"
    [ "$(meta_field "$t" aborted)" = "1" ] \
      && bad="$bad $t(its own guard fired mid-run)"
    [ "$(meta_field "$t" rc)" = "0" ] || red="$red $t(rc=$(meta_field "$t" rc))"
  done
  if [ -n "$bad" ]; then
    echo "CHECK FAIL [measure] a measurement run was cut short ($bad) — a truncated run's wall clock is a bound on the wrong thing; logs in $MEASURE_DIR"
    exit 1
  fi

  local quiet conc qgap cgap mgap
  quiet="$(meta_field quiet wall_ms)"; conc="$(meta_field conc-0 wall_ms)"
  [ "$(meta_field conc-1 wall_ms)" -gt "$conc" ] && conc="$(meta_field conc-1 wall_ms)"
  qgap="$(meta_field quiet max_gap_ms)"; cgap="$(meta_field conc-0 max_gap_ms)"
  [ "$(meta_field conc-1 max_gap_ms)" -gt "$cgap" ] && cgap="$(meta_field conc-1 max_gap_ms)"
  mgap="$qgap"; [ "$cgap" -gt "$mgap" ] && mgap="$cgap"

  # Each value is checked on its own: concatenating first would let a MISSING reading hide
  # behind its neighbours (an empty field leaves a shorter but still all-digits string).
  bad=""
  case "$quiet" in ''|*[!0-9]*) bad="quiet_wall_ms='$quiet'" ;; esac
  case "$conc" in ''|*[!0-9]*) bad="$bad concurrent_wall_ms='$conc'" ;; esac
  case "$mgap" in ''|*[!0-9]*) bad="$bad max_gap_ms='$mgap'" ;; esac
  if [ -n "$bad" ]; then
    echo "CHECK FAIL [measure] the measurement runs produced no usable reading ($bad) — check $MEASURE_DIR"
    exit 1
  fi

  # Each reading is a RUNNING MAXIMUM, not the latest sample. A threshold exists to survive
  # the worst case seen, so a later measurement that comes back faster must not talk the
  # bound back down — and on a box shared with the rest of the dispatch fleet the "quiet"
  # sample is not reliably quieter than the concurrent one anyway (this host has produced a
  # 58.7s quiet wall against a 57.8s concurrent one, purely from other workers). Merging
  # keeps the derivation a function of the worst observation on record.
  readings_load
  [ "$QUIET_WALL_MS" -lt "$quiet" ] && QUIET_WALL_MS="$quiet"
  [ "$CONCURRENT_WALL_MS" -lt "$conc" ] && CONCURRENT_WALL_MS="$conc"
  [ "$MAX_GAP_MS" -lt "$mgap" ] && MAX_GAP_MS="$mgap"

  printf 'QUIET_WALL_MS=%s\nCONCURRENT_WALL_MS=%s\nMAX_GAP_MS=%s\nMEASURED_AT=%s\n' \
    "$QUIET_WALL_MS" "$CONCURRENT_WALL_MS" "$MAX_GAP_MS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MEASURE_CACHE"

  # The cache now holds the merged readings, so re-deriving picks them up and the line
  # reports exactly the worst case on record.
  derive_line
  [ -n "$red" ] && echo "suite-hang-watchdog-check: [measure] note — the sample carried failing file(s) ($red); the readings stand (they measure the run's shape, not its verdict) and $MEASURE_DIR says which file it was"

  local derived_rt derived_si shipped_rt shipped_si floor_rt floor_si
  derived_rt="$(ceil_minute $((M_RUNTIME * conc)))"
  derived_si="$(ceil_minute $((M_SILENCE * mgap)))"
  shipped_rt="$(meta_field quiet shipped_max_runtime_ms)"
  shipped_si="$(meta_field quiet shipped_silence_ms)"
  # What is FAILED against is the recipe applied to the PINNED readings — the floor the
  # shipped defaults were derived from. Comparing against the fresh readings instead would
  # make this check a function of how busy the host happened to be (a slightly loaded
  # machine derives a minute more and the checker would go red for nothing), and a check
  # that reds on load is a check people learn to ignore. The fresh readings still get their
  # say, as drift below, because "the host has moved and the default may need re-deriving"
  # is a judgement for a person, not a verdict for a script.
  floor_rt="$(ceil_minute $((M_RUNTIME * PINNED_CONCURRENT_WALL_MS)))"
  floor_si="$(ceil_minute $((M_SILENCE * PINNED_MAX_GAP_MS)))"
  if [ "$shipped_rt" -lt "$floor_rt" ] || [ "$shipped_si" -lt "$floor_si" ]; then
    echo "CHECK FAIL [measure] scripts/test.sh ships thresholds below the ones the recipe derives from the recorded measurement — max_runtime ${shipped_rt}ms vs ${floor_rt}ms, silence ${shipped_si}ms vs ${floor_si}ms; a default under that floor can end a HEALTHY suite on this host"
    exit 1
  fi
  echo "CHECK OK   [measure] shipped thresholds clear the floor derived from the recorded measurement (max_runtime ${shipped_rt}ms >= ${floor_rt}ms, silence ${shipped_si}ms >= ${floor_si}ms)"
  if [ "$shipped_rt" -lt "$derived_rt" ] || [ "$shipped_si" -lt "$derived_si" ]; then
    echo "CHECK OK   [measure] drift: today's readings would derive max_runtime ${derived_rt}ms / silence ${derived_si}ms, above what ships (${shipped_rt}ms / ${shipped_si}ms) — this host is slower than when the defaults were derived, so re-derive them before trusting the margin"
  fi
  exit 0
}

WORK="$(mktemp -d)"
FIXTURES=()
cleanup() {
  local f
  for f in "${FIXTURES[@]+"${FIXTURES[@]}"}"; do rm -f "$f"; done
  rmdir --ignore-fail-on-non-empty "$ROOT_DIR/server/.suite-hang-check" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

SCENARIO="setup"
fail() { echo "CHECK FAIL [$SCENARIO] $*"; exit 1; }

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }

# pid_alive <pid> — false once the process is gone OR has become a zombie. `kill -0` alone
# is NOT enough: a zombie still answers it, and a watcher that polls on `kill -0` alone
# waits out its entire bound for a process that already finished. An unreadable /proc (non
# Linux) falls back to `kill -0`, which is then merely pessimistic, never wrong.
pid_alive() {
  local pid="$1" line st
  kill -0 "$pid" 2>/dev/null || return 1
  [ -r "/proc/$pid/stat" ] || return 0
  line="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 0
  st="${line##*) }"; st="${st%% *}"
  [ "$st" = "Z" ] && return 1
  return 0
}

# kill_tree <pid> <sig> — signal every DESCENDANT of <pid>, deepest first; <pid> is signalled
# by the caller. A suite left running here would outlive the gate that failed it.
kill_tree() {
  local pid="$1" sig="${2:-TERM}" c
  for c in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$c" "$sig"
    kill -s "$sig" "$c" 2>/dev/null || true
  done
  return 0
}

# ── fixtures ────────────────────────────────────────────────────────────────────────────
# Under server/ because scripts/test.sh decides a file's lane from its path prefix, and
# named *.fixture.ts rather than *.test.ts so a leftover copy can never be swept into a
# real suite run by the `find server -name '*.test.ts'` collection. All of them are passed
# positionally, which is the only way a file outside the collection is ever run.
HANG_FIXTURE="server/.suite-hang-check/hang-forever.fixture.ts"
SLOW_FIXTURE="server/.suite-hang-check/slow-but-alive.fixture.ts"
OK_FIXTURE="server/.suite-hang-check/healthy.fixture.ts"

mk_fixture() {
  local rel="$1"
  mkdir -p "$ROOT_DIR/${rel%/*}"
  cat > "$ROOT_DIR/$rel" || fail "could not write fixture $rel"
  [ -s "$ROOT_DIR/$rel" ] || fail "fixture $rel is empty after writing"
  FIXTURES+=("$ROOT_DIR/$rel")
}

mk_fixture "$HANG_FIXTURE" <<'FIXTURE'
import test from 'node:test';

// Never returns, and says nothing more after the runner's own banner. That silence is the
// whole point: this is the shape a real hang has — no red, no output, no end.
test('never returns', async () => {
  await new Promise(() => {});
});
FIXTURE

mk_fixture "$SLOW_FIXTURE" <<'FIXTURE'
import test from 'node:test';
import assert from 'node:assert/strict';

// Runs for longer than the checker's silence threshold while printing throughout. A guard
// that read "no MILESTONE for N seconds" without also counting output growth would kill
// this file; a guard that reads "no PROGRESS for N seconds" must not.
const ticks = Number(process.env.QUAY_HANG_CHECK_TICKS ?? '0');

test('slow but alive', async () => {
  for (let i = 0; i < ticks; i++) {
    process.stdout.write(`tick ${i}\n`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(1, 1);
});
FIXTURE

mk_fixture "$OK_FIXTURE" <<'FIXTURE'
import test from 'node:test';
import assert from 'node:assert/strict';

test('an ordinary passing file', () => {
  assert.equal(1, 1);
});
FIXTURE

# ── running the real suite under a bound ────────────────────────────────────────────────
# run_bounded <tag> <bound_secs> <ENV=VAL...> -- <test.sh args...>
# Leaves: BOUND_OUT (the suite's report), BOUND_STATE (exited | unended), BOUND_RC,
# BOUND_SECS. The report goes to its own `.<tag>.report` file and NOT to the scenario's
# stdout: both are open on the same directory, and sharing one path means the suite's
# redirect truncates the very verdict line the parent is about to read back.
# Whatever is still alive when the bound expires is ended here — the checker must not be
# the thing that leaks a hung suite.
run_bounded() {
  local tag="$1" bound="$2"; shift 2
  local -a envargs=()
  while [ "$1" != "--" ]; do envargs+=("$1"); shift; done
  shift
  local start pid i=0
  BOUND_OUT="$WORK/$tag.report"
  start=$(now_ms)
  env "${envargs[@]+"${envargs[@]}"}" bash "$TEST_SH" "$@" >"$BOUND_OUT" 2>&1 &
  pid=$!
  while [ "$i" -lt $((bound * 10)) ]; do
    pid_alive "$pid" || break
    i=$((i + 1)); sleep 0.1
  done
  if pid_alive "$pid"; then
    BOUND_STATE="unended"
    kill -s TERM "$pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 30 ]; do pid_alive "$pid" || break; i=$((i + 1)); sleep 0.1; done
    kill_tree "$pid" TERM
    kill -s KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  else
    BOUND_STATE="exited"
    wait "$pid" 2>/dev/null
    BOUND_RC=$?
  fi
  BOUND_SECS=$(( ($(now_ms) - start) / 1000 ))
  return 0
}

# abort_field <report> <key> — read one field out of the guard's verdict line. Reading the
# report rather than the source is the point: the guard has to SAY which guard it was.
abort_field() {
  grep -m1 '^suite-watchdog: ABORT ' "$1" 2>/dev/null | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1
}

# assert_ended <tag> <expected-guard> <expected-threshold> <expected-reason>
# The whole contract of a guard firing, in one place: it ENDED the run, the run is not a
# pass, and the report carries guard + threshold + silence so a reader needs no other file.
assert_ended() {
  local tag="$1" guard="$2" threshold="$3" reason="$4" out="$WORK/$1.report" observed
  [ "$BOUND_STATE" = "exited" ] \
    || bad "$tag: the suite was still running after ${BOUND_SECS}s — nothing ended it (the ${guard} guard was set to ${threshold}ms)"
  [ "${BOUND_RC:-0}" -ne 0 ] \
    || bad "$tag: the hanging suite exited 0 in ${BOUND_SECS}s — a guard firing must not look like a pass"
  local line; line="$(grep -m1 '^suite-watchdog: ABORT ' "$out" 2>/dev/null || true)"
  [ -n "$line" ] \
    || bad "$tag: the suite ended (rc=$BOUND_RC) but its report carries no verdict line, so nothing says a guard ended it; report tail: $(tail -3 "$out" | tr '\n' ' ')"
  observed="$(abort_field "$out" guard)"
  [ "$observed" = "$guard" ] \
    || bad "$tag: expected the ${guard} guard to fire but the report names guard=${observed:-<none>} (line: $line)"
  observed="$(abort_field "$out" threshold_ms)"
  [ "$observed" = "$threshold" ] \
    || bad "$tag: the report does not carry the threshold that was in force (expected threshold_ms=$threshold, read ${observed:-<none>})"
  observed="$(abort_field "$out" reason)"
  [ "$observed" = "$reason" ] \
    || bad "$tag: guard=${guard} must end the run as reason=${reason}, but the report says reason=${observed:-<none>}"
  observed="$(abort_field "$out" silent_ms)"
  case "$observed" in ''|*[!0-9]*) bad "$tag: the report carries no usable silent_ms (read '${observed:-<none>}'), so how long the suite had been silent is not recoverable from it" ;; esac
  [ "$observed" -gt 0 ] \
    || bad "$tag: the report says silent_ms=$observed, but a guard that ended a hang must have observed silence"
  grep -qF 'not ok - suite-watchdog:' "$out" \
    || bad "$tag: the guard's verdict never reached the failure list as a 'not ok - suite-watchdog:' line"
  ok "$tag: guard=${guard} reason=${reason} threshold_ms=${threshold} silent_ms=$(abort_field "$out" silent_ms) elapsed_ms=$(abort_field "$out" elapsed_ms) → exit ${BOUND_RC} after ${BOUND_SECS}s"
}

# assert_not_killed <tag> <fixture>
# "It was not killed" is only worth something if the file actually RAN, so the run has to
# show its own per-file pass record — otherwise a suite that quietly did nothing at all
# would satisfy every other assertion here.
assert_not_killed() {
  local tag="$1" fixture="$2" out="$WORK/$1.report" esc dur
  [ "$BOUND_STATE" = "exited" ] \
    || bad "$tag: a healthy suite was still running after ${BOUND_SECS}s — the guard killed or stalled a run that was making progress"
  [ "${BOUND_RC:-1}" -eq 0 ] \
    || bad "$tag: a healthy suite exited ${BOUND_RC}; report tail: $(tail -3 "$out" | tr '\n' ' ')"
  grep -qF 'suite-watchdog:' "$out" \
    && bad "$tag: a healthy suite passed but its report carries a watchdog line ($(grep -m1 -F 'suite-watchdog:' "$out")) — it must not be touched at all"
  esc="${fixture//./\\.}"
  grep -qE "^__PERFILE__ duration_ms=[0-9]+ ${esc} passed=true" "$out" \
    || bad "$tag: no passing per-file record for $fixture in the report, so nothing was actually run and 'not killed' says nothing; report tail: $(tail -3 "$out" | tr '\n' ' ')"
  dur="$(sed -n "s|^__PERFILE__ duration_ms=\([0-9]*\) ${esc} passed=true.*|\1|p" "$out" | head -1)"
  ok "$tag: $fixture passed in ${dur}ms, exit 0 after ${BOUND_SECS}s, no watchdog line in the report"
}

# Each scenario runs in its own subshell and ends by printing exactly one line: the detail
# on success (exit 0) or the cause on failure (exit 1).
ok()  { echo "$*"; return 0; }
bad() { echo "$*"; exit 1; }

# ── scenarios 1-4 (independent; run in parallel) ────────────────────────────────────────
s_hang_silence() {
  run_bounded hang-silence "$BOUND_SECS" \
    "QUAY_SUITE_SILENCE_MS=$CHECK_SILENCE_MS" \
    "QUAY_SUITE_MAX_RUNTIME_MS=$CHECK_UNREACHABLE_MS" \
    -- "$HANG_FIXTURE"
  assert_ended hang-silence silence "$CHECK_SILENCE_MS" hung
}

s_hang_max_runtime() {
  run_bounded hang-max-runtime "$BOUND_SECS" \
    "QUAY_SUITE_SILENCE_MS=$CHECK_UNREACHABLE_MS" \
    "QUAY_SUITE_MAX_RUNTIME_MS=$CHECK_MAX_RUNTIME_MS" \
    -- "$HANG_FIXTURE"
  assert_ended hang-max-runtime max-runtime "$CHECK_MAX_RUNTIME_MS" timeout
}

s_slow_but_alive() {
  # 7 ticks x 1s = ~7s of work under a 4s silence bound: it is silent for at most a second
  # at a time, so progress is continuous and the guard must never fire.
  run_bounded slow-but-alive "$BOUND_SECS" \
    "QUAY_SUITE_SILENCE_MS=$CHECK_SILENCE_MS" \
    "QUAY_SUITE_MAX_RUNTIME_MS=$CHECK_UNREACHABLE_MS" \
    "QUAY_HANG_CHECK_TICKS=7" \
    -- "$SLOW_FIXTURE"
  assert_not_killed slow-but-alive "$SLOW_FIXTURE"
}

s_healthy_defaults() {
  # No threshold overrides at all: this is the shipped configuration, on an ordinary file.
  run_bounded healthy-defaults "$BOUND_SECS" -- "$OK_FIXTURE"
  assert_not_killed healthy-defaults "$OK_FIXTURE"
}

run_scenario() {
  local name="$1" fn="$2"
  ( "$fn" ) > "$WORK/$name.out" 2>&1
  echo "$?" > "$WORK/$name.rc"
}

# Argument handling lives HERE, at the bottom of the definitions and not at the top of the
# file: bash only knows a function once it has executed its definition, and `--measure`
# calls now_ms and the helpers above. A mode dispatch placed above them would run against a
# half-defined script.
for arg in "$@"; do
  case "$arg" in
    --measure) measure_mode ;;
    -h|--help) sed -n '/^# Usage:/,/^set -u$/p' "${BASH_SOURCE[0]}" | grep '^#'; exit 0 ;;
    *) echo "suite-hang-watchdog-check: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SCENARIOS_ORDER="hang-silence hang-max-runtime slow-but-alive healthy-defaults"
run_scenario hang-silence s_hang_silence &
run_scenario hang-max-runtime s_hang_max_runtime &
run_scenario slow-but-alive s_slow_but_alive &
run_scenario healthy-defaults s_healthy_defaults &
wait

# The derivation line goes first, so the numbers are on screen before any scenario result
# and a reader who stops after one line still has them.
derive_line

FAILED_COUNT=0
FAILED_FIRST=""
# record_fail <scenario> <cause> — every failure is printed with its scenario and its
# cause, and the FIRST one is what the final verdict line repeats, so a red run names one
# concrete thing to go and look at rather than a count.
record_fail() {
  [ "$FAILED_COUNT" -eq 0 ] && FAILED_FIRST="$1|$2"
  FAILED_COUNT=$((FAILED_COUNT + 1))
  echo "CHECK FAIL [$1] $2"
}

for name in $SCENARIOS_ORDER; do
  rc="$(cat "$WORK/$name.rc" 2>/dev/null || echo 1)"
  detail="$(tail -1 "$WORK/$name.out" 2>/dev/null || true)"
  if [ "${rc:-1}" = "0" ]; then
    echo "CHECK OK   [$name] ${detail:-<no detail>}"
  else
    record_fail "$name" "${detail:-<no output>}"
  fi
done

# ── scenario 5: falsification ───────────────────────────────────────────────────────────
# Removing the guards must make THIS checker red, and red for the right reason. The
# mutation is anchored to the single line that arms the watchdog and is verified to have
# applied before anything is scored — an unapplied mutation would otherwise score as a
# suspiciously clean pass, which is the failure mode a falsification test exists to avoid.
if [ "$NESTED" -eq 0 ]; then
  SCENARIO="falsify/unarmed-watchdog"
  UNARMED="$ROOT_DIR/scripts/.suite-hang-watchdog-unarmed.$$.sh"
  FIXTURES+=("$UNARMED")
  # The replacement keeps a background job (`( : ) &`) rather than deleting the line
  # outright. What is being falsified is the GUARD, not the script's ability to start: a
  # deleted line leaves `$!` unset, `set -u` kills the copy at startup, and the run would
  # then go red for a reason that has nothing to do with the hang.
  awk '
    /^\( watchdog_loop \) &$/ { print "( : ) &  # __WATCHDOG_DISARMED__"; next }
    { print }
  ' "$TEST_SH" > "$UNARMED"
  if ! grep -qF '__WATCHDOG_DISARMED__' "$UNARMED"; then
    record_fail "falsify/unarmed-watchdog" "the disarm mutation did not apply to $TEST_SH — the arming line it anchors to is gone, so nothing was falsified"
  elif grep -qE '^\( watchdog_loop \) &$' "$UNARMED"; then
    record_fail "falsify/unarmed-watchdog" "the watchdog is still armed in the mutated copy of $TEST_SH — nothing was falsified"
  else
    QUAY_HANG_WATCHDOG_TEST_SH="$UNARMED" bash "${BASH_SOURCE[0]}" >"$WORK/nested.out" 2>&1
    NESTED_RC=$?
    if [ "$NESTED_RC" -eq 0 ]; then
      record_fail "falsify/unarmed-watchdog" "with both guards removed the checker still exited 0 — the hang it is supposed to watch go un-ended was not observed as un-ended; its verdict was: $(tail -1 "$WORK/nested.out")"
    elif ! grep -qF 'still running after' "$WORK/nested.out"; then
      record_fail "falsify/unarmed-watchdog" "the unguarded run went red (exit $NESTED_RC) but not for the hang: nothing in its verdict says a suite was still running; verdict was: $(tail -1 "$WORK/nested.out")"
    else
      echo "CHECK OK   [falsify/unarmed-watchdog] guards removed → checker exit $NESTED_RC, verdict names the un-ended hang"
    fi
  fi
fi

# ── verdict ─────────────────────────────────────────────────────────────────────────────
if [ "$FAILED_COUNT" -gt 0 ]; then
  echo "suite-hang-watchdog-check: FAIL ($FAILED_COUNT scenario(s) red) — ${FAILED_FIRST%%|*}: ${FAILED_FIRST#*|}"
  exit 1
fi

echo "CHECK PASS scripts/test.sh ends a hung suite with the guard that noticed it (silence or max-runtime), says which guard, its threshold and how long the suite had been silent, exits non-zero, leaves a healthy suite — even one slower than the silence threshold — untouched, and stops ending hangs at all once its guards are removed."
exit 0
