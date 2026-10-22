import assert from 'node:assert/strict';

import { test } from 'vitest';

import { deriveSimilarNamePattern } from '@/modules/sidebar/utils/deriveSimilarNamePattern';

const matches = (pattern: string, name: string) => new RegExp(pattern, 'i').test(name);

test('machine-style names cover their siblings but not unrelated names', () => {
  const worker = deriveSimilarNamePattern('claudecodeui-task-worker');
  assert.ok(matches(worker, 'claudecodeui-task-worker'));
  assert.ok(matches(worker, 'claudecodeui-task-worker-2'));
  assert.ok(!matches(worker, 'fix the login bug'));

  const numbered = deriveSimilarNamePattern('agent-run-17');
  assert.ok(matches(numbered, 'agent-run-17'));
  assert.ok(matches(numbered, 'agent-run-4032'));
  assert.ok(!matches(numbered, 'agent-walk-17'));

  const hashed = deriveSimilarNamePattern('task-worker-3f9a1c0be2d4');
  assert.ok(matches(hashed, 'task-worker-3f9a1c0be2d4'));
  assert.ok(matches(hashed, 'task-worker-aa00bb11cc22dd'));
  assert.ok(!matches(hashed, 'task-selector-3f9a1c0be2d4'));
});

test('timestamps are generalised', () => {
  const pattern = deriveSimilarNamePattern('nightly-2026-09-20T03:15:00');
  assert.ok(matches(pattern, 'nightly-2025-01-02 11:22'));
  assert.ok(!matches(pattern, 'weekly-2026-09-20T03:15:00'));
});

test('a human sentence becomes an anchored, fully escaped name', () => {
  const pattern = deriveSimilarNamePattern('修复登录页面的问题');
  assert.equal(pattern, '^修复登录页面的问题$');
  assert.ok(matches(pattern, '修复登录页面的问题'));
  assert.ok(!matches(pattern, '请修复登录页面的问题吧'));
});

test('regex metacharacters in the name are escaped, not interpreted', () => {
  const pattern = deriveSimilarNamePattern('why (a+b)? [c] $5.00');
  assert.ok(matches(pattern, 'why (a+b)? [c] $5.00'));
  assert.ok(!matches(pattern, 'why aab c 5x00'));
  assert.ok(pattern.includes('\\(') && pattern.includes('\\?'));
});

test('every result compiles and stays within 200 characters', () => {
  const names = [
    'claudecodeui-task-worker', 'a.b*c+d', '((((', 'x'.repeat(500), '1234567890 '.repeat(60),
    'deadbeefdeadbeef-'.repeat(30), '路径/带/斜杠[和]括号'.repeat(40),
  ];
  for (const name of names) {
    const pattern = deriveSimilarNamePattern(name);
    assert.ok(pattern.length > 0 && pattern.length <= 200, name.slice(0, 20));
    assert.doesNotThrow(() => new RegExp(pattern, 'i'));
  }
  assert.equal(deriveSimilarNamePattern('   '), '');
});
