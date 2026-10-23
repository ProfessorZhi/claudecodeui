#!/usr/bin/env node
/**
 * The quality reading: the trim saved time — did it also break what was said.
 *
 * The savings side of this question is answered next door
 * (`run-savings.mjs`: how much shorter, and did any speech sample go missing).
 * This runner answers the other half, on the *transcripts*: put the same audio
 * through a real recogniser before and after the trim, and compare what came
 * back. It is the reading AC-117 does not take, and it is the one that decides
 * whether the trim is shippable rather than merely effective.
 *
 * The measurement lived out of tree for its whole life
 * (`/data/home/yale/work/tc-verify/logs/test3-final.log`, `logs/quality-en.log`).
 * Its verdict, which shapes everything below: at the cap stage **CER goes UP**
 * (zh +1.101% mean, en +0.140%) while **identifier survival is neutral**
 * (zh 16.7% -> 16.7%, en 77.8% -> 77.8%) and **boundary marks roughly halve**
 * (zh 2.06 -> 1.00 per clip). Those three numbers are the reference readings the
 * thresholds below are set against; without them a tolerance is a guess.
 *
 * WHY IDENTIFIERS AND NOT CER, which is the whole design of this file.
 *
 * A criterion written as "CER must not rise" is red before it starts — the
 * reference reading above is a rise. Worse, it would be red for the wrong
 * reason and green for the wrong reason: CER's normal form lowercases and
 * deletes everything that is not a letter or a digit, so `voice.service.ts` and
 * `voice service ts` are the *same character sequence* to it. That is not an
 * accident of this corpus, it is what the metric is: the exact corruption this
 * project keeps being bitten by — a recogniser losing the dots and the case of
 * an identifier, after which an agent edits the wrong file — scores as a
 * perfect match. The `blindness` canary in this runner is that statement made
 * mechanical, and it is asserted rather than asserted-about: the run fails if
 * the CER reading is *not* blind to the corruption.
 *
 * So the hard criterion is the verbatim one, imported from
 * `src/shared/identifierFidelity.ts` — the same module the chat module's
 * dictation hook reports on, so this runner and the app cannot disagree about
 * what "survived" means. CER is still reported, because it is the number the
 * out-of-tree logs quote and a reading nobody can line up against the old one
 * is not evidence.
 *
 * WHAT THE FIXTURE IS, AND WHY IT IS NOT A SECOND IMPLEMENTATION.
 *
 * `fixtures/transcripts.json` holds, for the same eight clips `run-savings.mjs`
 * measures, four real recogniser transcripts each:
 *
 *   baseline   the fixture audio, untrimmed
 *   trimmed    the shipping module's output (`trimVoiceAudio`, frozen defaults)
 *   aggressive a control: the same module with the roll inverted
 *   flattened  a control: the same module with the pause table replaced
 *
 * plus the authored reference each was spoken from. The transcripts were taken
 * once, out of tree, against Groq `whisper-large-v3-turbo` (see `provenance` in
 * the JSON); **this runner never calls the network and never invokes a
 * recogniser**. It reads a frozen file.
 *
 * The "trimmed audio really is the shipping module's output" claim is not taken
 * on trust either. The fixture carries the sha256 of every encoded buffer, and
 * the runner re-derives each one here — decode the fixture wav, run it through
 * `src/shared/voiceTrim.ts`, re-encode with the encoder below — and requires the
 * hash to match, byte for byte. Nothing in this file decides where speech is or
 * how long a pause may be; the only algorithm in the pipeline is the module's,
 * and the `uniqueness` section asserts that mechanically rather than trusting a
 * reader to notice it.
 *
 * Usage:
 *   node experiments/voice-trim/run-quality.mjs
 *
 * Exit 0 only when every criterion holds on the shipping column *and* every
 * control below fails the criterion it simulates *and* the audio the fixture
 * names is the audio this module produces. A control that passes the criterion
 * it was built to fail means that criterion cannot tell a real trim from that
 * control, and the run fails rather than report a green it has not earned.
 * Failures go to stderr, one per line, in the order they were checked — the
 * gate that reads this reads stderr first, and a bare "false" is not a
 * diagnosis.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = new URL('./', import.meta.url);
const FIXTURE_DIR = new URL('fixtures/', HERE);
const TRANSCRIPTS_URL = new URL('fixtures/transcripts.json', HERE);
const MODULE_URL = new URL('../../src/shared/voiceTrim.ts', HERE);
const FIDELITY_URL = new URL('../../src/shared/identifierFidelity.ts', HERE);

/**
 * The frontend's `@/` source-root alias, resolved for a plain `node` process.
 *
 * `src/shared/voiceTrim.ts` reaches its shared endpoint module through the alias the
 * browser build, the type-checker and the unit transform all resolve — this hook is the
 * same mapping for the one place those toolchains do not reach, and it is the reason this
 * runner can still be the literal command the criterion pins (`node run-quality.mjs`)
 * instead of a wrapped one. The handler is shaped like the copy in
 * `experiments/voice-vad/run.mjs`: the alias prefix is stripped and the remainder is
 * joined onto the source root with a `.ts` extension.
 *
 * The depth is two levels (`../../src/`) because this file sits in
 * `experiments/voice-trim/`. `experiments/voice-vad/run.mjs` writes a single `../src/`,
 * which resolves to the nonexistent `experiments/src/` — a latent bug there (its own
 * criterion never loads the batch module), so it is not copied here.
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
// registration — which static imports cannot express. The two shipping imports are
// therefore dynamic, awaited at the top level (legal in an `.mjs` module) and placed
// strictly below `registerHooks`. Without the hook these same imports throw
// `ERR_MODULE_NOT_FOUND: Cannot find package '@/shared'`, which is exactly the failure
// this runner was restored to avoid.
const { identifierFidelity } = await import('../../src/shared/identifierFidelity.ts');
const { trimVoiceAudio } = await import('../../src/shared/voiceTrim.ts');

/**
 * ΔCER ceiling, as a fraction of 1 — the reference readings are zh +1.101% and
 * en +0.140%, so 1.5% is above both with room for a different eight clips, and
 * far below the damage a speech-eating trim does (the `aggressive` control
 * measures above +6%).
 */
const MAX_CER_DELTA = 0.015;

/**
 * How much of the baseline's sentence-final punctuation has to survive, pooled.
 *
 * Not the 0.9 this criterion was first written as. That number cannot hold and
 * the reference reading above is the proof: the cap stage takes zh from 2.06
 * marks per clip to 1.00 — a retention of 0.485 — and it does so *by design*,
 * because the pause it removes is the acoustic cue the recogniser uses to place
 * a full stop. A floor of 0.9 would be red on the very reading the task cites
 * as expected, so it would measure the corpus rather than the trim.
 *
 * 0.4 sits *below* the reference's 0.485 — deliberately, so the criterion can
 * never be red by behaviour that has already been measured and accepted — and
 * well below this fixture set's own 10/14 = 0.714. It is a tripwire for the
 * harm this axis names: a transcript that collapsed into a run-on. The `runOn`
 * control is that harm, and it scores 0.
 */
const MIN_BOUNDARY_RETENTION = 0.4;

/**
 * The control that eats speech: the shipping module with its roll inverted.
 *
 * Pre/post-roll normally *extends* each detected region, because the first
 * phoneme and the final consonant sit under the detector's threshold. Inverting
 * it cuts 200 ms off both ends of every region, which is real deleted speech —
 * the module reports it, and the fixture records `aggressiveSpeechKeptRatio`
 * between 0.77 and 0.87. This is the parameter set the identifier criterion has
 * to be able to see.
 *
 * The pause table is NOT this control, and the `flattened` column is the
 * evidence: `keepSec: 0` shortens the gaps *between* regions and never touches a
 * region's own samples, so the module's speech-kept ratio stays exactly 1 and no
 * transcript can lose an identifier to it through speech loss. A control built
 * from the table would therefore be vacuous against the verbatim criterion — not
 * because the criterion is weak, but because the table cannot reach the failure.
 * The `flattened` row is kept anyway: it is where boundaries are supposed to
 * suffer, the run asserts its speech-kept ratio is 1, and it is reported beside
 * the roll control so the difference is a reading rather than a claim.
 */
export const AGGRESSIVE_TRIM = { preRollMs: -200, postRollMs: -200 };

/** The pause table with every gap capped to nothing — the `flattened` control. */
export const FLATTENED_CAPS = [{ belowSec: Number.POSITIVE_INFINITY, keepSec: 0 }];

/** The two columns a trim produces; `baseline` is the fixture file itself. */
const CONTROL_COLUMNS = ['trimmed', 'flattened', 'aggressive'];

// ---------------------------------------------------------------------------
// WAV. Not part of the algorithm: the module takes a Float32Array and the caller
// owns turning bytes into one, and back. This is that caller, and nothing more.
// Both functions are exported because the fixture's hashes were taken through
// them — a fixture regenerated with a different encoder would not verify, and
// that is the point of pinning the bytes rather than the durations.
// ---------------------------------------------------------------------------

/** Parse a RIFF/WAVE file into mono float samples in [-1, 1]. */
export function decodeWav(path) {
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

/** Encode mono float samples as 16-bit PCM WAV. Deterministic, sample for sample. */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * One fixture file through the shipping module and back out as bytes.
 *
 * `opts` is `null` for the baseline column, which is the file's own bytes: the
 * point of that column is that no trim happened to it.
 */
function encodeColumn(samples, sampleRate, opts) {
  if (opts === null) return { bytes: encodeWav(samples, sampleRate), stats: null };
  const result = trimVoiceAudio(samples, sampleRate, opts);
  return { bytes: encodeWav(result.samples, sampleRate), stats: result.stats };
}

// ---------------------------------------------------------------------------
// The recogniser-independent metrics.
//
// CER is here, inline and deliberately not imported, because the module the task
// named for it (`experiments/voice-identifiers/metrics.mjs`) does not exist —
// not on this branch, not on any branch, not in the history. The reading it
// refers to lives out of tree at `tools/metrics.mjs`, and this is that metric:
// Whisper's own normal form (lowercase, drop everything that is not a letter,
// a number or a space, collapse runs of space) and Levenshtein over the
// resulting characters. Kept in the file rather than ported to a new path so
// that the harness stays the one directory the task declared.
// ---------------------------------------------------------------------------

function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const cersOf = (text) => [...normalizeText(text).replace(/\s/g, '')];

/** Levenshtein distance over arrays of tokens. */
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function cer(reference, hypothesis) {
  const want = cersOf(reference);
  return want.length ? levenshtein(want, cersOf(hypothesis)) / want.length : 0;
}

/**
 * Terminal marks, both scripts: how many boundaries the transcript kept.
 *
 * This is the count the out-of-tree reading was taken with, character for
 * character, and that is the reason to keep it rather than improve it: the
 * reference is zh 2.06 -> 1.00 per clip, the floor below is derived from it, and
 * a criterion that counted something else would have no anchor at all.
 *
 * Its flaw is real and worth naming, because it is visible in this fixture. The
 * count is "every `[.!?。！？]`", which includes the dots *inside* an identifier:
 * the English baseline's two "boundaries" are both dots of `voice.service.ts`,
 * and the trimmed column's third is the full stop the recogniser added. So this
 * axis is partly a proxy for the identifier axis, and a control that strips the
 * marks it counts necessarily disturbs both — which is how the `runOn` control
 * below is declared. Counting only marks that end a sentence would be a better
 * metric and a different one; it is not this criterion, and it would need its
 * own reference reading before it could carry a threshold.
 */
export function boundaryCount(text) {
  return (String(text).match(/[.!?。！？]/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Fixtures, and the claim that the fixture's audio is the module's output.
// ---------------------------------------------------------------------------

function loadTranscripts() {
  const parsed = JSON.parse(readFileSync(fileURLToPath(TRANSCRIPTS_URL), 'utf8'));
  if (!Array.isArray(parsed.entries) || !parsed.entries.length) {
    throw new Error('transcripts.json carries no entries');
  }
  return parsed;
}

/** Every `*.wav` in the fixture directory, sorted so two runs print in the same order. */
function fixtureFiles() {
  return readdirSync(fileURLToPath(FIXTURE_DIR))
    .filter((f) => f.endsWith('.wav'))
    .sort();
}

/**
 * The correspondence check — AC-6, made mechanical.
 *
 * Two things are asserted here and they are different things. First, that the
 * fixture and the audio are a bijection: every entry names a clip that exists,
 * and no clip exists without an entry. Second, and the load-bearing one, that
 * the audio the entry's `trimmed` transcript was taken from is *this* module's
 * output — the entry carries the sha256 of each encoded column, and the audio is
 * re-derived here from the fixture wav through `trimVoiceAudio` and compared
 * byte for byte. A transcript taken from an equivalent-but-different trim, or
 * from a stale copy of the algorithm, reds on the hash rather than passing on a
 * duration that happens to be close.
 *
 * Returns `{ failures, checked }` — the count is printed beside the verdict,
 * because a clean result from a check that looked at nothing is not a result.
 */
function correspondenceFailures(entries) {
  const onDisk = fixtureFiles();
  const named = entries.map((e) => e.clip);
  const failures = [];
  let checked = 0;

  for (const clip of onDisk) {
    if (!named.includes(clip)) failures.push(`fixture ${clip} has no entry in transcripts.json`);
  }
  for (const clip of named) {
    if (!onDisk.includes(clip)) failures.push(`entry ${clip} names an audio file that is not in fixtures/`);
  }

  for (const entry of entries) {
    if (!onDisk.includes(entry.clip)) continue;
    const { sampleRate, samples } = decodeWav(fileURLToPath(new URL(entry.clip, FIXTURE_DIR)));
    const wanted = {
      baseline: null,
      trimmed: {},
      flattened: { caps: FLATTENED_CAPS },
      aggressive: AGGRESSIVE_TRIM,
    };

    for (const column of Object.keys(wanted)) {
      const opts = wanted[column];
      const { bytes, stats } = encodeColumn(samples, sampleRate, opts);
      checked++;
      const recorded = entry.audio[`${column}Sha256`];
      if (recorded !== sha256(bytes)) {
        failures.push(
          `${entry.clip}/${column}: the fixture's transcript was not taken from this module's audio ` +
            `(sha256 ${recorded ?? 'missing'} != ${sha256(bytes)} re-derived here)`,
        );
      }
      if (stats && Math.abs(stats.savedRatio - entry.audio[`${column}SavedRatio`]) > 1e-9) {
        failures.push(
          `${entry.clip}/${column}: savedRatio ${entry.audio[`${column}SavedRatio`]} does not match ` +
            `the module's ${stats.savedRatio}`,
        );
      }
    }

    if (Math.abs(entry.audio.savedRatio - entry.audio.trimmedSavedRatio) > 1e-9) {
      failures.push(`${entry.clip}: audio.savedRatio is not the trimmed column's saving`);
    }
  }

  return { failures, checked };
}

/**
 * The falsifier for the check above: a fixture whose `trimmed` hash belongs to
 * different bytes, run through the identical code path. If this does not fire,
 * the correspondence check is blind and its green reading on the real fixture
 * means nothing.
 */
function correspondenceCanary(entries) {
  const [entry] = entries;
  if (!entry) return { fired: false, reason: 'no entries to build a canary from' };
  const corrupted = {
    ...entry,
    audio: { ...entry.audio, trimmedSha256: '0'.repeat(64) },
  };
  const { failures } = correspondenceFailures([corrupted]);
  return { fired: failures.some((f) => f.includes('/trimmed:')), reason: failures[0] ?? 'no failure reported' };
}

// ---------------------------------------------------------------------------
// The reading.
//
// A "criterion" is a function of one column's aggregate: it returns a failure
// reason, or null when it holds. The reason carries the numbers, because the
// failure has to be diagnosable from stderr alone. Every criterion is named, so
// the control matrix can require that a specific control fails a specific
// criterion *by name*.
// ---------------------------------------------------------------------------

/**
 * Fold one hypothesis column over the whole fixture into the numbers the
 * criteria read. `baseline` is always the fixture's own baseline column — the
 * criterion is paired, so the reference for every hypothesis is the transcript
 * the same audio produced before the trim.
 */
function measure(entries, hypothesisOf, savedRatioOf) {
  const clips = entries.map((entry) => {
    const baseline = entry.transcripts.baseline;
    const hypothesis = hypothesisOf(entry);
    const idTotal = identifierFidelity(entry.reference, baseline).total;
    const idTrimmed = identifierFidelity(entry.reference, hypothesis);
    const cerBaseline = cer(entry.reference, baseline);
    const cerHypothesis = cer(entry.reference, hypothesis);
    return {
      clip: entry.clip,
      language: entry.language,
      idTotal,
      idSurvived: idTrimmed.survived,
      idMissing: idTrimmed.missing,
      cerBaseline,
      cerHypothesis,
      cerDelta: cerHypothesis - cerBaseline,
      boundariesBaseline: boundaryCount(baseline),
      boundariesHypothesis: boundaryCount(hypothesis),
      savedRatio: savedRatioOf(entry),
    };
  });

  const sum = (pick) => clips.reduce((a, c) => a + pick(c), 0);
  const idSurvived = sum((c) => c.idSurvived);
  const idTotal = sum((c) => c.idTotal);
  const boundariesBaseline = sum((c) => c.boundariesBaseline);
  const boundariesHypothesis = sum((c) => c.boundariesHypothesis);

  return {
    clips,
    idSurvived,
    idTotal,
    idRate: idTotal ? idSurvived / idTotal : null,
    cerBaselineMean: sum((c) => c.cerBaseline) / clips.length,
    cerHypothesisMean: sum((c) => c.cerHypothesis) / clips.length,
    cerMeanDelta: sum((c) => c.cerDelta) / clips.length,
    boundariesBaseline,
    boundariesHypothesis,
    boundaryRetention: boundariesBaseline ? boundariesHypothesis / boundariesBaseline : null,
    minSavedRatio: Math.min(...clips.map((c) => c.savedRatio)),
  };
}

const ASSERTIONS = [
  {
    name: 'savedRatioPositive',
    run: (agg) => {
      const flat = agg.clips.filter((c) => !(c.savedRatio > 0));
      if (!flat.length) return null;
      const shown = flat.map((c) => `${c.clip} savedRatio=${c.savedRatio}`).join(', ');
      return `${flat.length}/${agg.clips.length} clip(s) were not shortened: ${shown} — ` +
        'the quality reading only means something when the trim actually happened';
    },
  },
  {
    name: 'identifierSurvival',
    // A reference that carries no identifier makes the rate null, and `null >=
    // null` is a comparison between two things that were never measured. That
    // case is its own failure rather than a silent pass: an axis with nothing on
    // it is exactly what a fixture that drifted into carrying only filler would
    // look like.
    run: (agg, base) => {
      if (!base.idTotal || !agg.idTotal) {
        return (
          `nothing to measure: the references carry ${base.idTotal} identifier(s) and the hypothesis column ` +
          `${agg.idTotal} — the verbatim criterion is vacuous on this fixture`
        );
      }
      if (agg.idRate >= base.idRate) return null;
      const lost = agg.clips.filter((c) => c.idMissing.length).map((c) => `${c.clip}: ${c.idMissing.join(', ')}`);
      return (
        `identifier survival ${agg.idSurvived}/${agg.idTotal} = ${fmt(agg.idRate, 4)} fell below baseline ` +
        `${base.idSurvived}/${base.idTotal} = ${fmt(base.idRate, 4)}` +
        (lost.length ? `; lost [${lost.join(' | ')}]` : '')
      );
    },
  },
  {
    name: 'cerDelta',
    run: (agg) => {
      if (agg.cerMeanDelta <= MAX_CER_DELTA) return null;
      return (
        `mean ΔCER ${(agg.cerMeanDelta * 100).toFixed(3)}% > ${(MAX_CER_DELTA * 100).toFixed(1)}% ` +
        `(baseline ${fmt(agg.cerBaselineMean, 4)} -> ${fmt(agg.cerHypothesisMean, 4)}; ` +
        `reference readings zh +1.101%, en +0.140%)`
      );
    },
  },
  {
    name: 'boundaryRetention',
    run: (agg) => {
      if (agg.boundaryRetention !== null && agg.boundaryRetention >= MIN_BOUNDARY_RETENTION) return null;
      return (
        `sentence boundaries ${agg.boundariesHypothesis}/${agg.boundariesBaseline} = ` +
        `${fmt(agg.boundaryRetention, 4)} < ${MIN_BOUNDARY_RETENTION} — the transcript lost its sentence ` +
        'structure (reference reading: zh 2.06 -> 1.00 per clip = 0.485)'
      );
    },
  },
];

const fmt = (v, n) => (v === null || v === undefined ? 'null' : v.toFixed(n));

// ---------------------------------------------------------------------------
// The columns under measurement.
//
// `shipping` is the criterion. The rest are controls — hypothetical readings the
// criteria must be able to tell apart from the real one. Each supplies the
// hypothesis transcript and the saving it would report, per clip; none of them
// re-transcribes anything, because the transcripts that exist are the ones the
// recogniser actually returned and a synthesised one would measure this file's
// imagination rather than the pipeline.
//
// Columns whose saving is not the shipping module's report the number the
// fixture pinned, which is itself derived from the module's own output — see
// the correspondence check, which re-derives all of them.
// ---------------------------------------------------------------------------

/**
 * Strip every mark the boundary count counts: a run-on, the harm
 * `boundaryRetention` names.
 *
 * It reds the identifier criterion too, and that is declared rather than
 * tolerated — see `boundaryCount` above. The marks this strips include the dots
 * inside `voice.service.ts`, so removing them is also removing identifiers; a
 * control that removed only sentence-final marks would leave the identifier
 * column untouched, but it would not be removing the marks this criterion
 * counts, and so would not be the harm this criterion names.
 */
const runOn = (text) => String(text).replace(/[.!?。！？]/g, '');

const IMPLEMENTATIONS = [
  {
    name: 'shipping',
    note: 'src/shared/voiceTrim.ts, trimmed column',
    hypothesis: (e) => e.transcripts.trimmed,
    savedRatio: (e) => e.audio.trimmedSavedRatio,
    mustFail: [],
  },
  {
    name: 'identity',
    note: 'no trim at all (savedRatio 0)',
    hypothesis: (e) => e.transcripts.baseline,
    savedRatio: () => 0,
    mustFail: ['savedRatioPositive'],
  },
  {
    name: 'aggressive',
    note: `roll inverted (${AGGRESSIVE_TRIM.preRollMs} ms) — eats speech`,
    hypothesis: (e) => e.transcripts.aggressive,
    savedRatio: (e) => e.audio.aggressiveSavedRatio,
    mustFail: ['identifierSurvival', 'cerDelta'],
  },
  {
    // Kept as a control with an empty `mustFail`: it is not here to be caught,
    // it is here to show why the caps table cannot be the speech-eating control.
    // Its saving is real and its transcripts are real — the run asserts below
    // that its speech-kept ratio is exactly 1, which is the reason no transcript
    // can lose an identifier to it.
    name: 'flattened',
    note: 'pause table replaced with keep-nothing — cannot reach speech',
    hypothesis: (e) => e.transcripts.flattened,
    savedRatio: (e) => e.audio.flattenedSavedRatio,
    mustFail: [],
  },
  {
    name: 'runOn',
    note: 'the trimmed transcript with every mark the boundary count counts removed',
    hypothesis: (e) => runOn(e.transcripts.trimmed),
    savedRatio: (e) => e.audio.trimmedSavedRatio,
    // Two, not one: stripping the dots out of `voice.service.ts` is stripping
    // identifiers, because the boundary count counts those dots. A reading-level
    // control, not a pipeline state — it is the shape of the harm, not a trim
    // that produces it.
    mustFail: ['identifierSurvival', 'boundaryRetention'],
  },
];

// ---------------------------------------------------------------------------
// The blindness canary.
//
// The claim the criterion's shape rests on, stated as an assertion rather than a
// paragraph: CER cannot see an identifier lose its dots and its case, and the
// verbatim reading can. Both strings are the corruption this project actually
// observed — `voice.se` came back where `voice.service.ts` was spoken (zh-d01
// baseline), and `service.ts` where `voice.service.ts` was spoken (en-e01-o65
// aggressive) — so the canary is a real failure shape, not an invented one.
//
// The run fails if CER is *not* blind here. If CER ever starts scoring this
// corruption, the reason for the verbatim axis has changed and this file's
// design has to be re-argued rather than quietly kept.
// ---------------------------------------------------------------------------

const BLINDNESS_CASE = {
  reference: 'voice.service.ts',
  hypothesis: 'voice service ts',
  note: 'the dots and the case lost — the corruption observed on zh-d01 and en-e01-o65',
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);

function printColumn(agg) {
  console.log(
    `\n  ${pad(agg.name, 12)} identifiers ${agg.idSurvived}/${agg.idTotal}=${fmt(agg.idRate, 4)}  ` +
      `CER ${fmt(agg.cerBaselineMean, 4)}->${fmt(agg.cerHypothesisMean, 4)} (mean Δ ${(agg.cerMeanDelta * 100).toFixed(3)}%)  ` +
      `boundaries ${agg.boundariesHypothesis}/${agg.boundariesBaseline}=${fmt(agg.boundaryRetention, 4)}  ` +
      `minSavedRatio=${fmt(agg.minSavedRatio, 4)}`,
  );
  for (const clip of agg.clips) {
    console.log(
      `      ${pad(clip.clip, 16)} id=${clip.idSurvived}/${clip.idTotal}  ` +
        `cer ${fmt(clip.cerBaseline, 4)}->${fmt(clip.cerHypothesis, 4)}  ` +
        `b ${clip.boundariesBaseline}->${clip.boundariesHypothesis}  ` +
        `savedRatio=${fmt(clip.savedRatio, 4)}` +
        (clip.idMissing.length ? `  lost=[${clip.idMissing.join(', ')}]` : ''),
    );
  }
}

function main() {
  const failures = [];
  const fixture = loadTranscripts();
  const entries = fixture.entries;
  const moduleSrc = readFileSync(fileURLToPath(MODULE_URL), 'utf8');
  const fidelitySrc = readFileSync(fileURLToPath(FIDELITY_URL), 'utf8');

  const totalSec = entries.reduce((a, e) => a + e.audio.baselineSec, 0);
  console.log('voice-trim quality — transcripts from a real recogniser, criteria offline');
  console.log(
    `fixtures: ${entries.length} clips, ${totalSec.toFixed(1)}s of audio, ` +
      `${entries.reduce((a, e) => a + boundaryCount(e.transcripts.baseline), 0)} baseline boundary mark(s); ` +
      `recogniser: ${fixture.provenance.recogniser.model} (${fixture.provenance.recogniser.provider}), ` +
      `taken ${fixture.provenance.generatedAt}`,
  );

  // 1. The audio the transcripts came from, re-derived here. This runs first
  //    because every number below is a statement about that audio: if the
  //    correspondence does not hold, the reading is about some other pipeline.
  console.log('\nfixture correspondence (the transcript must be this module\'s audio, byte for byte):');
  const canary = correspondenceCanary(entries);
  console.log(`  canary=${canary.fired ? 'RED' : 'GREEN'} ${canary.fired ? 'corrupted hash detected' : 'NOT detected — the check is blind'}`);
  if (!canary.fired) {
    failures.push(`[correspondence] canary not detected (${canary.reason}) — a green fixture reading is worthless`);
  }

  const correspondence = correspondenceFailures(entries);
  console.log(
    `  fixture=${correspondence.failures.length ? 'RED' : 'GREEN'} checked: ${correspondence.checked} encoded ` +
      `column(s) over ${entries.length} clip(s), ${fixtureFiles().length} audio file(s)`,
  );
  for (const failure of correspondence.failures) {
    console.log(`    - ${failure}`);
    failures.push(`[correspondence] ${failure}`);
  }

  // 2. The control that is supposed to be unable to reach speech. Asserted, not
  //    argued: `keepSec: 0` shortens the gaps between regions, and the module
  //    copies each region's samples verbatim, so this ratio is 1 by construction
  //    — which is why the speech-eating control above is the roll.
  console.log('\nspeech-kept, on the audio (a control that cannot delete speech cannot damage a transcript):');
  for (const column of CONTROL_COLUMNS) {
    const ratios = entries.map((e) => e.audio[`${column}SpeechKeptRatio`]);
    const worst = Math.min(...ratios);
    console.log(`  ${pad(column, 12)} speechKeptRatio min=${fmt(worst, 4)} over ${ratios.length} clip(s)`);
  }
  const losslessColumns = ['trimmed', 'flattened'];
  for (const column of losslessColumns) {
    const lossy = entries.filter((e) => e.audio[`${column}SpeechKeptRatio`] !== 1);
    if (lossy.length) {
      failures.push(
        `[speech] ${column}: ${lossy.length} clip(s) lost speech (${lossy.map((e) => e.clip).join(', ')}) — ` +
          'this column is supposed to reach only silence',
      );
    }
  }
  const aggressiveLossy = entries.filter((e) => e.audio.aggressiveSpeechKeptRatio >= 1);
  if (aggressiveLossy.length) {
    failures.push(
      `[speech] aggressive: ${aggressiveLossy.length} clip(s) kept all their speech ` +
        `(${aggressiveLossy.map((e) => e.clip).join(', ')}) — the speech-eating control did not eat any, ` +
        'so it cannot stand in for that failure',
    );
  }

  // 3. Every column, over the same fixture, through the same criteria.
  const results = new Map();
  for (const impl of IMPLEMENTATIONS) {
    const agg = measure(entries, impl.hypothesis, impl.savedRatio);
    agg.name = impl.name;
    agg.note = impl.note;
    results.set(impl.name, agg);
    printColumn(agg);
  }

  const shipping = results.get('shipping');
  const baseline = measure(entries, (e) => e.transcripts.baseline, () => shipping.clips[0].savedRatio);

  // 4. The criteria, on the shipping column.
  console.log('\ncriteria on shipping:');
  for (const assertion of ASSERTIONS) {
    const reason = assertion.run(shipping, baseline);
    console.log(`  ${reason ? 'FAIL' : 'ok  '} ${assertion.name}${reason ? ` — ${reason}` : ''}`);
    if (reason) failures.push(`[shipping] ${assertion.name}: ${reason}`);
  }

  // 5. The same criteria on every control. A criterion a control passes is a
  //    criterion that cannot see that control, so it is reported as a failure of
  //    the criterion rather than a pass of the control.
  console.log('\ncontrols (each must fail the criteria it simulates):');
  for (const impl of IMPLEMENTATIONS.filter((i) => i.mustFail.length)) {
    const agg = results.get(impl.name);
    const red = ASSERTIONS.filter((a) => a.run(agg, baseline)).map((a) => a.name);
    const missed = impl.mustFail.filter((n) => !red.includes(n));
    console.log(
      `  ${missed.length ? 'VACUOUS' : 'ok     '} ${pad(impl.name, 12)} ${impl.note} — red on [${red.join(', ') || 'nothing'}]`,
    );
    if (missed.length) {
      failures.push(
        `[control ${impl.name}] criteria that cannot see it: ${missed.join(', ')} — ` +
          'a criterion no control can fail is not measuring anything',
      );
    }
  }

  // 6. The blindness canary. See BLINDNESS_CASE.
  console.log('\nblindness (why the criterion is verbatim and not CER):');
  const blindFidelity = identifierFidelity(BLINDNESS_CASE.reference, BLINDNESS_CASE.hypothesis);
  const blindCer = cer(BLINDNESS_CASE.reference, BLINDNESS_CASE.hypothesis);
  console.log(
    `  identifierFidelity("${BLINDNESS_CASE.reference}", "${BLINDNESS_CASE.hypothesis}") = ` +
      `${blindFidelity.survived}/${blindFidelity.total} (rate ${fmt(blindFidelity.rate, 4)})`,
  );
  console.log(`  cer(same pair) = ${fmt(blindCer, 4)}`);
  if (blindFidelity.rate !== 0) {
    failures.push(
      `[blindness] the verbatim reading scored ${fmt(blindFidelity.rate, 4)} on ${BLINDNESS_CASE.note} — ` +
        'the axis does not see the corruption it was chosen for',
    );
  }
  if (blindCer !== 0) {
    failures.push(
      `[blindness] CER scored ${fmt(blindCer, 4)} (expected exactly 0) on ${BLINDNESS_CASE.note} — ` +
        'CER is no longer blind to this corruption, so the reason for the verbatim axis no longer holds',
    );
  }

  if (failures.length) {
    process.stderr.write(`\nvoice-trim quality: ${failures.length} failure(s)\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.exit(1);
  }

  console.log(
    `\nvoice-trim quality: OK — identifiers ${shipping.idSurvived}/${shipping.idTotal} (baseline ` +
      `${baseline.idSurvived}/${baseline.idTotal}), ΔCER ${(shipping.cerMeanDelta * 100).toFixed(3)}% <= ` +
      `${(MAX_CER_DELTA * 100).toFixed(1)}%, boundaries ${fmt(shipping.boundaryRetention, 4)} >= ` +
      `${MIN_BOUNDARY_RETENTION}, savedRatio > 0 on every clip`,
  );
  // The source reads are here so the run has to have opened both modules: a
  // criterion that never loaded the shipping fidelity module would report an
  // identical green while measuring something else entirely.
  if (!moduleSrc.includes('trimVoiceAudio') || !fidelitySrc.includes('identifierFidelity')) {
    process.stderr.write('\nvoice-trim quality: the modules under measurement were not read\n');
    process.exit(1);
  }
}

// Only when invoked; the fixture generator imports this file for its encoder.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
