/**
 * The falsifying forms behind `voice-dashscope-settings.test.ts` — AC4's executable cases.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that claim is not something a passing run can show
 * about itself. So each case here builds a BROKEN copy of the shipping service by a one-line text
 * mutation, runs the whole reading list against it, and requires the readings it predicts to fail.
 * The two mutations are the two cheap ways to satisfy the task's words while missing its subject:
 *
 *   · `key-plaintext-echo` — mask nothing. Every sentence about "the key is masked on the readback"
 *     is still literally implemented (there IS a mask function, it IS called on the readback face)
 *     and the credential is handed to the client. If this file's first case passes, AC5's masking
 *     readings are measuring the mask rather than the intent.
 *   · `env-only-configured` — ask the deployment rather than the user. `providerConfigured` keeps
 *     its per-provider shape and its per-provider call sites; it just stops reading the document.
 *     This is the regression the task exists to prevent, and if the second case passes, AC3's
 *     per-provider readings are not measuring whose credential decides the answer.
 *
 * EACH CASE HAS THREE PARTS, and the first is what keeps the other two from being vacuous:
 *   1. the UNMUTATED copy must clear the whole list (a harness that is red for its own reasons
 *      proves nothing by going red on a mutant);
 *   2. the MUTATED copy must red at least one reading in the predicted family, and the red reading
 *      is printed by name so the failure is attributable;
 *   3. some reading OUTSIDE that family must still be green, so "the whole rig broke" is not what
 *      the red means.
 *
 * THE COPIES LIVE IN THE SAME TREE as the file they copy (`server/modules/voice/`), because the
 * module's own imports are relative — `../../../shared/asr/asrRegistry.js` — and a copy in the OS
 * temp directory would not resolve them. Each copy gets its OWN path, because ESM caches a module by
 * URL: a mutant written over the base copy's path would import the already-evaluated base module and
 * the run would measure nothing. Both are deleted in a `finally`, and the last reading below states
 * that in a way the repository can check — the temp copies are untracked files, so a run that left
 * one behind is visible in `git status --porcelain`.
 *
 * THAT DIRECTORY IS SHARED, AND THAT IS TWO READINGS' PROBLEM RATHER THAN ONE'S. The sibling
 * criteria (`voice-capture-off`, `voice-capture-text`) write the same `__criterion-falsify-` copies
 * there and the suite runs four files at a time, so (a) the `git status` half below is scoped to
 * this process's own copies — its doc comment says why — and (b) the scan it drives through
 * `collectReadings` must not treat a neighbour's in-flight copy as product source. The second half
 * lives in `voice-dashscope-settings.test.ts`: `collectSourceFiles` skips the prefix by name, and
 * the AC4(b) case there is what holds both halves of that exclusion to account — stability under a
 * neighbour's churn, AND the positive control proving a real hit in a real product file is still a
 * hit.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { collectReadings, SHIPPING_SERVICE_MODULE } from './voice-dashscope-settings.test.js';

/** Where the mutated copies go: beside the module, so the module's relative imports still resolve. */
const VOICE_DIR = path.dirname(SHIPPING_SERVICE_MODULE);
const REPO_ROOT = path.resolve(VOICE_DIR, '../../..');

/** The prefix every temp copy carries, so "nothing was left behind" is a pattern rather than a guess. */
const TEMP_PREFIX = '__criterion-falsify-';

/** `git status --porcelain` for the worktree, as one string. */
function gitStatusPorcelain(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/**
 * The tail every temp copy THIS process writes ends with.
 *
 * A copy's name already carries `process.pid` (`${TEMP_PREFIX}${name}-base-${process.pid}.ts`), so
 * "is this porcelain line mine?" is answered by the same value the file name was built from. It has
 * to be asked, because this directory is shared with the sibling criteria — see the AC4 case below.
 */
const OWN_TEMP_SUFFIX = `-${process.pid}.ts`;

/** True for a porcelain line naming a temp copy — any process's, this one's included. */
function isTempCopy(line: string): boolean {
  return line.includes(TEMP_PREFIX);
}

/** True for a porcelain line naming a temp copy THIS process wrote. */
function isOwnTempCopy(line: string): boolean {
  return isTempCopy(line) && line.trimEnd().endsWith(OWN_TEMP_SUFFIX);
}

/**
 * The two snapshots' disagreement, split by which side each line was seen on.
 *
 * Set-based rather than positional: `git status --porcelain` emits its entries sorted, so a set
 * difference says the same thing as a line-by-line walk while staying correct if porcelain ever
 * repeats a line.
 */
function snapshotDelta(before: string, after: string): { onlyBefore: string[]; onlyAfter: string[] } {
  const split = (value: string): string[] => value.split('\n').filter((line) => line !== '');
  const beforeLines = new Set(split(before));
  const afterLines = new Set(split(after));
  return {
    onlyBefore: [...beforeLines].filter((line) => !afterLines.has(line)),
    onlyAfter: [...afterLines].filter((line) => !beforeLines.has(line)),
  };
}

/** The first line of a string, for printing something bounded. */
function firstLine(value: string): string {
  return value.split('\n').find((line) => line !== '') ?? '(empty)';
}

/**
 * `git status --porcelain` BEFORE anything here runs.
 *
 * Captured in the module body rather than in a hook, because what this case owes is that THIS RUN
 * adds nothing: a tree that a developer already had dirty should not be reported as this
 * criterion's leftovers, and a tree that was clean has to come back clean.
 */
const PRE_RUN_PORCELAIN = gitStatusPorcelain();

type MutationCase = {
  /** The case's name, used in the reading names and the temp file names. */
  name: string;
  /** The exact shipping text to replace. Required to be unique in the file. */
  anchor: string;
  /** What it is replaced with. */
  replacement: string;
  /** The readings this mutation must break, as the criterion names them. */
  target: RegExp;
  /** What the mutation is, in one sentence, for the reason printed with the reading. */
  why: string;
};

const CASES: readonly MutationCase[] = [
  {
    name: 'key-plaintext-echo',
    anchor: [
      'function maskCredential(value: string): string {',
      "  return value === '' ? '' : CREDENTIAL_MASK_MARKER;",
      '}',
    ].join('\n'),
    replacement: ['function maskCredential(value: string): string {', '  return value;', '}'].join('\n'),
    target: /^AC5 /,
    why: 'the mask function is made the identity, so every readback hands the credential to the client',
  },
  {
    name: 'env-only-configured',
    anchor: [
      '  return (',
      "    readStoredField(settings, fields.endpointField) !== '' &&",
      "    readStoredField(settings, fields.apiKeyField) !== ''",
      '  );',
    ].join('\n'),
    replacement: '  return Boolean(defaults.baseUrl);',
    target: /^AC3 /,
    why: 'a credential-declaring provider is judged by the deployment’s backend instead of the user’s document',
  },
];

/** One arm's measurement, as the reading list reports it. */
type ArmOutcome = {
  /** The reading names that failed, in the order the list ran them. */
  red: string[];
  /** The value of the first red reading, which is what a reader needs to attribute the failure. */
  firstRedReason: string;
  /** Whether a reading outside the target family stayed green. */
  outsiderGreen: string;
};

async function measureArm(modulePath: string, target: RegExp): Promise<ArmOutcome> {
  const outcomes = await collectReadings(modulePath);
  const red = outcomes.filter((outcome) => !outcome.ok);
  const outsider = outcomes.find((outcome) => outcome.ok && !target.test(outcome.name));
  return {
    red: red.map((outcome) => outcome.name),
    firstRedReason: red[0] === undefined ? '(none)' : `${red[0].name} measured ${red[0].value}`,
    outsiderGreen: outsider?.name ?? '(none)',
  };
}

for (const mutation of CASES) {
  test(`AC4/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.target}`, async () => {
    const basePath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-base-${process.pid}.ts`);
    const mutantPath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-mut-${process.pid}.ts`);

    try {
      await copyFile(SHIPPING_SERVICE_MODULE, basePath);

      // ── arm one: the same text, unmutated. A harness that reds here cannot say anything about
      // the mutant, so this arm is a precondition rather than a second experiment.
      const base = await measureArm(basePath, mutation.target);
      process.stdout.write(
        `falsify/${mutation.name} base: readings=${String(base.red.length === 0)} red=${base.red.length}` +
          `${base.red.length === 0 ? '' : ` [${base.red.join(' ')}]`}\n`,
      );
      assert.deepEqual(
        base.red,
        [],
        `the unmutated copy must clear the whole list before the mutation means anything; it red at ${base.red.join(', ')}`,
      );

      // ── the mutation itself. The anchor has to be unique: a text that occurs twice would be
      // rewritten in both places, and the case would then be about two edits rather than one.
      const shippingText = await readFile(SHIPPING_SERVICE_MODULE, 'utf8');
      const anchorCount = shippingText.split(mutation.anchor).length - 1;
      assert.equal(
        anchorCount,
        1,
        `the anchor for ${mutation.name} occurs ${anchorCount} times in the shipping module; a mutation ` +
          'case has to name exactly one site, or it is not this case that the red would be about',
      );

      const mutated = shippingText.replace(mutation.anchor, mutation.replacement);
      assert.notEqual(mutated, shippingText, `the ${mutation.name} replacement did not change the text`);
      await writeFile(mutantPath, mutated, 'utf8');

      // ── arm two: the mutant, at a NEW path, because ESM caches by URL and a mutant that reused
      // the base copy's path would import the base module and measure nothing at all.
      const mutant = await measureArm(mutantPath, mutation.target);
      const inTargetFamily = mutant.red.filter((name) => mutation.target.test(name));
      process.stdout.write(
        `falsify/${mutation.name} mutant: red=${mutant.red.length} [${mutant.red.join(' ')}] ` +
          `in-target=[${inTargetFamily.join(' ')}] red-reason=${mutant.firstRedReason} ` +
          `outsider-still-green=${mutant.outsiderGreen} why=${mutation.why}\n`,
      );

      assert.ok(
        inTargetFamily.length > 0,
        `the ${mutation.name} mutation (${mutation.why}) must red a reading matching ${mutation.target}; ` +
          `the mutant was graded as: ${mutant.red.length === 0 ? 'all green' : mutant.red.join(', ')}`,
      );

      // ── arm three: something outside the family is still green, so the red is attributable to the
      // mutation rather than to a rig that fell over as a whole.
      assert.notEqual(
        mutant.outsiderGreen,
        '(none)',
        `every reading red under ${mutation.name}, which reads as a broken rig rather than as this mutation`,
      );
    } finally {
      await rm(basePath, { force: true });
      await rm(mutantPath, { force: true });
    }
  });
}

/**
 * The tree half, scoped to what THIS run is answerable for.
 *
 * WHY THE READING IS SCOPED BY PID. The copies cannot live in the OS temp directory (the module's
 * relative imports would not resolve), and this file is not the only criterion writing into that
 * directory: `voice-capture-off` and `voice-capture-text` build their own `__criterion-falsify-*`
 * copies in the SAME directory, and the suite runs four files at a time. A sibling's copy is an
 * untracked line in this file's tree through no act of this file's — and because the runs overlap,
 * a copy that a neighbour is still holding when this reading runs was reported as if this run had
 * left it behind. That is a cross-PROCESS artifact, not residue, so the reading forgives exactly
 * that and nothing else:
 *
 *   · THIS run's own copies stay an unconditional red (`own-temp-copies`), so the property the case
 *     names — no temp copy of this run survives — is asserted at full strength, and more precisely
 *     than before (the old reading reported a sibling's copies as if they were this run's);
 *   · a difference is forgiven ONLY when every line in it is a temp copy belonging to another pid.
 *     Any other added, removed or modified path — a copy of this run's, a stray file, a touched
 *     tracked file — keeps the red, and the failure prints both sides of the delta;
 *   · a foreign copy present in BOTH snapshots contributes no difference at all and needs no
 *     forgiveness.
 *
 * `temp-copies-any` and `raw-unchanged` are printed beside the scoped verdict, so what was excluded
 * is visible in the reading rather than implied by it.
 */
test('AC4: the temp copies are gone and git status --porcelain gained nothing', () => {
  const porcelain = gitStatusPorcelain();
  const lines = porcelain.split('\n');
  const ownLeftovers = lines.filter(isOwnTempCopy);
  const anyTempCopies = lines.filter(isTempCopy);
  const foreignTempCopies = anyTempCopies.filter((line) => !isOwnTempCopy(line));
  const clean = porcelain.trim() === '';

  const delta = snapshotDelta(PRE_RUN_PORCELAIN, porcelain);
  const rawUnchanged = delta.onlyBefore.length === 0 && delta.onlyAfter.length === 0;
  const differing = [...delta.onlyBefore, ...delta.onlyAfter];
  // Every differing line is some other process's in-flight temp copy => this run changed nothing.
  const concurrentOnly =
    differing.length > 0 && differing.every((line) => isTempCopy(line) && !isOwnTempCopy(line));
  const unchanged = rawUnchanged || concurrentOnly;

  process.stdout.write(
    `falsify/leftovers: git.status-clean=${String(clean)} unchanged=${String(unchanged)} ` +
      `own-temp-copies=${ownLeftovers.length === 0 ? 'none' : ownLeftovers.join(' ')} ` +
      `temp-copies-any=${anyTempCopies.length} foreign-temp-copies=${foreignTempCopies.length} ` +
      `raw-unchanged=${String(rawUnchanged)} added=${delta.onlyAfter.length} ` +
      `removed=${delta.onlyBefore.length} concurrent-foreign-only=${String(concurrentOnly)}\n`,
  );

  // The copies are UNTRACKED files, so a run that failed to delete one shows up as a `??` line
  // naming it. This is asserted before the comparison below, because it is the property the cases are
  // responsible for and it is the one that holds whether or not the tree was clean.
  assert.deepEqual(
    ownLeftovers,
    [],
    `this run left its own temp copies behind: ${ownLeftovers.join(' ')}`,
  );

  // The case's own words: `git status --porcelain` is identical to the state this file started in. In
  // the tree the gate runs, that state is empty; in a tree a developer was already iterating on, the
  // property this case owns is that the run ADDED nothing, so the comparison is against the state
  // this file started in rather than against an ideal it was never handed — and, for that same
  // reason, a sibling criterion's in-flight copies are not this run's change to answer for.
  assert.equal(
    unchanged,
    true,
    "this run changed the worktree's git status; " +
      `added=[${delta.onlyAfter.join(' ')}] removed=[${delta.onlyBefore.join(' ')}] ` +
      `started-with=["${firstLine(PRE_RUN_PORCELAIN)}"] ended-with=["${firstLine(porcelain)}"]`,
  );
  if (concurrentOnly) {
    process.stdout.write(
      `falsify/concurrent-foreign-only=true (the only delta was ${differing.length} temp copy ` +
        "line(s) belonging to another process, alive at this file's start and cleaned up by now)\n",
    );
  }
  if (clean) {
    process.stdout.write('falsify/git-status-clean=true (the run started from a committed tree)\n');
  } else {
    process.stdout.write(
      `falsify/git-status-clean=false (tree was already dirty before this run): ${firstLine(porcelain)}\n`,
    );
  }
});
