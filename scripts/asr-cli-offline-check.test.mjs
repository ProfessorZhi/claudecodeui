#!/usr/bin/env node
/**
 * The controls for `scripts/asr-cli-offline-check.mjs` (AC-131's criterion).
 *
 * A criterion that reports "offline, redacted, replayed" is only worth what its controls are worth,
 * so each fake shape the task names gets a case of its own:
 *
 *   AC2  a dry run that really sends          — `neverSend` actually calls the injected transport
 *   AC3  only the credential redacted         — the audio field prints its bytes as well as its digest
 *   AC4  a transcript edited on the way out   — `transcriptFromReplay` trims
 *   AC5  a replay that falls through          — `recordedResponse` uses the injected transport
 *   AC6  a CLI bare node can load             — the relative `.js` specifiers become `.ts`
 *   AC7a a missing recording                  — the fixture is deleted
 *   AC7b a dry run that prints nothing        — the report is dropped, exit code unchanged
 *
 * Every mutation case is a PAIR of assertions, in this order: the same command must exit 0 on the
 * same tree BEFORE the mutation, and must exit non-zero AFTER it. The first half is what makes the
 * second half mean anything — without it, "it went red" could just as well be "this tree never ran
 * at all", a fake shape this repository has already paid for once.
 *
 * Each case also asserts the substitution landed on the number of sites it needs. A mutation that
 * matched nothing would leave the tree green while the case reported "red after mutation", and the
 * count is the only thing that tells those two apart.
 *
 * WHERE THE MUTATIONS ARE APPLIED. Never to this checkout. The tree is built by COPYING the files
 * the criterion drives — the CLI's own relative-import closure (discovered by parsing its
 * specifiers, so a module added to that graph is copied without this list being edited), the
 * recording fixture, and the double — into a layout under the OS temp directory, with this
 * checkout's `node_modules` linked in so the copied CLI still boots under `npx tsx`. The criterion
 * is then pointed at it with `--root`, the flag that exists so a control can drive a tree that is
 * not the one it lives in.
 *
 * THE READINGS THE CRITERION ONLY SUMMARISES are available to these cases because the criterion
 * honours `$ASR_CLI_CHECK_CALL_LOG_DIR`: with it set, the per-arm call logs and the dry run's raw
 * stdout survive the run, so "the credential is still redacted while the audio is not" and "the
 * double was really called" are checked against those files rather than against the criterion's own
 * one-line summary of them.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const PROBE = join(HERE, 'asr-cli-offline-check.mjs');

/**
 * The criterion's own source, read once.
 *
 * Two things are taken from it rather than repeated here, both on purpose: the paths it drives
 * (so this suite's copy set cannot drift from the set the criterion actually opens) and the
 * credential constant it makes up (so the AC3 case asserts against the same string the criterion
 * looks for, not against a copy of it that could be updated on only one side).
 */
const CRITERION_SOURCE = readFileSync(PROBE, 'utf8');

/**
 * The value of a `const NAME = join('a', 'b');` declaration in the criterion.
 * @param {string} name @returns {string}
 */
function pathConst(name) {
  const declaration = new RegExp(`^const ${name} = join\\(([^;]*)\\);$`, 'm').exec(CRITERION_SOURCE);
  if (!declaration) throw new Error(`the criterion declares no join(...) named ${name}`);
  const parts = [...declaration[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  if (parts.length === 0) throw new Error(`${name} is not a join(...) of string literals`);
  return join(...parts);
}

/** @param {string} name @returns {string} */
function stringConst(name) {
  const declaration = new RegExp(`^const ${name} = '([^']*)';$`, 'm').exec(CRITERION_SOURCE);
  if (!declaration) throw new Error(`the criterion declares no string constant named ${name}`);
  return declaration[1];
}

const CLI_REL = pathConst('CLI_REL');
const RECORDING_REL = pathConst('RECORDING_REL');
const DOUBLE_REL = pathConst('DOUBLE_REL');

const TEST_KEY = stringConst('TEST_KEY');
const LOG_DIR_VAR = 'ASR_CLI_CHECK_CALL_LOG_DIR';

/**
 * Resolves one of the CLI's relative import specifiers to a path in `tree`.
 *
 * Mirrors the mapping the loader applies: the specifier is a `.js` the server's NodeNext
 * configuration emits, and on disk it is the `.ts` source next to it. A specifier that resolves
 * literally wins, so a real `.js` module in the graph would be copied as itself.
 *
 * @param {string} tree @param {string} fromRel @param {string} specifier
 * @returns {string | null}
 */
function resolveSpecifier(tree, fromRel, specifier) {
  const candidate = join(dirname(fromRel), specifier);
  if (existsSync(join(tree, candidate))) return candidate;
  if (candidate.endsWith('.js')) {
    const source = `${candidate.slice(0, -3)}.ts`;
    if (existsSync(join(tree, source))) return source;
  }
  return null;
}

/**
 * The files the CLI entry reaches through its own relative imports, as paths relative to the tree.
 *
 * Discovered rather than listed, which is the point: the CLI's graph is what the copy set has to
 * follow, and a module added to it must be copied by this suite without anyone remembering to.
 *
 * @param {string} tree @param {string} entryRel @returns {string[]}
 */
function importClosure(tree, entryRel) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const queue = [entryRel];
  while (queue.length > 0) {
    const rel = /** @type {string} */ (queue.shift());
    if (seen.has(rel)) continue;
    seen.add(rel);
    const path = join(tree, rel);
    if (!existsSync(path)) continue;
    for (const match of readFileSync(path, 'utf8').matchAll(/from\s+'(\.[^']*)'/g)) {
      const resolved = resolveSpecifier(tree, rel, match[1]);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return [...seen];
}

/**
 * The package.json that governs the CLI's module format, as a path relative to the tree root.
 *
 * Walked up to rather than named, because that is what the loader does: the nearest package.json
 * above a `.ts` is what decides whether it is loaded as ESM or as CJS, and a CLI that one day lives
 * under a package of its own carries its own boundary with it.
 *
 * It has to be copied. Measured on this tree: without it there is no `"type": "module"`, so tsx
 * compiles the CLI as CJS, so `import.meta.resolve` is not a function — and the copied CLI dies
 * before it can report a site. The failure is worth naming because it is silent in the wrong
 * direction: the check arms survive it (nothing they drive needs `import.meta.resolve`) and only
 * the `--explain-sites` arm falls over. A tree that does not reproduce the module format is not a
 * smaller version of the shipping tree, it is a different one.
 *
 * @param {string} root @param {string} rel @returns {string}
 */
function packageRootRelative(root, rel) {
  let dir = dirname(rel);
  while (dir !== '.' && dir !== '/') {
    if (existsSync(join(root, dir, 'package.json'))) return join(dir, 'package.json');
    dir = dirname(dir);
  }
  if (existsSync(join(root, 'package.json'))) return 'package.json';
  throw new Error(`no package.json above ${rel}: the copied tree would not reproduce the module format`);
}

/**
 * The control's tree: the criterion's inputs copied into the layout the criterion expects, with
 * `node_modules` linked in so the copied CLI boots under the same launcher.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ tree: string, logs: string }}
 */
function makeTree(t) {
  const parent = mkdtempSync(join(tmpdir(), 'asr-cli-ctrl-'));
  const tree = join(parent, 'tree');
  const logs = join(parent, 'logs');
  mkdirSync(tree, { recursive: true });
  mkdirSync(logs, { recursive: true });

  const copySet = [...importClosure(ROOT, CLI_REL), RECORDING_REL, DOUBLE_REL, packageRootRelative(ROOT, CLI_REL)];
  assert.ok(copySet.length >= 4, `makeTree: the copy set is too small to be the CLI's graph: ${copySet.join(', ')}`);
  for (const rel of copySet) {
    const destination = join(tree, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(ROOT, rel), destination);
  }
  // The CLI is booted with `npx tsx` from inside the tree, so `npx` has to find the package there;
  // the link is to this checkout's own install, which is the same one the criterion uses.
  symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'), 'dir');

  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { tree, logs };
}

/**
 * `node scripts/asr-cli-offline-check.mjs --root <tree> <extra>`, or without `--root` when the tree
 * is this checkout — so the AC1 case runs the criterion command exactly as the task writes it.
 *
 * @param {string | null} tree
 * @param {string} logs
 * @param {string[]} [extra]
 * @returns {{ status: number | null, stdout: string, stderr: string, text: string }}
 */
function runProbe(tree, logs, extra = []) {
  const args = tree === null ? [PROBE, ...extra] : [PROBE, '--root', tree, ...extra];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, [LOG_DIR_VAR]: logs },
  });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return { status: result.status, stdout, stderr, text: `${stdout}${stderr}` };
}

/**
 * The first half of every mutation case: the unmutated tree must pass, or the second half proves
 * nothing.
 *
 * @param {string} tree @param {string} logs @param {string} label @returns {void}
 */
function assertGreenBeforeMutation(tree, logs, label) {
  const run = runProbe(tree, logs);
  assert.equal(run.status, 0, `${label}: the unmutated tree must exit 0 first\n${run.text}`);
  assert.match(run.stdout, /^arms=\d+ red=0$/m, `${label}: the unmutated tree must report no red arms\n${run.text}`);
}

/**
 * Substitutes one site, asserting it was found the expected number of times.
 *
 * @param {string} tree @param {string} rel @param {string} find @param {string} replace
 * @param {number} [expected] @returns {void}
 */
function mutate(tree, rel, find, replace, expected = 1) {
  const path = join(tree, rel);
  const source = readFileSync(path, 'utf8');
  const hits = source.split(find).length - 1;
  assert.equal(hits, expected, `${rel}: expected the substitution to hit ${expected} site(s), it hit ${hits}`);
  writeFileSync(path, source.replace(find, replace));
}

/** @param {Buffer} haystack @param {Buffer} needle @returns {boolean} */
function containsWindow(haystack, needle) {
  for (let start = 0; start + 32 <= needle.length; start += 1) {
    if (haystack.includes(needle.subarray(start, start + 32))) return true;
  }
  return false;
}

/**
 * Every non-empty line written by the injected double in this run's log directory.
 * @param {string} logs @returns {string[]}
 */
function doubleCallLines(logs) {
  /** @type {string[]} */
  const lines = [];
  for (const name of readdirSync(logs)) {
    if (!name.endsWith('.log')) continue;
    for (const line of readFileSync(join(logs, name), 'utf8').split('\n')) {
      if (line.trim().length > 0) lines.push(line);
    }
  }
  return lines;
}

// ── the cases ─────────────────────────────────────────────────────────────────────────────────

test('AC1 the criterion itself: the four readings, and PASS on this checkout', () => {
  const logs = mkdtempSync(join(tmpdir(), 'asr-cli-ac1-'));
  const first = runProbe(null, logs);
  assert.equal(first.status, 0, `AC1: ${first.text}`);

  assert.match(first.stdout, /^verdict PASS dry-run calls=0$/m, first.text);
  assert.match(
    first.stdout,
    /^verdict PASS redaction audio-bytes=elided sha256=[0-9a-f]{64}$/m,
    first.text,
  );
  assert.match(first.stdout, /^verdict PASS offline text=".*" calls=0 variant=v1\/lenient$/m, first.text);
  assert.match(first.stdout, /^verdict PASS offline error=non-json-response calls=0 variant=v2\/strict$/m, first.text);
  assert.match(first.stdout, /^verdict PASS launch tsx$/m, first.text);
  assert.match(first.stdout, /^arms=\d+ red=0$/m, first.text);
  assert.doesNotMatch(first.stdout, /^reason /m, first.text);

  // Two runs rather than one: the clip is synthesized and the request is built from it, so anything
  // that leaked a per-run value (a boundary, a timestamp) into the readings would make the second
  // run disagree with the first — and the AC1 line is a report of readings that are supposed to be
  // reproducible.
  const second = runProbe(null, logs);
  assert.equal(second.stdout, first.stdout, 'AC1: two runs of the same checkout disagree');

  rmSync(logs, { recursive: true, force: true });
});

test('AC2 a dry run that really sends must go red', (t) => {
  const { tree, logs } = makeTree(t);
  assertGreenBeforeMutation(tree, logs, 'AC2');

  mutate(
    tree,
    join('experiments', 'voice-asr-cli', 'dryRun.ts'),
    '  void request;\n  void transport;\n',
    '  const send = transport ?? fetch;\n  await send(request.url, request.init);\n',
  );
  assert.equal(doubleCallLines(logs).length, 0, 'AC2: the green run must not have called the double');

  const run = runProbe(tree, logs);
  assert.notEqual(run.status, 0, `AC2: a dry run that sends must be red\n${run.text}`);
  assert.match(run.stdout, /^verdict FAIL dry-run calls=1$/m, run.text);
  assert.match(run.stdout, /dry-run made 1 calls/, run.text);
  assert.equal(doubleCallLines(logs).length, 1, 'AC2: the double must hold the one call that was made');
});

test('AC3 a payload side that is not redacted must go red, and not for the credential', (t) => {
  // The other half of what AC3 is about — the credential is one this task made up and reaches the
  // CLI through a variable the criterion names — is a property of the criterion's source, and it is
  // readable without running anything. Both parts are asserted rather than one: a key that happened
  // to come from the environment would make the redaction reading meaningless, because then "the
  // key is not in the stdout" could be true of a key the criterion never had.
  assert.ok(TEST_KEY.length > 0, 'AC3: the criterion must declare a key of its own');
  const keyEnvArg = /'--api-key-env',\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(CRITERION_SOURCE)?.[1];
  assert.ok(keyEnvArg, 'AC3: the criterion must hand the CLI a named variable as --api-key-env');
  // Followed the whole way, because the AC names a chain and each link is what stops the key from
  // coming from somewhere else: the CLI is told to read a variable the criterion declares
  // (`--api-key-env TEST_KEY_VAR`), that variable holds the NAME of the variable the CLI will find
  // in its environment, and that name holds a string the criterion also declares — which has to be
  // the very string this case looks for in the raw stdout, or "the credential is gone" and "the
  // credential" would be two different things.
  const handedName = stringConst(keyEnvArg);
  assert.ok(handedName.length > 0, `AC3: ${keyEnvArg} must hold the name the CLI will read`);
  assert.ok(
    CRITERION_SOURCE.includes(`[${keyEnvArg}]: TEST_KEY`),
    `AC3: the criterion must fill ${handedName} in the CLI's environment from its own constant, not from the environment it was started in`,
  );
  const ambientReads = [
    ...new Set(
      [...CRITERION_SOURCE.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\['([^']+)'\])/g)].map(
        (match) => match[1] ?? match[2],
      ),
    ),
  ].sort();
  assert.deepEqual(
    ambientReads,
    [LOG_DIR_VAR],
    `AC3: the criterion must read nothing but its own log-directory knob out of the environment, saw ${ambientReads.join(', ')}`,
  );

  const { tree, logs } = makeTree(t);
  assertGreenBeforeMutation(tree, logs, 'AC3');

  mutate(
    tree,
    join('experiments', 'voice-asr-cli', 'dryRun.ts'),
    '  return `bytes=${bytes.length} sha256=${sha256Hex(bytes)}`;',
    "  return `bytes=${bytes.length} sha256=${sha256Hex(bytes)} data=${Buffer.from(bytes).toString('latin1')}`;",
  );

  const run = runProbe(tree, logs);
  assert.notEqual(run.status, 0, `AC3: an unredacted payload must be red\n${run.text}`);
  assert.match(run.stdout, /^verdict FAIL redaction audio-bytes=leaked@\d+ sha256=[0-9a-f]{64}$/m, run.text);
  // Which half went red, read off the reason rather than inferred: the audio window is the failed
  // half and the credential's absence is not.
  assert.match(run.stdout, /reason redaction: a 32-byte window of the audio/, run.text);
  assert.doesNotMatch(run.stdout, /reason redaction: the criterion's own key constant/, run.text);
  assert.doesNotMatch(run.stdout, /no readings/, run.text);

  // And the independent version of the same statement, off the raw stdout the criterion kept: the
  // credential is still gone while the audio is not — so this case is proving the payload half, not
  // "the arm reds for some reason".
  const dryRunStdout = readFileSync(join(logs, 'dry-run-stdout.bin'));
  assert.equal(
    dryRunStdout.includes(Buffer.from(TEST_KEY, 'utf8')),
    false,
    'AC3: the credential must still be redacted by this mutation',
  );
  const clipPath = join(logs, 'clip.wav');
  const emitted = spawnSync(process.execPath, [PROBE, '--emit-audio', clipPath], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(emitted.status, 0, `AC3: --emit-audio must work\n${emitted.stdout}${emitted.stderr}`);
  const clip = readFileSync(clipPath);
  assert.ok(
    containsWindow(dryRunStdout, clip),
    'AC3: the payload half must be the one that leaked — no window of the clip is in the raw stdout',
  );
});

test('AC4 a transcript edited on the way out must go red', (t) => {
  const { tree, logs } = makeTree(t);
  assertGreenBeforeMutation(tree, logs, 'AC4');

  mutate(
    tree,
    join('experiments', 'voice-asr-cli', 'offlineReplay.ts'),
    'export function transcriptFromReplay(text: string): string {\n  return text;\n}',
    'export function transcriptFromReplay(text: string): string {\n  return text.trim();\n}',
  );

  const run = runProbe(tree, logs);
  assert.notEqual(run.status, 0, `AC4: an edited transcript must be red\n${run.text}`);
  assert.match(run.stdout, /offline text differs/, run.text);
  // Targeted: the strict arm's recorded failure is not a transcript, so it must not move. If it
  // did, this case would be proving "something changed" rather than "the text comparison works".
  assert.match(run.stdout, /^verdict PASS offline error=non-json-response calls=0 variant=v2\/strict$/m, run.text);
});

test('AC5 a replay that falls through to the injected transport must go red', (t) => {
  const { tree, logs } = makeTree(t);
  assertGreenBeforeMutation(tree, logs, 'AC5');

  mutate(
    tree,
    join('experiments', 'voice-asr-cli', 'offlineReplay.ts'),
    '  void injectedTransport;\n  return new Response(entry.body, {',
    "  if (injectedTransport) return injectedTransport('https://asr.invalid/replay-fell-through', { method: 'POST' });\n  return new Response(entry.body, {",
  );

  const run = runProbe(tree, logs);
  assert.notEqual(run.status, 0, `AC5: a replay that goes online must be red\n${run.text}`);
  assert.match(run.stdout, /offline made \d+ calls with --fetch-impl supplied/, run.text);

  // The double's own log, not the criterion's count of it: this is what makes "the red is the
  // online half" a reading rather than the criterion's opinion of itself.
  const calls = doubleCallLines(logs);
  assert.ok(calls.length > 0, 'AC5: the double log must be non-empty after the mutation');
  assert.ok(
    calls.some((line) => line.includes('replay-fell-through')),
    `AC5: the recorded call must be the replay's, saw ${calls.join(' | ')}`,
  );
  assert.equal(
    calls.some((line) => line.includes('/audio/transcriptions')),
    false,
    'AC5: the mutation must send the replay through the transport, not the original request',
  );
});

test('AC6 a CLI that bare node can load must go red', (t) => {
  const { tree, logs } = makeTree(t);
  assertGreenBeforeMutation(tree, logs, 'AC6');

  // WHY THIS IS A SET OF SITES AND NOT ONE. The task names the mutation as the adapter's relative
  // specifier changing from `.js` to `.ts`, and in this tree that specifier is written in three
  // modules — the entry point, the redaction module and the replay module all reach the adapter
  // directly, which is what keeps each of them from re-implementing it. Bare node stops at the
  // FIRST specifier it cannot resolve (measured: `ERR_MODULE_NOT_FOUND` on the adapter), so
  // rewriting one of the three leaves the CLI unloadable and the arm green — a mutation that would
  // prove nothing. The substitution is therefore applied to every relative `.js` specifier in the
  // CLI's graph, and what replaces the single-site hit count is the check below: after the rewrite
  // the graph holds no relative `.js` specifier at all, so there is nothing left for bare node to
  // trip over. Every one of them was found, not assumed.
  const specifiers = [...importClosure(ROOT, CLI_REL)];
  let rewrittenSites = 0;
  for (const rel of specifiers) {
    const path = join(tree, rel);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    const matches = [...source.matchAll(/from\s+'(\.[^']*)'/g)];
    if (matches.length === 0) continue;
    for (const match of matches) {
      assert.ok(
        match[1].endsWith('.ts') || match[1].endsWith('.js'),
        `AC6: unexpected specifier ${match[1]} in ${rel}`,
      );
    }
    const after = source.replace(/(from\s+')(\.[^']*)\.js(')/g, '$1$2.ts$3');
    assert.notEqual(after, source, `AC6: the rewrite must change ${rel}`);
    writeFileSync(path, after);
    rewrittenSites += matches.length;
  }
  assert.ok(rewrittenSites >= 3, `AC6: expected several specs to rewrite, saw ${rewrittenSites}`);
  for (const rel of specifiers) {
    const path = join(tree, rel);
    if (!existsSync(path)) continue;
    const remaining = [...readFileSync(path, 'utf8').matchAll(/from\s+'\.[^']*\.js'/g)];
    assert.equal(remaining.length, 0, `AC6: ${rel} still has a relative .js specifier after the rewrite`);
  }

  const run = runProbe(tree, logs);
  assert.notEqual(run.status, 0, `AC6: a bare-node-loadable CLI must be red\n${run.text}`);
  assert.match(run.stdout, /^verdict FAIL launch node-arm=ran \(launcher=node\)$/m, run.text);
  assert.match(run.stdout, /cli-not-tsx-launched/, run.text);
  // Targeted: the tsx arm is untouched, so the red is the bare-node arm and not the launcher's.
  assert.match(run.stdout, /^verdict PASS launch tsx$/m, run.text);
});

test('AC7a a missing recording must go red, not silently green', (t) => {
  const { tree, logs } = makeTree(t);
  assertGreenBeforeMutation(tree, logs, 'AC7a');

  const path = join(tree, RECORDING_REL);
  assert.ok(existsSync(path), 'AC7a: the fixture this case deletes must exist');
  rmSync(path);
  assert.equal(existsSync(path), false, 'AC7a: the deletion must hit exactly one file');

  const run = runProbe(tree, logs);
  assert.notEqual(run.status, 0, `AC7a: a deleted recording must be red\n${run.text}`);
  assert.match(run.stdout, /^verdict FAIL recording loaded=false$/m, run.text);
  assert.match(run.stdout, /recording-missing/, run.text);
});

test('AC7b a dry run that prints nothing must go red, not silently green', (t) => {
  const { tree, logs } = makeTree(t);
  assertGreenBeforeMutation(tree, logs, 'AC7b');

  mutate(
    tree,
    join('experiments', 'voice-asr-cli', 'dryRun.ts'),
    '  await neverSend(request, transport);\n  process.stdout.write(renderDryRun(report));\n',
    '  await neverSend(request, transport);\n  void report;\n',
  );

  const run = runProbe(tree, logs);
  assert.notEqual(run.status, 0, `AC7b: an empty dry run must be red\n${run.text}`);
  assert.match(run.stdout, /no readings/, run.text);
  assert.match(run.stdout, /^verdict FAIL redaction/m, run.text);
  // The exit code stayed 0 and the transport was still not called — the arm reds on the emptiness
  // of the reading, which is the whole point of refusing to read "printed nothing" as "redacted".
  assert.match(run.stdout, /^verdict PASS launch tsx$/m, run.text);
  assert.equal(readFileSync(join(logs, 'dry-run-stdout.bin')).length, 0, 'AC7b: the dry run must print nothing');
});

test('AC8 the criterion drives shipping symbols, and spells no recogniser path', (t) => {
  const { tree, logs } = makeTree(t);
  const run = runProbe(tree, logs, ['--explain-sites']);
  assert.equal(run.status, 0, `AC8: --explain-sites must exit 0\n${run.text}`);

  assert.match(run.stdout, /^site cli \S*transcribe\.ts symbol=main in-shipping-tree$/m, run.text);
  assert.match(
    run.stdout,
    /^site adapter \S*transcriptionWire\.ts symbol=createTranscriptionRequest in-shipping-tree$/m,
    run.text,
  );
  assert.match(
    run.stdout,
    /^site adapter \S*transcriptionWire\.ts symbol=parseTranscriptionResponse in-shipping-tree$/m,
    run.text,
  );
  assert.doesNotMatch(run.stdout, /OUTSIDE-SHIPPING-TREE/, run.text);
  assert.match(run.stdout, /^verdict PASS sites=\d+ red=0$/m, run.text);

  // The independent reading AC8 asks for, narrowed to the files this task creates.
  //
  // The task writes it as `grep -rn "audio/transcriptions" scripts/asr-cli-offline-check.mjs
  // scripts/__fixtures__/`, and that literal form cannot be green for ANY implementation of this
  // task: `scripts/__fixtures__/asr-extraction-parity-baseline.json` — a committed artifact of the
  // sibling AC-130 task, already on develop — records captured endpoint URLs and contains the
  // string twice. The reading is therefore taken over the two files this task owns. The invariant
  // is the one the original guarded: neither the criterion nor its double spells the recogniser's
  // path itself, so the hop is reached through the shipping adapter rather than re-derived here.
  for (const rel of [join('scripts', 'asr-cli-offline-check.mjs'), DOUBLE_REL]) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    assert.equal(
      source.split('audio/transcriptions').length - 1,
      0,
      `AC8: ${rel} spells the recogniser path itself`,
    );
  }
});
