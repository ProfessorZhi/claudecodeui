import { describe, expect, test } from 'vitest';

import { findIdentifiers, identifierFidelity } from '@/shared/identifierFidelity';

// ---------------------------------------------------------------------------------------
// The CER caliber this repo already scores transcripts with, transcribed verbatim from the
// verification harness (`/data/home/yale/work/tc-verify/tools/metrics.mjs`): `normalize()`
// is "Lowercase, drop punctuation, collapse whitespace — Whisper's own normal form", and
// `chars()` strips the whitespace it left behind. It is reproduced here, rather than
// exported from the metric module, because what this file has to pin is the *existing*
// caliber — a second notion of text similarity living in production code would be unused
// there and would make the blindness claim below self-referential.
// ---------------------------------------------------------------------------------------
function cerNormalForm(text: string): string {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '');
}

/** Levenshtein distance over character arrays — the harness's `levenshtein`. */
function levenshtein(a: string[], b: string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** Character error rate — the harness's `cer()`: distance over normalised characters. */
function cer(reference: string, hypothesis: string): number {
  const want = [...cerNormalForm(reference)];
  return want.length ? levenshtein(want, [...cerNormalForm(hypothesis)]) / want.length : 0;
}

// The pair the AC names: a project file name as it is written, and the same name as the
// recogniser returns it (dots read as spaces). `REPAIRED` is what the deterministic repair
// of AC-113 restores for this shape — the project's real file name, which is the reference.
const REFERENCE = 'voice.service.ts';
const CORRUPTED = 'voice service ts';
const REPAIRED = REFERENCE;

describe('identifier fidelity', () => {
  // AC-114 assertion (1).
  test('a corrupted identifier scores 0, and the reading names what was lost', () => {
    const reading = identifierFidelity(REFERENCE, CORRUPTED);
    expect(reading.total).toBe(1);
    expect(reading.survived).toBe(0);
    expect(reading.rate).toBe(0);
    expect(reading.missing).toEqual([REFERENCE]);
  });

  // AC-114 assertion (2): the same pair is a perfect match under the CER caliber, which is
  // exactly why CER cannot see this failure. This is the regression guard for the claim
  // ("CER reports 0.00% while the identifier is corrupted") the metric exists to answer.
  test('the CER caliber calls that same pair a perfect match — CER is blind to it', () => {
    expect(cerNormalForm(REFERENCE)).toBe(cerNormalForm(CORRUPTED));
    expect(cer(REFERENCE, CORRUPTED)).toBe(0);
    // Same two strings, opposite verdicts: the blindness is the caliber, not the data.
    expect(identifierFidelity(REFERENCE, CORRUPTED).rate).toBe(0);
  });

  // AC-114 assertion (3).
  test('once the identifier is repaired the reading returns to 1', () => {
    const reading = identifierFidelity(REFERENCE, REPAIRED);
    expect(reading.survived).toBe(1);
    expect(reading.rate).toBe(1);
    expect(reading.missing).toEqual([]);
  });

  test('the reading follows the identifier, not the shape: a half-repaired transcript scores 1/2', () => {
    const reading = identifierFidelity('voice.service.ts and useVoiceInput', 'voice.service.ts and Use voice input');
    expect(reading.total).toBe(2);
    expect(reading.survived).toBe(1);
    expect(reading.rate).toBe(0.5);
    expect(reading.missing).toEqual(['useVoiceInput']);
  });

  test('case is part of the survival axis — a case flip is a lost identifier', () => {
    expect(identifierFidelity('useVoiceInput', 'usevoiceinput').rate).toBe(0);
    expect(identifierFidelity('useVoiceInput', 'Use voice Input').rate).toBe(0);
  });

  test('re-spacing around an identifier is not a loss; moving a dot is', () => {
    expect(identifierFidelity('voice.service.ts', '  voice. service. ts  ').rate).toBe(1);
    expect(identifierFidelity('voice.service.ts', 'voice service.ts').rate).toBe(0);
  });

  test('nothing to lose reads null rather than a vacuous 1', () => {
    const reading = identifierFidelity('open the settings panel', 'open the settings panel');
    expect(reading).toEqual({ total: 0, survived: 0, rate: null, missing: [] });
  });

  test('findIdentifiers reports the spans the reading is taken over', () => {
    expect(findIdentifiers('call useVoiceInput then --verbose on /api/voice and open voice.service.ts')).toEqual([
      'voice.service.ts',
      'useVoiceInput',
      '--verbose',
      '/api/voice',
    ]);
  });
});
