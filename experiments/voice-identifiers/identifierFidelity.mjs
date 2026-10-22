/**
 * Identifier fidelity — the metric CER cannot provide.
 *
 * CER normalises away punctuation and whitespace, which is correct for prose and
 * catastrophic for code. After normalisation `voice.service.ts` and
 * `voice service ts` are the SAME character sequence, so CER scores a corrupted
 * identifier as a perfect match — and a change that visibly repairs
 * `Use voice.Input` into `useVoiceInput` registers as literally 0.00%.
 *
 * For an agent that will go and edit a file, the identifier either survived
 * exactly or it did not. So this counts exact identifier survival, punctuation
 * preserved, and treats it as its own axis rather than folding it into CER.
 *
 * Provenance: ported from the out-of-repo verification harness whose findings
 * report is quoted in the goal record for this work (§10 of FINDINGS.md).
 */

/** Spans that must survive verbatim. Ordered longest-first at match time. */
const IDENTIFIER_PATTERNS = [
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.[a-z]{1,5}\b/g, // file.ts, voice.service.ts
  /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/g,      // camelCase
  /\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g, // PascalCase
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,     // snake_case
  /--?[A-Za-z][A-Za-z0-9-]{1,}/g,           // --flag
  /\/[A-Za-z0-9_./-]{3,}/g,                 // /path/to/thing
];

export function identifiers(text) {
  const found = [];
  for (const re of IDENTIFIER_PATTERNS) {
    for (const m of String(text).matchAll(re)) found.push(m[0]);
  }
  return [...new Set(found)];
}

/**
 * Compare against a hypothesis WITHOUT stripping punctuation — the whole point
 * is to notice that the dots and case were lost.
 */
function loose(s) {
  return String(s).toLowerCase().replace(/\s+/g, '');
}

export function identifierFidelity(reference, hypothesis) {
  const want = identifiers(reference);
  if (!want.length) return { total: 0, survived: 0, rate: null, missing: [] };
  const hay = loose(hypothesis);
  const missing = want.filter((w) => !hay.includes(loose(w)));
  return {
    total: want.length,
    survived: want.length - missing.length,
    rate: (want.length - missing.length) / want.length,
    missing,
  };
}

/** Aggregate over many pairs; reports the pooled rate, not the mean of rates. */
export function aggregateFidelity(pairs) {
  let total = 0;
  let survived = 0;
  const missingAll = [];
  for (const [ref, hyp] of pairs) {
    if (hyp == null) continue;
    const f = identifierFidelity(ref, hyp);
    total += f.total;
    survived += f.survived;
    missingAll.push(...f.missing);
  }
  return { total, survived, rate: total ? survived / total : null, missing: missingAll };
}

export const fmt = (a) => (a.rate === null ? 'n/a' : `${(a.rate * 100).toFixed(1)}% (${a.survived}/${a.total})`);
