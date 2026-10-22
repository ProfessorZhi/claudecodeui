/**
 * The confidence-flag shadow's criterion: known answers, and parity with the offline experiment.
 *
 * WHY THIS FILE IS SPLIT THE WAY IT IS. `flagStats` is not a new idea being tested into existence —
 * it is a port of a rule `experiments/voice-index-loop/sim/sv-eval2.mjs` already states, and the port
 * is only correct if the number a live recording produces is the number that script produces. So
 * there are two halves:
 *
 *   · The KNOWN-ANSWER cases below pin the rule itself — an all-confident sequence draws no mark, two
 *     adjacent low tokens merge into one mark while two scattered ones do not, a CJK-only run is a
 *     mark without being a Latin mark, the counts never fall as the threshold rises, and an empty
 *     input is zeros rather than a throw. These are written out by hand so a reader can check each
 *     expectation against the header of `shared/asr/confidenceFlags.ts` without running anything.
 *   · The PARITY half below runs the production implementation and a second, independent one — a
 *     transcription of the offline script kept in that script's own `{ tok, p }` idiom — over the
 *     committed fixture and demands the same mark counts at every threshold. A transcription can
 *     drift from its source, so a third assertion PINS the three fragments of the offline rule
 *     straight off `sv-eval2.mjs` on disk: if the script's rule changes, this file reds and the
 *     transcription beside it has to be revisited, rather than both sides quietly agreeing on a rule
 *     the experiment no longer uses.
 *
 * WHERE THE FIXTURE COMES FROM. `fixtures/confidence-flags-tokens.json` carries only SYNTHETIC
 * sentences lifted from `experiments/voice-context-asr/pilot/cases.mjs` (its NEUTRAL and TRAPS lists
 * and its zh2/en templates) with per-token confidences constructed on top — no user-message original
 * appears in it. The parity it establishes is therefore a statement about the ALGORITHM (how a low
 * run is defined and merged) and not about any recording; the live reading belongs to the task's
 * browser criterion.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import fixture from '@/shared/asr/tests/fixtures/confidence-flags-tokens.json';
import { DEFAULT_CONFIDENCE_THETAS, flagStats, type ConfidenceFlagToken } from '@shared/asr/confidenceFlags';

const THETAS = [...DEFAULT_CONFIDENCE_THETAS];

/** One fixture record, as the JSON carries it. */
type FixtureRecord = { id: string; text: string; tokens: { text: string; confidence: number }[] };

const RECORDS = fixture.records as FixtureRecord[];

/**
 * The offline script's rule, transcribed into its own `{ tok, p }` vocabulary.
 *
 * The two `▁`-handling expressions are kept character-for-character identical to `tokSpans`'s in
 * `sv-eval2.mjs` (including the string-overload `replace`, which swaps only the FIRST marker) and so
 * is the run loop below: `p < theta` opens a run, the `while` absorbs every adjacent token that is
 * also below it, and the Latin test reads the SLICED SEGMENT rather than the tokens. The `pin_*`
 * assertions further down fail if the script stops saying any of these things.
 */
function offlineSpans(record: { text: string; tokens: { tok: string; p: number }[] }) {
  let raw = '';
  const pos: number[] = [];
  for (const k of record.tokens) {
    pos.push(raw.length);
    raw += k.tok.replace('▁', ' ');
  }
  const lead = raw.length - raw.trimStart().length;
  return record.tokens.map((k, i) => ({
    start: Math.max(0, pos[i] - lead),
    end: Math.max(0, pos[i] + k.tok.replace('▁', ' ').length - lead),
    p: k.p,
  }));
}

function offlineFlagCount(
  record: { text: string; tokens: { tok: string; p: number }[] },
  theta: number,
  latinOnly: boolean,
): number {
  const ts = offlineSpans(record);
  let count = 0;
  let i = 0;
  while (i < ts.length) {
    if (ts[i].p < theta) {
      let j = i;
      while (j + 1 < ts.length && ts[j + 1].p < theta) j++;
      const seg = record.text.slice(ts[i].start, ts[j].end);
      if (!latinOnly || /[A-Za-z0-9]/.test(seg)) count += 1;
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return count;
}

/** The fixture's tokens in the offline script's shape; `confidence` is its `p`. */
function asOfflineRecord(record: FixtureRecord) {
  return { text: record.text, tokens: record.tokens.map((t) => ({ tok: t.text, p: t.confidence })) };
}

describe('flagStats known answers', () => {
  it('① an all-confident sequence draws no mark at any threshold', () => {
    const tokens: ConfidenceFlagToken[] = [
      { text: 'please', confidence: 0.99 },
      { text: '▁run', confidence: 0.97 },
      { text: '▁tests', confidence: 0.95 },
    ];
    const stats = flagStats('please run tests', tokens);
    expect(stats.chars).toBe('please run tests'.length);
    expect(stats.byTheta.map((row) => row.theta)).toEqual(THETAS);
    for (const row of stats.byTheta) {
      expect(row.flags, `flags at theta ${row.theta}`).toBe(0);
      expect(row.flagsLatin, `flagsLatin at theta ${row.theta}`).toBe(0);
      expect(row.flagsPer100Chars).toBe(0);
      expect(row.flagsLatinPer100Chars).toBe(0);
    }
  });

  it('② two adjacent low tokens merge into ONE mark', () => {
    const tokens: ConfidenceFlagToken[] = [
      { text: 'alpha', confidence: 0.95 },
      { text: '▁beta', confidence: 0.5 },
      { text: '▁gamma', confidence: 0.55 },
      { text: '▁delta', confidence: 0.95 },
    ];
    const row = flagStats('alpha beta gamma delta', tokens, [0.6]).byTheta[0];
    expect(row.flags).toBe(1);
    expect(row.flagsLatin).toBe(1);
  });

  it('③ two separated low tokens are TWO marks', () => {
    const tokens: ConfidenceFlagToken[] = [
      { text: 'alpha', confidence: 0.95 },
      { text: '▁beta', confidence: 0.5 },
      { text: '▁gamma', confidence: 0.95 },
      { text: '▁delta', confidence: 0.55 },
      { text: '▁epsilon', confidence: 0.95 },
    ];
    const row = flagStats('alpha beta gamma delta epsilon', tokens, [0.6]).byTheta[0];
    expect(row.flags).toBe(2);
    expect(row.flagsLatin).toBe(2);
  });

  it('④ a CJK-only low run counts as a mark but not as a Latin mark', () => {
    // The low run slices to the segment `意。` — a mark, and one with no Latin letter or digit in it.
    const cjk: ConfidenceFlagToken[] = [
      { text: '同', confidence: 0.9 },
      { text: '意', confidence: 0.5 },
      { text: '。', confidence: 0.55 },
      { text: '好', confidence: 0.9 },
    ];
    const cjkRow = flagStats('同意。好', cjk, [0.6]).byTheta[0];
    expect(cjkRow.flags).toBe(1);
    expect(cjkRow.flagsLatin).toBe(0);

    // The positive control: the same shape over Latin text counts BOTH, so `flagsLatin === 0` above
    // is the segment's property and not a reading that could never have been anything else.
    const latin: ConfidenceFlagToken[] = [
      { text: 'ok', confidence: 0.9 },
      { text: '▁run', confidence: 0.5 },
      { text: '▁it', confidence: 0.55 },
      { text: '▁now', confidence: 0.9 },
    ];
    const latinRow = flagStats('ok run it now', latin, [0.6]).byTheta[0];
    expect(latinRow.flags).toBe(1);
    expect(latinRow.flagsLatin).toBe(1);
  });

  it('⑤ the counts never fall as the threshold rises', () => {
    const tokens: ConfidenceFlagToken[] = [
      { text: 'a', confidence: 0.95 },
      { text: '▁b', confidence: 0.79 },
      { text: '▁c', confidence: 0.95 },
      { text: '▁d', confidence: 0.69 },
      { text: '▁e', confidence: 0.95 },
      { text: '▁f', confidence: 0.59 },
      { text: '▁g', confidence: 0.95 },
      { text: '▁h', confidence: 0.49 },
      { text: '▁i', confidence: 0.95 },
    ];
    const rows = flagStats('a b c d e f g h i', tokens).byTheta;
    // The crafted ladder: one scattered low token per threshold as the sweep widens.
    expect(rows.map((row) => row.flags)).toEqual([1, 2, 3, 4]);
    for (let k = 1; k < rows.length; k += 1) {
      expect(rows[k].flags).toBeGreaterThanOrEqual(rows[k - 1].flags);
      expect(rows[k].flagsLatin).toBeGreaterThanOrEqual(rows[k - 1].flagsLatin);
    }

    // The same monotonicity must hold on every committed record, not just this hand-made one.
    for (const record of RECORDS) {
      const fixtureRows = flagStats(record.text, record.tokens).byTheta;
      for (let k = 1; k < fixtureRows.length; k += 1) {
        expect(fixtureRows[k].flags, `${record.id} flags at theta ${fixtureRows[k].theta}`)
          .toBeGreaterThanOrEqual(fixtureRows[k - 1].flags);
        expect(fixtureRows[k].flagsLatin, `${record.id} flagsLatin at theta ${fixtureRows[k].theta}`)
          .toBeGreaterThanOrEqual(fixtureRows[k - 1].flagsLatin);
      }
    }
  });

  it('⑥ empty text and empty tokens answer all zeros and do not throw', () => {
    const stats = flagStats('', []);
    expect(stats.chars).toBe(0);
    expect(stats.byTheta).toHaveLength(THETAS.length);
    for (const row of stats.byTheta) {
      expect(row.flags).toBe(0);
      expect(row.flagsLatin).toBe(0);
      expect(row.flagsPer100Chars).toBe(0);
      expect(row.flagsLatinPer100Chars).toBe(0);
    }

    // Empty text WITH a low token must still answer a rate of zero rather than NaN — the division
    // that an empty recording would otherwise do is pinned here, not left to the caller.
    const emptyText = flagStats('', [{ text: 'x', confidence: 0.1 }]).byTheta[0];
    expect(emptyText.flags).toBe(1);
    expect(emptyText.flagsPer100Chars).toBe(0);
    expect(Number.isNaN(emptyText.flagsPer100Chars)).toBe(false);
  });
});

describe('flagStats parity with the offline experiment', () => {
  it('pins the offline rule the transcription below reproduces', () => {
    const source = readFileSync(resolve(process.cwd(), 'experiments/voice-index-loop/sim/sv-eval2.mjs'), 'utf8');
    // `tokSpans`: the concatenation, the leading-whitespace shift, and the clamp.
    expect(source).toContain("k.tok.replace('▁', ' ')");
    expect(source).toContain('raw.trimStart().length');
    expect(source).toContain('Math.max(0, pos[i] - lead)');
    // The run loop: strict `<`, adjacency, and the sliced-segment Latin test.
    expect(source).toContain('ts[i].p < th');
    expect(source).toContain('ts[j + 1].p < th');
    expect(source).toContain('r.own_text.slice(ts[i].start, ts[j].end)');
    expect(source).toContain('/[A-Za-z0-9]/.test(seg)');
  });

  it('agrees mark-for-mark on every committed synthetic record, at every threshold', () => {
    expect(RECORDS.length).toBeGreaterThanOrEqual(5);
    for (const record of RECORDS) {
      // The fixture's own integrity: the tokens, with `▁` read as a space, spell the sentence the
      // record names — otherwise the spans both sides compute would be intervals of a different text.
      // The trim is the algorithm's own `lead` shift, applied here too so a record whose first token
      // opens on a boundary marker (the leading-boundary case) is checked against the same string the
      // two implementations slice.
      expect(record.tokens.map((t) => t.text).join('').replace(/▁/g, ' ').trimStart(), record.id).toBe(record.text);

      const produced = flagStats(record.text, record.tokens).byTheta;
      const offline = asOfflineRecord(record);
      expect(produced.map((row) => row.theta), record.id).toEqual(THETAS);
      for (const row of produced) {
        expect(row.flags, `${record.id} flags at theta ${row.theta}`)
          .toBe(offlineFlagCount(offline, row.theta, false));
        expect(row.flagsLatin, `${record.id} flagsLatin at theta ${row.theta}`)
          .toBe(offlineFlagCount(offline, row.theta, true));
      }
    }
  });

  it('negative control: dropping the merge rule makes known answer ② go red', () => {
    const tokens: ConfidenceFlagToken[] = [
      { text: 'alpha', confidence: 0.95 },
      { text: '▁beta', confidence: 0.5 },
      { text: '▁gamma', confidence: 0.55 },
      { text: '▁delta', confidence: 0.95 },
    ];
    // The mutated reading: every low token is its own mark, with no adjacency merged.
    const noMerge = tokens.filter((t) => (t.confidence ?? 1) < 0.6).length;
    expect(noMerge).toBe(2);
    // ②'s expectation is 1; the mutation does not satisfy it, which is what makes ② falsifiable.
    expect(noMerge).not.toBe(1);
    expect(flagStats('alpha beta gamma delta', tokens, [0.6]).byTheta[0].flags).toBe(1);
  });
});
