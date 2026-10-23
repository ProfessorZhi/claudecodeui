import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { AppTab, Project } from '@/shared/types';
import { isQuayTabVisible, useEnsureQuayTabVisible } from '@/modules/quay';

const project = (hasQuayConfig: boolean | undefined): Project => ({
  projectId: 'p',
  displayName: 'p',
  fullPath: '/tmp/p',
  hasQuayConfig,
});

test('isQuayTabVisible follows the Tier-1 hasQuayConfig reading', () => {
  assert.equal(isQuayTabVisible(project(true)), true);
  assert.equal(isQuayTabVisible(project(false)), false);
  assert.equal(isQuayTabVisible(project(undefined)), false);
  assert.equal(isQuayTabVisible(null), false);
});

test('a hidden Quay tab snaps the active view back to chat', () => {
  const setActiveTab = vi.fn();
  renderHook(() => useEnsureQuayTabVisible(false, 'quay', setActiveTab));

  assert.equal(setActiveTab.mock.calls.length, 1);
  assert.equal(setActiveTab.mock.calls[0][0], 'chat');
});

test('a visible Quay tab is left untouched, and an unrelated tab never moves', () => {
  const visibleSetter = vi.fn();
  renderHook(() => useEnsureQuayTabVisible(true, 'quay', visibleSetter));
  assert.equal(visibleSetter.mock.calls.length, 0);

  const otherTabSetter = vi.fn();
  renderHook(() => useEnsureQuayTabVisible(false, 'chat' as AppTab, otherTabSetter));
  assert.equal(otherTabSetter.mock.calls.length, 0);
});
