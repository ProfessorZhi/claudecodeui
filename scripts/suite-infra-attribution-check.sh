#!/usr/bin/env bash
# suite-infra-attribution-check.sh — re-runnable proof that scripts/test.sh can tell an
# infrastructure-shaped failure from a real one, and says which it is in the report.
#
# WHY THIS EXISTS: two 2026-09-20 fan-in runs went red with a *different* subset of files each
# time, and every file that was red passed when run alone. The suite printed load artifacts
# (`Error: STACK_TRACE_ERROR`, `spawnSync ... ETIMEDOUT`) in exactly the same shape as a genuine
# assertion failure — `not ok - <file>: <first line>` — so the only thing downstream could see was
# `state: red` with no worker-fixable defect named, and dispatch stopped. The project-side half of
# the fix is the `__PERFILE_KIND__ file=<label> kind=infra|assert` record scripts/test.sh now emits
# for every failure; this script is the half that makes it re-checkable.
#
# It does NOT feed synthetic strings to the parser: every scenario really runs scripts/test.sh
# (scoped to one fixture, so no typecheck/lint and no full suite) and reads the report it printed.
# Each scenario additionally asserts the report carries no bash diagnostic (a broken normaliser in
# the instrumentation shows up there first, e.g. `[: : integer expression expected`).
#
# SCENARIOS
#   1 infra/spawn-timeout  a fixture that never returns, under a 4s per-file bound => timeout(1)
#                          exits 124 => kind=infra, and the legacy line shapes are still parseable
#   2 infra/worker-death   a vitest fixture that kills its own worker => vitest reports nothing
#                          per-file => kind=infra
#   3 assert/real-failure  a fixture with a genuine failing assertion => kind=assert
#   4 falsify/always-assert  the classification region of a copy of scripts/test.sh is replaced by
#                          `echo assert`; THIS SAME CHECKER must then exit non-zero and name the
#                          kind it actually observed (AC-104's falsifiability requirement)
#   5 falsify/no-kind-field  the marked __PERFILE_KIND__ emission is deleted from a copy; this
#                          checker must then exit non-zero naming the absent classification field
#                          (the field is mandatory, not decorative)
#
# Usage: bash scripts/suite-infra-attribution-check.sh
# Exit:  0 = every scenario behaved as specified. 1 = the first scenario that did not (its cause and
#        the classification value actually observed are printed on that one verdict line). 2 = env
#        or usage error.
# Env:   QUAY_ATTRIBUTION_TEST_SH=<path>  score an alternative scripts/test.sh. Scenarios 4-5 use
#        it to score their mutated copies, and it suppresses 4-5 in the child, so the checker cannot
#        recurse into itself.
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || { echo "CHECK FAIL [setup] cannot cd to $ROOT_DIR"; exit 2; }

TEST_SH="${QUAY_ATTRIBUTION_TEST_SH:-$ROOT_DIR/scripts/test.sh}"
[ -f "$TEST_SH" ] || { echo "CHECK FAIL [setup] no scripts/test.sh at $TEST_SH"; exit 2; }
NESTED=0
[ -n "${QUAY_ATTRIBUTION_TEST_SH:-}" ] && NESTED=1

# Long enough that tsx/vitest start and run the fixture, short enough to keep this gate quick.
INFRA_TIMEOUT=4
WORK="$(mktemp -d)"
FIXTURES=()

cleanup() {
  local f
  for f in "${FIXTURES[@]+"${FIXTURES[@]}"}"; do rm -f "$f"; done
  rm -rf "$WORK"
  rmdir --ignore-fail-on-non-empty "$ROOT_DIR/server/.suite-check" 2>/dev/null || true
  rmdir --ignore-fail-on-non-empty "$ROOT_DIR/src/.suite-check" 2>/dev/null || true
}
trap cleanup EXIT

SCENARIO="setup"
fail() { echo "CHECK FAIL [$SCENARIO] $*"; exit 1; }
pass() { echo "CHECK OK   [$SCENARIO] $*"; }

# Fixtures live under server/ and src/ because scripts/test.sh decides a file's lane from its path
# prefix (server/* => node:test, anything else => vitest), and vitest only runs files matched by its
# `include` (src/**). They are removed on any exit; a leftover fixture is inert either way (the
# server ones are not named *.test.ts, the vitest one is a no-op without QUAY_SUITE_INFRA_FIXTURE).
mk_fixture() {
  local rel="$1"
  mkdir -p "$ROOT_DIR/${rel%/*}"
  cat > "$ROOT_DIR/$rel" || fail "could not write fixture $rel"
  [ -s "$ROOT_DIR/$rel" ] || fail "fixture $rel is empty after writing"
  FIXTURES+=("$ROOT_DIR/$rel")
}

# run_suite <tag> <per-file-timeout-secs> <extra-env-assignment|-> <fixture...>
# Runs the real scripts/test.sh scoped to the given files; combined output lands in $OUT, exit code
# in $LAST_RC.
run_suite() {
  local tag="$1" tmo="$2" extra="$3"; shift 3
  local -a envargs=("QUAY_TEST_FILE_TIMEOUT=$tmo")
  [ "$extra" != "-" ] && envargs+=("$extra")
  OUT="$WORK/$tag.out"
  env "${envargs[@]}" bash "$TEST_SH" "$@" >"$OUT" 2>&1
  LAST_RC=$?
}

# kind_of <report> <label> -> infra | assert | absent | conflict[<values>]
kind_of() {
  local out="$1" label="$2" kinds
  kinds="$(sed -n "s|^__PERFILE_KIND__ file=$label kind=\(.*\)\$|\1|p" "$out" | sort -u | tr '\n' ',')"
  kinds="${kinds%,}"
  case "$kinds" in
    "") echo absent ;;
    infra|assert) echo "$kinds" ;;
    *) echo "conflict[$kinds]" ;;
  esac
}

# assert_kind <report> <label> <expected>
assert_kind() {
  local out="$1" label="$2" expected="$3" observed
  observed="$(kind_of "$out" "$label")"
  case "$observed" in
    absent) fail "$label was reported as failed with NO classification record — a failure must not be reported without its kind (observed kind=<absent>)" ;;
    conflict\[*\]) fail "$label carries conflicting classification records ($observed) — a file must have exactly one kind" ;;
    "$expected") pass "$label observed kind=$observed" ;;
    *) fail "$label expected kind=$expected but observed kind=$observed" ;;
  esac
}

# assert_all_failed_kinds <report> <expected> — every failed record in the report must be <expected>
assert_all_failed_kinds() {
  local out="$1" expected="$2" labels l observed n=0
  labels="$(sed -n 's/^__PERFILE__ duration_ms=[0-9.]* \(.*\) passed=false .*$/\1/p' "$out")"
  [ -n "$labels" ] || fail "the scenario produced no failed file at all (no 'passed=false' __PERFILE__ line) — there was nothing to attribute"
  while IFS= read -r l; do
    n=$((n + 1))
    observed="$(kind_of "$out" "$l")"
    [ "$observed" = "$expected" ] || fail "$l expected kind=$expected but observed kind=$observed (every failure in this scenario must be $expected)"
  done <<< "$labels"
  pass "$n failed record(s), all kind=$expected"
}

# assert_legacy_shape <report> <label> — the two line shapes downstream parsers depend on are still
# intact. quay's parsePerFileLines matches __PERFILE__ with an ANCHORED regex and silently drops
# non-matching lines, so a new key=value on that line would lose every per-file row on /tests.
assert_legacy_shape() {
  local out="$1" label="$2" esc line
  esc="${2//./\\.}"
  if ! grep -qE "^__PERFILE__ duration_ms=[0-9.]+ ${esc} passed=false( end_ms=[0-9]+)?( cpu_ms=[0-9.]+)?( mem_peak_kb=[0-9.]+)?\$" "$out"; then
    line="$(grep -m1 -F "__PERFILE__ duration_ms=" "$out" || echo '<no __PERFILE__ line>')"
    fail "the failing file's __PERFILE__ line no longer matches quay's anchored per-file regex (every downstream row would be dropped); observed: $line"
  fi
  grep -qF "not ok - $label: " "$out" || fail "no 'not ok - $label: <reason>' line in the report"
  pass "legacy line shapes intact for $label (__PERFILE__ still matches quay's anchored regex, 'not ok -' line present)"
}

# assert_no_shell_diagnostics <report> — a report is read by a machine and by whoever is on call;
# a bash diagnostic inside it means the instrumentation itself is broken (e.g. an arithmetic test on
# an unnormalised value), and it is exactly the kind of noise that makes a red unattributable.
assert_no_shell_diagnostics() {
  local out="$1" hit
  hit="$(grep -nE 'integer expression expected|unbound variable' "$out" | head -1)"
  [ -z "$hit" ] || fail "scripts/test.sh wrote a shell diagnostic into its own report: $hit"
  pass "report carries no shell diagnostics"
}

# ---------------------------------------------------------------------------------------------
SCENARIO="infra/spawn-timeout"
mk_fixture server/.suite-check/hang-forever.fixture.ts <<'FIXTURE'
import test from 'node:test';

// Never returns. Under scripts/test.sh's per-file bound the process is cut off by timeout(1),
// which exits 124 — the structural fact that classifies this file kind=infra. No worker can fix
// this shape, which is exactly why it must not reach a judge looking like a real failure.
test('never returns', async () => {
  await new Promise(() => {});
});
FIXTURE
run_suite hang "$INFRA_TIMEOUT" - server/.suite-check/hang-forever.fixture.ts
[ "$LAST_RC" -ne 0 ] || fail "scripts/test.sh exited 0 on a file that never returns — the infra shape was not reproduced"
assert_kind "$OUT" server/.suite-check/hang-forever.fixture.ts infra
assert_legacy_shape "$OUT" server/.suite-check/hang-forever.fixture.ts
assert_no_shell_diagnostics "$OUT"

# ---------------------------------------------------------------------------------------------
SCENARIO="infra/worker-death"
mk_fixture src/.suite-check/worker-death.fixture.test.ts <<'FIXTURE'
import { test } from 'vitest';

// A worker that dies mid-run is the shape the 2026-09-20 fan-in runs produced: vitest can report
// nothing test-attributable for the file, so there is no defect here for a worker to fix. Inert
// unless this checker sets QUAY_SUITE_INFRA_FIXTURE, so a fixture left behind by an interrupted
// run is a no-op pass and can never sabotage a real suite.
test('kills its own worker', () => {
  if (process.env.QUAY_SUITE_INFRA_FIXTURE !== 'kill-worker') return;
  process.kill(process.pid, 'SIGKILL');
});
FIXTURE
run_suite worker-death 600 QUAY_SUITE_INFRA_FIXTURE=kill-worker src/.suite-check/worker-death.fixture.test.ts
[ "$LAST_RC" -ne 0 ] || fail "scripts/test.sh exited 0 on a vitest worker death — the infra shape was not reproduced"
assert_all_failed_kinds "$OUT" infra
assert_legacy_shape "$OUT" client-vitest
assert_no_shell_diagnostics "$OUT"

# ---------------------------------------------------------------------------------------------
SCENARIO="assert/real-failure"
mk_fixture server/.suite-check/real-assertion.fixture.ts <<'FIXTURE'
import test from 'node:test';
import assert from 'node:assert/strict';

// A genuine assertion failure. The runner tallies it (ℹ fail 1), which is the structural fact that
// must ALWAYS beat the infra shapes: one exemption per red is irreversible, so the default is
// real-defect.
test('a genuine assertion failure', () => {
  assert.equal(1, 2);
});
FIXTURE
run_suite real-assertion 600 - server/.suite-check/real-assertion.fixture.ts
[ "$LAST_RC" -ne 0 ] || fail "scripts/test.sh exited 0 on a failing assertion — the scenario did not reproduce"
assert_kind "$OUT" server/.suite-check/real-assertion.fixture.ts assert
assert_legacy_shape "$OUT" server/.suite-check/real-assertion.fixture.ts
assert_no_shell_diagnostics "$OUT"

# ---------------------------------------------------------------------------------------------
if [ "$NESTED" -eq 0 ]; then
  # Falsification. scripts/test.sh delimits its classification decision with the
  # __BEGIN_CLASSIFY__/__END_CLASSIFY__ markup so these mutations are anchored to that markup
  # rather than to the shape of the code, and each one is verified to have applied before it is
  # scored — otherwise a checker that stopped mutating anything would quietly keep passing.
  mutate_always_assert() {
    awk '
      /^# __BEGIN_CLASSIFY__$/ { print; print "classify_failure_kind() { echo assert; }"; skip = 1; next }
      /^# __END_CLASSIFY__$/   { skip = 0 }
      !skip { print }
    ' "$1" > "$2"
  }
  mutate_drop_kind_record() {
    awk '/__PERFILE_KIND__/ && /__KIND_RECORD__/ { next } { print }' "$1" > "$2"
  }

  # run_nested <mutated-test.sh> — runs THIS script against the mutated scripts/test.sh and leaves
  # its exit code in $NESTED_RC, its output in $NESTED_OUT. The child sees QUAY_ATTRIBUTION_TEST_SH,
  # so it stops after scenarios 1-3 instead of recursing into these two.
  run_nested() {
    NESTED_OUT="$WORK/nested-$(basename "$1").out"
    QUAY_ATTRIBUTION_TEST_SH="$1" bash "${BASH_SOURCE[0]}" >"$NESTED_OUT" 2>&1
    NESTED_RC=$?
  }

  SCENARIO="falsify/always-assert"
  DEGRADED="$ROOT_DIR/scripts/.suite-attribution-always-assert.$$.sh"
  mutate_always_assert "$TEST_SH" "$DEGRADED"
  FIXTURES+=("$DEGRADED")
  grep -qF 'classify_failure_kind() { echo assert; }' "$DEGRADED" \
    || fail "the always-assert mutation did not apply to $TEST_SH — nothing was falsified"
  run_nested "$DEGRADED"
  [ "$NESTED_RC" -ne 0 ] || fail "with the classifier degraded to always 'assert' the checker still exited 0 — the classification field is not load-bearing; observed: $(grep -m1 -F '__PERFILE_KIND__' "$NESTED_OUT" || echo '<no classification record>')"
  grep -qE 'observed kind=[a-z]+' "$NESTED_OUT" \
    || fail "the degraded run was red but did not name the kind it actually observed; its verdict was: $(head -c 200 "$NESTED_OUT")"
  pass "degraded classifier (always assert) -> exit $NESTED_RC, verdict names $(sed -n 's/.*\(observed kind=[a-z]*\).*/\1/p' "$NESTED_OUT" | head -1)"

  SCENARIO="falsify/no-kind-field"
  NOFIELD="$ROOT_DIR/scripts/.suite-attribution-no-kind.$$.sh"
  mutate_drop_kind_record "$TEST_SH" "$NOFIELD"
  FIXTURES+=("$NOFIELD")
  grep -qE '^ *echo "__PERFILE_KIND__' "$NOFIELD" \
    && fail "the drop-kind-record mutation did not apply to $TEST_SH — nothing was falsified"
  run_nested "$NOFIELD"
  [ "$NESTED_RC" -ne 0 ] || fail "with the __PERFILE_KIND__ record removed the checker still exited 0 — a failing file with no classification field passed silently"
  grep -qiF 'classification record' "$NESTED_OUT" \
    || fail "the red run did not name the absent classification field; its verdict was: $(head -c 200 "$NESTED_OUT")"
  pass "missing classification field -> exit $NESTED_RC, verdict names the absent field"
fi

# ---------------------------------------------------------------------------------------------
SCENARIO="summary"
echo "CHECK PASS scripts/test.sh attributes cut-off/worker-death failures to kind=infra and genuine assertion failures to kind=assert, keeps the legacy __PERFILE__ / 'not ok -' line shapes, never reports a failure without a classification field, and keeps its own shell diagnostics out of the report."
exit 0
