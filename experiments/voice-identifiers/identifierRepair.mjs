/**
 * Harness bridge — the way a runner reaches the shipped repair algorithm.
 *
 * This file used to hold a second implementation of that algorithm, ported from
 * the out-of-repo harness before the module existed. It no longer does. Two
 * copies of one algorithm drift, and these two did: measured on the AC-113
 * recovery corpus with the repository's own `git ls-files` as the candidate set,
 * they agreed on 10 of 16 entries and disagreed on 6 — every one of the six a
 * case the copy repaired and the shipped module did not. A criterion written
 * against the copy was therefore reporting a survival rate the app could not
 * produce.
 *
 * So the algorithm lives in exactly one place, `src/shared/identifierRepair.ts`,
 * and this file re-exports it. There is nothing here to drift: the names below
 * are the shipped module's own, and the four functions that used to be defined
 * here (`editDistance`, `splitIndex`, `nearestDottedCandidate`,
 * `longestSplitMatch`) now exist only in the module. The unit test beside the
 * module asserts that mechanically.
 *
 * What stays is what is genuinely harness-side and must never enter the shipped
 * module: enumerating candidate names from the repository's git index, which
 * needs `child_process` and would poison a module the browser also imports.
 *
 * The re-export is written with the `.ts` extension because plain `node` (v22.18
 * and later, and v24 here) strips types on import, so both `node` and `tsx` can
 * load this bridge. That is what keeps AC-112's recorded criterion — `node
 * experiments/voice-identifiers/run-false-positive.mjs` — working unchanged
 * while measuring the shipped module instead of a copy.
 */

import { execFileSync } from 'node:child_process';

export {
  editDistance,
  normalizeSymbol,
  repairIdentifiers,
} from '../../src/shared/identifierRepair.ts';

/**
 * Every name this app can enumerate for free: each file's basename AND the bare
 * symbol it exports.
 *
 * The bare form is what makes English recovery work at all. Whisper renders a
 * spoken camelCase symbol as ordinary words — `useVoiceInput` comes back as
 * "Use voice input" — which carries no dot, so a filename-only candidate list
 * cannot match it. Offering `useVoiceInput` beside `useVoiceInput.ts` turns a
 * case-and-spacing error into an exact match, which is the single largest class
 * of English failure and costs nothing to fix.
 */
export function fileCandidates(paths) {
  const out = new Set();
  for (const p of paths) {
    const base = p.split('/').pop();
    if (!base) continue;
    out.add(base);
    const stem = base.replace(/\.[a-z]{1,5}$/i, '');
    if (stem && stem !== base) out.add(stem);
  }
  return [...out];
}

/**
 * The candidate set, taken live from the repository's own index.
 *
 * `git ls-files` rather than a walk: the list is exactly what the app can
 * enumerate for the project, it is what the file-tree endpoint would return,
 * and it needs no ignore rules of its own. No path outside the repository is
 * consulted, so the harness is reproducible in CI.
 */
export function projectCandidates({ cwd = process.cwd() } = {}) {
  const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const paths = out.split('\n').filter(Boolean);
  return { paths, candidates: fileCandidates(paths) };
}
