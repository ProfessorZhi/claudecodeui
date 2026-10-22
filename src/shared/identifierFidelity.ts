/**
 * Identifier fidelity — the metric CER cannot provide.
 *
 * CER's normal form lowers case and deletes punctuation and whitespace, which is right
 * for prose and structurally blind to code: after it, `voice.service.ts` and
 * `voice service ts` are the SAME character sequence, so a corrupted identifier scores
 * as a perfect match. Measured 2026-09-21 on the verification harness behind
 * `docs/proposals/voice-identifier-repair-and-temporal-compression.md`: a change that
 * repaired `Use voice.Input` into `useVoiceInput` — the identifier really was fixed —
 * reported 0.00% CER movement. Judging dictation by CER therefore produces an all-green
 * reading while the agent goes and edits the wrong file.
 *
 * So identifiers are counted on their own axis and verbatim: punctuation AND case have
 * to survive. Case is kept here on purpose, unlike the port at
 * `experiments/voice-identifiers/identifierFidelity.mjs` (which lowercases both sides,
 * so a transcript that dithered between `useVoiceInput` and `usevoiceinput` reads as
 * survived). The failure this metric exists to name is an identifier that did not arrive
 * exactly as written, and a case flip is exactly that.
 *
 * Used by the chat module's dictation hook (useVoiceInput) to report the reading on the
 * real transcript fill-back path, and by this module's tests.
 */

/** Spans that have to survive verbatim. A token may match more than one pattern. */
const IDENTIFIER_PATTERNS: RegExp[] = [
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.[a-z]{1,5}\b/g, // file.ts, voice.service.ts
  /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g, // camelCase
  /\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g, // PascalCase
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, // snake_case
  /--?[A-Za-z][A-Za-z0-9-]{1,}/g, // --flag
  /\/[A-Za-z0-9_./-]{3,}/g, // /path/to/thing
];

/** What one reference/hypothesis pair scores. */
export type IdentifierFidelityReading = {
  /** How many identifiers the reference carried; 0 means there was nothing to lose. */
  total: number;
  /** How many of those appear verbatim — punctuation and case intact — in the hypothesis. */
  survived: number;
  /** survived/total, or null when the reference carried no identifier at all. */
  rate: number | null;
  /** The identifiers that did not survive, so a caller can name what was lost. */
  missing: string[];
};

/**
 * Every identifier-shaped span in `text`, deduplicated and in first-seen order.
 * Callers that need the token list rather than the rate (an instrument reporting what a
 * transcript carried) use this directly.
 */
export function findIdentifiers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of String(text).matchAll(pattern)) found.push(match[0]);
  }
  return [...new Set(found)];
}

/**
 * The hypothesis with whitespace removed, so a recogniser that re-spaces around an
 * identifier is not punished for it. Nothing else is touched: moving a dot, changing a
 * character or flipping a letter all mean the identifier did not survive.
 */
function loose(text: string): string {
  return String(text).replace(/\s+/g, '');
}

/**
 * Compare `hypothesis` against `reference` without normalising punctuation or case — the
 * whole point is to notice that the dots and the letters were lost.
 */
export function identifierFidelity(reference: string, hypothesis: string): IdentifierFidelityReading {
  const want = findIdentifiers(reference);
  if (!want.length) return { total: 0, survived: 0, rate: null, missing: [] };
  const haystack = loose(hypothesis);
  const missing = want.filter((identifier) => !haystack.includes(loose(identifier)));
  return {
    total: want.length,
    survived: want.length - missing.length,
    rate: (want.length - missing.length) / want.length,
    missing,
  };
}
