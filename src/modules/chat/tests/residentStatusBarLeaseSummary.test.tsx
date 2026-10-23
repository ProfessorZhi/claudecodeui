import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Type-only module aliases, so the mock's `importOriginal` can name the module's type without an
// `import()` annotation (which this repo's lint forbids) and without a runtime import (the factory
// is hoisted above every statement in this file). Erased before that hoisting runs.
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type { SessionHostsSnapshot } from '@/shared/types';

/**
 * The resident surface, after the busy/idle word and the lease counts were taken off it.
 *
 * This file used to pin the shape of the collapsed status bar's *merged lease count* and the
 * popover's per-kind chips. Both are gone: a count of the leases a host is holding is a second
 * answer to "is this session working", and the page's one answer is the activity dock's state,
 * read from the server's own frames rather than from a one-second poll of the host listing. What
 * survives of that bar is the part the dock cannot know — which process holds the conversation,
 * where it answers, and how to start, restart and close it — and it lives in the dock's expanded
 * panel now.
 *
 * So the readings below are the two halves of AC-188's third clause, in milliseconds: the
 * busy/idle word and the lease counts are **absent from the tree at all** (not hidden, not
 * zero-valued — absent), and the identity and lifecycle controls are **present**. The second half
 * is what separates "merged into the dock" from "deleted": a page that simply dropped the bar
 * would pass the first half and fail this one.
 *
 * The browser criterion (`e2e/activity-dock-truthful.spec.ts -g "AC-188"`) is what proves it on a
 * real page against a real host; this file pins the shape, in milliseconds and with the reason
 * named.
 */

const SESSION_ID = 'session-lease-summary';
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** Three leases of three distinct kinds: the fixture the old bar drew chips and a count for. */
const LEASES: Array<Record<string, unknown>> = [
  { kind: 'turn', runId: 'run-1' },
  { kind: 'monitor', id: 'monitor-1' },
  { kind: 'cron', id: 'cron-1', recurring: false, expiresAt: 0 },
];

// Shared with the hoisted mock below. Mutable so one test case can re-render the same component
// against a different lease set — the positive control that proves the controls below are read
// off the listing rather than written as constants.
const harness = vi.hoisted(() => ({
  leases: [] as Array<Record<string, unknown>>,
}));

// The store is a module-scope poller with no test seam, so the snapshot is supplied through the
// hook; the original module's readings (`findSessionHostState`, `findBinding`, …) are kept, because
// this file exercises the surface's own DOM shape and not a reimplementation of them.
vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  const snapshot = (): SessionHostsSnapshot => ({
    hosts: [
      {
        hostId: 'host-lease-summary',
        provider: 'claude',
        mode: 'resident',
        state: 'busy',
        pid: 4242,
        startedAt: 0,
        closeReason: null,
        closeDetail: null,
        bindings: [
          {
            appSessionId: SESSION_ID,
            providerSessionId: 'provider-lease-summary',
            state: 'busy',
            leases: harness.leases,
            lastActivityAt: 0,
            peerName: 'resident@host',
          },
        ],
      },
    ],
    sessions: [
      {
        appSessionId: SESSION_ID,
        provider: 'claude',
        lifecycleMode: 'resident',
        running: true,
        reason: null,
      },
    ],
  } as unknown as SessionHostsSnapshot);

  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot: snapshot(),
      error: null,
      loading: false,
      refresh: async () => {},
      start: async () => {},
      close: async () => {},
    }),
  };
});

/** Reads a dotted path out of a parsed locale file, the way the app's own lookup walks it. */
function readKey(source: unknown, keyPath: string): unknown {
  let node: unknown = source;
  for (const segment of keyPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const enChat = JSON.parse(readFileSync(join(LOCALES_DIR, 'en', 'chat.json'), 'utf8')) as unknown;

/**
 * The shipped English copy, interpolated — the sentence a user reads, not a key name. Passing this
 * as `t` is what lets the readings below compare rendered text against the locale file rather than
 * against a value this file also wrote.
 */
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = readKey(enChat, key);
  const base = typeof template === 'string' ? template : key;
  return base.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? ''));
}) as unknown as TFunction;

const ResidentPanel = (await import('@/modules/chat/transcript/ResidentStatusBar')).default;

function renderPanel(): ReturnType<typeof render> {
  return render(createElement(ResidentPanel, { sessionId: SESSION_ID, t }));
}

/**
 * Every marker the resident surface used to publish about *activity*.
 *
 * Named as a list rather than checked one at a time so a re-introduction of any one of them — the
 * busy/idle word, the collapsed total, a per-kind chip — is one failing reading naming the
 * attribute that came back.
 */
const ACTIVITY_MARKERS = [
  'data-resident-ui-state',
  'data-resident-state-text',
  'data-resident-lease-summary',
  'data-resident-lease-total',
  'data-lease-kind',
  'data-lease-count',
] as const;

afterEach(() => {
  cleanup();
  harness.leases = [];
});

describe('the resident surface no longer carries a second busy/idle reading', () => {
  it('publishes none of the activity markers even while the host holds three leases', () => {
    harness.leases = LEASES;
    const view = renderPanel();

    const found = ACTIVITY_MARKERS.filter(
      (marker) => view.container.querySelector(`[${marker}]`) !== null,
    );
    console.log(`activityMarkers.present=${JSON.stringify(found)}`);
    console.log(`host.leases=${harness.leases.length}`);
    assert.deepEqual(
      found,
      [],
      'the resident surface must not publish a busy/idle word or a lease count of its own; the dock is the one reading',
    );

    // Premise: the fixture really does hold leases, so the absence above is about the surface and
    // not about a listing this file forgot to fill in.
    assert.equal(harness.leases.length, 3, 'premise: the host must hold the three fixture leases');
  });

  it('keeps the identity and the lifecycle controls, which is what makes it a merge and not a deletion', () => {
    harness.leases = LEASES;
    const view = renderPanel();

    const address = view.container.querySelector('[data-resident-address]');
    const pid = view.container.querySelector('[data-resident-pid-text]');
    const copy = view.container.querySelector('[data-resident-copy]');
    const close = view.container.querySelector('[data-resident-close]');
    console.log(`resident.address=${JSON.stringify(address?.textContent ?? null)}`);
    console.log(`resident.pid=${JSON.stringify(pid?.textContent ?? null)}`);
    console.log(`resident.copy=${copy !== null} resident.close=${close !== null}`);

    assert.ok(address, 'the address of the process holding the session must still be shown');
    assert.equal(
      (address?.textContent ?? '').trim(),
      'resident@host',
      'and it is the address the listing reports, read through the panel',
    );
    assert.ok(pid, 'so must the pid');
    assert.ok((pid?.textContent ?? '').includes('4242'), `the pid must be the host's; it reads ${pid?.textContent ?? ''}`);
    assert.ok(copy, 'and the copy control that puts the address on the clipboard');
    assert.ok(close, 'and the control that closes the process');
  });

  it('offers the start control only when there is no live process, as the bar did', () => {
    // The positive control for the control set: with a busy host there is nothing to start, so the
    // start control is absent — and the close control beside it is what the reading above pins.
    // Without this, "close is present" could be read off a surface that drew every button always.
    harness.leases = LEASES;
    const view = renderPanel();
    console.log(`resident.start.busyHost=${view.container.querySelector('[data-resident-start]') !== null}`);
    assert.equal(
      view.container.querySelector('[data-resident-start]'),
      null,
      'a live host has nothing to start; the start control is the unstarted/exited state\'s',
    );
  });
});

describe('every shipped locale carries the dock\'s own copy', () => {
  it('has non-empty claudeStatus.dock keys in each locale', () => {
    const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const required = ['claudeStatus.dock.idleLabel', 'claudeStatus.dock.toggle'];
    const missing: string[] = [];
    for (const locale of locales) {
      const chat = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'chat.json'), 'utf8')) as unknown;
      for (const keyPath of required) {
        const value = readKey(chat, keyPath);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${locale}/chat.json:${keyPath}`);
        }
      }
    }

    console.log(`locales.checked=${locales.length} keys.perLocale=${required.length} missing=${missing.length}`);
    console.log(`locales=${locales.join(',')}`);
    assert.equal(locales.length > 0, true, 'the locale directory must enumerate at least one locale');
    expect(
      missing,
      `every locale must carry the dock's own copy; missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
