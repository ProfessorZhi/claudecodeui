import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { namedFailingFiles, extractedFailingFiles } from './quay-attribution-probe.mjs';

const fixture = fs.readFileSync(fileURLToPath(new URL('./__fixtures__/fan-in-suite-lint-failure.log', import.meta.url)), 'utf8');
// the plugin's regex as of quay 0.10.0 (quay-repo test layout only)
const PLUGIN_RE = /(?:^|\s|\/)((?:packages|plugin|experiments)\/[^\s]+\.test\.mjs)\s+passed=false\b/;

test('named failing files come from not-ok lines only, never the pathless lint pseudo-file', () => {
  assert.deepEqual(namedFailingFiles(fixture), ['server/modules/launch-profiles/tests/model-context-window.test.ts']);
});

test('lines without a file path name nothing', () => {
  assert.deepEqual(namedFailingFiles('not ok - lint: something broke\n__PERFILE__ lint passed=false\n'), []);
});

test('quay-layout regex extracts zero files from this repo log', () => {
  assert.deepEqual(extractedFailingFiles(fixture, PLUGIN_RE), []);
});

test('a covering regex extracts the named file', () => {
  const re = /(?:^|\s)((?:server|src)\/[^\s]+\.test\.tsx?)\s+passed=false\b/;
  const log = '__PERFILE__ duration_ms=1 server/a/b.test.ts passed=false end_ms=2\n';
  assert.deepEqual(extractedFailingFiles(log, re), ['server/a/b.test.ts']);
});
