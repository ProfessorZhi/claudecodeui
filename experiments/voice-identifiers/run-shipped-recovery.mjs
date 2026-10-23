#!/usr/bin/env node
/**
 * AC-113 — repair restores misspelled identifiers to real file names, measured
 * on the SHIPPED module.
 *
 * The distinction is the whole point of this runner existing. AC-113's earlier
 * criterion ran `run-recovery.mjs`, which measured a copy of the algorithm that
 * lived in this directory; on the same corpus the two disagreed on 6 of 16
 * entries, so the survival rate it reported was one the app could never produce.
 * This file imports `src/shared/identifierRepair.ts` — the module the app calls
 * — and nothing else implements the algorithm, so the reading below describes
 * the product.
 *
 * Measured on transcript shapes that were actually observed coming back from
 * the recogniser, not on invented typos: `voice.service.ts` arriving as
 * `voice.seluis.ts`, `useVoiceInput` arriving as "Use voice input", and
 * `voice.module.ts` arriving as `voice.module.t`.
 *
 * Two readings matter and they are not the same reading:
 *
 *   survivalBefore -> survivalAfter   the repair has to actually help.
 *   misRepairs                        how often it helped by inventing a name
 *                                     the reference never contained. A repair
 *                                     that "improves" survival by writing a
 *                                     plausible-but-wrong file into the
 *                                     transcript is worse than no repair at
 *                                     all: that is the failure that sends an
 *                                     agent to edit the wrong file.
 *
 * The module returns the repaired text and nothing else, so a mis-repair is read
 * off the text: an identifier the repaired transcript has, the original
 * transcript did not, and the reference does not name. That is the same claim
 * the retired runner made about its own repair list, stated in terms of the one
 * thing the shipped module promises to return.
 *
 * Run from anywhere; the repository is located from this file's own path:
 *   npx tsx experiments/voice-identifiers/run-shipped-recovery.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repairIdentifiers } from '../../src/shared/identifierRepair.ts';
import { identifierFidelity, identifiers } from './identifierFidelity.mjs';
import { projectCandidates } from './identifierRepair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const MIN_CANDIDATES = 1000;
const MIN_ENTRIES = 12;

const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'recovery.json'), 'utf8'));
const { candidates } = projectCandidates({ cwd: REPO_ROOT });

let before = 0;
let after = 0;
let total = 0;
const misRepairs = [];
const rows = [];

for (const entry of fixture.entries) {
  const referenceIds = identifiers(entry.reference);
  const spokenIds = identifiers(entry.transcript);
  const repaired = repairIdentifiers(entry.transcript, candidates);

  const b = identifierFidelity(entry.reference, entry.transcript);
  const a = identifierFidelity(entry.reference, repaired);

  const written = identifiers(repaired).filter((id) => !spokenIds.includes(id));
  for (const id of written) {
    if (!referenceIds.includes(id)) misRepairs.push({ id: entry.id, wrote: id, referenceIds });
  }

  before += b.survived;
  after += a.survived;
  total += b.total;
  rows.push({ id: entry.id, b, a, text: repaired, written });
}

const rate = (n) => (total ? n / total : 0);
const survivalBefore = rate(before);
const survivalAfter = rate(after);

// The readings the criterion pins, on the first line and in this order.
console.log(`survivalBefore=${survivalBefore.toFixed(4)} survivalAfter=${survivalAfter.toFixed(4)} misRepairs=${misRepairs.length}`);
console.log(`candidates=${candidates.length} entries=${fixture.entries.length} identifiers=${total}`);
console.log(`survivalBeforeDetail=${before}/${total} survivalAfterDetail=${after}/${total}`);

for (const row of rows) {
  const mark = row.a.survived > row.b.survived ? 'FIXED' : row.a.survived < row.b.survived ? 'BROKE' : 'flat ';
  console.log(`  ${mark} ${row.id} ${row.b.survived}/${row.b.total} -> ${row.a.survived}/${row.a.total} wrote=${JSON.stringify(row.written)}`);
}
for (const m of misRepairs) {
  console.log(`  MISREPAIR ${m.id}: wrote "${m.wrote}" not among reference identifiers ${JSON.stringify(m.referenceIds)}`);
}

if (candidates.length < MIN_CANDIDATES) {
  console.error(`FAIL: only ${candidates.length} candidates from git ls-files, need >= ${MIN_CANDIDATES}`);
  process.exit(1);
}
if (fixture.entries.length < MIN_ENTRIES) {
  console.error(`FAIL: only ${fixture.entries.length} observed-shape entries, need >= ${MIN_ENTRIES}`);
  process.exit(1);
}
if (misRepairs.length) {
  console.error(`FAIL: ${misRepairs.length} repair(s) wrote a name the reference never contained`);
  process.exit(1);
}
// Strictly greater, not "greater by a margin": the invariant this pins is that
// repair helps, and the measurement is deterministic, so there is no noise for a
// margin to absorb.
if (!(survivalAfter > survivalBefore)) {
  console.error(`FAIL: survival did not improve (${survivalBefore.toFixed(4)} -> ${survivalAfter.toFixed(4)})`);
  process.exit(1);
}

console.log(`OK: shipped identifier survival ${(survivalBefore * 100).toFixed(1)}% -> ${(survivalAfter * 100).toFixed(1)}% with zero mis-repairs`);
