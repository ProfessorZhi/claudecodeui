#!/usr/bin/env node
/**
 * AC-135 — "裁不裁" is decided by the recogniser's own declared capability (`pauseCues`), at
 * exactly one read point, and the shipped default still trims.
 *
 * WHY THIS IS A RESOLVER AND NOT A LIST. The three things this criterion is about — which
 * declaration is authoritative, which export is the read point, and who reaches it — are all
 * FOUND here rather than named here, because each of them can be moved without this file being
 * edited, and a checker that names them asserts what its own text says. So:
 *
 *   · the declaring module is the one production file that declares the capability's type — the
 *     VOCABULARY's home, which is not the same module as the DECLARATIONS' home;
 *   · the declarations are the registry's: which recognisers are registered and what each
 *     declares, read by following the registration table to the adapter modules (through
 *     `registryDeclarations`, the same reading `scripts/asr-pause-cues-source-check.mjs` makes,
 *     so the roster is not derived twice);
 *   · the read point is the one exported function whose answer FLIPS between two opposite values
 *     of the capability (a function that returns the same thing for both is not deciding
 *     anything, whatever it is called);
 *   · the consumers are production files whose own text reaches that symbol.
 *
 * ⚠️ THE VOCABULARY AND THE DECLARATIONS LIVE IN DIFFERENT MODULES, and this file was red for as
 * long as it assumed otherwise. It used to require an exported `{provider, pauseCues}` table
 * inside the type-declaring module. `0ae696cd` then moved the declarations to where the capability
 * is — `AsrCapabilities.pauseCues` on the adapter modules, read back through
 * `pauseCuesDeclarationFor(id)` — and left the vocabulary (`export type PauseCues`) where it was.
 * The table the old reading looked for is not in that module any more, and cannot be: keeping one
 * there is the second declaration the seam exists to remove.
 *
 * That is what makes the two fake forms falsifiable rather than merely forbidden. A client that
 * keeps deciding for itself is caught from the consumer side (nothing reaches the read point any
 * more, and the reading of "how many sites answer 裁不裁 from the capability" is 0), and a client
 * that answers it from the capability *by hand* is caught from the uniqueness side (a production
 * file outside the declaring module comparing the vocabulary). Both are the same defect seen from
 * either end, and neither is expressible as a path list.
 *
 * THE EMPTY READING IS A FAILURE. A scan that matched nothing must not exit 0: zero declarations,
 * zero read points, or zero consumers are each their own verdict with their own token, so
 * deleting the thing under test cannot read as passing it.
 *
 * The last two checks are the "nothing changed" half. The default chain is read as the product of
 * the two gates it really has — the shipped switch's default AND the declaration of the recogniser
 * a deployment that names no provider resolves to, which is the FIRST registered one — so "the
 * default still trims" is a measurement of this tree rather than a restatement of the task. And
 * every declaration that is not `destructive` has to point at a file that exists, which is ADR-004
 * decision 1's discipline: changing what gets uploaded is not a one-line edit.
 *
 * Usage:
 *   node scripts/asr-trim-capability-check.mjs [--root <dir>] [--explain-scan]
 *
 *   --root <dir>    the tree to check (default: this script's repository root). The falsification
 *                   cases point it at a throwaway tree copied from the shipping files.
 *   --explain-scan  print the scanned glob set and every file it matched, then run the checks
 *
 * Exit codes: 0 = every check above passed; 1 = at least one failed (each prints its own reason
 * on its own line, prefixed `check <name>: FAIL`).
 */

import { existsSync, globSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The registry side's one reading. Imported rather than re-derived: following the registration
// table to the adapter modules a second time here would be the same 口径 read twice, and the two
// copies are free to disagree the moment the registry's shape moves.
import { REGISTRY_MODULE, registryDeclarations } from './asr-pause-cues-source-check.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

/** Production sources: the only place a declaration or a second read point would be shipping code. */
const PRODUCTION_GLOBS = ['src/**/*.ts', 'src/**/*.tsx', 'server/**/*.ts', 'server/**/*.js', 'shared/**/*.ts'];

/**
 * The capability's own literal values, in the order this file reads them: the first is the value
 * that means "the pauses are worthless to this recogniser", the last the value that means the
 * opposite. The read point is discovered by the flip between these two, so the pair is the
 * contract this file depends on — not a symbol name.
 */
const CAPABILITY_VALUES = ['destructive', 'neutral', 'useful'];
const TRIM_VALUE = CAPABILITY_VALUES[0];
const KEEP_VALUE = CAPABILITY_VALUES[CAPABILITY_VALUES.length - 1];

/**
 * A production file comparing the capability vocabulary itself: `…capability === 'destructive'`.
 * This is the shape of a second answer to 裁不裁, and the shape this criterion forbids outside the
 * declaring module.
 *
 * BOTH NAMES THE VALUE HAS TRAVELLED UNDER, because the shape is the comparison and not the
 * spelling: `pauseCues` is what the provider side calls it, and `capability` is what the client's
 * own read point receives. Keyed to one of them, this scan is blind to a hand-decision written
 * with the other — and `0ae696cd` renamed the client-side field, so the name it used to be keyed
 * to is no longer the name a client would write.
 * @type {RegExp}
 */
const HAND_DECISION = new RegExp(
  `(?:\\bcapability|\\bpauseCues)\\s*(?:===|!==|==|!=)\\s*['"](?:${CAPABILITY_VALUES.join('|')})['"]`,
);

/** The capability's type declaration, which is what makes a file the declaring module. */
const CAPABILITY_TYPE_DECLARATION = /^export\s+type\s+PauseCues\s*=/m;

/** The shipped switch's own declaration; named by the task, so it is looked up rather than guessed. */
const TRIM_SWITCH_EXPORT = /^export\s+function\s+isVoiceTrimEnabled\s*\(/m;

/**
 * @param {string} root
 * @param {string[]} argv
 * @returns {{ root: string, explainScan: boolean }}
 */
function parseArgs(root, argv) {
  let explainScan = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      const next = argv[i + 1];
      if (!next) throw new Error('--root needs a directory');
      root = path.resolve(next);
      i++;
    } else if (arg === '--explain-scan') {
      explainScan = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/asr-trim-capability-check.mjs [--root <dir>] [--explain-scan]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, explainScan };
}

/**
 * Test files are not part of the tree the criterion is about: the question is who decides 裁不裁
 * for a user's recording, and a spec that reaches the read point is asking the question, not
 * shipping an answer. Counting one as a second consumer would inflate the `single-source` reading;
 * leaving one in the hand-deciders scan would red a file whose whole job is to say what each
 * capability means.
 * @param {string} relative repository-relative, POSIX-separated
 * @returns {boolean}
 */
function isTestSource(relative) {
  return (
    /\.(?:test|spec)\.[jt]sx?$/.test(relative)
    || relative.split('/').some((segment) => segment === 'tests' || segment === '__tests__')
  );
}

/**
 * Every production source under `root`, repository-relative and POSIX-separated.
 * @param {string} root
 * @returns {string[]}
 */
function productionSources(root) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const glob of PRODUCTION_GLOBS) {
    for (const hit of globSync(glob, { cwd: root })) {
      const relative = hit.split(path.sep).join('/');
      if (isTestSource(relative)) continue;
      if (existsSync(path.join(root, relative))) found.add(relative);
    }
  }
  return [...found].sort();
}

/**
 * The frontend source-root alias (`@/X` -> `<root>/src/X.ts`), resolved for this plain `node`
 * process.
 *
 * The shipped declaring module reaches a sibling shared module through `@/`, the alias the browser
 * build, the type-checker, the lint pass and the unit transform all resolve. A bare `node` process
 * resolves none of those, so this is the same mapping for the one runtime that does not carry it —
 * the reading `experiments/voice-vad/run.mjs` and `scripts/voice-vad-harness.test.mjs` already make
 * for their own plain-node loads. A relative import in the shipping module would be the inverse of
 * the repository's convention and is deliberately not the fix: the check adapts to how the tree
 * ships, not the other way round.
 *
 * The root is the one `run()` resolved from `--root`, NOT this script's repository: the probe is
 * designed to read a fixture tree that is not this one (see the file header), so the alias has to
 * point at whichever tree is under test.
 * @param {string} root the tree under test
 */
function registerSourceRootAlias(root) {
  const srcRoot = path.join(root, 'src');
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@/')) {
        return { url: pathToFileURL(path.join(srcRoot, specifier.slice(2)) + '.ts').href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

/**
 * Imports a TypeScript module from the tree under test. The specifier is computed, so TypeScript
 * does not try to resolve it at check time — which is the point: this file must be able to read a
 * tree that is not this one.
 * @param {string} root
 * @param {string} relativePath
 * @returns {Promise<Record<string, unknown>>}
 */
async function importModule(root, relativePath) {
  const url = pathToFileURL(path.join(root, relativePath)).href;
  return /** @type {Record<string, unknown>} */ (await import(url));
}

/**
 * The boolean leaves of a value, as `path -> boolean`, so two answers can be compared by what
 * they decided rather than by whether their objects are identical.
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {Record<string, boolean>}
 */
function booleanLeaves(value, prefix = '') {
  /** @type {Record<string, boolean>} */
  const leaves = {};
  if (typeof value === 'boolean') {
    leaves[prefix] = value;
    return leaves;
  }
  if (!value || typeof value !== 'object') return leaves;
  for (const [key, child] of Object.entries(value)) {
    Object.assign(leaves, booleanLeaves(child, prefix ? `${prefix}.${key}` : key));
  }
  return leaves;
}

/**
 * Calls `fn` and returns its value, or null when it throws — a function that cannot take a
 * capability value was never a candidate read point.
 * @param {Function} fn
 * @param {unknown} argument
 * @returns {unknown}
 */
function callSafely(fn, argument) {
  try {
    return fn(argument);
  } catch {
    return null;
  }
}

/**
 * The exported functions whose boolean answer differs between the two opposite capability values.
 *
 * A rename does not hide a read point from this, and a function that returns the same thing for
 * both values is not one — which is exactly the property "decides 裁不裁 from the capability"
 * means.
 * @param {Record<string, unknown>} moduleExports
 * @returns {{ name: string, forTrimValue: Record<string, boolean>, forKeepValue: Record<string, boolean> }[]}
 */
function discriminatingExports(moduleExports) {
  /** @type {{ name: string, forTrimValue: Record<string, boolean>, forKeepValue: Record<string, boolean> }[]} */
  const found = [];
  for (const [name, value] of Object.entries(moduleExports)) {
    if (typeof value !== 'function') continue;
    const forTrimValue = booleanLeaves(callSafely(value, TRIM_VALUE));
    const forKeepValue = booleanLeaves(callSafely(value, KEEP_VALUE));
    const flipped = Object.keys(forTrimValue).some(
      (leaf) => forKeepValue[leaf] !== undefined && forTrimValue[leaf] !== forKeepValue[leaf],
    );
    if (flipped) found.push({ name, forTrimValue, forKeepValue });
  }
  return found;
}

/**
 * @typedef {{ provider: string, pauseCues: string, evidence?: string }} DeclarationRow
 * @typedef {{ name: string, rows: DeclarationRow[] }} DeclarationTable
 */

/**
 * Reads the capability and answers 裁不裁 for it — used by this file to ask the read point what it
 * decides, without knowing what the read point is called.
 * @param {Function} readPoint
 * @param {string} pauseCues
 * @returns {boolean | null}
 */
function trimAnswerFor(readPoint, pauseCues) {
  const answer = callSafely(readPoint, pauseCues);
  if (!answer || typeof answer !== 'object') return null;
  const trim = /** @type {Record<string, unknown>} */ (answer).trim;
  return typeof trim === 'boolean' ? trim : null;
}

/**
 * The file exporting the shipped trim switch, and the switch's own default in this process.
 * @param {string} root
 * @param {string[]} sources
 * @returns {Promise<{ file: string, default: boolean } | null>}
 */
async function readTrimSwitchDefault(root, sources) {
  for (const file of sources) {
    if (!TRIM_SWITCH_EXPORT.test(readFileSync(path.join(root, file), 'utf8'))) continue;
    const moduleExports = await importModule(root, file);
    const fn = moduleExports.isVoiceTrimEnabled;
    if (typeof fn !== 'function') return null;
    const value = callSafely(/** @type {Function} */ (fn), undefined);
    if (typeof value !== 'boolean') return null;
    return { file, default: value };
  }
  return null;
}

/**
 * @typedef {{ name: string, ok: boolean, reason: string }} Check
 */

/**
 * @param {string} root
 * @param {boolean} explainScan
 * @returns {Promise<{ checks: Check[], lines: string[] }>}
 */
async function run(root, explainScan) {
  // ESM resolves a module's whole static specifier graph before that module's body executes, so
  // the `@/` alias has to be installed before the first `importModule()` below — a hook registered
  // after the import has already resolved is a hook that never ran. Registered here rather than at
  // module load because it is bound to the `--root` under test, which is a fixture tree for the
  // falsification cases and this repository only for the shipping run.
  registerSourceRootAlias(root);

  /** @type {Check[]} */
  const checks = [];
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {string} name
   * @param {boolean} ok
   * @param {string} reason
   */
  const check = (name, ok, reason) => {
    checks.push({ name, ok, reason });
    lines.push(`check ${name}: ${ok ? 'ok' : 'FAIL'} ${reason}`);
  };

  const sources = productionSources(root);
  lines.push(`scan: ${sources.length} production sources under ${root} across ${PRODUCTION_GLOBS.length} globs`);
  if (explainScan) {
    for (const glob of PRODUCTION_GLOBS) lines.push(`scan glob ${glob} -> ${globSync(glob, { cwd: root }).length} files`);
    for (const file of sources) lines.push(`scan file ${file}`);
  }
  if (sources.length === 0) {
    check('sources', false, `the production scan matched nothing under ${root} — an empty scan is not a pass`);
    return { checks, lines };
  }

  // ── the declaring module ────────────────────────────────────────────────────────────────────
  const declaring = sources.filter((file) => CAPABILITY_TYPE_DECLARATION.test(readFileSync(path.join(root, file), 'utf8')));
  if (declaring.length !== 1) {
    check(
      'declaration',
      false,
      declaring.length === 0
        ? 'no production file declares the pause-cues capability type — there is nothing to read'
        : `${declaring.length} production files declare the pause-cues capability type: ${declaring.join(', ')} — a capability with two declarations has no single source`,
    );
    return { checks, lines };
  }
  const declaringModule = declaring[0];
  lines.push(`declaration module: ${declaringModule}`);
  const moduleExports = await importModule(root, declaringModule);

  // ── the declarations ───────────────────────────────────────────────────────────────────────
  // Read from the registry, not from the declaring module: the vocabulary's home and the
  // declarations' home are two modules, and the declarations are the ones a request is actually
  // served under. The rows are `{provider, pauseCues, evidence}` where the registry keeps them —
  // the adapter modules' own `capabilities.pauseCues`, reached through the registration table.
  const registry = registryDeclarations(root);
  if (registry.error !== null) {
    check(
      'declaration',
      false,
      `the registered declarations could not be read: ${registry.error} — a registry that cannot be followed is not a pass`,
    );
    return { checks, lines };
  }
  const table = /** @type {DeclarationTable} */ ({
    name: `the registration table (${REGISTRY_MODULE})`,
    rows: registry.providers.map((entry) => ({
      provider: entry.id,
      pauseCues: entry.capability,
      evidence: entry.evidence,
    })),
  });
  if (table.rows.length === 0) {
    check(
      'declaration',
      false,
      `${REGISTRY_MODULE} registers no recogniser — a table with 0 rows is a zero-row reading, not a pass`,
    );
    return { checks, lines };
  }
  const malformed = table.rows.filter((row) => !CAPABILITY_VALUES.includes(row.pauseCues));
  if (malformed.length > 0) {
    check(
      'declaration',
      false,
      `${table.name} declares a capability outside the vocabulary: ${malformed.map((row) => `${row.provider}=${row.pauseCues}`).join(', ')}`,
    );
    return { checks, lines };
  }
  check('declaration', true, `${table.name} declares ${table.rows.length} row(s), read off the adapter modules`);
  for (const row of table.rows) {
    lines.push(`declared provider=${row.provider} pauseCues=${row.pauseCues} evidence=${row.evidence ?? '(none)'}`);
  }

  // ── the read point ──────────────────────────────────────────────────────────────────────────
  const readers = discriminatingExports(moduleExports);
  if (readers.length !== 1) {
    check(
      'read-point',
      false,
      readers.length === 0
        ? `no export of ${declaringModule} answers differently for ${TRIM_VALUE} than for ${KEEP_VALUE} — the capability is not read anywhere`
        : `${readers.length} exports of ${declaringModule} answer 裁不裁 from the capability: ${readers.map((r) => r.name).join(', ')} — "the only source" needs one`,
    );
    return { checks, lines };
  }
  const readPoint = moduleExports[readers[0].name];
  const readPointName = readers[0].name;
  check('read-point', true, `${declaringModule} reads the capability at ${readPointName}`);

  // ── one source: nobody else answers it by hand, and somebody reaches the read point ──────────
  /** @type {Function} */
  const readPointFn = /** @type {Function} */ (readPoint);
  const reachable = readPointFn;
  const consumers = sources.filter((file) => {
    if (file === declaringModule) return false;
    const text = readFileSync(path.join(root, file), 'utf8');
    return new RegExp(`\\b${readPointName}\\b`).test(text);
  });
  // Read over the whole tree, not just over the consumers: a file that decides by hand *and*
  // reaches the read point is still a second answer to 裁不裁.
  const handDeciders = sources.filter(
    (file) => file !== declaringModule && HAND_DECISION.test(readFileSync(path.join(root, file), 'utf8')),
  );
  const unique = consumers.length > 0 && handDeciders.length === 0;
  check(
    'single-source',
    unique,
    unique
      ? `${consumers.length} production file(s) reach ${readPointName}: ${consumers.join(', ')}; no file answers 裁不裁 by hand`
      : consumers.length === 0
        ? `no production file reaches ${readPointName} — the capability is declared and never read, so 裁不裁 is still decided elsewhere (${readPointName} is unreachable)`
        : `${handDeciders.join(', ')} compare the capability vocabulary directly instead of reading ${readPointName}`,
  );
  if (!unique) return { checks, lines };

  // ── the decision the capability yields ──────────────────────────────────────────────────────
  const wrong = table.rows.filter((row) => trimAnswerFor(reachable, row.pauseCues) !== (row.pauseCues === TRIM_VALUE));
  const trims = table.rows.filter((row) => trimAnswerFor(reachable, row.pauseCues) === true);
  const keeps = trimAnswerFor(reachable, KEEP_VALUE);
  const decisionOk = wrong.length === 0 && trims.length > 0 && keeps === false;
  check(
    'decision',
    decisionOk,
    decisionOk
      ? `${readPointName} takes the trim path for ${trims.map((row) => row.provider).join(', ')} and declines it for ${KEEP_VALUE}`
      : wrong.length > 0
        ? `${readPointName} disagrees with the declaration for ${wrong.map((row) => `${row.provider}=${row.pauseCues}`).join(', ')}`
        : trims.length === 0
          ? `no declared recogniser takes the trim path — the decision is inert`
          : `${readPointName} answers ${String(keeps)} for ${KEEP_VALUE} — the decision does not follow the capability`,
  );

  // ── the shipped default ─────────────────────────────────────────────────────────────────────
  // The default is not a fallback row (the registry deliberately has none: an id no adapter claims
  // yields `null`, covered by `src/shared/tests/voiceTrimShippedRecogniser.test.ts`). It is the
  // recogniser a deployment that names no provider actually resolves to, which is the FIRST
  // registered one — so the order of the registration table is part of the reading, not a detail.
  const effective = table.rows[0];
  const effectiveTrim = trimAnswerFor(reachable, effective.pauseCues);
  const trimSwitch = await readTrimSwitchDefault(root, sources);
  const defaultOk = effectiveTrim === true && trimSwitch !== null && trimSwitch.default === true;
  check(
    'default',
    defaultOk,
    defaultOk
      ? `a deployment that names no provider resolves to ${effective.provider} (first registered), which declares ${effective.pauseCues} and is trimmed; ${trimSwitch.file}'s own default is ${String(trimSwitch.default)} — the shipped chain still trims`
      : effectiveTrim !== true
        ? `a deployment that names no provider resolves to ${effective.provider} (first registered), which declares ${effective.pauseCues} and does not take the trim path — the default stopped changing what gets uploaded`
        : trimSwitch === null
          ? 'the shipped trim switch could not be read, so "the default is on" has no reading'
          : `${trimSwitch.file}'s own default is ${String(trimSwitch.default)} — the trim is off unless somebody switches it on`,
  );

  // ── the discipline: a non-destructive declaration names its experiment ───────────────────────
  const unjustified = table.rows.filter(
    (row) => row.pauseCues !== TRIM_VALUE && (typeof row.evidence !== 'string' || row.evidence.trim() === ''),
  );
  const missing = table.rows.filter(
    (row) => typeof row.evidence === 'string' && row.evidence.trim() !== '' && !existsSync(path.join(root, row.evidence)),
  );
  const disciplineOk = unjustified.length === 0 && missing.length === 0;
  check(
    'discipline',
    disciplineOk,
    disciplineOk
      ? `every declaration outside ${TRIM_VALUE} names its own paired experiment, and every named record exists`
      : unjustified.length > 0
        ? `${unjustified.map((row) => `${row.provider}=${row.pauseCues}`).join(', ')} declares a non-${TRIM_VALUE} capability with no paired experiment to point at`
        : `the declared experiment record does not exist: ${missing.map((row) => `${row.provider}->${String(row.evidence)}`).join(', ')}`,
  );

  return { checks, lines };
}

const argv = process.argv.slice(2);
try {
  const { root, explainScan } = parseArgs(DEFAULT_ROOT, argv);
  const { checks, lines } = await run(root, explainScan);
  for (const line of lines) console.log(line);
  const failed = checks.filter((entry) => !entry.ok);
  for (const entry of failed) console.log(`reason ${entry.name}: ${entry.reason}`);
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.log(`check probe: FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
