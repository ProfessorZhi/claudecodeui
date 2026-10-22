import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { test } from 'vitest';

import { LLMProviderLogo } from '@/shared/ui';
import { PROVIDER_LABELS } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/**
 * The debug agent's display identity, read off the modules that ship it.
 *
 * ADR-003 decision 2 keeps the runtime provider id out of `LLMProvider`, so the
 * debug agent reaches every provider-rendering site as an id those sites were
 * never written to expect — and both sites below have a default that reads as
 * claude. `LLMProviderLogo` ends in `return <ClaudeLogo />`, and the sidebar
 * row's text slot is `PROVIDER_LABELS[session.__provider]`, whose declared type
 * promises a `string` for every input. Neither can go red on its own: a debug
 * session rendered as a Claude session has the right shape and the wrong
 * identity, and nothing in the reading tells a reader which one they got.
 *
 * So both readings here are taken from the shipped expressions, not from a local
 * copy of the map or a stand-in for the mark. A test that re-declared either one
 * would stay green with the product code reverted, which is the failure mode
 * this file exists to be able to see.
 */

// The id the backend registers under — `DEBUG_AGENT_PROVIDER_ID` in
// server/modules/debug-agent/debug-agent.gate.ts. `src` does not reach into
// `server`, so it is written here as the literal it is, which is how it arrives
// in production too: as the session row's provider column. If the backend ever
// renames it this file will not notice; carrying that coupling is the registry
// side's criterion, not this one's.
const DEBUG_AGENT_PROVIDER_ID = 'debug';

/** The ids the debug agent has to stay distinguishable from on the mark axis. */
const OTHER_PROVIDER_IDS = ['codex', 'cursor', 'opencode'] as const;

/**
 * The session view whose row is being read.
 *
 * Constructed rather than fetched: a real debug session row does not exist yet
 * (the engine that writes one is a separate deliverable), and what this
 * criterion is about is the row's own expression, not the plumbing that fills
 * the row. `__provider` is deliberately typed `string`: `SessionWithProvider`
 * declares it `LLMProvider`, which is exactly the point — the union cannot name
 * this id, so the lookup below has no compile-time guarantee behind it, and it
 * compiles only because `PROVIDER_LABELS` admits an id the union does not carry.
 */
const debugSessionView: { id: string; title: string; __provider: string } = {
  id: 'debug-agent-session-view-1',
  title: 'debug-agent-fixture',
  __provider: DEBUG_AGENT_PROVIDER_ID,
};

/** The sidebar row's own read (`SidebarSessionItem.tsx`: `PROVIDER_LABELS[session.__provider]`). */
const providerTextSlot = (session: { __provider: string }): string =>
  PROVIDER_LABELS[session.__provider];

/** The shipped mark for a provider, as the nine call sites render it. */
const markFor = (provider: string): string =>
  renderToStaticMarkup(React.createElement(LLMProviderLogo, { provider }));

const CLAUDE_IDENTITY = 'aria-label="Claude"';

test('a debug session names its provider, and its mark is not Claude', () => {
  const label: unknown = providerTextSlot(debugSessionView);
  const claudeLabel = PROVIDER_LABELS['claude'];
  const debugMark = markFor(DEBUG_AGENT_PROVIDER_ID);
  const claudeMark = markFor('claude');
  const otherMarks = OTHER_PROVIDER_IDS.map((id) => [id, markFor(id)] as const);

  // (a) the sidebar row's provider text slot. `label` is `unknown` on purpose:
  // the declared type says `string` for every input, so the only honest way to
  // ask "is it actually there" is to stop trusting the declaration at the one
  // point where a missing entry would still type-check.
  console.log(
    `[AC-136] (a) PROVIDER_LABELS[session.__provider] with __provider=` +
      `${JSON.stringify(DEBUG_AGENT_PROVIDER_ID)} -> ${JSON.stringify(label)}`,
  );
  assert.ok(
    typeof label === 'string' && label.length > 0,
    `(a) the sidebar row's provider text slot is empty for __provider=` +
      `${JSON.stringify(DEBUG_AGENT_PROVIDER_ID)} (rendered ${JSON.stringify(label)}) — a debug ` +
      `session is listed with no provider name`,
  );
  assert.notEqual(
    label,
    'Claude',
    `(a) the sidebar row names a ${JSON.stringify(DEBUG_AGENT_PROVIDER_ID)} session ` +
      `${JSON.stringify(label)} — the wrong provenance, asserted positively`,
  );

  // (b) the positive control for (a): the same expression, on an id the product
  // does carry, must produce Claude's name. Without this, "not Claude" is a
  // predicate a slot that renders nothing satisfies.
  console.log(`[AC-136] (b) PROVIDER_LABELS['claude'] -> ${JSON.stringify(claudeLabel)}`);
  assert.equal(
    claudeLabel,
    'Claude',
    `(b) PROVIDER_LABELS['claude'] is ${JSON.stringify(claudeLabel)} — the control this ` +
      `criterion compares against has moved`,
  );

  // (c) the mark, read as identity rather than as bytes: the debug agent's
  // markup must not carry Claude's accessible name. "Different markup" alone
  // would also be satisfied by a mark that impersonates codex.
  const debugCarriesClaudeIdentity = debugMark.includes(CLAUDE_IDENTITY);
  console.log(
    `[AC-136] (c) mark for ${JSON.stringify(DEBUG_AGENT_PROVIDER_ID)} -> ${debugMark.length} ` +
      `chars, carries ${CLAUDE_IDENTITY}: ${debugCarriesClaudeIdentity}`,
  );
  assert.equal(
    debugCarriesClaudeIdentity,
    false,
    `(c) LLMProviderLogo rendered ${JSON.stringify(DEBUG_AGENT_PROVIDER_ID)} as Claude — the ` +
      `fall-through was not preceded by a branch for this id, so the mark asserts a provenance ` +
      `the session does not have`,
  );

  // (d) the positive control for (c), same shape as (b).
  const claudeCarriesClaudeIdentity = claudeMark.includes(CLAUDE_IDENTITY);
  console.log(
    `[AC-136] (d) mark for 'claude' -> ${claudeMark.length} chars, carries ` +
      `${CLAUDE_IDENTITY}: ${claudeCarriesClaudeIdentity}`,
  );
  assert.equal(
    claudeCarriesClaudeIdentity,
    true,
    `(d) LLMProviderLogo no longer renders Claude as Claude — the control this criterion ` +
      `compares against has moved`,
  );

  // (e) the mutual-distinctness reading, which is what makes (c) a statement
  // about this id rather than about a component that renders one thing.
  const marks = [[DEBUG_AGENT_PROVIDER_ID, debugMark] as const, ...otherMarks];
  const collisions = marks.flatMap(([leftId, leftMark], leftIndex) =>
    marks
      .slice(leftIndex + 1)
      .filter(([, rightMark]) => rightMark === leftMark)
      .map(([rightId]) => `${leftId}=${rightId}`),
  );
  console.log(
    `[AC-136] (e) mark lengths ${marks.map(([id, mark]) => `${id}:${mark.length}`).join(', ')}; ` +
      `identical pairs: ${collisions.length > 0 ? collisions.join(', ') : 'none'}`,
  );
  assert.deepEqual(
    collisions,
    [],
    `(e) these marks rendered identically (${collisions.join(', ')}) — "not Claude" is then ` +
      `being satisfied by a comparison that cannot fail`,
  );
});

/**
 * Beyond the five readings: the debug mark has to *say* something. (c) is a
 * negative, and a component that renders nothing satisfies every negative; the
 * positive declaration of identity is what makes the row readable to a person
 * rather than merely different to a string comparison.
 */
test('the debug mark declares its own accessible name', () => {
  const ariaLabel = /aria-label="([^"]*)"/.exec(markFor(DEBUG_AGENT_PROVIDER_ID))?.[1] ?? '';
  console.log(`[AC-136] mark's own aria-label: ${JSON.stringify(ariaLabel)}`);
  assert.ok(
    ariaLabel.length > 0 && ariaLabel !== 'Claude',
    `the debug agent's mark declares ${JSON.stringify(ariaLabel)} as its accessible name`,
  );
});
