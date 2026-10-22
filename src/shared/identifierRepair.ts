/**
 * Repairs the identifiers a voice transcript got wrong, using names the project
 * really has.
 *
 * A recogniser never emits a file name. Ask for `voiceConfig.ts` and it hands
 * back "voice config.ts"; say `useVoiceInput` and it hands back "use voice
 * input", one symbol shredded into three words. Neither needs a model to fix,
 * because the candidate set is the project's own file tree — everything the
 * repair needs is a string comparison against names that already exist.
 *
 * There are two failure shapes and they need opposite rules, so there are two
 * passes:
 *
 *  - a dotted token is a *typo*, so it is matched by edit distance;
 *  - a run of words is a *split*, so it is matched by exact equality once
 *    whitespace and case are removed.
 *
 * Everything here is a pure function of its arguments — no DOM, no React, no
 * network, no model, no clock. The caller owns where the candidates come from
 * and what to do with the result.
 */

/**
 * The most edits the dotted pass will pay for. It is also the pruning bound
 * handed to `editDistance`: two names whose lengths differ by more than this
 * cannot be each other's typo, whatever edit script connects them.
 *
 * Four, not two. The cap is a ceiling, not the working budget — `MIN_SIMILARITY`
 * is what scales with the name, and for anything shorter than sixteen
 * characters the similarity floor binds first. Four is the observed shape: the
 * recogniser really does return `voice.seluis.ts` for `voice.service.ts`, four
 * edits in a fifteen-character name, and that is the failure this module exists
 * for. A flat cap of two made the budget unreachable for every name long enough
 * to be worth repairing, which is how the dotted half came to be dead code on
 * exactly the shapes the recogniser produces.
 */
const MAX_EDIT_DISTANCE = 4;

/**
 * How much of the longer name has to survive the edit. A raw distance is not
 * enough on its own — four edits are a typo in a 20-character name and a
 * different name entirely in a 6-character one — so the edit is scaled by the
 * length it happened in.
 *
 * 0.75 is set by the same observation as the cap: `voice.seluis.ts` against
 * `voice.service.ts` is exactly 0.75, and it is a repair, not a coincidence —
 * the two share their opening, their extension and their whole shape. Below
 * this line the pairs stop being names that resemble each other and start being
 * names that merely have the same length.
 */
const MIN_SIMILARITY = 0.75;

/**
 * A mistyped name keeps its opening. Without this, short names slide into each
 * other wholesale: the last three characters of `ui.ts` and `api.ts` agree.
 */
const SHARED_PREFIX_LENGTH = 3;

/**
 * A final segment at most this long is read as an extension. It is the same
 * bound the token shape used to impose on every segment, kept only where it
 * describes something true: `.ts`, `.tsx`, `.json`, `.md`.
 */
const EXTENSION_LENGTH = 5;

/**
 * How far an extension may be from the candidate's own before the pair stops
 * being a mishearing of one name. The extension is the shortest, most
 * stereotyped part of a file name, so it survives recognition far better than
 * the stem does: `.js` for `.ts` is one edit and happens; `.io` for `.ts` is
 * two and does not.
 */
const EXTENSION_EDIT_BUDGET = 1;

/**
 * A dotted name anywhere in the text: a stem, then one or more `.segment`s, each
 * starting with a letter. Two things follow from matching the *shape* rather
 * than the whitespace-delimited token:
 *
 *  - a name is not required to stand alone. Chinese is written without spaces,
 *    so `改一下。voice.roue.ts` is one token to a whitespace tokeniser and the
 *    identifier inside it was never considered at all. Scanning finds it.
 *  - the segments after the stem are unbounded, because real ones are: the
 *    intermediate segment of `voice.service.ts` is `service`, seven characters,
 *    and a one-to-five rule made every such name invisible to this pass.
 *
 * What the shape still excludes is what keeps the pass off ordinary prose:
 * `ends.` has an empty extension and `3.14` starts its extension with a digit,
 * so neither is ever compared against a candidate and a sentence that merely
 * ends in a full stop cannot be rewritten.
 */
const DOTTED_TOKEN = /[-A-Za-z0-9_$]+(?:\.[A-Za-z][A-Za-z0-9_$]*)+/g;

/**
 * What a split symbol may have been broken across. A newline is a real line
 * break, not a recogniser's idea of a word boundary, so a run never spans one.
 */
const INLINE_SEPARATOR = /^[ \t]+$/;

/**
 * How many words a split has to be broken into before the split pass will look
 * at it.
 *
 * Two, because one word is not a split. The candidate list contains bare stems
 * as well as file names, so a single token can equal one — and then ordinary
 * prose becomes a repair target: "The readme md file is out of date" comes back
 * as "The README md file is out of date", a lowercase English word rewritten
 * into an identifier, which is precisely the failure the split pass exists to
 * avoid. A recogniser that splits a symbol produces at least two words for it;
 * nothing shorter is evidence of anything.
 */
const MIN_SPLIT_TOKENS = 2;

/** One whitespace-delimited run of the input, with where it sits. */
type Token = {
  text: string;
  /** Offset of the token's first character in the input. */
  start: number;
  /** Offset one past its last character. */
  end: number;
  /** The whitespace between the previous token and this one ('' for the first). */
  separator: string;
};

/** One span of the input to replace. */
type Replacement = {
  start: number;
  end: number;
  text: string;
};

/** Splits on whitespace while remembering where every token was. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const word = /\S+/g;
  let match = word.exec(text);

  while (match !== null) {
    const previous = tokens[tokens.length - 1];
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      separator: previous === undefined ? '' : text.slice(previous.end, match.index),
    });
    match = word.exec(text);
  }

  return tokens;
}

/**
 * Levenshtein distance, pruned by a length bound.
 *
 * The difference in length is a *lower* bound on the true distance: no edit
 * script is shorter than the number of characters one side has and the other
 * does not. So once it exceeds `maxDistance` the pair is settled — and it is
 * settled with `Infinity`, deliberately not with `maxDistance + 1`.
 *
 * The caller turns distances into similarity, and `maxDistance + 1` is a finite
 * number that reads as a near-match on a long name: a lower bound on the
 * distance becomes an upper bound on the similarity, and a threshold tested
 * against an upper bound is a false positive waiting for a long enough name.
 * `Infinity` is the honest reading of "these two cannot be within the cap".
 *
 * Exported because the harness that measures this module has to state its
 * claims in the module's own terms; a runner verifying "one edit away" with a
 * private normaliser of its own would be asserting about a different function.
 */
export function editDistance(a: string, b: string, maxDistance = Infinity): number {
  if (Math.abs(a.length - b.length) > maxDistance) return Infinity;

  const width = b.length + 1;
  let previous = new Array<number>(width);
  let current = new Array<number>(width);
  for (let column = 0; column < width; column += 1) previous[column] = column;

  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let column = 1; column < width; column += 1) {
      const substitute = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitute);
    }
    const finished = previous;
    previous = current;
    current = finished;
  }

  return previous[b.length];
}

/** How much of the longer of the two strings the given edit left standing. */
function similarity(distance: number, a: string, b: string): number {
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * The module's one normaliser for a name spoken as separate words: case folded
 * and whitespace removed, nothing else. `use voice input` and `useVoiceInput`
 * both become `usevoiceinput`, which is the equality the split pass tests.
 *
 * Exported for the same reason as `editDistance`: a fixture that claims a phrase
 * is one edit from a symbol has to be measured with the normaliser the matcher
 * itself uses, or it is measuring a different module.
 */
export function normalizeSymbol(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** How many dot-separated segments a name is written in; a name with no dot is one. */
function segmentCount(name: string): number {
  let count = 1;
  for (const character of name) if (character === '.') count += 1;
  return count;
}

/** The text after the last dot — the extension, or the whole name if there is none. */
function finalSegment(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * Whether the two names end the same way, when that ending is short enough to
 * be an extension.
 *
 * This is the guard that keeps a widened edit budget from rewriting one file
 * name into another. Once the dotted pass pays four edits at a similarity of
 * 0.75, a candidate with the same length and the same opening is reachable from
 * a great deal of prose — `socket.io` is two edits from `socket.ts`, and
 * `voicePlayer.stop` is three from `voicePlayer.ts`, both inside the budget.
 * What separates those from a real repair is that the recogniser kept the
 * extension: `voice.module.t` for `voice.module.ts` is truncation, `.js` for
 * `.ts` is one edit, and `.io` for `.ts` is neither — it is a different name.
 *
 * A final segment too long to be an extension (the stem tail of a two-segment
 * name) is not judged here; those pairs are left to the distance and similarity
 * guards like any other part of the name.
 */
function extensionSurvives(a: string, b: string): boolean {
  const left = finalSegment(a).toLowerCase();
  const right = finalSegment(b).toLowerCase();
  if (left.length > EXTENSION_LENGTH && right.length > EXTENSION_LENGTH) return true;
  if (left === right) return true;
  if (left.startsWith(right) || right.startsWith(left)) return true;

  return editDistance(left, right, EXTENSION_EDIT_BUDGET) <= EXTENSION_EDIT_BUDGET;
}

/**
 * The dotted candidate closest to `token`, or null if none is close enough.
 *
 * Five guards run, and all five are load-bearing:
 *
 *  1. only dotted candidates are considered — the caller passes exactly those,
 *     so a token spelled without its extension can never reach a name that has
 *     one (and the reverse is true by construction of the other pass);
 *  2. the two must open with the same three characters;
 *  3. the spoken form may not be written in more segments than the candidate,
 *     because a recogniser garbles characters inside a name — it does not drop
 *     one of its dot-separated words;
 *  4. the edit must leave enough of the name standing, which is what the
 *     distance-to-similarity step measures;
 *  5. the ending must be one the recogniser could plausibly have produced, which
 *     is what `extensionSurvives` decides.
 *
 * Comparison is case-folded because recognisers do not preserve case, and the
 * winner is returned with the candidate's own spelling. Ties break on the name
 * itself, so the answer does not depend on the order the caller listed them in.
 */
function nearestDottedCandidate(token: string, candidates: readonly string[]): string | null {
  const needle = token.toLowerCase();
  const opening = needle.slice(0, SHARED_PREFIX_LENGTH);
  let best: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const haystack = candidate.toLowerCase();
    if (haystack.slice(0, SHARED_PREFIX_LENGTH) !== opening) continue;

    // Written in more segments than the name it is being compared to: the
    // difference is a whole dotted word, not a misheard character. This is the
    // shape a widened budget finds on real prose — `README.jp.md` against
    // `README.md` is three edits at a similarity of exactly 0.75 with the
    // extension untouched, so every other guard passes it, and the answer is a
    // name the text never mentioned.
    if (segmentCount(needle) > segmentCount(haystack)) continue;

    const distance = editDistance(needle, haystack, MAX_EDIT_DISTANCE);
    if (!Number.isFinite(distance)) continue;
    if (similarity(distance, needle, haystack) < MIN_SIMILARITY) continue;
    if (!extensionSurvives(needle, haystack)) continue;

    if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * Indexes the dotless candidates by the shape a recogniser would leave behind
 * if it split them: whitespace removed, case removed.
 */
function splitIndex(candidates: readonly string[]): { keys: Map<string, string>; longest: number } {
  const keys = new Map<string, string>();
  let longest = 0;

  for (const candidate of candidates) {
    const key = normalizeSymbol(candidate);
    if (key.length === 0) continue;
    if (!keys.has(key)) keys.set(key, candidate);
    if (key.length > longest) longest = key.length;
  }

  return { keys, longest };
}

/**
 * The longest run of tokens starting at `start` that spells a split candidate,
 * or null.
 *
 * The test is *equality* — the run with whitespace and case removed against the
 * candidate's own form the same way — and deliberately nothing looser. The
 * tempting rule here is a similarity threshold and it cannot be made to work:
 * "use voice input" and "look at how" have exactly the same shape, three
 * lowercase words, so any threshold that accepts the first accepts the second.
 * Only one of them is the symbol. Only equality can tell them apart.
 */
function longestSplitMatch(
  tokens: readonly Token[],
  start: number,
  keys: Map<string, string>,
  longest: number,
): { end: number; text: string } | null {
  let compact = '';
  let match: { end: number; text: string } | null = null;
  const limit = Math.min(longest, tokens.length - start);

  for (let length = 1; length <= limit; length += 1) {
    const token = tokens[start + length - 1];
    if (length > 1 && !INLINE_SEPARATOR.test(token.separator)) break;

    compact += token.text.toLowerCase();
    if (compact.length > longest) break;
    if (length < MIN_SPLIT_TOKENS) continue;

    const candidate = keys.get(compact);
    if (candidate !== undefined) match = { end: start + length - 1, text: candidate };
  }

  return match;
}

/**
 * Returns `text` with every identifier-shaped mistake against `candidates`
 * repaired, and every other character exactly as it was.
 *
 * `candidates` are names the project really has. They are only read: nothing is
 * mutated, nothing is fetched, and the result depends on nothing but the two
 * arguments — the same call always produces the same string.
 */
export function repairIdentifiers(text: string, candidates: readonly string[]): string {
  if (text.length === 0 || candidates.length === 0) return text;

  const dotted: string[] = [];
  const dotless: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    if (candidate.includes('.')) dotted.push(candidate);
    else dotless.push(candidate);
  }

  const tokens = tokenize(text);
  const replacements: Replacement[] = [];

  // Pass one: dotted names, one scanned span at a time. The scan is what lets a
  // name be found inside a token rather than requiring the whole token to be
  // one, which is the difference between `change voice.roue.ts now` and
  // `改一下。voice.roue.ts`.
  for (const match of text.matchAll(DOTTED_TOKEN)) {
    const token = match[0];
    const repaired = nearestDottedCandidate(token, dotted);
    if (repaired !== null && repaired !== token) {
      const start = match.index ?? 0;
      replacements.push({ start, end: start + token.length, text: repaired });
    }
  }

  // Pass two: split symbols, a run of tokens at a time.
  if (dotless.length > 0) {
    const { keys, longest } = splitIndex(dotless);
    let index = 0;

    while (index < tokens.length) {
      const matched = longestSplitMatch(tokens, index, keys, longest);
      if (matched === null) {
        index += 1;
        continue;
      }
      const start = tokens[index];
      const end = tokens[matched.end];
      if (text.slice(start.start, end.end) !== matched.text) {
        replacements.push({ start: start.start, end: end.end, text: matched.text });
      }
      index = matched.end + 1;
    }
  }

  if (replacements.length === 0) return text;

  // The two passes find disjoint spans: a dotted span contains a dot, and every
  // token of a split match is dot-free — a dot anywhere in the run would break
  // the equality against a dotless key. The dotted pass scans the text while the
  // split pass walks tokens, so their finds can still arrive out of order.
  replacements.sort((left, right) => left.start - right.start);

  let repaired = '';
  let cursor = 0;
  for (const replacement of replacements) {
    repaired += text.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }

  return repaired + text.slice(cursor);
}
