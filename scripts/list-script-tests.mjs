#!/usr/bin/env node
// Prints the script-test files that `npm run test:scripts` is about to run.
//
// Why this exists instead of relying on the runner's own output: `node --test` names a test FILE
// only when that file FAILS — the spec and tap reporters list failing files and never passing ones
// — so a green run is silent about what it executed, and a glob that quietly stopped matching
// looks exactly like a glob that matched everything. This line puts the covered set on every run.
//
// It is also the fail-closed half. `node --test "scripts/**/*.test.mjs"` exits 0 when the glob
// matches NOTHING (measured), so without the throw below a stale or misspelled glob would keep
// reporting success forever, with zero tests run. The throw is what converts that into a failure.
//
// The pattern is repeated verbatim from package.json's `test:scripts`, and `**` carries the same
// zero-or-more-segments meaning in node:fs.globSync as it does in the runner's own matcher, so the
// announced set is the executed set.

import { globSync } from 'node:fs';

const PATTERN = 'scripts/**/*.test.mjs';

const files = globSync(PATTERN).sort();

if (files.length === 0) {
  throw new Error(`no script test files matched ${PATTERN} — the test:scripts glob is stale`);
}

console.log(`script test files (${files.length}):`);
for (const file of files) {
  console.log(`  ${file}`);
}
