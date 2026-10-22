// Controls for the criterion `scripts/serve-scoped-check.sh`.
//
// The criterion answers a question about a RUNNING unit ("does a killed server come back?", "does a
// leak hit a ceiling?") and answers it with readings. That makes the criterion itself the thing
// most in need of a control: a section that never ran, a fake that recorded nothing, or a start
// that silently refused all produce the same shape as a passing one — a summary line and exit 0.
//
// So every case below is a PAIR, in this order: the same command must exit 0 on the same tree
// BEFORE the mutation, and must exit non-zero AFTER it. The first half is what makes the second
// half mean something; without it, "it went red" could just as well mean "this tree never ran".
// Each mutation also asserts the substitution landed on exactly one site, for the same reason — a
// mutation that matched nothing leaves the tree green while the case reports "red after mutation".
//
// The mutations are never applied to this checkout. Each case builds a two-file tree under the OS
// temp directory (the criterion and the script it drives, which is all it opens) and mutates the
// copy.
//
// Only the `fake` section is driven from here: it is 60ms, and the real-machine sections are what
// the criterion's own bare run is for (`bash scripts/serve-scoped-check.sh`, ~15s of systemd
// waiting). What these cases pin down is the VERDICT machinery — that each branch can go red at
// all, that the red names the missing item and carries the actual argv on the same line, and that
// "no usable systemd user manager" is a refusal rather than a silent success.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'serve-scoped-check.sh');
const SERVE = join(HERE, 'serve-scoped.sh');
const UNIT_FILE = join(HERE, 'systemd', 'claudecodeui-server.service');

const TMP = mkdtempSync(join(tmpdir(), 'serve-scoped-check-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

let treeSeq = 0;

/**
 * A two-file copy of the criterion plus the script it drives, at the same relative layout, so the
 * criterion's own `dirname/..` resolves inside the copy.
 * @returns {string} the copy's root
 */
function makeTree() {
  treeSeq += 1;
  const root = join(TMP, `tree-${treeSeq}`);
  mkdirSync(join(root, 'scripts', 'systemd'), { recursive: true });
  copyFileSync(UNIT_FILE, join(root, 'scripts', 'systemd', 'claudecodeui-server.service'));
  copyFileSync(SERVE, join(root, 'scripts', 'serve-scoped.sh'));
  copyFileSync(CHECK, join(root, 'scripts', 'serve-scoped-check.sh'));
  return root;
}

/**
 * @param {string} script the criterion to run
 * @param {string} mode
 * @param {Record<string, string>} [env]
 */
function runScript(script, mode, env = {}) {
  return spawnSync('/bin/bash', [script, mode], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

/**
 * The same, against a tree built by makeTree() rather than against this checkout.
 * @param {string} root @param {string} mode @param {Record<string, string>} [env]
 */
function runCheck(root, mode, env = {}) {
  return runScript(join(root, 'scripts', 'serve-scoped-check.sh'), mode, env);
}

/** @param {string} root @param {string} from @param {string} to */
function mutate(root, from, to) {
  const file = join(root, 'scripts', 'serve-scoped.sh');
  const source = readFileSync(file, 'utf8');
  const sites = source.split(from).length - 1;
  assert.equal(sites, 1, `the mutation anchor must match exactly one site, matched ${sites}: ${from}`);
  writeFileSync(file, source.replace(from, to));
}

/**
 * The pair: pristine tree green, mutated tree red. Returns the red run's output for the caller to
 * assert the verdict on.
 * @param {string} name @param {(root: string) => void} applyMutation
 */
function afterMutation(name, applyMutation) {
  const root = makeTree();
  const before = runCheck(root, 'fake');
  assert.equal(
    before.status,
    0,
    `${name}: the PRISTINE tree must exit 0 before the mutation, else the red below proves nothing\n${before.stdout}${before.stderr}`,
  );
  applyMutation(root);
  const after = runCheck(root, 'fake');
  assert.notEqual(after.status, 0, `${name}: the mutated tree must exit non-zero\n${after.stdout}`);
  assert.ok(
    after.stdout.includes('serve-scoped-check: FAIL'),
    `${name}: the run must say FAIL\n${after.stdout}`,
  );
  return after.stdout;
}

/**
 * The one FAIL line for a branch. Vacuity here is the failure mode being guarded against, so a
 * missing line is an assertion error rather than an empty string the caller can match anything
 * against.
 * @param {string} out @param {string} label
 */
function failLine(out, label) {
  const line = out.split('\n').find((l) => l.startsWith(`FAIL fake/${label}:`));
  assert.ok(line, `no FAIL verdict for fake/${label} in:\n${out}`);
  return line;
}

const OK_DEFAULT = 'ok   fake/default:';

test('a pristine tree passes the fake section, and the fake section touches no unit', () => {
  const out = runScript(CHECK, 'fake');
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  assert.ok(out.stdout.includes(OK_DEFAULT), out.stdout);
  assert.ok(out.stdout.includes('ok   fake/heap-off:'), out.stdout);
  assert.ok(out.stdout.includes('ok   fake/caller-node-options:'), out.stdout);
  assert.ok(out.stdout.includes('ok   fake/cmd-override:'), out.stdout);
  assert.ok(out.stdout.includes('ok   fake/no-user-manager:'), out.stdout);
  for (const label of ['no-path-setenv', 'fixed-unit-start', 'fixed-unit-no-systemd-run', 'fixed-unit-not-installed', 'unit-file']) {
    assert.ok(out.stdout.includes(`ok   fake/${label}:`), out.stdout);
  }
  assert.ok(out.stdout.includes('ok   fake/usage:'), out.stdout);
  assert.ok(out.stdout.includes('serve-scoped-check: PASS'), out.stdout);

  // The fake section must not have started (or stopped) anything: its whole premise is that
  // `systemd-run` never runs for real. Asserted on the live user manager, so it is skipped where
  // there is none rather than reporting a vacuous pass.
  const hasSystemctl = spawnSync('/bin/bash', ['-c', 'command -v systemctl'], { encoding: 'utf8' }).status === 0;
  if (!hasSystemctl) return;
  const units = spawnSync('/bin/bash', ['-c', 'systemctl --user list-units --all --no-pager'], {
    encoding: 'utf8',
  });
  assert.ok(
    !units.stdout.includes('serve-scoped-check-'),
    `the fake section left a transient unit behind:\n${units.stdout}`,
  );
});

test('AC1: dropping Restart=on-failure reds the default case, naming it and the actual argv', () => {
  const stdout = afterMutation('restart-property-dropped', (root) => {
    mutate(root, '--property=Restart=on-failure', '--property=Restart=no');
  });
  const line = failLine(stdout, 'default');
  assert.ok(line.includes('argv is missing: Restart=on-failure'), line);
  assert.ok(line.includes('actual argv:'), `the verdict must carry the actual argv: ${line}`);
  assert.ok(line.includes('--property=Restart=no'), line);
});

test('AC1: the heap ceiling is composed into NODE_OPTIONS, and its absence reds the default case', () => {
  const stdout = afterMutation('heap-ceiling-dropped', (root) => {
    mutate(root, 'opts="${opts:+$opts }--max-old-space-size=$HEAP_MB"', 'opts=""');
  });
  const line = failLine(stdout, 'default');
  assert.ok(line.includes('--max-old-space-size=2048'), line);
  assert.ok(line.includes('actual argv:'), line);
});

test('AC1: a caller NODE_OPTIONS is APPENDED to, not replaced', () => {
  const stdout = afterMutation('node-options-clobbered', (root) => {
    // The plausible slip: compose the ceiling from scratch instead of from the caller's value.
    mutate(root, 'opts="${opts:+$opts }--max-old-space-size=$HEAP_MB"', 'opts="--max-old-space-size=$HEAP_MB"');
  });
  const line = failLine(stdout, 'caller-node-options');
  assert.ok(line.includes('--trace-warnings'), line);
  assert.ok(line.includes('actual argv:'), line);
});

test('AC1: QUAY_SERVER_HEAP_MB=off removes the flag rather than blanking it', () => {
  const stdout = afterMutation('heap-off-unreachable', (root) => {
    // Comment out the `off` pattern: an off value then falls through and is used as a heap size.
    mutate(root, '    off|0) ;;', '    #off|0) ;;');
  });
  const line = failLine(stdout, 'heap-off');
  assert.ok(line.includes('--max-old-space-size'), line);
  assert.ok(line.includes('actual argv:'), line);
});

test('production mode drives the fixed unit: ignoring the empty-CMD branch reds fixed-unit-start', () => {
  const stdout = afterMutation('fixed-start-bypassed', (root) => {
    mutate(root, 'if [ -z "$SERVER_CMD" ]; then start_fixed; exit 0; fi', ':');
  });
  const line = failLine(stdout, 'fixed-unit-start');
  assert.ok(line.includes('--user start'), line);
});

test('no PATH is handed to a transient unit: re-adding --setenv=PATH reds no-path-setenv', () => {
  const stdout = afterMutation('path-setenv-readded', (root) => {
    mutate(root, '      --setenv=SERVER_PORT="$SERVER_PORT"\n    )', '      --setenv=SERVER_PORT="$SERVER_PORT"\n      --setenv=PATH="$PATH"\n    )');
  });
  const line = failLine(stdout, 'no-path-setenv');
  assert.ok(line.includes('--setenv=PATH'), line);
});

test('the shipped unit file may not carry a PATH: adding one reds unit-file', () => {
  const root = makeTree();
  const unit = join(root, 'scripts', 'systemd', 'claudecodeui-server.service');
  writeFileSync(unit, readFileSync(unit, 'utf8') + 'Environment=PATH=/x/plugins/cache/quay/quay/0.11.0/bin\n');
  const after = runCheck(root, 'fake');
  assert.notEqual(after.status, 0, after.stdout);
  assert.ok(failLine(after.stdout, 'unit-file').includes('forbidden-directive'), after.stdout);
});

test('AC1: QUAY_SERVER_CMD is a real seam — ignoring it reds the override case', () => {
  const stdout = afterMutation('cmd-override-ignored', (root) => {
    mutate(root, 'SERVER_CMD="${QUAY_SERVER_CMD:-}"', 'SERVER_CMD="npm run server"');
  });
  const line = failLine(stdout, 'cmd-override');
  assert.ok(line.includes('-- node /tmp/serve-scoped-check-stub.js'), line);
  assert.ok(line.includes('actual argv:'), line);
});

test('AC4: with no usable user manager the script refuses loudly, and going silent reds the case', () => {
  const stdout = afterMutation('refusal-silenced', (root) => {
    // The defect this guards: `exit 3` becoming `exit 0`, i.e. the refusal reading as success.
    mutate(root, '  exit 3', '  exit 0');
  });
  const line = failLine(stdout, 'no-user-manager');
  assert.ok(line.includes('must not read as success or as usage'), line);
});

test('AC5: the usage contract is asserted, and changing the exit code reds it', () => {
  const stdout = afterMutation('usage-exit-code-changed', (root) => {
    mutate(root, '    exit 2', '    exit 0');
  });
  const line = failLine(stdout, 'usage');
  assert.ok(line.includes('expected 2'), line);
});

test('AC5: no arguments still exits 2 with usage, on the shipped script', () => {
  const out = spawnSync('/bin/bash', [SERVE], { encoding: 'utf8' });
  assert.equal(out.status, 2, `${out.stdout}${out.stderr}`);
  assert.ok(out.stderr.includes('usage: serve-scoped.sh start|stop|restart|status'), out.stderr);
});

test('no usable user manager: the real sections are reported SKIP, never a silent pass', () => {
  // A `systemd-run` that exists and always fails — the shape of a user manager that is present but
  // unreachable. The criterion must say the sections were not exercised instead of reporting them
  // as green, and the whole run must not pretend the readings exist.
  const bin = join(TMP, 'no-manager-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'systemd-run'), '#!/usr/bin/env bash\nexit 1\n');
  spawnSync('/bin/bash', ['-c', `chmod +x '${join(bin, 'systemd-run')}'`]);

  const out = runScript(CHECK, 'restart', { PATH: `${bin}:${process.env.PATH ?? ''}` });
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  assert.ok(out.stdout.includes('section restart: SKIP'), out.stdout);
  assert.ok(out.stdout.includes('no usable systemd user manager'), out.stdout);
  assert.ok(!out.stdout.includes('ok   restart:'), `nothing may be reported as exercised:\n${out.stdout}`);
});

test('an unknown mode is a usage error, not a silent pass', () => {
  const out = runScript(CHECK, 'not-a-mode');
  assert.equal(out.status, 2, `${out.stdout}${out.stderr}`);
  assert.ok(out.stderr.includes('usage: serve-scoped-check.sh'), out.stderr);
});
