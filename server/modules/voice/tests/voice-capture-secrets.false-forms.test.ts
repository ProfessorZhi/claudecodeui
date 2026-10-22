/**
 * The falsifying forms behind `voice-capture-secrets.test.ts`, plus the exit-code half of AC10.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that is not something a passing run can show about
 * itself. So each case here builds a BROKEN copy of the shipping capture module by a one-anchor text
 * mutation, runs the whole reading list against it, and requires the readings it predicts to fail —
 * by name, with the figure that went wrong, so the red is attributable to a clause rather than to a
 * reading. The two mutations are the two cheap ways to satisfy this task's words while missing its
 * subject — RECORD THE REQUEST'S HEADERS, and RECORD THE UPLOAD'S ENCODING:
 *
 *   · (i) `headers-into-capture` — the builder's return literal also copies the request's headers onto
 *     the row. The row is still built by the one construction point from the narrowed input, every
 *     field it always had is still there, and the `Authorization: Bearer <key>` the attempt sent is now
 *     in the process's own output. If this case passes, AC4's `logHits`/`consoleHits` are not measuring
 *     the credential's absence from the log faces.
 *   · (ii) `base64-into-capture-row` — the builder's return literal also carries the upload as base64.
 *     The recording is still written to disk byte for byte (AC5's subject is untouched) and a copy of
 *     it is now in the log. If this case passes, AC4 is not measuring the recording's absence either.
 *
 * EACH CASE HAS THREE PARTS, and the first is what keeps the other two from being vacuous:
 *   1. the UNMUTATED copy must clear the whole list (a harness that is red for its own reasons proves
 *      nothing by going red on a mutant);
 *   2. the MUTATED copy must red every reading the case predicts, that reading's measured value must
 *      contain the figure the mutation changes, AND the mutant's raw sink hits must be > 0 — a mutant
 *      whose leak reached no surface at all reads exactly like a criterion with no resolution, and
 *      `anti-fake-variant-passes-means-criterion-hole` is the memory that says so. This is the AC9
 *      `mutant.rawSinkHits=<n>` reading, and it is required to be non-zero;
 *   3. some reading OUTSIDE that family must still be green, so "the whole rig broke" is not what the
 *      red means.
 *
 * WHY THE SEAM EXISTS AT ALL, AND WHY IT IS REGISTERED RATHER THAN HIDDEN. The row is built by a PURE
 * function from a NARROWED input, so a field added on the service side is dropped at the construction
 * point: a mutation that put the headers there would find nothing to leak and the case would read
 * green for the wrong reason (the AC9 reachability clause names exactly this trap). The narrowed input
 * therefore carries the request's headers as a named field the shipping builder does not copy, and the
 * criterion's AC11 reading reports both halves — the two shipping files the seam touches, and the
 * builder's own return literal, which does not name it. That is the one shipping change this task
 * makes; it is not zero and the completion record says so.
 *
 * WHERE THE COPIES GO, AND WHY NOT BESIDE THIS FILE. A copy of a module keeps that module's relative
 * imports (`../../../shared/asr/…`), so a copy in this file's directory would not resolve them; the
 * copies therefore live beside the module they copy, under `server/modules/voice/`, which is the same
 * tree and the only place a copy of it resolves at all. Each copy gets its OWN path, because ESM
 * caches a module by URL: a mutant written over the base copy's path would import the already-evaluated
 * base module and the run would measure nothing. A copy of the CAPTURE module is still imported by the
 * SHIPPING service — the criterion drives the shipping service — so the mutation is the only difference
 * in each arm. THAT DIRECTORY IS SHARED and the suite runs several files at a time, so the tree-half
 * reading is scoped to this process's own copies; the AC9 tree case below says why.
 *
 * WHY AC10'S EXIT CODES ARE HERE. AC10 asks for the exit code of eight existing criteria plus
 * `npm run typecheck` and `npm run lint`, each printed rather than assumed. Those are SUBPROCESSES, and
 * AC1 requires the criterion file itself to start none inside a fifteen-second budget — one `npm run
 * typecheck` alone is most of that budget. This file is the task's other executable artifact, it
 * already starts `git` and `npx`, and it is not the file AC1's budget is about.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  collectRawSinkHits,
  collectReadings,
  SHIPPING_CAPTURE_MODULE,
  SHIPPING_SERVICE_MODULE,
} from './voice-capture-secrets.test.js';

/** Where the mutated copies go: beside the module they copy, so its relative imports still resolve. */
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
 * "is this porcelain line mine?" is answered by the same value the file name was built from. It has to
 * be asked, because this directory is shared with the sibling criteria.
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
 * Captured in the module body rather than in a hook, because what AC9 owes is that THIS RUN leaves no
 * `__criterion-falsify-` residue: a tree a developer already had dirty should not be reported as this
 * criterion's leftovers, and a tree that was clean has to come back clean.
 */
const PRE_RUN_PORCELAIN = gitStatusPorcelain();

// ── the mutation cases ────────────────────────────────────────────────────────────────────────

/** One reading a mutation must break, and the figure in it that the mutation is supposed to move. */
type Expectation = {
  /** The reading, as the criterion names it. */
  reading: RegExp;
  /** A literal that must appear in that reading's measured value once the mutation is in place. */
  token: string;
  /** What the figure means, for the reason printed with the reading. */
  meaning: string;
};

type MutationCase = {
  /** The case's name, used in the reading names and the temp file names. */
  name: string;
  /** The exact shipping text to replace. Required to be unique in the file. */
  anchor: string;
  /** What it is replaced with. */
  replacement: string;
  /** The readings this mutation must break, as the criterion names them. */
  target: RegExp;
  /** Which reading the red must be on, printed as `inTarget=`. */
  family: string;
  /** Figure-level attribution: each of these must red WITH this token in its measured value. */
  expects: readonly Expectation[];
  /** What the mutation is, in one sentence, for the reason printed with the reading. */
  why: string;
};

/**
 * THE ANCHOR BOTH CASES SHARE: the builder's return literal's first line.
 *
 * It is a `model:` line and not a "start of the literal" one because the return literal has no single
 * line that is only a delimiter — inserting after a field is the one edit whose text is unambiguous in
 * both the shipping file and the mutant. It occurs EXACTLY ONCE in the shipping module (the criterion
 * asserts that below), which is what makes the case about one site rather than about two.
 *
 * BOTH MUTATIONS ADD A FIELD TO THAT SAME LITERAL, and that is the AC9 reachability point: the row is
 * built by listing the names this function copies, so a value that is not named here cannot reach a row
 * no matter what the service holds. The two added names are the two the narrowed input already carries
 * — the request's headers, and the upload's bytes.
 */
const ANCHOR = '    model: input.model,';

const CASES: readonly MutationCase[] = [
  {
    name: 'headers-into-capture',
    anchor: ANCHOR,
    replacement: `${ANCHOR}\n    requestHeaders: input.requestHeaders,`,
    target: /^AC4 /,
    family: 'AC4/log-faces',
    expects: [
      {
        reading: /^AC4 /,
        token: 'logFaceClean=false',
        meaning:
          "the attempt's own request headers — the `Authorization: Bearer <key>` it sent — were copied " +
          'onto the capture row, so the credential is in the process output',
      },
    ],
    why: "the row now carries the request's headers, which puts the bearer credential in the log",
  },
  {
    name: 'base64-into-capture-row',
    anchor: ANCHOR,
    replacement: `${ANCHOR}\n    audioBase64: Buffer.from(input.audio.bytes).toString('base64'),`,
    target: /^AC4 /,
    family: 'AC4/log-faces',
    expects: [
      {
        reading: /^AC4 /,
        token: 'logFaceClean=false',
        meaning:
          'the upload was re-encoded into the capture row, so a copy of the recording is in the ' +
          'process output — turned into something a reader can turn back into audio',
      },
    ],
    why: 'the row now carries the upload as base64, which puts the recording in the log',
  },
];

/** One arm's measurement, as the reading list reports it. */
type ArmOutcome = {
  /** The reading names that failed, in the order the list ran them. */
  red: string[];
  /** The number of readings the list ran, so a shortened list is visible. */
  total: number;
  /** The value of the first red reading, which is what a reader needs to attribute the failure. */
  firstRedReason: string;
  /** Whether a reading outside the target family stayed green. */
  outsiderGreen: string;
  /** Every reading's outcome, so a case can look a figure up by reading name. */
  outcomes: { name: string; value: string; ok: boolean }[];
  /** The mutant's raw sink hits: every needle occurrence it left on any receiving surface. */
  rawSinkHits: number;
};

async function measureArm(modulePath: string): Promise<ArmOutcome> {
  const modules = { capture: modulePath };
  const outcomes = await collectReadings(modules);
  const rawSinkHits = await collectRawSinkHits(modules);
  const red = outcomes.filter((outcome) => !outcome.ok);
  return {
    red: red.map((outcome) => outcome.name),
    total: outcomes.length,
    firstRedReason: red[0] === undefined ? '(none)' : `${red[0].name} measured ${red[0].value}`,
    outsiderGreen: '(none)',
    outcomes,
    rawSinkHits,
  };
}

/**
 * The figure-level check: every predicted reading red, and red for the predicted reason.
 *
 * THIS IS WHAT KEEPS A CASE FROM BEING SATISFIED BY AN ACCIDENT. "AC4 is red" is a much weaker claim
 * than "AC4 is red because `sinkHits` is not zero": the first is also true if the mutation broke the
 * module's import, and the second is also false if the criterion stopped printing `sinkHits` while
 * still failing for another reason. Both are reported by name, together with the measured value, so
 * the failure says which of the two happened.
 */
function attributionMisses(mutation: MutationCase, mutant: ArmOutcome): string[] {
  const misses: string[] = [];
  for (const expectation of mutation.expects) {
    const outcome = mutant.outcomes.find((entry) => expectation.reading.test(entry.name));
    if (outcome === undefined) {
      misses.push(`no reading matching ${String(expectation.reading)} ran at all`);
      continue;
    }
    if (outcome.ok) {
      misses.push(
        `${outcome.name} STAYED GREEN while the figure read ${expectation.token}: this mutation ` +
          `(${expectation.meaning}) is not what that reading's verdict rests on`,
      );
      continue;
    }
    if (!outcome.value.includes(expectation.token)) {
      misses.push(
        `${outcome.name} went red but without ${expectation.token} in its measured value ` +
          `(measured ${outcome.value}): the red is about something else`,
      );
    }
  }
  return misses;
}

for (const mutation of CASES) {
  test(`AC9/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
    const basePath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-base-${process.pid}.ts`);
    const mutantPath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-mut-${process.pid}.ts`);

    try {
      await copyFile(SHIPPING_CAPTURE_MODULE, basePath);

      // ── arm one: the same text, unmutated. A harness that reds here cannot say anything about the
      // mutant, so this arm is a precondition rather than a second experiment.
      const base = await measureArm(basePath);
      const baseExit = base.red.length === 0 ? 0 : 1;
      process.stdout.write(
        `falsify/${mutation.name} base: mutation=${mutation.name} baseExit=${baseExit} ` +
          `readings=${base.total} red=${base.red.length}` +
          `${base.red.length === 0 ? '' : ` [${base.red.join(' ')}]`}\n`,
      );
      assert.deepEqual(
        base.red,
        [],
        `the unmutated copy must clear the whole list before the mutation means anything; it red at ${base.red.join(', ')}`,
      );

      // ── the mutation itself. The anchor has to be unique: a text that occurs twice would be
      // rewritten in both places, and the case would then be about two edits rather than one.
      const shippingText = await readFile(SHIPPING_CAPTURE_MODULE, 'utf8');
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

      // ── arm two: the mutant, at a NEW path, because ESM caches by URL and a mutant that reused the
      // base copy's path would import the base module and measure nothing at all.
      const mutant = await measureArm(mutantPath);
      const inTargetFamily = mutant.red.filter((name) => mutation.target.test(name));
      const outsider = mutant.outcomes.find(
        (outcome) => outcome.ok && !mutation.target.test(outcome.name),
      );
      mutant.outsiderGreen = outsider?.name ?? '(none)';
      const misses = attributionMisses(mutation, mutant);

      // AC9's own line, printed before any assertion so a red names itself and its figures in the log.
      process.stdout.write(
        `mutation=${mutation.name} baseExit=0 anchorCount=${anchorCount} ` +
          `mutantRed=${inTargetFamily.length > 0} inTarget=[${inTargetFamily.join(' ')}] ` +
          `red-reason=${mutant.firstRedReason} outsiderGreen=${mutant.outsiderGreen} ` +
          `mutant.rawSinkHits=${mutant.rawSinkHits} whichReading=${mutation.family} ` +
          `red=${mutant.red.length} [${mutant.red.join(' ')}] why=${mutation.why}\n`,
      );

      // THE REACHABILITY READING, and the reason it is asked FIRST: a mutant that changed no surface at
      // all reads exactly like a criterion with no resolution, and the two are opposite facts. Zero raw
      // sink hits means the leak this case is about never happened, so nothing below is about anything.
      assert.ok(
        mutant.rawSinkHits > 0,
        `the ${mutation.name} mutation (${mutation.why}) reached NO receiving surface ` +
          `(mutant.rawSinkHits=0): the mutation did not take effect, so its green readings are not ` +
          'evidence that the criterion has resolution',
      );

      assert.ok(
        inTargetFamily.length > 0,
        `the ${mutation.name} mutation (${mutation.why}) must red a reading matching ${String(mutation.target)}; ` +
          `the mutant was graded as: ${mutant.red.length === 0 ? 'all green' : mutant.red.join(', ')}`,
      );

      assert.deepEqual(
        misses,
        [],
        `the ${mutation.name} mutation did not red the figure it is supposed to move: ${misses.join(' | ')}`,
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

// ── AC10's exit codes: the surfaces this task must not have moved ──────────────────────────────

/**
 * The eight criteria AC10 names, by path so the printed line says which one answered.
 *
 * `voice-capture-off` is first among the capture criteria because it is AC-143's, and this task edits
 * the one construction point that criterion reads: if this task's builder left a field on the row it
 * pinned, this is the line that says so. `voice-capture-text` and `voice-capture-audio` are the two
 * siblings whose subject this task's log-face reading borders, and `voice-dashscope-settings` is
 * AC-141's, whose needles this task's four families overlap.
 */
const EXISTING_CRITERIA = [
  'server/modules/voice/tests/voice-dashscope-settings.test.ts',
  'server/modules/voice/tests/voice-capture-off.test.ts',
  'server/modules/voice/tests/voice-capture-text.test.ts',
  'server/modules/voice/tests/voice-capture-audio.test.ts',
  'server/modules/voice/tests/voice.service.test.ts',
  'server/modules/voice/tests/voiceHealth.test.ts',
  'server/modules/voice/tests/voice-config.routes.test.ts',
  'server/modules/voice/tests/voiceTranscribeGaps.test.ts',
];

type CommandOutcome = {
  command: string;
  exitCode: number;
  /** The case tally the runner printed, or `null` for a command that prints no tally. */
  cases: number | null;
};

/**
 * Runs one command and reports its exit code plus, for a test runner, how many cases it ran.
 *
 * `NODE_TEST_CONTEXT` IS DELETED FROM THE CHILD'S ENVIRONMENT, and that is what makes "exit 0" mean
 * something: a `node --test` child that inherits it runs in the parent's context and exits 0 having run
 * NOTHING, which is the exact false green this reading exists to catch. The tally is asserted non-zero
 * for the same reason, one level down.
 */
function runCommand(command: string, args: readonly string[], tally: boolean): CommandOutcome {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const options = {
    cwd: REPO_ROOT,
    encoding: 'utf8' as const,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  };

  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(command, [...args], options);
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    exitCode = typeof failure.status === 'number' ? failure.status : 1;
    output = typeof failure.stdout === 'string' ? failure.stdout : '';
  }

  const match = tally ? /pass (\d+)/.exec(output) : null;
  return {
    command: `${command} ${args.join(' ')}`,
    exitCode,
    cases: match === null ? null : Number(match[1]),
  };
}

test('AC10 the eight criteria and the repository gates still exit 0', () => {
  const outcomes: CommandOutcome[] = [
    ...EXISTING_CRITERIA.map((file) =>
      runCommand('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', '--test', file], true),
    ),
    // `npm run typecheck` is the three configurations AC10 names — root `tsconfig.json`,
    // `server/tsconfig.json` and `scripts/tsconfig.json` — chained in one script, so its exit code is
    // the answer for all three at once.
    runCommand('npm', ['run', 'typecheck'], false),
    runCommand('npm', ['run', 'lint'], false),
  ];

  for (const outcome of outcomes) {
    const tally =
      outcome.cases === null
        ? 'cases=n/a'
        : `cases=${outcome.cases}${outcome.cases > 0 ? '' : ' (NOTHING RAN)'}`;
    process.stdout.write(`AC10 exit=${outcome.exitCode} ${tally} :: ${outcome.command}\n`);
  }

  assert.deepEqual(
    outcomes.filter((outcome) => outcome.exitCode !== 0).map((outcome) => outcome.command),
    [],
    'a surface this task must not have moved is red',
  );
  assert.deepEqual(
    outcomes
      .filter((outcome) => outcome.cases !== null && outcome.cases === 0)
      .map((outcome) => outcome.command),
    [],
    'a criterion that exits 0 having run no cases is a vacuous pass, not a green one',
  );
});

/**
 * AC9's tree half, scoped to what THIS run is answerable for.
 *
 * WHY THE READING IS SCOPED BY PID. The copies cannot live in the OS temp directory (their relative
 * imports would not resolve), and this file is not the only criterion writing into that directory: the
 * sibling `voice-*.false-forms.test.ts` criteria build their own `__criterion-falsify-*` copies in the
 * SAME directory, and the suite runs several files at a time. So a sibling's copies are untracked lines
 * in this file's tree through no act of this file's, and a sibling that is still holding them when this
 * file STARTS has finished and cleaned up by the time this reading runs — which made the
 * snapshot-vs-sample comparison report "changed" on a tree whose final state was empty. That is a
 * cross-PROCESS artifact, not residue, so the comparison forgives exactly that and nothing else:
 *
 *   · THIS run's own copies stay an unconditional red (`own-temp-copies`), so the property AC9 names —
 *     no `__criterion-falsify-` residue from this run — is asserted at full strength;
 *   · a difference is forgiven ONLY when every line in it is a temp copy belonging to another pid.
 *     Any other added, removed or modified path — a copy of this run's, a stray file, a touched tracked
 *     file — keeps the red, and the failure prints both sides of the delta;
 *   · a foreign copy present in BOTH snapshots contributes no difference at all and needs no
 *     forgiveness.
 *
 * `temp-copies-any` and `raw-unchanged` are printed beside the scoped verdict, so what was excluded is
 * visible in the reading rather than implied by it.
 */
test('AC9/tree: no __criterion-falsify- residue and git status --porcelain gained nothing', () => {
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

  // The copies are UNTRACKED files, so a run that failed to delete one shows up as a `??` line naming
  // it. This is asserted before the comparison below, because it is the property the cases are
  // responsible for and it is the one that holds whether or not the tree was clean.
  assert.deepEqual(
    ownLeftovers,
    [],
    `this run left its own temp copies behind: ${ownLeftovers.join(' ')}`,
  );

  // AC9's own words: `__criterion-falsify-` does not survive the run. In the tree the gate runs, the
  // starting state is empty; in a tree a developer was already iterating on, the property this case
  // owns is that the run ADDED nothing, so the comparison is against the state this file started in
  // rather than against an ideal it was never handed — and, for that same reason, a sibling criterion's
  // in-flight copies are not this run's change to answer for.
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
