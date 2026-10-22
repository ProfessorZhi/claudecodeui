/** The backend rejects rules longer than this. */
const MAX_PATTERN_LENGTH = 200;

/**
 * Variable fragments of a session name, tried in this order at each position:
 * timestamps, then hex hashes (8+ chars), then plain digit runs.
 */
const VARIABLE_FRAGMENT =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?|(?<![0-9a-z])[0-9a-f]{8,}(?![0-9a-z])|\d+/gi;

const FRAGMENT_WILDCARDS = {
  timestamp: '\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?)?',
  hash: '[0-9a-f]{8,}',
  digits: '\\d+',
} as const;

/** Machine-style names (task-worker-3, agent_a1b2…) versus human sentences. */
const IDENTIFIER_NAME = /^[\w.-]+$/;

const escapeRegexLiteral = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const classifyFragment = (fragment: string) => {
  if (/^\d{4}-\d{2}-\d{2}/.test(fragment)) return FRAGMENT_WILDCARDS.timestamp;
  if (/^\d+$/.test(fragment)) return FRAGMENT_WILDCARDS.digits;
  return FRAGMENT_WILDCARDS.hash;
};

const buildBody = (source: string) => {
  let body = '';
  let cursor = 0;
  for (const match of source.matchAll(VARIABLE_FRAGMENT)) {
    body += escapeRegexLiteral(source.slice(cursor, match.index));
    body += classifyFragment(match[0]);
    cursor = match.index + match[0].length;
  }
  body += escapeRegexLiteral(source.slice(cursor));
  return body;
};

/**
 * Turns a session name into one session-filter rule that also covers its
 * siblings. Machine-style names become an unanchored pattern (the rule engine is
 * case-insensitive and unanchored), with numbers, hashes and timestamps
 * generalised. Human sentences are anchored so a rule never hides unrelated
 * titles that merely contain the text. Returns '' for a blank name.
 *
 * Used by SessionOptions' "hide similar" action.
 */
export function deriveSimilarNamePattern(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';

  const isIdentifier = IDENTIFIER_NAME.test(trimmed);
  for (let length = trimmed.length; length > 0; length -= 1) {
    const truncated = length < trimmed.length;
    const body = buildBody(trimmed.slice(0, length));
    const pattern = !isIdentifier ? `^${body}${truncated ? '' : '$'}` : body;
    if (pattern.length <= MAX_PATTERN_LENGTH) return pattern;
  }
  return '';
}
