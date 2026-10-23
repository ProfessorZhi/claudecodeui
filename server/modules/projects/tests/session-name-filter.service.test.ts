import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileSessionFilter,
  compileStoredSessionFilter,
  validateSessionFilter,
} from '@/modules/projects/services/session-name-filter.service.js';

test('validateSessionFilter accepts valid patterns and treats null as empty', () => {
  assert.deepEqual(validateSessionFilter(['-task-worker$', '^tmp']), { ok: true, hide: ['-task-worker$', '^tmp'] });
  assert.deepEqual(validateSessionFilter(null), { ok: true, hide: [] });
});

test('validateSessionFilter rejects an invalid regex and reports its 1-based line', () => {
  const result = validateSessionFilter(['ok', '(unclosed', 'also-ok']);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.line, 2);
    assert.match(result.error, /Line 2/);
  }
});

test('validateSessionFilter rejects over-long patterns and too many patterns', () => {
  const tooLong = validateSessionFilter(['a', 'b'.repeat(201)]);
  assert.equal(tooLong.ok, false);
  assert.equal(!tooLong.ok && tooLong.line, 2);

  const tooMany = validateSessionFilter(Array.from({ length: 21 }, (_, index) => `p${index}`));
  assert.equal(tooMany.ok, false);
  assert.equal(validateSessionFilter(Array.from({ length: 20 }, (_, index) => `p${index}`)).ok, true);
});

test('validateSessionFilter rejects non-array and empty-string entries', () => {
  assert.equal(validateSessionFilter('abc').ok, false);
  const result = validateSessionFilter(['x', '']);
  assert.equal(!result.ok && result.line, 2);
});

test('compileSessionFilter merges patterns, ignores case and is unanchored', () => {
  const matcher = compileSessionFilter(['-task-worker$', 'selector']);
  assert.equal(matcher('quay-TASK-Worker'), true);
  assert.equal(matcher('my Selector run'), true);
  assert.equal(matcher('task-worker follow-up'), false);
  assert.equal(matcher('human chat'), false);
});

test('empty rules never hide anything', () => {
  assert.equal(compileSessionFilter([])('anything'), false);
  assert.equal(compileStoredSessionFilter(null)('anything'), false);
  assert.equal(compileStoredSessionFilter('not json')('anything'), false);
  assert.equal(compileStoredSessionFilter('{"hide":["foo"]}')('a FOO b'), true);
});
