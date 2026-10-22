#!/usr/bin/env node
/**
 * AC-112 — repair must leave identifier-free text alone, measured on the
 * SHIPPED module.
 *
 * Same corpus and same claims as the runner this replaces; the difference is
 * which implementation is asked. `repairIdentifiers` here is imported from
 * `src/shared/identifierRepair.ts`, so a zero here is a statement about the app
 * rather than about a harness-local copy that could pass while the app failed.
 *
 * This is also the reverse reading for the dotted pass. That pass was widened —
 * its segments are no longer capped at five characters and it scans for the
 * shape inside a token instead of demanding the whole token be one — and a
 * widening that is only ever measured on recovery is measured on one side. The
 * near-miss entries below are the other side: ordinary phrases that sit one edit
 * from a real file name, which is exactly what a matcher without guards rewrites.
 *
 * The candidate set is the repository's real file list (`git ls-files`), not a
 * toy vocabulary. That matters: with a real list the module is asked to choose
 * between ~2k names, so any threshold-only matcher has plenty of chances to
 * "repair" an ordinary word into a name that exists.
 *
 * The corpus is not a list of unrelated sentences — those cannot fail, because
 * nothing in them is close to a candidate. At least twelve of the entries carry
 * a phrase one edit distance from a real file name; those are the ones a
 * similarity-only implementation rewrites.
 *
 * Run from anywhere; the repository is located from this file's own path:
 *   npx tsx experiments/voice-identifiers/run-shipped-false-positive.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  editDistance,
  normalizeSymbol,
  repairIdentifiers,
} from '../../src/shared/identifierRepair.ts';
import { projectCandidates } from './identifierRepair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const MIN_CANDIDATES = 1000;
const MIN_NEAR_WORDS = 12;

/**
 * The positive control, without which this whole run is satisfied by a module
 * that does nothing at all.
 *
 * Forty-four sentences that must come back unchanged is a claim an identity
 * function satisfies perfectly — measured, and that is how the hole was found.
 * A repair module that cannot repair is not a careful module, it is a broken
 * one, so every sentence below is a shape the module is required to fix: the
 * same corpus the recovery runner counts, reduced to one case per mechanism, in
 * both scripts and in Chinese, where the identifier is glued to a character with
 * no space to split on.
 *
 * Nothing here is a claim about the negative corpus. It is the floor beneath it:
 * a zero that a stub also scores is not a reading.
 */
const CONTROLS = [
  { text: 'Change the timeout in voice.seluis.ts to thirty seconds', expect: 'Change the timeout in voice.service.ts to thirty seconds' },
  { text: '改一下。voice.roue.ts', expect: '改一下。voice.routes.ts' },
  { text: 'check use voice input before the change', expect: 'check useVoiceInput before the change' },
];

const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'negative.json'), 'utf8'));
const { candidates } = projectCandidates({ cwd: REPO_ROOT });
const live = new Set(candidates);

const problems = [];
const controlFailures = [];
const falsePositives = [];
let nearWords = 0;

for (const control of CONTROLS) {
  const text = repairIdentifiers(control.text, candidates);
  if (text !== control.expect) {
    controlFailures.push(`${JSON.stringify(control.text)} -> ${JSON.stringify(text)}, expected ${JSON.stringify(control.expect)}`);
  }
}

for (const entry of fixture.entries) {
  if (entry.near) {
    const { word, of } = entry.near;
    if (!live.has(of)) {
      problems.push(`${entry.id}: near.of "${of}" is not a candidate any more`);
    } else {
      const d = editDistance(normalizeSymbol(word), normalizeSymbol(of));
      if (d !== 1) problems.push(`${entry.id}: "${word}" is ${d} edits from "${of}", not 1`);
      else nearWords++;
    }
  }

  const text = repairIdentifiers(entry.text, candidates);
  if (text !== entry.text) falsePositives.push({ entry, text });
}

// The readings the criterion pins, on the first line and in this order.
console.log(`candidates=${candidates.length} negatives=${fixture.entries.length} falsePositives=${falsePositives.length}`);
console.log(`nearWords=${nearWords} minNearWords=${MIN_NEAR_WORDS} minCandidates=${MIN_CANDIDATES} controls=${CONTROLS.length - controlFailures.length}/${CONTROLS.length}`);

for (const { entry, text } of falsePositives) {
  console.log(`  FP ${entry.id} [${entry.lang}] ${JSON.stringify(entry.text)}`);
  console.log(`     -> ${JSON.stringify(text)}`);
}
for (const c of controlFailures) console.log(`  CONTROL ${c}`);
for (const p of problems) console.log(`  FIXTURE ${p}`);

if (candidates.length < MIN_CANDIDATES) {
  console.error(`FAIL: only ${candidates.length} candidates from git ls-files, need >= ${MIN_CANDIDATES}`);
  process.exit(1);
}
if (nearWords < MIN_NEAR_WORDS) {
  console.error(`FAIL: only ${nearWords} near-miss entries verified, need >= ${MIN_NEAR_WORDS}`);
  process.exit(1);
}
if (problems.length) {
  console.error(`FAIL: ${problems.length} fixture claim(s) no longer hold`);
  process.exit(1);
}
if (controlFailures.length) {
  console.error(`FAIL: ${controlFailures.length} of ${CONTROLS.length} sentences that must be repaired were not — the zero below is a stub's zero`);
  process.exit(1);
}
if (falsePositives.length) {
  console.error(`FAIL: ${falsePositives.length} of ${fixture.entries.length} identifier-free sentences were rewritten`);
  process.exit(1);
}

console.log(`OK: ${fixture.entries.length} identifier-free sentences unchanged over ${candidates.length} real candidates`);
