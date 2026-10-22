// E2: the maintenance rules, one positive case and one NEGATIVE CONTROL each. The negative control builds the same
// index with the rule switched off (`disable`) and asserts the very same check now FAILS — a test that cannot go red
// measures nothing.   node --test experiments/voice-index-loop/sim/mech.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EntityIndex } from './index.mjs';

const P = 'proj';
const redWhenOff = (rule, scenario) => { const on = scenario(new EntityIndex()); const off = scenario(new EntityIndex({ disable: [rule] })); assert.equal(on, true, `${rule}: should hold with the rule on`); assert.equal(off, false, `${rule}: must FAIL with the rule off`); };

test('promotion: one confirm promotes under promoteAfter=1, two are needed under 2; promoteAfter is what decides it', () => {
  const one = new EntityIndex({ promoteAfter: 1 }); one.confirm(P, 'key', 'quay', 'a', 0);
  assert.ok(one.l1(P, 'key', 'a', 1));
  const two = new EntityIndex({ promoteAfter: 2 }); two.confirm(P, 'key', 'quay', 'a', 0);
  assert.equal(two.l1(P, 'key', 'a', 1), null, 'pending after a single confirm');
  two.confirm(P, 'key', 'quay', 'a', 1);
  assert.ok(two.l1(P, 'key', 'a', 2), 'active after the second');
});
test('demotion: reverts beyond hits send an active alias back to pending (negative control: rule off)', () => {
  redWhenOff('demote', (idx) => { idx.confirm(P, 'key', 'quay', 'x', 0); idx.l1(P, 'key', 'x', 1); idx.revert(P, 'key', 'quay', 'x', 2); idx.revert(P, 'key', 'quay', 'y', 3); return idx.l1(P, 'key', 'z', 4) === null; });
});
test('negative context: a reverted left-neighbour stops the alias applying there, and only there', () => {
  const on = new EntityIndex(); on.confirm(P, 'key', 'quay', 'a', 0); on.l1(P, 'key', 'a', 0); on.l1(P, 'key', 'a', 0); on.revert(P, 'key', 'quay', 'enter', 1);
  assert.equal(on.l1(P, 'key', 'enter', 2), null, 'blocked after "enter"');
  assert.ok(on.l1(P, 'key', 'status', 2), 'still applies elsewhere');
  redWhenOff('negative', (idx) => { idx.confirm(P, 'key', 'quay', 'a', 0); idx.l1(P, 'key', 'a', 0); idx.l1(P, 'key', 'a', 0); idx.revert(P, 'key', 'quay', 'enter', 1); return idx.l1(P, 'key', 'enter', 2) === null; });
});
test('conflict: one heard string, two meanings, no distinguishing context -> both pending and counted', () => {
  redWhenOff('conflict', (idx) => { idx.confirm(P, 'fan', 'fan-in', 'a', 0); idx.confirm(P, 'fan', 'fan-out', 'a', 1); return idx.l1(P, 'fan', 'a', 2) === null && idx.conflicts >= 1; });
});
test('archive: an alias unused for archiveDays stops applying (negative control: rule off)', () => {
  redWhenOff('archive', (idx) => { idx.confirm(P, 'key', 'quay', 'a', 0); idx.sweep(91); return idx.l1(P, 'key', 'a', 91) === null; });
  const fresh = new EntityIndex(); fresh.confirm(P, 'key', 'quay', 'a', 0); fresh.l1(P, 'key', 'a', 80); fresh.sweep(120); assert.ok(fresh.l1(P, 'key', 'a', 120), 'use refreshes the clock');
});
test('tombstone: a name that left the snapshot stays a flagged candidate for tombDays, then goes (negative control: rule off)', () => {
  const idx = new EntityIndex(); const names = new Map([['gap-old-task', 'task'], ['gap-new-task', 'task']]);
  idx.syncProject(P, names, 0); idx.syncProject(P, new Map([['gap-new-task', 'task']]), 1);
  const e1 = idx.entities(P, new Map(), 2, new Set(['P'])).get('gap-old-task'); assert.ok(e1 && e1.tomb, 'kept, marked deleted');
  idx.syncProject(P, new Map([['gap-new-task', 'task']]), 40); assert.equal(idx.entities(P, new Map(), 40, new Set(['P'])).has('gap-old-task'), false, 'expired');
  redWhenOff('tombstone', (i) => { i.syncProject(P, names, 0); i.syncProject(P, new Map([['gap-new-task', 'task']]), 1); return i.entities(P, new Map(), 2, new Set(['P'])).has('gap-old-task'); });
});
test('conversation decay: a token last mentioned more than 8 turns ago is not offered (negative control: rule off)', () => {
  redWhenOff('convDecay', (idx) => !idx.entities(P, new Map([['SendMessage', 9]]), 0, new Set(['C'])).has('SendMessage'));
  assert.ok(new EntityIndex().entities(P, new Map([['SendMessage', 3]]), 0, new Set(['C'])).has('SendMessage'));
});
test('eligibility: plain dictionary words from the project tree are not candidates; identifier-shaped names are', () => {
  const idx = new EntityIndex(); idx.syncProject(P, new Map([['index', 'file'], ['types', 'file'], ['useVoiceInput', 'file']]), 0);
  const got = [...idx.entities(P, new Map(), 0, new Set(['P'])).keys()]; assert.deepEqual(got, ['useVoiceInput']);
});
test('determinism: the same events in the same order give the same entities and aliases', () => {
  const run = () => { const i = new EntityIndex(); i.syncProject(P, new Map([['fan-in', 'task']]), 0); i.observeSent(['SendMessage'], 1); i.confirm(P, 'fanin', 'fan-in', 'a', 2); return JSON.stringify([[...i.entities(P, new Map([['MCP', 1]]), 3, new Set(['P', 'C', 'U'])).keys()], [...i.aliases.get(P)]]); };
  assert.equal(run(), run());
});
test('invariants: nothing stale or expired is offered, over a scripted history', () => {
  const idx = new EntityIndex(); const bad = [];
  for (let d = 0; d < 200; d += 5) { idx.syncProject(P, new Map([[`gap-task-${Math.floor(d / 40)}`, 'task']]), d); idx.observeSent(['MCP'], d); bad.push(...idx.checkInvariants(P, new Map([['SendMessage', d % 12]]), d, new Set(['P', 'C', 'U']))); idx.sweep(d); }
  assert.deepEqual(bad, []);
});
