import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { test } from 'vitest';

import { repairIdentifiers } from '@/shared/identifierRepair';

// A slice of a project's file tree plus one symbol, which is what the caller
// has: real names, and the text a recogniser produced from speech.
const CANDIDATES = [
  'App.tsx',
  'README.md',
  'index.ts',
  'package.json',
  'useVoiceInput',
  'voice.routes.ts',
  'voice.service.ts',
  'voiceConfig.ts',
  'voiceIdentifierRepair.ts',
];

test('a misheard file name is repaired to the name the project really has', () => {
  assert.equal(
    repairIdentifiers('open voiceConfg.ts and check', CANDIDATES),
    'open voiceConfig.ts and check',
  );
});

test('a sentence with no identifier in it comes back character for character', () => {
  // Every one of these tokens is a trap for a looser matcher: `ends.` and
  // `readme.` are one edit from a real extension, `3.14` looks like a dotted
  // name, and `e.g.` is a dotted token whose opening matches nothing.
  const prose = 'I looked at how the file ends. Then read the readme. 3.14 and e.g. matter.';

  assert.equal(repairIdentifiers(prose, CANDIDATES), prose);
});

test('a symbol the recogniser split into words is put back together', () => {
  assert.equal(
    repairIdentifiers('check use voice input before the change', CANDIDATES),
    'check useVoiceInput before the change',
  );
});

test('prose shaped exactly like the split symbol is left alone', () => {
  // "look at how" and "use voice input" are the same shape — three lowercase
  // words — so this is the case that rules out every threshold-based match on
  // the split half. Only the one that is the symbol may be rewritten.
  const prose = 'look at how it behaves';

  assert.equal(repairIdentifiers(prose, CANDIDATES), prose);
});

test('a token spelled without its extension is not matched to a name that has one', () => {
  // Without the dotted/dotless split this one is a single edit from `README.md`
  // with a similarity of 0.89: the two halves of the candidate list must never
  // see each other.
  const text = 'readmemd';

  assert.equal(repairIdentifiers(text, CANDIDATES), text);
});

test('names that do not open alike are never treated as each other', () => {
  // Two edits from `voiceConfig.ts` at a similarity of 0.86 — the opening is
  // the only thing that says this is a different name rather than a typo.
  const text = 'rename boiceConfg.ts';

  assert.equal(repairIdentifiers(text, CANDIDATES), text);
});

test('a name too short to be a typo of a candidate is not stretched into it', () => {
  // `voiceIdentifier.ts` shares the opening and is a plausible edit of
  // `voiceIdentifierRepair.ts`, but seven characters of difference is not a
  // mishearing. This is the case the length guard settles on its own: with the
  // guard degraded to a finite sentinel, the similarity of the surviving
  // characters reads as 0.88 and the name is stretched.
  const text = 'the voiceIdentifier.ts file';

  assert.equal(repairIdentifiers(text, CANDIDATES), text);
});

test('a name already spelled correctly is kept, in its own spelling', () => {
  assert.equal(
    repairIdentifiers('open voiceConfig.ts and use voice input', CANDIDATES),
    'open voiceConfig.ts and useVoiceInput',
  );
});

test('a name whose middle segment is long is still a name', () => {
  // The observed shape this module exists for: whisper returns `voice.seluis.ts`
  // for `voice.service.ts`. It is four edits — a hard repair, and the reason the
  // pass pays more than two — but the segment that got mangled is six
  // characters, so a rule that reads every `.segment` as a one-to-five letter
  // extension never even looks at the token.
  assert.equal(
    repairIdentifiers('open voice.seluis.ts and check', CANDIDATES),
    'open voice.service.ts and check',
  );
});

test('an identifier written against Chinese with no space is still found', () => {
  // Chinese is written without spaces, so a whitespace tokeniser sees one token
  // here and the identifier inside it is never a candidate for anything. The
  // same token in English prose is repaired; it must be repaired in Chinese too.
  assert.equal(
    repairIdentifiers('改一下。voice.roue.ts', CANDIDATES),
    '改一下。voice.routes.ts',
  );
});

test('the extension is misheard by one edit, and by one edit only', () => {
  // The two sides of the guard that keeps a widened budget from rewriting one
  // file name into another. `.js` for `.ts` is a mishearing and the whole point
  // is to fix it; `.io` for `.ts` is a different name, and repairing it is the
  // failure mode — an agent sent to edit a file that was never mentioned. Both
  // are inside the edit budget; only the first is inside the extension's.
  assert.equal(
    repairIdentifiers('deploy voice.service.js now', CANDIDATES),
    'deploy voice.service.ts now',
  );
  const other = 'deploy voice.service.io now';

  assert.equal(repairIdentifiers(other, CANDIDATES), other);
});

test('a name is not shortened by dropping one of its dotted words', () => {
  // The other thing a widened budget reaches on real prose. `README.jp.md` is
  // three edits from `README.md` at a similarity of exactly 0.75 with the
  // extension intact, so the opening, the budget and the extension guard all
  // pass it — and the repair writes a file the text never mentioned. A
  // recogniser garbles characters inside a name; it does not delete a whole
  // dot-separated word, which is the only way the two differ.
  const prose = 'the README.jp.md translation is missing';

  assert.equal(repairIdentifiers(prose, CANDIDATES), prose);
});

test('a single ordinary word is not a split symbol', () => {
  // The candidate list carries bare stems, so one word can equal one. It is not
  // a split: nobody says `README` and produces `readme`. Without this the module
  // rewrites ordinary prose — "the readme file is old" becomes "the README file
  // is old" — which is the failure the split pass is written to avoid.
  const prose = 'the readme file is old';

  assert.equal(repairIdentifiers(prose, CANDIDATES), prose);
});

test('the answer does not depend on the order the candidates arrive in', () => {
  const text = 'open voiceConfg.ts';

  assert.equal(
    repairIdentifiers(text, CANDIDATES),
    repairIdentifiers(text, [...CANDIDATES].reverse()),
  );
});

test('the module is a pure string function sitting beside voiceConfig.ts', () => {
  // The `@` alias maps to `src`, so the import at the top of this file resolves
  // to this path. Reading it here is what pins the module to `src/shared`,
  // beside the voice config it is meant to sit next to instead of inside a
  // module folder, and the neighbour is checked first so the pair is real.
  const sharedDir = resolve(process.cwd(), 'src', 'shared');
  assert.equal(statSync(join(sharedDir, 'voiceConfig.ts')).isFile(), true);

  const source = readFileSync(join(sharedDir, 'identifierRepair.ts'), 'utf8');

  // Nothing may be pulled in except local code and node builtins: that is what
  // "no React dependency" means for a module that is meant to run anywhere.
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map(
    (match) => match[1],
  );
  for (const specifier of specifiers) {
    assert.match(specifier, /^(?:node:|@\/|\.)/, `unexpected dependency: ${specifier}`);
  }

  // And it may not reach for the DOM, which would make it unusable anywhere the
  // transcription itself runs.
  for (const global of ['document', 'window', 'HTMLElement', 'localStorage', 'navigator']) {
    assert.equal(
      new RegExp(`\\b${global}\\b`).test(source),
      false,
      `the module must not touch ${global}`,
    );
  }
});

test('the harness holds no second copy of the repair algorithm', () => {
  // Two copies of one algorithm drift, and these two did: measured on the
  // AC-113 recovery corpus with this repository's own file list as candidates,
  // they agreed on 10 of 16 entries and disagreed on 6 — every one of the six a
  // case the copy repaired and the shipped module did not. A criterion pointed
  // at the copy was reporting a survival rate the app could never produce.
  //
  // So the algorithm is the module's alone. This is AC-3's grep, in the place
  // that runs on every commit rather than once by hand.
  const harness = readFileSync(
    resolve(process.cwd(), 'experiments', 'voice-identifiers', 'identifierRepair.mjs'),
    'utf8',
  );

  for (const name of ['editDistance', 'splitIndex', 'nearestDottedCandidate', 'longestSplitMatch']) {
    assert.equal(
      new RegExp(`function\\s+${name}\\b`).test(harness),
      false,
      `the harness must not define ${name} again`,
    );
  }

  // The absence above is only worth asserting together with the presence: a
  // harness that re-exported nothing would pass it and measure nothing.
  assert.match(harness, /from '\.\.\/\.\.\/src\/shared\/identifierRepair\.ts'/);
});
