import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import type { Project } from '@/shared/types';
import QuayIndicator from '@/modules/sidebar/QuayIndicator';
import { getQuayIndicatorStatus } from '@/modules/sidebar/utils/sidebarProjectFormatting';

const project = (hasQuayConfig: boolean | undefined): Project => ({
  projectId: 'p',
  displayName: 'p',
  fullPath: '/tmp/p',
  hasQuayConfig,
});

test('QuayIndicator renders nothing when the project has no quay config', () => {
  const { container } = render(<QuayIndicator hasQuayConfig={false} />);

  assert.equal(container.querySelector('[data-quay-indicator]'), null);
  assert.equal(container.textContent, '');
});

test('QuayIndicator renders a distinct variant for each driver state', () => {
  const states = ['running', 'idle', 'stale', 'unavailable'] as const;
  const rendered = states.map((status) => {
    const { container } = render(<QuayIndicator hasQuayConfig status={status} />);
    const marker = container.querySelector('[data-quay-indicator]');
    return {
      status,
      attribute: marker?.getAttribute('data-quay-indicator'),
      className: marker?.getAttribute('class') ?? '',
      title: marker?.getAttribute('title') ?? '',
    };
  });

  for (const entry of rendered) {
    assert.equal(entry.attribute, entry.status);
    assert.ok(entry.title.length > 0, `${entry.status} must carry a tooltip`);
  }

  const classNames = rendered.map((entry) => entry.className);
  assert.equal(new Set(classNames).size, states.length, 'each state must paint a distinct colour class');
});

test('getQuayIndicatorStatus gates on hasQuayConfig and passes a known driver state through', () => {
  assert.equal(getQuayIndicatorStatus(project(false), null), 'not-configured');
  assert.equal(getQuayIndicatorStatus(project(false), { driver: { state: 'running' } }), 'not-configured');
  assert.equal(getQuayIndicatorStatus(project(true), { driver: { state: 'running' } }), 'running');
  assert.equal(getQuayIndicatorStatus(project(true), { driver: { state: 'stale' } }), 'stale');
  // Configured but no snapshot fetched yet: idle is the honest default, never a
  // running/stale claim the sidebar never observed.
  assert.equal(getQuayIndicatorStatus(project(true), null), 'idle');
  // An observed failed read is not an absent snapshot: it passes through instead
  // of decaying to `idle`, so the badge cannot claim a reading nobody got.
  assert.equal(getQuayIndicatorStatus(project(true), { driver: { state: 'unavailable' } }), 'unavailable');
});
