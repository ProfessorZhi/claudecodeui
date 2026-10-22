/**
 * The confidence-flag shadow: how many underlines a confidence sweep WOULD draw, counted without
 * drawing anything.
 *
 * THE QUESTION THIS ANSWERS IS A BUDGET QUESTION, ASKED BEFORE THE UI EXISTS. The correction loop's
 * proposal wants low-confidence words underlined, and an underline UI is only worth building if it
 * does not turn the whole transcript into noise — so the reading that decides it is "at this
 * threshold, how many marks per 100 characters would appear". This module produces that reading as
 * a pure function and nothing else: no DOM, no Node builtin, no logging, no rendering. The future
 * underline UI and the offline report script are both meant to call it, which is why it lives in
 * the repository-root `shared/` tree (ADR-004 decision 2) rather than beside either of them.
 *
 * THE CALIBRE IS THE OFFLINE EXPERIMENT'S, ONE-FOR-ONE. `experiments/voice-index-loop/sim/
 * sv-eval2.mjs` already defines what a "flag" is (R1), and the point of this task is that the
 * number read off a live recording and the number read off the experiment are the same number —
 * so the two definitions may not drift. Concretely, and this is the whole of the contract:
 *
 *   · A token's character interval is the running concatenation of the tokens' TEXTS with `▁`
 *     (the local engine's word-boundary marker) read as a space, minus the leading whitespace the
 *     whole string starts with. `sv-eval2.mjs`'s `tokSpans` builds exactly this, including the
 *     `Math.max(0, …)` clamp: a fixture whose first token begins before the trimmed text still
 *     lands on index 0 rather than on a negative one.
 *   · A FLAG is one maximal run of ADJACENT tokens whose confidence is strictly below the
 *     threshold — neighbouring low-confidence tokens merge into a single flag. Scattered low tokens
 *     are separate flags. A token with no confidence is never low (absent means the recogniser
 *     declared none), which is what makes the `undefined` reading match the experiment's
 *     `undefined < theta === false`.
 *   · `flagsLatin` counts only those runs whose sliced text contains a Latin letter or a digit —
 *     the experiment's `/[A-Za-z0-9]/` test over the segment, used to isolate the marks that fall
 *     on the code-switched / identifier half of a transcript.
 *
 * WHAT IS DELIBERATELY NOT HERE. The rate is a plain `100 * flags / chars` with no rounding; the
 * experiment rounds only at print time (`toFixed(2)`), and a stored statistic that has already been
 * rounded cannot be re-aggregated. `chars` is the caller's text length, so a caller summing over a
 * corpus sums the flags and the characters separately rather than averaging the rates.
 *
 * `chars === 0` (empty text) answers `0` for both rates rather than `NaN`: "no characters, no marks
 * per hundred characters" is the only reading a division by zero can legitimately have here, and a
 * `NaN` would poison every aggregate it touched.
 */

/**
 * One recognised token, as much of it as this file needs.
 *
 * A STRUCTURAL TYPE RATHER THAN AN IMPORT. `AsrToken` in `asrRegistry.ts` carries `startMs` too and
 * is the wire's/frontend's spelling; naming it here would make this environment-neutral module
 * depend on the registry (and, transitively, on every adapter) for a field it never reads. A
 * recogniser's token array is assignable to this shape by structure, so `voice.service.ts` hands
 * over its `AsrToken[]` without a cast while the offline script's `{ tok, p }` can be mapped at its
 * edge.
 */
export type ConfidenceFlagToken = {
  /** The token's own text; `▁` marks a word boundary the way the local engine emits it. */
  text: string;
  /** The recogniser's confidence in this token, in `[0, 1]`. Absent means it declared none. */
  confidence?: number;
};

/** The mark count at one threshold, plus the two per-100-character rates. */
export type ConfidenceFlagTheta = {
  /** The threshold the counts below were taken at. */
  theta: number;
  /** Maximal runs of adjacent tokens with `confidence < theta`. */
  flags: number;
  /** Of `flags`, the ones whose run text contains a Latin letter or digit. */
  flagsLatin: number;
  /** `flags` per 100 characters of the text; `0` when the text is empty. */
  flagsPer100Chars: number;
  /** `flagsLatin` per 100 characters of the text; `0` when the text is empty. */
  flagsLatinPer100Chars: number;
};

/** What `flagStats` answers: the text length and one row per requested threshold. */
export type ConfidenceFlagStats = {
  /** The length of the text the marks were counted against. */
  chars: number;
  byTheta: ConfidenceFlagTheta[];
};

/**
 * The thresholds the shadow reads at, matching the offline experiment's sweep.
 *
 * A default rather than a constant the caller cannot change: a future report that wants a finer
 * sweep calls `flagStats(text, tokens, [...])` and gets its own rows in the order it asked for.
 */
export const DEFAULT_CONFIDENCE_THETAS = [0.5, 0.6, 0.7, 0.8] as const;

type TokenSpan = { start: number; end: number; confidence: number | undefined };

/**
 * Each token's interval in the text, by the offline experiment's rule (see the header).
 *
 * `positions[i]` is the length of the concatenation of everything BEFORE token `i`, so the token's
 * own interval is `[positions[i], positions[i] + len(token_i))` measured on `raw`; subtracting the
 * leading whitespace count shifts the whole thing onto the trimmed text. `replace('▁', ' ')` with a
 * string replaces only the first occurrence — kept exactly as the experiment has it, so a token
 * that somehow carried two markers would read the same on both sides.
 */
function tokenSpans(tokens: readonly ConfidenceFlagToken[]): TokenSpan[] {
  let raw = '';
  const positions: number[] = [];
  for (const token of tokens) {
    positions.push(raw.length);
    raw += token.text.replace('▁', ' ');
  }
  const lead = raw.length - raw.trimStart().length;
  return tokens.map((token, index) => {
    const length = token.text.replace('▁', ' ').length;
    return {
      start: Math.max(0, positions[index] - lead),
      end: Math.max(0, positions[index] + length - lead),
      confidence: token.confidence,
    };
  });
}

/** Whether a token's confidence is below `theta`; a missing confidence is never below. */
function isLow(confidence: number | undefined, theta: number): boolean {
  return typeof confidence === 'number' && confidence < theta;
}

/** The two mark counts at one threshold, by the run-merging rule in the header. */
function countFlags(
  spans: readonly TokenSpan[],
  text: string,
  theta: number,
): { flags: number; flagsLatin: number } {
  let flags = 0;
  let flagsLatin = 0;
  let index = 0;
  while (index < spans.length) {
    if (isLow(spans[index].confidence, theta)) {
      let last = index;
      while (last + 1 < spans.length && isLow(spans[last + 1].confidence, theta)) {
        last += 1;
      }
      const segment = text.slice(spans[index].start, spans[last].end);
      flags += 1;
      if (/[A-Za-z0-9]/.test(segment)) {
        flagsLatin += 1;
      }
      index = last + 1;
    } else {
      index += 1;
    }
  }
  return { flags, flagsLatin };
}

/** `count` per 100 characters, with the empty-text reading pinned to zero. */
function per100Chars(count: number, chars: number): number {
  return chars === 0 ? 0 : (100 * count) / chars;
}

/**
 * Counts the marks a confidence sweep would draw on `text` with `tokens`, at each threshold.
 *
 * The one entry point: `voice.service.ts` calls it to fill a record's `flagStats`, and the offline
 * report script and the unit criterion call it to compare against `sv-eval2.mjs`. It reads only its
 * arguments — no clock, no environment, no module state — so the same input answers the same rows
 * in every caller.
 */
export function flagStats(
  text: string,
  tokens: readonly ConfidenceFlagToken[],
  thetas: readonly number[] = DEFAULT_CONFIDENCE_THETAS,
): ConfidenceFlagStats {
  const chars = text.length;
  const spans = tokenSpans(tokens);
  return {
    chars,
    byTheta: thetas.map((theta) => {
      const { flags, flagsLatin } = countFlags(spans, text, theta);
      return {
        theta,
        flags,
        flagsLatin,
        flagsPer100Chars: per100Chars(flags, chars),
        flagsLatinPer100Chars: per100Chars(flagsLatin, chars),
      };
    }),
  };
}
