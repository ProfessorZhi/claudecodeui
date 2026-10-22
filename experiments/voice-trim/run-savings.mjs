#!/usr/bin/env node
/**
 * The savings reading, taken inside the repo and on the shipping module.
 *
 * The measurement this reproduces has lived out of tree for its whole life:
 * `/data/home/yale/work/tc-verify` holds a 49 MB corpus and a `tools/` directory
 * with its own copy of the pause-cap algorithm. That copy drifted — by AC-113 it
 * disagreed with the module that actually ships on 6 of 16 clips — and a reading
 * taken on a stale copy of the algorithm is worse than no reading, because it
 * looks like evidence. This runner therefore has exactly one source of behaviour:
 * it imports `src/shared/voiceTrim.ts` and reports what that module reports. It
 * decodes WAV headers and does arithmetic on the numbers the module hands back;
 * it does not decide where speech is, how long a pause may be, or when to give
 * up. The uniqueness section at the bottom asserts that mechanically rather than
 * trusting the reader to notice.
 *
 * What it answers: how much shorter does a dictation get, and did any speech go
 * missing while it got shorter. The second half is not decoration — a trimmer
 * that returns an empty buffer saves 100%.
 *
 * Curation, stated up front because it bounds what the numbers mean. The eight
 * fixtures under `fixtures/` are a *ladder*, not a sample: three Chinese
 * occupancy tiers, two English ones, picked so the monotonicity assertion has
 * tiers to move along. The thresholds are therefore pinned to this eight-clip
 * ladder rather than to the corpus it was drawn from — which is the point, since
 * a threshold that needs a 49 MB corpus to evaluate is a threshold that stops
 * being checked the moment the corpus is not there. `VOICE_TRIM_CORPUS` prints
 * the corpus readings beside the ladder's own tier means, so the two can be
 * compared instead of assumed equal.
 *
 * Usage:
 *   node experiments/voice-trim/run-savings.mjs             # fixtures only, asserts
 *   VOICE_TRIM_CORPUS=/data/home/yale/work/tc-verify/corpus \
 *     node experiments/voice-trim/run-savings.mjs           # + full-corpus readings
 *
 * Exit 0 only when every assertion holds on the shipping module *and* every
 * control below fails the assertions it is supposed to fail. A control that
 * passes one of them means that assertion cannot tell a real trim from that
 * control, and the run fails rather than report a green it has not earned.
 * Failures are written to stderr, one per line, in the order they were checked.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = new URL('./', import.meta.url);
const FIXTURE_DIR = new URL('fixtures/', HERE);
const MODULE_URL = new URL('../../src/shared/voiceTrim.ts', HERE);

/**
 * The frontend's `@/` source-root alias, resolved for a plain `node` process.
 *
 * `src/shared/voiceTrim.ts` reaches its shared endpoint module through the alias the
 * browser build, the type-checker and the unit transform all resolve — this hook is the
 * same mapping for the one place those toolchains do not reach, and it is the reason this
 * runner can still be the literal command the criterion pins (`node run-savings.mjs`)
 * instead of a wrapped one. The handler is shaped like the copy in
 * `experiments/voice-vad/run.mjs`: the alias prefix is stripped and the remainder is
 * joined onto the source root with a `.ts` extension.
 *
 * The depth is two levels (`../../src/`) because this file sits in
 * `experiments/voice-trim/`. `experiments/voice-vad/run.mjs` writes a single `../src/`,
 * which resolves to the nonexistent `experiments/src/` — a latent bug there (its own
 * criterion never loads the batch module), so it is not copied here. The same fix, same
 * depth, already lives in the sibling `experiments/voice-trim/run-quality.mjs`.
 */
const SRC_ROOT = fileURLToPath(new URL('../../src/', HERE));
const aliasHook = {
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(join(SRC_ROOT, specifier.slice(2)) + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
};
registerHooks(aliasHook);

// ESM resolves a module's *static* specifiers before its own body runs, so a hook
// registered here can only cover `voiceTrim.ts` if that module is imported *after* the
// registration — which static imports cannot express. The shipping import is therefore
// dynamic, awaited at the top level (legal in an `.mjs` module) and placed strictly below
// `registerHooks`. Without the hook this same import throws
// `ERR_MODULE_NOT_FOUND: Cannot find package '@/shared'`, which is exactly the failure
// this runner was restored to avoid.
const { PAUSE_CAPS, trimVoiceAudio } = await import('../../src/shared/voiceTrim.ts');

/** The aggregate the AC pins; see `## AC` in the task. */
const MIN_AGGREGATE_SAVED_RATIO = 0.15;

/** Tier order, densest occupancy first, so the monotonicity claim reads off the rows. */
const TIERS = ['o85', 'o65', 'o45'];

/** How much of each detected region the `drops-speech` control keeps. */
const CONTROL_SPEECH_FRACTION = 0.9;

/** Pre/post-roll the `speech-too-wide` control passes, in ms. Wide enough that
 *  every frame lands inside some region: that is what "the detector called the
 *  silence speech too" looks like through this module's public surface. */
const CONTROL_WIDE_ROLL_MS = 60000;

/** The rate the `refuses` control passes. Below the module's floor, so it falls back. */
const CONTROL_UNSUPPORTED_RATE = 4000;

// ---------------------------------------------------------------------------
// WAV decoding. Not part of the algorithm: the module takes a Float32Array and
// the caller owns turning bytes into one. This is that caller, and nothing more.
// ---------------------------------------------------------------------------

/** Parse a RIFF/WAVE file into mono float samples in [-1, 1]. */
function decodeWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`not a RIFF file: ${path}`);

  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`missing fmt or data chunk: ${path}`);
  if (fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) {
    throw new Error(`expected 16-bit PCM, got format=${fmt.format} bits=${fmt.bits}: ${path}`);
  }

  const frames = data.length / (fmt.channels * 2);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      acc += data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    }
    samples[i] = acc / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples };
}

// ---------------------------------------------------------------------------
// Fixtures and corpus discovery.
// ---------------------------------------------------------------------------

/**
 * `zh-d11-o85.wav` -> `{ language: 'zh', clip: 'd11', occupancy: 'o85' }`, and
 * `d11-o85.wav` -> the same thing with no language. Both forms occur: the
 * in-repo fixtures carry the language, the out-of-tree corpus keeps it in the
 * directory name instead, and the tier has to be readable off either or the
 * corpus reading silently comes back with every tier blank.
 *
 * The occupancy tier is the design parameter the corpus was generated at — the
 * fraction of the clip that is speech — and it is the axis the monotonicity
 * assertion moves along. `null` for a name that does not carry one.
 */
function parseClipName(name) {
  const m = /^(?:([a-z]{2})-)?([a-z0-9]+)-(o\d{2})\.wav$/.exec(name);
  if (!m) return null;
  return { language: m[1] ?? null, clip: m[2], occupancy: m[3] };
}

/** Every `*.wav` in a directory, sorted so two runs print in the same order. */
function wavFilesIn(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.wav'))
    .sort();
}

// ---------------------------------------------------------------------------
// The implementations under measurement.
//
// Four of these five are controls — hypothetical implementations the assertions
// must be able to tell apart from a real trim. Each returns the same record
// shape, so the assertion battery cannot special-case the shipping one.
//
// A control reports the readings such an implementation would produce rather
// than materialising a buffer, because the assertions read numbers: `stats` and
// not `samples` is what this runner judges, and a control that returned a real
// buffer would only be testing the decode path over again. Where a control can
// reach its state through the module's own API it does — `speech-too-wide` and
// `refuses` call `trimVoiceAudio`; only `identity` and `drops-speech` stand in
// for an implementation that is not the module.
// ---------------------------------------------------------------------------

/** Project the module's stats onto the record shape the assertions read. */
function record(result, fallback) {
  return {
    inputSec: result.stats.inputSec,
    outputSec: result.stats.outputSec,
    savedRatio: result.stats.savedRatio,
    speechKeptRatio: result.stats.speechKeptRatio,
    fallbackCount: fallback ? 1 : 0,
  };
}

/**
 * Handing the buffer back untouched is exactly what a trimmer that measures
 * nothing returns, and it scores 0 savings while keeping 100% of the speech —
 * the two readings a lazy implementation gets for free.
 */
function identityControl(input) {
  return {
    inputSec: input.totalSec,
    outputSec: input.totalSec,
    savedRatio: 0,
    speechKeptRatio: 1,
    fallbackCount: 0,
  };
}

/**
 * The module's public surface, driven with a pre/post-roll so wide that every
 * frame lands inside a detected region — the state "this detector called the
 * silence speech too". It still runs the shipping algorithm; what it exercises is
 * the aggregate's sensitivity to a detector that keeps everything.
 */
function wideSpeechControl(input) {
  const result = trimVoiceAudio(input.samples, input.sampleRate, {
    preRollMs: CONTROL_WIDE_ROLL_MS,
    postRollMs: CONTROL_WIDE_ROLL_MS,
  });
  return record(result, result.stats.fallback);
}

/**
 * Trims like the shipping module, then keeps only a fraction of each region the
 * module itself reported. The point is the speech-loss reading: duration still
 * falls and the ordering across tiers still holds, so nothing except the
 * speech-kept assertion can see it.
 */
function dropsSpeechControl(input) {
  const stats = trimVoiceAudio(input.samples, input.sampleRate).stats;
  const regionSec = (s) => s.endSec - s.startSec;
  const allSpeechSec = stats.vadSegments.reduce((a, s) => a + regionSec(s), 0);
  const keptSpeechSec = allSpeechSec * CONTROL_SPEECH_FRACTION;
  const outputSec = stats.outputSec - (allSpeechSec - keptSpeechSec);
  return {
    inputSec: stats.inputSec,
    outputSec,
    savedRatio: stats.inputSec === 0 ? 0 : 1 - outputSec / stats.inputSec,
    speechKeptRatio: allSpeechSec === 0 ? 1 : keptSpeechSec / allSpeechSec,
    fallbackCount: 0,
  };
}

/**
 * An input the module must refuse: a rate below its floor, where trimming would
 * cut the audio at the wrong places. The module hands the buffer back untouched
 * and sets `fallback`, and the reading has to say so rather than quietly
 * counting the clip as a 0% saving.
 */
function refusesControl(input) {
  const result = trimVoiceAudio(input.samples, CONTROL_UNSUPPORTED_RATE);
  return record(result, result.stats.fallback);
}

const IMPLEMENTATIONS = [
  {
    name: 'shipping',
    note: 'src/shared/voiceTrim.ts, imported',
    run: (input) => {
      const result = trimVoiceAudio(input.samples, input.sampleRate);
      return record(result, result.stats.fallback);
    },
    mustFail: [],
  },
  {
    name: 'identity',
    note: 'no trim at all (savedRatio 0)',
    run: identityControl,
    mustFail: ['perClipDecrease', 'monotonicity', 'aggregate'],
  },
  {
    // `monotonicity` is deliberately not required of this one. Widening the roll
    // adds a fixed 0.35 s to every clip, so what orders the tiers here is clip
    // duration — and denser clips are shorter, so the ordering survives an
    // implementation that trims nothing. Requiring it would demand that a
    // criterion fire on a control it has no reason to see; `identity`, where the
    // three tier means are all exactly 0, is the control that holds this
    // assertion honest.
    name: 'speech-too-wide',
    note: `pre/post-roll ${CONTROL_WIDE_ROLL_MS} ms`,
    run: wideSpeechControl,
    mustFail: ['perClipDecrease', 'aggregate'],
  },
  {
    name: 'drops-speech',
    note: `keeps ${CONTROL_SPEECH_FRACTION} of each detected region`,
    run: dropsSpeechControl,
    mustFail: ['speechKeptRatio'],
  },
  {
    name: 'refuses',
    note: `${CONTROL_UNSUPPORTED_RATE} Hz input (fallback)`,
    run: refusesControl,
    mustFail: ['perClipDecrease', 'aggregate', 'noFallback'],
  },
];

// ---------------------------------------------------------------------------
// The assertion battery.
//
// Each assertion takes one implementation's aggregate and returns a failure
// reason, or null when it holds. The reason carries the numbers, because the
// gate that reads this reads stderr first and a bare "false" is not a diagnosis.
// Every assertion is named, so the control matrix below can require that a
// specific control fails a specific assertion by name.
// ---------------------------------------------------------------------------

const ASSERTIONS = [
  {
    name: 'perClipDecrease',
    run: (agg) => {
      const grown = agg.clips.filter((c) => !(c.outputSec < c.inputSec));
      if (!grown.length) return null;
      const shown = grown
        .map((c) => `${c.name} in=${c.inputSec.toFixed(3)} out=${c.outputSec.toFixed(3)}`)
        .join(', ');
      return `${grown.length}/${agg.clips.length} clip(s) did not shorten: ${shown}`;
    },
  },
  {
    name: 'monotonicity',
    run: (agg) => {
      const means = TIERS.map((t) => agg.tierMean[t]);
      for (let i = 0; i + 1 < TIERS.length; i++) {
        if (!(means[i + 1] > means[i])) {
          const all = TIERS.map((t, k) => `${t}=${means[k].toFixed(4)}`).join(' ');
          return `expected savedRatio(${TIERS[i + 1]}) > savedRatio(${TIERS[i]}), got ${all}`;
        }
      }
      return null;
    },
  },
  {
    name: 'aggregate',
    run: (agg) => {
      if (agg.aggregate >= MIN_AGGREGATE_SAVED_RATIO) return null;
      return (
        `aggregate savedRatio ${agg.aggregate.toFixed(4)} < ${MIN_AGGREGATE_SAVED_RATIO} ` +
        `(clips=${agg.clips.length}, totalIn=${agg.totalInputSec.toFixed(2)}s)`
      );
    },
  },
  {
    name: 'speechKeptRatio',
    run: (agg) => {
      const lost = agg.clips.filter((c) => c.speechKeptRatio !== 1);
      if (!lost.length) return null;
      const shown = lost.map((c) => `${c.name} kept=${c.speechKeptRatio}`).join(', ');
      return `${lost.length} clip(s) lost speech: ${shown}`;
    },
  },
  {
    name: 'noFallback',
    run: (agg) => {
      if (agg.fallbacks === 0) return null;
      return `fallbacks=${agg.fallbacks}/${agg.clips.length} — the module refused to trim`;
    },
  },
];

/** Run one implementation over every clip and fold the records into an aggregate. */
function measure(implementation, clips) {
  const rows = clips.map((clip) => ({
    name: clip.name,
    occupancy: clip.occupancy,
    language: clip.language,
    ...implementation.run(clip),
  }));

  const totalInputSec = rows.reduce((a, r) => a + r.inputSec, 0);
  const totalOutputSec = rows.reduce((a, r) => a + r.outputSec, 0);
  const tierMean = {};
  for (const tier of TIERS) {
    const inTier = rows.filter((r) => r.occupancy === tier);
    tierMean[tier] = inTier.length
      ? inTier.reduce((a, r) => a + r.savedRatio, 0) / inTier.length
      : Number.NaN;
  }

  return {
    name: implementation.name,
    note: implementation.note,
    clips: rows,
    totalInputSec,
    totalOutputSec,
    aggregate: totalInputSec === 0 ? 0 : 1 - totalOutputSec / totalInputSec,
    tierMean,
    fallbacks: rows.reduce((a, r) => a + r.fallbackCount, 0),
  };
}

// ---------------------------------------------------------------------------
// Uniqueness: is this harness measuring the module, or a second copy of it?
//
// Static, derived from the shipping module's own source and exports — no list of
// forbidden words is written down here, because a hand-written list is exactly
// the thing that goes stale. Three checks, each of which a copy trips:
//
//   imports  a second algorithm needs a module to live in (the out-of-tree
//            layout that drifted was a vad module plus a compress module).
//            Importing the *shipping* tree is not that — it is the thing this
//            check exists to require — so the rule is written as the tree.
//   names    a copy keeps the names, unless someone renames every one
//   table    the frozen pause table is the module's decision, and a copy of the
//            algorithm carries it
//
// Scope, stated so a green line is not read as more than it is: this proves the
// harness neither imports nor declares a second detector. "The harness" is the
// directory, not this file — a copy is no less a copy for living in the file
// next door, and a scan that only reads itself reports a clean harness while
// having measured one file. It cannot prove the absence of an arbitrarily
// rewritten one, and it does not try. The canary below is what keeps the checks
// honest — it runs each check over a source that violates it, and the run fails
// if the check does not fire.
//
// `declaredNames` anchors at the line start, so it reads the first word of a
// line and not a name quoted inside a string. That precision is deliberate and
// it is not the only reader of these files: the suite greps the same directory
// for a declaration of the module's names without anchoring, and therefore also
// reports a declaration-shaped literal. Both readers have to come back clean,
// which is why the canary takes its name from the module rather than writing
// one down here.
// ---------------------------------------------------------------------------

/** Top-level bindings the shipping module declares. */
function shippingTopLevelNames(src) {
  const re = /^(?:export\s+)?(?:const|let|var|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/gm;
  return new Set([...src.matchAll(re)].map((m) => m[1]));
}

/** Top-level bindings a source declares. Sibling of the above, minus the type forms. */
function declaredNames(src) {
  const re = /^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  return new Set([...src.matchAll(re)].map((m) => m[1]));
}

/** Module specifiers a source imports from. */
function importedFrom(src) {
  return [...src.matchAll(/^[ \t]*import\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

/**
 * Does this specifier name a file in the shipping source tree?
 *
 * A harness is *supposed* to import shipping code — "measures the module, not a
 * copy of it" means the shipped file is the thing under test — so this rule is
 * written as the tree (`src/`, and the `@/` alias the frontend maps to it, both
 * spelled with the explicit `.ts` that these harnesses need under plain `node`)
 * rather than as a list of file names. An extensionless specifier is not one
 * these harnesses could load, so it is not read as shipping either.
 *
 * The list was the bug. It named one shipping file, so a sibling harness that
 * imported a *different* shipping module — `run-quality.mjs` importing
 * `src/shared/identifierFidelity.ts`, which is precisely the behaviour this
 * check wants — read as "imports a second implementation" and held AC-117 red
 * from 2026-09-21T15:59Z until this function replaced it. Anything that stays
 * outside the shipping tree (`./vad.mjs`, a vendored detector, a module the
 * harness brought with it) is still a violation, and the `imports` canary below
 * is exactly such a specifier — so the check is still shown to fire.
 *
 * `src/shared/tests/` is not shipping: a test carries fixtures and copies, which
 * is the thing being looked for.
 */
function isShippingSource(specifier) {
  // Both spellings of the shipping tree, both spellings of the tests inside it:
  // relative paths through `src/`, and the `@` alias the frontend maps there.
  const shipping = /(^|\/)src\//.test(specifier) || specifier.startsWith('@/');
  const isTest = /(^|\/)(src|@)\/shared\/tests\//.test(specifier);
  return shipping && !isTest && specifier.endsWith('.ts');
}

/** Every run of numbers a source writes inside square brackets. */
function bracketedNumbers(src) {
  const out = [];
  for (const m of src.matchAll(/\[([^[\]]*)\]/g)) {
    const nums = [...m[1].matchAll(/-?\d+(?:\.\d+)?/g)].map((n) => Number(n[0]));
    if (nums.length) out.push(nums);
  }
  return out;
}

/** The values the frozen pause table is made of, read off the module's own export. */
function pauseTableValues() {
  const values = new Set();
  for (const row of PAUSE_CAPS) {
    for (const v of [row.belowSec, row.keepSec]) {
      if (typeof v === 'number' && Number.isFinite(v)) values.add(v);
    }
  }
  return values;
}

/**
 * The three checks, as one function of a source string — so the canary and the
 * real harness go through the identical code path. The caller prints how many
 * things were looked at beside the verdict: a clean result from a scan that saw
 * nothing is not a result.
 */
function uniquenessViolations(src, shippingNames) {
  const violations = [];

  const stray = importedFrom(src).filter((s) => !s.startsWith('node:') && !isShippingSource(s));
  if (stray.length) violations.push(`imports a second implementation from: ${stray.join(', ')}`);

  const collisions = [...declaredNames(src)].filter((n) => shippingNames.has(n));
  if (collisions.length) violations.push(`declares the module's own top-level names: ${collisions.join(', ')}`);

  const table = pauseTableValues();
  for (const nums of bracketedNumbers(src)) {
    const shared = nums.filter((n) => table.has(n));
    if (shared.length >= 2) violations.push(`carries the frozen pause table: [${nums.join(', ')}]`);
  }

  return violations;
}

/**
 * Sources that violate one check each, run through the same scanner — so that a
 * clean reading of this file is a reading from a scanner that has been shown to
 * fire, rather than one that simply matched nothing.
 *
 * The `names` case declares one of the shipping module's own top-level names,
 * and reads that name *from the module* instead of spelling one out in this
 * file. Derived for the same reason the three checks are: a name written down
 * here is a name that has to be rewritten here whenever the module renames it.
 * It also keeps the canary legible to the source-text greps that read this file
 * from elsewhere in the suite — those search for a declaration of one of the
 * module's names and anchor on nothing, so a declaration-shaped string literal
 * in this file is reported as a copy of the algorithm. This scanner anchors at
 * the line start and can tell the two apart; a looser grep cannot, and the
 * harness should not have to be the thing that teaches it the difference.
 */
function uniquenessCanaries(shippingNames) {
  const [aShippingName] = shippingNames;
  return [
    { check: 'imports', src: "import { speechSegments } from './vad.mjs';\n" },
    { check: 'names', src: `const ${aShippingName} = 0;\n` },
    { check: 'table', src: `const caps = [${[...pauseTableValues()].join(', ')}];\n` },
  ];
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const fixed = (v, n) => v.toFixed(n);

function printAggregate(agg) {
  console.log(
    `\n  ${pad(agg.name, 16)} ${agg.note}\n` +
      `    aggregate=${fixed(agg.aggregate, 4)}  ` +
      TIERS.map((t) => `${t}=${fixed(agg.tierMean[t], 4)}`).join('  ') +
      `  fallbacks=${agg.fallbacks}`,
  );
  for (const clip of agg.clips) {
    console.log(
      `      ${pad(clip.name, 24)} ${fixed(clip.inputSec, 3).padStart(7)}s -> ` +
        `${fixed(clip.outputSec, 3).padStart(7)}s  savedRatio=${fixed(clip.savedRatio, 4)}  ` +
        `speechKeptRatio=${clip.speechKeptRatio}`,
    );
  }
}

/** `NaN` for a tier the corpus does not have — printed as a dash, never as a number. */
const tierText = (agg, tier) => (Number.isFinite(agg.tierMean[tier]) ? fixed(agg.tierMean[tier], 4) : '-');

function printCorpus(corpus, fixtures) {
  for (const clip of corpus.clips) {
    console.log(
      `    ${pad(clip.name, 32)} ${pad(clip.occupancy ?? '-', 5)} ` +
        `${fixed(clip.inputSec, 2).padStart(7)}s savedRatio=${fixed(clip.savedRatio, 4)}`,
    );
  }
  console.log(
    `    ${pad('ALL', 32)} ${pad('', 5)} aggregate=${fixed(corpus.aggregate, 4)}  ` +
      TIERS.map((t) => `${t}=${tierText(corpus, t)}`).join('  ') +
      `  fallbacks=${corpus.fallbacks}`,
  );
  console.log(
    `    ladder vs corpus: ` +
      TIERS.map((t) => {
        const ladder = fixtures.tierMean[t];
        const wide = corpus.tierMean[t];
        if (!Number.isFinite(ladder) || !Number.isFinite(wide)) return `${t}: -`;
        return `${t} ${fixed(ladder, 4)} vs ${fixed(wide, 4)} (${(ladder - wide >= 0 ? '+' : '') + (ladder - wide).toFixed(4)})`;
      }).join('  '),
  );
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function loadFixtures() {
  const dir = fileURLToPath(FIXTURE_DIR);
  const clips = [];
  for (const file of wavFilesIn(dir)) {
    const parsed = parseClipName(file);
    if (!parsed) throw new Error(`fixture name does not carry a tier: ${file}`);
    const { sampleRate, samples } = decodeWav(`${dir}/${file}`);
    clips.push({ name: file, ...parsed, totalSec: samples.length / sampleRate, sampleRate, samples });
  }
  if (!clips.length) throw new Error(`no fixtures in ${dir}`);
  return clips;
}

/**
 * The out-of-tree corpus, when the caller points at it. Readings only: the
 * thresholds above stay pinned to the in-repo fixtures, so a corpus that is
 * absent on another machine cannot change the verdict.
 */
function loadCorpus(root) {
  const dirs = [];
  for (const candidate of [`${root}/dictation`, `${root}/dictation-en`]) {
    try {
      if (readdirSync(candidate).length) dirs.push(candidate);
    } catch {
      /* not that layout; fall through to the root itself */
    }
  }
  if (!dirs.length) dirs.push(root);

  const clips = [];
  for (const dir of dirs) {
    for (const file of wavFilesIn(dir)) {
      const parsed = parseClipName(file);
      const { sampleRate, samples } = decodeWav(`${dir}/${file}`);
      clips.push({
        name: `${dir === root ? '' : `${dir.slice(root.length + 1)}/`}${file}`,
        language: parsed?.language ?? null,
        occupancy: parsed?.occupancy ?? null,
        totalSec: samples.length / sampleRate,
        sampleRate,
        samples,
      });
    }
  }
  return clips;
}

function main() {
  const failures = [];
  const clips = loadFixtures();
  const moduleSrc = readFileSync(fileURLToPath(MODULE_URL), 'utf8');
  const shippingNames = shippingTopLevelNames(moduleSrc);

  console.log('voice-trim savings — measured on src/shared/voiceTrim.ts');
  console.log(
    `fixtures: ${clips.length} clips, ${clips.reduce((a, c) => a + c.totalSec, 0).toFixed(1)}s total; ` +
      'curated ladder (see the header) — unbiased tier means need VOICE_TRIM_CORPUS',
  );

  // 1. Every implementation, over the same fixtures, through the same battery.
  const results = new Map();
  for (const impl of IMPLEMENTATIONS) {
    const agg = measure(impl, clips);
    results.set(impl.name, agg);
    printAggregate(agg);
  }

  const shipping = results.get('shipping');

  // 2. The battery on the shipping module. These are the criteria.
  console.log('\nassertions on shipping:');
  for (const assertion of ASSERTIONS) {
    const reason = assertion.run(shipping);
    console.log(`  ${reason ? 'FAIL' : 'ok  '} ${assertion.name}${reason ? ` — ${reason}` : ''}`);
    if (reason) failures.push(`[shipping] ${assertion.name}: ${reason}`);
  }

  // 3. The battery on every control. An assertion a control passes is an
  //    assertion that cannot see that control, so it is reported as a failure of
  //    the criterion rather than a pass of the control.
  console.log('\ncontrols (each must fail the assertions it simulates):');
  for (const impl of IMPLEMENTATIONS.filter((i) => i.mustFail.length)) {
    const agg = results.get(impl.name);
    const red = ASSERTIONS.filter((a) => a.run(agg)).map((a) => a.name);
    const missed = impl.mustFail.filter((n) => !red.includes(n));
    console.log(
      `  ${missed.length ? 'VACUOUS' : 'ok     '} ${pad(impl.name, 16)} ${impl.note} — ` +
        `red on [${red.join(', ') || 'nothing'}]`,
    );
    if (missed.length) {
      failures.push(
        `[control ${impl.name}] assertions that cannot see it: ${missed.join(', ')} — ` +
          'a criterion no control can fail is not measuring anything',
      );
    }
  }

  // 4. Uniqueness. The canary first: if the scanner cannot fire, its silence on
  //    the harness means nothing.
  console.log('\nuniqueness (the harness must measure the module, not a second copy of it):');
  const canaries = uniquenessCanaries(shippingNames);
  const canariesFired = canaries.filter((c) => uniquenessViolations(c.src, shippingNames).length);
  console.log(
    `  canary=${canariesFired.length === canaries.length ? 'RED' : 'GREEN'} ` +
      `${canariesFired.length}/${canaries.length} injected copies detected`,
  );
  if (canariesFired.length !== canaries.length) {
    failures.push(
      `[uniqueness] canary not detected (${canariesFired.length}/${canaries.length}) — ` +
        'the scanner is blind, so a clean harness reading is worthless',
    );
  }

  // Every file the harness ships, this one included. The `fixtures/` subtree is
  // not walked — it is audio, and both this scanner and the suite's grep stop at
  // the same edge, so neither can be read as covering more than the other.
  const harnessDir = fileURLToPath(HERE);
  const harnessFiles = readdirSync(harnessDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const violations = [];
  let imports = 0;
  let declarations = 0;
  for (const file of harnessFiles) {
    const src = readFileSync(`${harnessDir}${file}`, 'utf8');
    imports += importedFrom(src).length;
    declarations += declaredNames(src).size;
    for (const violation of uniquenessViolations(src, shippingNames)) {
      violations.push(`${file}: ${violation}`);
    }
  }
  console.log(
    `  harness=${violations.length ? 'RED' : 'GREEN'} checked: ` +
      `${harnessFiles.length} file(s), ${imports} import(s), ${declarations} declaration(s), ` +
      `${shippingNames.size} module name(s), ${pauseTableValues().size} pause-table value(s)`,
  );
  for (const violation of violations) {
    console.log(`    - ${violation}`);
    failures.push(`[uniqueness] ${violation}`);
  }

  // 5. Optional: the out-of-tree corpus, readings only.
  const corpusRoot = process.env.VOICE_TRIM_CORPUS;
  if (!corpusRoot) {
    console.log('\nfull corpus: skipped (set VOICE_TRIM_CORPUS=<dir> for the out-of-tree readings)');
  } else {
    try {
      const corpusClips = loadCorpus(corpusRoot.replace(/\/+$/, ''));
      if (!corpusClips.length) throw new Error('no .wav files found');
      console.log(`\nfull corpus (VOICE_TRIM_CORPUS=${corpusRoot}) — readings, not thresholds:`);
      printCorpus(measure(IMPLEMENTATIONS[0], corpusClips), shipping);
    } catch (err) {
      failures.push(`[corpus] VOICE_TRIM_CORPUS=${corpusRoot} could not be read: ${err.message}`);
    }
  }

  if (failures.length) {
    process.stderr.write(`\nvoice-trim savings: ${failures.length} failure(s)\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.exit(1);
  }
  console.log(
    `\nvoice-trim savings: OK — aggregate ${fixed(shipping.aggregate, 4)} >= ${MIN_AGGREGATE_SAVED_RATIO}`,
  );
}

main();
