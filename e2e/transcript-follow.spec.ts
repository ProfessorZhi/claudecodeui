import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// AC-106: a transcript sitting at the bottom follows content that grows in place — the last row getting
// taller with no new row and no store write — while a transcript the user has scrolled away from is left
// exactly where the user put it.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
// Nothing here stubs a request: the transcript is a real Claude transcript seeded into the run's isolated
// HOME before the server booted and indexed by the backend's own synchronizer, the session is opened through
// the sidebar, and the viewport is moved in both directions by real wheel gestures.
//
// The two growths are direct DOM mutations, deliberately: no row is added and no store flush reaches the code
// under test, so only an implementation driven by the content's own geometry can see them. That is the whole
// point of the criterion — a version that waited on a React signal satisfies nothing here.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-transcript-follow';
/** Display name of that session, as the sidebar renders it. */
const SESSION_NAME = 'transcript-follow';
/** Height each growth adds, in CSS pixels — comfortably past any tolerance a follow could justify. */
const GROWTH_PX = 480;
/** How far the control half moves away from the bottom, in CSS pixels. */
const AWAY_PX = 400;
/**
 * One wheel tick, in CSS pixels.
 *
 * Kept well under LazyMessageRow's 1200px viewport margin: a row outside that band is unmounted and replaced
 * by a placeholder, and the growths below have to land on a row whose real content is in the DOM.
 */
const WHEEL_STEP_PX = 700;
/** A gap at or below this is "at the bottom"; the criterion's own bound is 1px. */
const AT_BOTTOM_PX = 1;
/** Height the boxes above the viewport lose, in CSS pixels — AC-111's M. */
const SHRINK_PX = 240;
/** The scroll-to-bottom control, located the way the app labels it. */
const SCROLL_BUTTON = '[aria-label="Scroll to bottom"], [title="Scroll to bottom"]';

/**
 * The page-side instruments AC-111 reads, installed before the app's first script runs.
 *
 * Nothing here changes what the page does. The scrollTop setter keeps its original descriptor and
 * only appends the value it was handed to a list, so a write is counted without being altered, and
 * every listener is a passive recorder. What the three counters separate is the *source* of a
 * scroll: an input event (wheel, touch, key, pointer press) means the user asked for it, a write
 * through the setter means the app placed the viewport, and a scroll with neither behind it is the
 * browser's own scroll anchoring or clamping.
 */
const instrumentScrollSources = () => {
  interface Instruments {
    /** Every `scroll` the page saw, capture phase, with the element it came from. */
    __scrollEvents: { target: string; t: number }[];
    /** Every assignment to `scrollTop`, recorded without altering it. */
    __scrollWrites: { value: number; t: number }[];
    /** Every input event that could have moved a viewport. */
    __scrollInputs: { type: string; t: number }[];
    /** Every mount of the scroll-to-bottom control, which lives for less than a sample. */
    __scrollButtonAppearances: { t: number }[];
  }
  const page = window as unknown as Instruments;
  page.__scrollEvents = [];
  page.__scrollWrites = [];
  page.__scrollInputs = [];
  page.__scrollButtonAppearances = [];

  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(this: Element, value: number) {
        page.__scrollWrites.push({ value, t: performance.now() });
        descriptor.set!.call(this, value);
      },
    });
  }

  window.addEventListener('scroll', (event) => {
    const target = event.target;
    page.__scrollEvents.push({
      target: target instanceof Element ? target.className : '',
      t: performance.now(),
    });
  }, true);

  for (const type of ['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown']) {
    window.addEventListener(type, () => {
      page.__scrollInputs.push({ type, t: performance.now() });
    }, true);
  }

  // The button is mounted and unmounted, so counting what appears is the only
  // way to see one that lived for less than a sample interval.
  const selector = '[aria-label="Scroll to bottom"], [title="Scroll to bottom"]';
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.matches(selector) || node.querySelector(selector)) {
          page.__scrollButtonAppearances.push({ t: performance.now() });
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
};

/**
 * The app's transport, doubled: it records every frame the app's websocket receives and it
 * is the way a reply is produced at all. Installed before the app's first script runs.
 *
 * Recording. The streaming kinds are the transport's own vocabulary — `stream_delta` for one
 * piece of a reply, `stream_end` for the end of a content block — and how many of each the
 * client was handed is not visible from the DOM. Wrapping the constructor is the only way to
 * see them without touching the app.
 *
 * Producing. The app's only frame producer is a provider run, and a run needs a model client;
 * this file must not depend on one. So the frames are handed to the app here instead, through
 * the transport it made for itself: a real `MessageEvent` dispatched at a real socket, which
 * the app's own `onmessage` receives. What is doubled is the wire, never the consumer —
 * nothing below reaches a store, a component or the DOM, and a frame the app does not act on
 * is a frame it did not receive.
 *
 * Only the chat socket is addressed. The shell keeps a socket of its own, and a chat frame
 * delivered there would be recorded as received without the pane ever seeing it.
 */
const installWireDouble = () => {
  const page = window as unknown as {
    __streamFrames: { kind: string; t: number }[];
    __wireSockets: { url: string; socket: WebSocket }[];
    __injectStreamFrame: (frame: unknown) => number;
  };
  page.__streamFrames = [];
  page.__wireSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      const socket = this as WebSocket;
      page.__wireSockets.push({ url: String(args[0]), socket });
      socket.addEventListener('message', (event) => {
        try {
          const frame = JSON.parse(String((event as MessageEvent).data)) as { kind?: string };
          if (frame?.kind) {
            page.__streamFrames.push({ kind: frame.kind, t: Math.round(performance.now()) });
          }
        } catch {
          // Not a JSON frame; nothing to record.
        }
      });
    }
  } as unknown as typeof WebSocket;

  /**
   * Delivers one frame to every open chat socket and reports how many took it. The return
   * value is the liveness signal for the cases below: a reply that was never delivered looks
   * exactly like a reply the app ignored.
   */
  page.__injectStreamFrame = (frame: unknown) => {
    const data = JSON.stringify(frame);
    let delivered = 0;
    for (const entry of page.__wireSockets) {
      if (!entry.url.includes('/ws')) continue;
      if (entry.socket.readyState !== 1) continue;
      entry.socket.dispatchEvent(new MessageEvent('message', { data }));
      delivered += 1;
    }
    return delivered;
  };
};

/** One frame of the reply, shaped the way the server shapes one. */
type WireFrame = {
  kind: 'stream_delta' | 'stream_end';
  sessionId: string;
  content?: string;
};

/** Hands the app one frame of a reply on its own chat socket. Returns the delivery count. */
const injectStreamFrame = (page: Page, frame: WireFrame) =>
  page.evaluate(
    (payload) =>
      (window as unknown as { __injectStreamFrame: (frame: unknown) => number }).__injectStreamFrame({
        ...payload,
        // The same fields a live frame carries. No `seq`: no provider run is in flight, so
        // there is no sequence for the client to have missed, and claiming one would make the
        // app's reconnect bookkeeping try to resume a run that does not exist.
        id: `e2e-wire-${payload.kind}`,
        timestamp: new Date().toISOString(),
        provider: 'claude',
        role: 'assistant',
      }),
    frame,
  );

/**
 * A reply being delivered through the app's own socket, one delta at a time, in the
 * background while the case does its work.
 *
 * `delivered` and `finished` are the pump's own counters rather than readings off the page:
 * a case that must observe the pane *mid-reply* has to know the reply really is mid-flight,
 * and the alternatives — a frame count, a DOM marker — only say that something arrived.
 */
type WireStream = {
  /** How many deltas have been handed to the app so far. */
  delivered: () => number;
  /** True once the last delta is on the wire and only `stream_end` remains. */
  finished: () => boolean;
  /** Resolves once the whole reply, `stream_end` included, has been delivered. */
  done: Promise<void>;
};

/** Starts delivering `deltas` at `intervalMs`, then ends the content block. */
const startWireStream = (
  page: Page,
  sessionId: string,
  deltas: string[],
  intervalMs: number,
): WireStream => {
  let delivered = 0;
  let finished = false;
  const done = (async () => {
    for (const content of deltas) {
      await injectStreamFrame(page, { kind: 'stream_delta', sessionId, content });
      delivered += 1;
      finished = delivered === deltas.length;
      await page.waitForTimeout(intervalMs);
    }
    await injectStreamFrame(page, { kind: 'stream_end', sessionId });
  })();
  return { delivered: () => delivered, finished: () => finished, done };
};

type ScrollInstruments = {
  __scrollEvents: { target: string; t: number }[];
  __scrollWrites: { value: number; t: number }[];
  __scrollInputs: { type: string; t: number }[];
  __scrollButtonAppearances: { t: number }[];
};

/** Whatever the instruments have recorded since they were last cleared. */
const readInstruments = (page: Page) =>
  page.evaluate(() => {
    const read = window as unknown as ScrollInstruments;
    return JSON.parse(JSON.stringify({
      __scrollEvents: read.__scrollEvents,
      __scrollWrites: read.__scrollWrites,
      __scrollInputs: read.__scrollInputs,
      __scrollButtonAppearances: read.__scrollButtonAppearances,
    })) as ScrollInstruments;
  });

/** Clears the counters, so the window that follows is measured on its own. */
const clearInstruments = (page: Page) =>
  page.evaluate(() => {
    const read = window as unknown as {
      __scrollEvents: unknown[];
      __scrollWrites: unknown[];
      __scrollInputs: unknown[];
      __scrollButtonAppearances: unknown[];
    };
    read.__scrollEvents.length = 0;
    read.__scrollWrites.length = 0;
    read.__scrollInputs.length = 0;
    read.__scrollButtonAppearances.length = 0;
  });

/**
 * Removes `amount` CSS pixels of height from the boxes above the viewport, in place.
 *
 * The browser anchors on the topmost row it can see, so a box above that row shrinking has to move
 * the offset for the row to stay where the user is looking — which is the scroll this criterion is
 * about, and the reason the change is measured rather than assumed. Rows are taken from just above
 * the viewport upwards, because a single row can only lose the height it has.
 */
const shrinkRowsAboveViewport = (page: Page, amount: number) =>
  page.evaluate((shrink) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const paneTop = pane.getBoundingClientRect().top;
    // The outermost element carrying a row's timestamp — the lazy row wrapper —
    // so a row is one box here rather than the box and the row inside it. Every
    // row has one whether or not its content is currently mounted.
    const rows = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
      .filter((row) => !row.parentElement?.closest('[data-message-timestamp]'));
    const above = rows
      .filter((row) => row.getBoundingClientRect().bottom <= paneTop)
      .reverse();
    const shrunk: { before: number; after: number }[] = [];
    let remaining = shrink;
    for (const row of above) {
      if (remaining <= 0) break;
      const before = row.getBoundingClientRect().height;
      const after = Math.max(Math.round(before - remaining), 24);
      row.style.height = `${after}px`;
      // A row that only ever declared a minimum (a lazy placeholder's estimate)
      // would keep its old height under a bare `height`, since min-height wins.
      row.style.minHeight = '0px';
      row.style.overflow = 'hidden';
      shrunk.push({ before, after });
      remaining -= before - after;
    }
    return {
      shrunk,
      lost: shrunk.reduce((total, row) => total + (row.before - row.after), 0),
      scrollHeight: pane.scrollHeight,
    };
  }, amount);

/**
 * Arms a probe that resolves once the resize it is watching has been laid out, the observers the
 * app installed have run, and the frame they deferred their write to has passed.
 *
 * A ResizeObserver created after the app's is called after it, so by the time this one is
 * notified the follow has already decided; the frame and the timeout after it put the read on the
 * far side of a write the follow deferred, which is what makes the geometry a painted one rather
 * than the pre-pin state.
 */
const armLayoutProbe = (page: Page, selector: string) =>
  page.evaluate((probeSelector) => {
    (window as unknown as { __transcriptLayoutProbe: Promise<void> }).__transcriptLayoutProbe =
      new Promise<void>((resolve) => {
        const matches = document.querySelectorAll(probeSelector);
        const target = matches[matches.length - 1];
        if (!target) {
          resolve();
          return;
        }
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          requestAnimationFrame(() => setTimeout(() => resolve(), 0));
        });
        observer.observe(target);
      });
  }, selector);

const awaitLayoutProbe = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __transcriptLayoutProbe: Promise<void> }).__transcriptLayoutProbe,
  );

type Geometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  gap: number;
};

/**
 * Reads the pane's geometry once a frame's rendering steps have run.
 *
 * The frame is requested from inside the page, so a write deferred to a frame of its own lands first, and the
 * timeout puts this read after that frame's rendering steps. Reading scrollHeight in the same evaluation that
 * grew the box would report a layout the user never sees.
 */
const readGeometry = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Geometry>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
            resolve({
              scrollTop: pane.scrollTop,
              scrollHeight: pane.scrollHeight,
              clientHeight: pane.clientHeight,
              gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
            });
          }, 0);
        });
      }),
  );

/**
 * Waits for the pane to stop moving, and returns the geometry it stopped at.
 *
 * Waiting rather than reading once is what makes the measurement meaningful: the follow is allowed to land a
 * frame after the growth, and a scroll the browser animates arrives over several. Both a pinned and an
 * un-pinned implementation reach a steady state here, and the steady state is what gets asserted.
 */
const waitForSettledPane = async (page: Page): Promise<Geometry> => {
  let previous: Geometry | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await readGeometry(page);
    if (
      previous
      && Math.abs(current.scrollTop - previous.scrollTop) < 0.5
      && Math.abs(current.gap - previous.gap) < 0.5
    ) {
      stable += 1;
      if (stable >= 3) {
        return current;
      }
    } else {
      stable = 0;
    }
    previous = current;
    await page.waitForTimeout(80);
  }
  throw new Error('the transcript pane never stopped moving');
};

/**
 * Puts the pointer over the middle of the pane, so the wheel gestures land on the transcript.
 *
 * A wheel is aimed at whatever is under the pointer, and where that is depends on the viewport: the
 * sidebar is beside the pane on a desktop and over it on a phone, so a coordinate that reached the
 * transcript at one width can land on the sidebar at another. Every gesture below therefore aims
 * before it scrolls rather than inheriting a position from somewhere else in the run.
 */
const pointAtPane = async (page: Page) => {
  const box = await page.locator(PANE).boundingBox();
  if (!box) {
    throw new Error('the transcript pane has no box to aim a gesture at');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};

/**
 * Scrolls the pane with real wheel gestures until `reached` holds.
 *
 * Chromium animates wheel scrolling, so each tick is followed by a wait for the pane to settle; the loop
 * exists because one tick's travel is the browser's to decide, not the spec's.
 */
const wheelUntil = async (page: Page, deltaY: number, reached: (geometry: Geometry) => boolean) => {
  await pointAtPane(page);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.mouse.wheel(0, deltaY);
    const geometry = await waitForSettledPane(page);
    if (reached(geometry)) {
      return geometry;
    }
  }
  throw new Error(`the pane never reached the state this gesture was for (deltaY=${deltaY})`);
};

/**
 * Appends a block of exactly `height` CSS pixels to the last assistant row.
 *
 * This is the growth a streaming answer performs: the row already on screen gets taller, no message is added,
 * and no store write happens. Returns the pane's scrollHeight with the growth already laid out.
 */
const growLastAssistantRow = (page: Page, height: number) =>
  page.evaluate((growth) => {
    const rows = document.querySelectorAll('.chat-message.assistant');
    const row = rows[rows.length - 1] as HTMLElement | undefined;
    if (!row) {
      return null;
    }
    const spacer = document.createElement('div');
    spacer.dataset.ac106Growth = 'appended';
    spacer.style.height = `${growth}px`;
    row.appendChild(spacer);
    return (document.querySelector('.chat-messages-pane') as HTMLElement).scrollHeight;
  }, height);

/**
 * Replaces the last content block of the last assistant row with a taller one — the other way the same row
 * grows in place, and the one a markdown re-render takes.
 *
 * The block is a markdown paragraph as this app really renders one. `<Markdown>` overrides react-markdown's
 * `p` to a `div.mb-2` (transcript/Markdown.tsx), so a `p` selector would find nothing in a transcript whose
 * every paragraph went through it. `.prose` is the container StreamingMarkdown gives a reply, which keeps the
 * match inside the reply body rather than any chrome around it.
 */
const replaceLastAssistantSegment = (page: Page, height: number) =>
  page.evaluate((growth) => {
    const rows = document.querySelectorAll('.chat-message.assistant');
    const row = rows[rows.length - 1] as HTMLElement | undefined;
    if (!row) {
      return null;
    }
    const body = row.querySelector('.prose');
    if (!body) {
      return null;
    }
    const blocks = Array.from(body.querySelectorAll('.mb-2'));
    const target = blocks[blocks.length - 1] ?? body;
    if (!target) {
      return null;
    }
    const replacement = document.createElement('div');
    replacement.dataset.ac106Growth = 'replacement';
    replacement.style.height = `${growth}px`;
    replacement.textContent = 'replaced segment';
    target.replaceWith(replacement);
    return (document.querySelector('.chat-messages-pane') as HTMLElement).scrollHeight;
  }, height);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * AC-107's viewports: a phone-sized pane, and the same pane after a software
 * keyboard would have taken half of it.
 *
 * The two differ in height only, and that is the point of the case: what shrinks
 * is the scroll container's own box, while the content column inside it keeps
 * exactly the box it had. The keyboard is not simulated — the shell is `fixed
 * inset-0` and the pane is `flex-1` inside it, so moving the viewport moves the
 * pane by the same amount through the layout the app already has.
 */
const AC107_VIEWPORT = { width: 390, height: 844 };
const AC107_SHRUNK_VIEWPORT = { width: 390, height: 420 };

/**
 * AC-110's viewport: wide enough to lay the transcript out as a desktop chat, and
 * tall enough that the seeded transcript's first page has no scrollbar at all.
 *
 * The height is the fixture, not a convenience. The pane counts `scrollTop < 100`
 * as "the user is at the top", and on this transcript `scrollTop` starts at 0 and
 * cannot move: the content is shorter than the pane, so no wheel can raise a
 * scroll. The gesture is therefore invisible to anything that reads offsets, and
 * the only evidence it happened is the wheel itself.
 */
const AC110_VIEWPORT = { width: 1440, height: 6000 };
/** Rows the first page holds; SESSION_MESSAGES_PAGE_SIZE's own value. */
const AC110_FIRST_PAGE_ROWS = 20;
/** How long the window under test stays open, in milliseconds. */
const AC110_SAMPLE_WINDOW_MS = 2_000;
/** How long the sample waits for a resize that never comes before reading anyway. */
const AC110_SAMPLE_FALLBACK_MS = 120;
/** The anchored row's offset may move by at most this, in CSS pixels. */
const AC110_DRIFT_PX = 2;
/** The content column: the pane's last child, the box whose growth the follow watches. */
const CONTENT_COLUMN = `${PANE} > div:last-child`;

/**
 * When the seeded transcript's own turns stop, in epoch milliseconds.
 *
 * playwright.config.ts stamps the seeded turns forward from the run's boot, one a
 * minute, so a message the app stamps with `Date.now()` while this case runs would
 * sort *into* the middle of the transcript — computeMerged interleaves server and
 * realtime messages by timestamp. The growth this case measures has to land below
 * the row the restore anchored to: a row inserted above it moves that row through
 * the browser's own scroll anchoring, which is a different mechanism from the one
 * being discriminated. Read from the seeded file rather than assumed, so the clock
 * and the fixture cannot drift apart.
 */
const seededTranscriptEndsAt = () => {
  const seeded = path.join(
    process.env.QUAY_E2E_DATA_DIR!,
    '.claude',
    'projects',
    'transcript-follow-workspace',
    `${SESSION_ID}.jsonl`,
  );
  const records = fs.readFileSync(seeded, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return Math.max(...records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite));
};

type PaneFixture = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  gap: number;
  /** How many message rows are on screen. */
  rows: number;
  /** The first row's own timestamp, which is how the row is found again later. */
  firstStamp: string | null;
  /** True while the pane still offers an older page. */
  hasMore: boolean;
};

/**
 * Reads the pane's fixture state: geometry, row count, the first row's identity,
 * and whether the transcript has an older page left.
 *
 * The rows are the outermost elements carrying a timestamp — the lazy row wrapper —
 * so a row is one element here whether or not its content is mounted. The pagination
 * banner is matched on the string the app renders rather than on a class, and it is
 * the same string the criterion's precondition names.
 */
const readFixture = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const rows = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
      .filter((row) => !row.parentElement?.closest('[data-message-timestamp]'));
    return {
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      scrollTop: pane.scrollTop,
      gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
      rows: pane.querySelectorAll('.chat-message').length,
      firstStamp: rows[0]?.getAttribute('data-message-timestamp') ?? null,
      hasMore: (pane.textContent ?? '').includes('Scroll up to load more'),
    };
  });

/** The element the app mounts into, and the one thing a blank document can be asked about. */
const APP_ROOT = '#root';
/** How long a document is given to put the app into its root before this spec reloads it, and how often. */
const MOUNT_PROBE_MS = 5_000;
const MOUNT_RELOADS = 2;

/**
 * What the page said about itself, for the guards below: a client that never rendered has to be explainable.
 *
 * Filled by the describe's `beforeAll` from the moment the page exists, read by whichever guard gives up.
 */
type PageEvidence = { consoleErrors: string[]; failedRequests: string[] };
const pageEvidence: PageEvidence = { consoleErrors: [], failedRequests: [] };

/**
 * The page's own account of a load that did not render, in the form a failure message can carry.
 *
 * A blank page is a blank page. What tells the ways this spec meets one apart is the text, the console
 * and the requests that failed: `504 Outdated Optimize Dep` is a dependency re-optimization, a cancelled
 * module URL is a document whose graph was pulled out from under it, and neither says anything by itself.
 * The last ten entries rather than the first, because the failure being explained is the latest one.
 */
const readPageEvidence = async (page: Page, evidence: PageEvidence): Promise<string> => {
  const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
  return `the page shows "${shown.replace(/\s+/g, ' ').slice(0, 600)}"; `
    + `console errors: ${evidence.consoleErrors.slice(-10).join(' | ') || 'none'}; `
    + `failed requests: ${evidence.failedRequests.slice(-10).join(' | ') || 'none'}`;
};

/**
 * Waits, bounded, for the app to mount into the document it was sent to, and says so loudly if it never does.
 *
 * The routes this spec opens are full document loads, so they are where a client that was still catching up
 * leaves a white page: nothing on such a document will ever answer the locator await that follows, so the run
 * reports this spec's own error — with the page's text, the console's and the failed requests — instead of an
 * assertion timing out thirty seconds later or a ceiling above the spec killing it with nothing to read.
 * Reloading is what the app's own client does about the same class of blank, and it is bounded: two reloads,
 * and the error stands if the third load is blank too.
 */
const waitForAppMount = async (page: Page, evidence: PageEvidence): Promise<void> => {
  const mounted = (timeoutMs: number) =>
    page
      .waitForFunction(
        (selector) => (document.querySelector(selector)?.childElementCount ?? 0) > 0,
        APP_ROOT,
        { timeout: timeoutMs, polling: 100 },
      )
      .then(() => true, () => false);
  if (await mounted(MOUNT_PROBE_MS)) return;
  for (let attempt = 0; attempt < MOUNT_RELOADS; attempt += 1) {
    await page.reload().catch(() => undefined);
    if (await mounted(MOUNT_PROBE_MS)) return;
  }
  throw new Error(
    `the app never mounted into ${APP_ROOT} across ${MOUNT_RELOADS + 1} bounded loads of the document: `
    + await readPageEvidence(page, evidence),
  );
};

/**
 * What a document has to show before the case that navigated to it is allowed to touch it: the sidebar the
 * case's next step clicks in, or — if the stored preference left the panel closed — the collapsed bar's own
 * expand control.
 *
 * Deliberately the shell the case uses rather than `#root` with children, which `waitForAppMount` probes: a
 * document that mounts React and is replaced a moment later is exactly the one this guard exists to notice.
 * One constant, so a negative control can point the probe somewhere that never appears in a single edit.
 */
const SECOND_DOCUMENT_READY = '#sidebar-panel, [aria-label="Show sidebar"]';
/** How long the second document is given to show it, and how many times a document that did not is replayed. */
const SECOND_DOCUMENT_PROBE_MS = 4_000;
const SECOND_DOCUMENT_RELOADS = 2;

/**
 * The startup guard for a navigation the describe's `beforeAll` did not make.
 *
 * This spec navigates twice: `beforeAll`'s `goto('/')`, and AC-110's own `goto('/')` a thousand lines later —
 * which the case needs, because a viewport of 1440×6000 cannot be expressed through `test.use()` and the
 * shared page was opened at the default one. The startup guard only ever wrapped the first navigation, so the
 * second one arrived with no bound on it at all: a document that came up and was then replaced left the case
 * waiting on a locator in a page that no longer existed, and the run was ended from outside by the 55s watchdog
 * with nothing but `Channel closed` to read — no assertion, no page text, nothing naming the criterion.
 *
 * The same two pieces `beforeAll` uses, in the same order, applied to whichever document the second navigation
 * lands on: a short bounded probe, at most `SECOND_DOCUMENT_RELOADS` bounded replays, and then this spec's own
 * error carrying the page's text and the console's and the requests'. Nothing above the spec is touched — the
 * watchdog is load-bearing and the ceiling above it is not this fixture's to raise.
 */
const settleSecondDocument = async (page: Page, evidence: PageEvidence): Promise<void> => {
  const ready = (timeoutMs: number) =>
    page.locator(SECOND_DOCUMENT_READY).first().waitFor({ state: 'attached', timeout: timeoutMs }).then(
      () => true,
      () => false,
    );
  for (let load = 0; load <= SECOND_DOCUMENT_RELOADS; load += 1) {
    if (load > 0) await page.reload().catch(() => undefined);
    if (await ready(SECOND_DOCUMENT_PROBE_MS)) return;
  }
  throw new Error(
    `this run's client never settled on a document the criterion can measure on: ${SECOND_DOCUMENT_READY} did not `
    + `appear across ${SECOND_DOCUMENT_RELOADS + 1} bounded loads of it (${SECOND_DOCUMENT_PROBE_MS}ms each): `
    + await readPageEvidence(page, evidence),
  );
};

/**
 * How long the sidebar's session link is given to become clickable, and to survive its own click.
 *
 * Under the 55s watchdog and the 60s gate above it with room to spare: the click is the last unbounded wait in
 * this spec's path into the transcript, so the budget it fails inside has to be small enough that the failure
 * is reported *by this spec* rather than by a ceiling that names neither the link nor the page.
 */
const SESSION_LINK_CLICK_MS = 15_000;

/**
 * Opens the seeded session from the sidebar, bounded, and explained by this spec if it cannot.
 *
 * `locator.click()` carries no action timeout here, so on a document that is still being replaced it
 * re-resolves its target forever — the failure this bounds is `element was detached from the DOM, retrying`
 * for 33.5s until the watchdog ended the run from outside. `beforeAll` never had to bound it because on its
 * document the sidebar had long settled; the second navigation is the one that arrives without that history,
 * and the wait belongs to both. A link that never becomes clickable, and a link that keeps being detached
 * under the click, both end as this spec's own error with the page's account attached.
 */
const clickSessionLink = async (page: Page, link: Locator, evidence: PageEvidence): Promise<void> => {
  const clickable = await link
    .waitFor({ state: 'visible', timeout: SESSION_LINK_CLICK_MS })
    .then(() => true, () => false);
  if (!clickable) {
    throw new Error(
      `the sidebar's session link never became clickable inside ${SESSION_LINK_CLICK_MS}ms, so this run's client `
      + 'never settled on a document that stays: '
      + await readPageEvidence(page, evidence),
    );
  }
  try {
    await link.click({ timeout: SESSION_LINK_CLICK_MS });
  } catch (error) {
    throw new Error(
      `the sidebar's session link could not be clicked inside ${SESSION_LINK_CLICK_MS}ms `
      + `(${error instanceof Error ? error.message : String(error)}): `
      + await readPageEvidence(page, evidence),
    );
  }
};

/**
 * A conversation the app creates and then opens, over the app's own REST route.
 *
 * Both streaming cases deliver frames addressed to a session, so there has to be one. This is
 * the same `POST /api/providers/sessions` the New Session button makes — the app allocates the
 * id, writes the row and registers the workspace — issued from inside the page so it carries
 * the session the UI just created (the app keeps its token in storage rather than in a cookie,
 * so the same request from the test process would be anonymous). Nothing here is the subject:
 * the case is about what the pane does once frames arrive.
 *
 * The session is created empty and stays empty. An empty conversation is what lets the
 * readings below treat "the last row" and "the reply" as the same thing, and it means the
 * reply has no neighbours to be confused with — no prompt row above it, no seeded history
 * below it, and no request to any provider at any point.
 */
const openAppSession = async (page: Page, projectPath: string) => {
  const created = await page.evaluate(async (workspacePath) => {
    const response = await fetch('/api/providers/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}`,
      },
      body: JSON.stringify({ provider: 'claude', projectPath: workspacePath, initialMessage: '' }),
    });
    return { status: response.status, body: await response.text() };
  }, projectPath);
  expect(created.status, `the app did not create a session: ${created.body}`).toBe(201);
  const sessionId = (JSON.parse(created.body) as { data?: { sessionId?: string } }).data?.sessionId ?? '';
  expect(sessionId, `the app created a session without an id: ${created.body}`).not.toBe('');

  await page.goto(`/session/${sessionId}`);
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`));
  // A full document load, so the app is built from scratch here — the load a blank one lands on. Bounded
  // and self-reporting, rather than leaving the assertion below to wait out a document that never renders.
  await waitForAppMount(page, pageEvidence);
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  // The app registers the workspace while it boots, so the sidebar settles too. Waiting for
  // rest keeps the first sampled frame from landing on a pane the app is still laying out.
  await waitForSettledPane(page);
  await pointAtPane(page);
  return sessionId;
};

/** Wheels up over the pane until the transcript has prepended an older page. */
const wheelUntilPrepended = async (page: Page, originalFirst: string, previousRows: number) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.mouse.wheel(0, -WHEEL_STEP_PX);
    await waitForSettledPane(page);
    const fixture = await readFixture(page);
    if (fixture.rows > previousRows && fixture.firstStamp !== originalFirst) {
      return fixture;
    }
  }
  throw new Error('the wheel over the pane never made the transcript prepend an older page');
};

/** The offset of a row's top from the pane's top, in CSS pixels — the row's place in the viewport. */
const readRowOffset = (page: Page, stamp: string) =>
  page.evaluate((target) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const row = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
      .find((node) => node.getAttribute('data-message-timestamp') === target);
    return row ? row.getBoundingClientRect().top - pane.getBoundingClientRect().top : null;
  }, stamp);

type AnchorSample = { offset: number | null; scrollTop: number; gap: number };

/**
 * Samples the anchored row's offset, the offset and the gap on the far side of
 * layout and of the ResizeObserver callbacks a growth raises.
 *
 * The observer is created here and observes the content column, so it is called
 * after the app's own and the follow has already written by the time this one is
 * notified; the frame and the timeout after it put the read after that frame's
 * rendering steps. Reading scrollHeight in the same evaluation that grew the box
 * would report a layout nobody ever saw. A fallback keeps a quiet window — the
 * samples after the growth, when nothing resizes — from reading as a hang.
 */
const sampleAnchor = (page: Page, stamp: string) =>
  page.evaluate(
    ({ target, fallbackMs }) => new Promise<AnchorSample>((resolve) => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
      const content = document.querySelector('.chat-messages-pane > div:last-child');
      let settled = false;
      const read = () => {
        if (settled) return;
        settled = true;
        const row = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
          .find((node) => node.getAttribute('data-message-timestamp') === target);
        resolve({
          offset: row ? row.getBoundingClientRect().top - pane.getBoundingClientRect().top : null,
          scrollTop: pane.scrollTop,
          gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
        });
      };
      const afterLayout = () => requestAnimationFrame(() => setTimeout(read, 0));
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        afterLayout();
      });
      if (content) observer.observe(content);
      setTimeout(() => {
        observer.disconnect();
        afterLayout();
      }, fallbackMs);
    }),
    { target: stamp, fallbackMs: AC110_SAMPLE_FALLBACK_MS },
  );

/**
 * Adds a message row the way a user does — through the composer, as the app really
 * sends one — and reports whether the transcript grew.
 *
 * The row arrives as an ordinary React re-render of a real store change: no store
 * write from the spec, no DOM edit of ours, no style of ours. The suggestion menu
 * swallows Enter, so it is dismissed first; that is the composer's own behaviour,
 * not something this case is about.
 */
const appendRowThroughComposer = async (page: Page) => {
  const before = await page.locator(`${PANE} .chat-message`).count();
  const composer = page.locator('textarea').first();
  await composer.click();
  await composer.fill('/memory');
  await composer.press('Escape');
  await composer.press('Enter');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await page.locator(`${PANE} .chat-message`).count()) > before) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
};

/* ────────────────────── AC-108: a reply that really streams ────────────────────── */

/**
 * Viewport the streaming case runs at.
 *
 * A desktop chat, and the window every threshold below is stated against: the wide layout
 * keeps the pane beside the sidebar, and 720px of height makes "more than one screen" a
 * bound one reply can really cross.
 */
const AC108_VIEWPORT = { width: 1280, height: 720 };

/**
 * How many text deltas the reply arrives in, and how far apart.
 *
 * 22 × 250 ms ≈ 5.5s — the criterion's own floor (≥20 deltas over ≥5s) with a delta of
 * margin, which costs less than a longer test. The spacing is what makes the steps
 * countable at all: the client buffers deltas for 100ms before flushing one in-place
 * update, so two deltas inside that window arrive as one growth instead of two.
 */
const AC108_DELTA_COUNT = 22;
const AC108_DELTA_INTERVAL_MS = 250;

/** The gap the pane may show at a frame where no growth just landed, in CSS pixels. */
const AC108_GAP_PX = 1;

/**
 * How long after the last delta its own growth may still be painted, in milliseconds.
 *
 * The client buffers deltas for 100ms before flushing one, so the frame that carries the last
 * delta is a flush plus a frame behind the frame that delivered it. Used to bound the window
 * the criterion measures, together with the pane-shrink test below.
 */
const AC108_STREAM_SETTLE_MS = 250;

/** Carried by the last delta, so the case can wait for the reply to have fully arrived. */
const AC108_COMPLETION_MARKER = 'AC108STREAMDONE';

/**
 * The reply, as the text each of its frames carries.
 *
 * One frame carries one piece of the reply rather than the whole of it: the app appends every
 * piece to the text it is already showing, which is what makes each delivery a growth of the
 * row that is already there instead of a new row. The last piece carries the completion
 * marker, so "the whole reply has arrived" stays a fact about the pane rather than a fact
 * about the pump that fed it.
 *
 * Plain prose on purpose: the reply goes through the app's markdown renderer, and a construct
 * whose layout can jump backwards — a table, a fence that opens before it closes, a list that
 * renumbers — would make "the last row grew" a claim about the renderer rather than about the
 * follow. Four sentences is comfortably more than a line, so every delivery is a visible step
 * rather than a sub-pixel nudge.
 */
const AC108_DELTAS = Array.from({ length: AC108_DELTA_COUNT }, (_, index) => {
  const body = `Delta ${index}. ${'The transcript pane keeps the newest line in view while a reply arrives one piece at a time. '.repeat(4)}`;
  return index === AC108_DELTA_COUNT - 1 ? `${body} ${AC108_COMPLETION_MARKER}` : body;
});

/** One frame's reading of the pane while a reply streams. */
type FollowSample = {
  /** Milliseconds since the page's time origin. */
  t: number;
  /** `scrollHeight − scrollTop − clientHeight`: 0 means the last line is on screen. */
  gap: number;
  /** Rows in the transcript. One per message, mounted or not. */
  rows: number;
  /** The last assistant row's own height, in CSS pixels — what a flush grows. */
  lastRowHeight: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Which `.chat-messages-pane` this was, and how many the document had — a pane that is
   * replaced mid-stream starts life at offset zero, which is a different event from a pane
   * that was placed back there. */
  pane: number;
  panes: number;
  /** Characters in the last assistant row and in the whole pane: a box that keeps its text and
   * loses its height was re-laid out, one that loses its text was unmounted. */
  lastRowText: number;
  paneText: number;
  /**
   * The identity of the last assistant row's own DOM node, numbered as each node is first seen.
   *
   * A React key change is an unmount followed by a mount, so the node the row is drawn with is
   * replaced rather than reconciled — and the replacement is invisible in every other field here,
   * because the new node carries the same text and, a frame later, the same height. The number is
   * what makes the replacement itself readable: the same number means the row kept its node.
   */
  lastRowNode: number;
  /**
   * The lazy wrapper's inline height while it is standing in for the row's content, in CSS pixels,
   * and `null` while the content itself is mounted.
   *
   * `LazyMessageRow` writes `height: measuredHeight ?? 100` on the wrapper exactly when it is NOT
   * rendering `children`, so a non-null reading is the placeholder state and the value is the box
   * the pane's geometry was computed against.
   */
  lastRowPlaceholder: number | null;
  /**
   * The last assistant row's own `data-message-timestamp`, which is the row's identity as the
   * app re-projects it: the store re-mints the live row's timestamp on every flush and again
   * when the turn settles, and the wrapper carries whatever the current one is.
   *
   * Read next to `lastRowNode` it is what separates "the row was re-rendered" from "the row was
   * replaced": a stamp that changes while the node does not is one row re-projected in place,
   * which is the pair every delta used to produce as a re-key. A run in which the stamp never
   * changes never re-projected the row at all, so it cannot say anything about the remount.
   */
  lastRowStamp: string | null;
  /** The content column's own laid-out height — what the rows add up to, independent of the pane. */
  contentHeight: number;
  /**
   * Whether the scroll-to-bottom control is on screen at this frame.
   *
   * It is the only thing a reader is offered when the pane is not at the bottom, so a run that
   * ends up above the bottom with no control ever appearing has left the reader with a transcript
   * that is neither following nor offering to — a different, and worse, state than "detached".
   */
  scrollButton: boolean;
};

/** One sample as a single line, for the readings that have to fit in a gate's excerpt. */
const describeSample = (sample: FollowSample, index: number, marked = false) =>
  `${index}${marked ? '*' : ''}@t${sample.t}:top${Math.round(sample.scrollTop)}/h${Math.round(sample.scrollHeight)}-c${Math.round(sample.clientHeight)}`
  + `=gap${Math.round(sample.gap)},row${Math.round(sample.lastRowHeight)},n${sample.rows},pane${sample.pane}/${sample.panes}`
  + `,text${sample.lastRowText}/${sample.paneText}`
  + `,col${Math.round(sample.contentHeight)},node${sample.lastRowNode}`
  + `,stamp${sample.lastRowStamp === null ? '-' : sample.lastRowStamp.slice(11, 23)}`
  + (sample.lastRowPlaceholder === null ? '' : `,ph${sample.lastRowPlaceholder}`)
  + (sample.scrollButton ? ',btn' : '');

/**
 * One layout the content column went through, as the probe's own observer saw it.
 *
 * The app's follow is driven by exactly this signal, so this is the same evidence the follow had.
 * It is a *trace* rather than a per-frame sample because the excursion being pinned here can
 * begin and end inside one frame, where a once-a-frame read would never see it.
 */
type ContentHeightEntry = {
  /** Milliseconds since the page's time origin, as the observer delivered it. */
  t: number;
  /** The content column's border-box height, in CSS pixels. */
  height: number;
};

/**
 * One row added to or removed from the transcript, as the probe's own observer saw it.
 *
 * This is the only place a React unmount/mount is directly visible: the DOM node itself is
 * created or destroyed, which no per-frame geometry read can distinguish from a re-render.
 */
type RowMutationEntry = {
  t: number;
  kind: 'added' | 'removed';
  /** The row's own `data-message-timestamp`, present on the lazy wrapper for both kinds. */
  stamp: string | null;
};

/**
 * Starts sampling the pane once a frame, each reading taken after the frame's rendering
 * steps and after every ResizeObserver callback they ran.
 *
 * The frame-then-task placement is the whole instrument. A read taken inside a frame callback,
 * which is what the criterion forbids, reports a box the browser has not laid out yet — layout is
 * what a frame's own rendering steps end with, so a read before them measures the geometry the
 * previous frame left — and would say "pinned" no matter what the follow did. A read one frame
 * later sees the box that frame's rendering steps produced and the paint showed, and that is what
 * both the gap and the row height below are read from.
 *
 * Which frame the follow writes in is deliberately not assumed here. `followTranscriptGrowth`
 * answers a growth either in the commit task that landed it or one frame after the observer
 * delivered it, and a sampler that only measured a write whose timing it already knew would be
 * measuring its own model of the follow instead of the pane, so nothing below depends on that.
 */
const startFollowSampler = (page: Page) =>
  page.evaluate(() => {
    type Sample = {
      t: number;
      gap: number;
      rows: number;
      lastRowHeight: number;
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      pane: number;
      panes: number;
      lastRowText: number;
      paneText: number;
      lastRowNode: number;
      lastRowStamp: string | null;
      lastRowPlaceholder: number | null;
      contentHeight: number;
      scrollButton: boolean;
    };
    type HeightEntry = { t: number; height: number };
    type MutationEntry = { t: number; kind: 'added' | 'removed'; stamp: string | null };

    // A DOM node's identity, numbered on first sight. Weak, so it annotates the tree without
    // keeping any of it alive — including the nodes a remount throws away, whose numbers are
    // never reused.
    const nodeIds = new WeakMap<Element, number>();
    let nextNodeId = 0;
    const nodeId = (element: Element) => {
      let id = nodeIds.get(element);
      if (id === undefined) {
        id = (nextNodeId += 1);
        nodeIds.set(element, id);
      }
      return id;
    };

    const panes: Element[] = [];
    const contentHeightTrace: HeightEntry[] = [];
    const rowMutations: MutationEntry[] = [];
    let watchedContent: Element | null = null;
    let contentObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    /** The content column the rows live in: the pane's last child, as the follow's own observer is pointed. */
    const contentColumnOf = (pane: HTMLElement) =>
      (pane.querySelector(':scope > div:last-child') as HTMLElement | null);

    /**
     * Points both probes at whatever content column is current.
     *
     * Re-aimed on every read rather than installed once, because the pane and its column are
     * ordinary React output: a remount that replaced either would otherwise leave the probes
     * watching a detached node and quietly recording nothing.
     */
    const aimProbes = (pane: HTMLElement) => {
      const content = contentColumnOf(pane);
      if (!content || content === watchedContent) return;
      contentObserver?.disconnect();
      contentObserver = new ResizeObserver(() => {
        contentHeightTrace.push({ t: Math.round(performance.now()), height: Math.round(content.getBoundingClientRect().height) });
      });
      contentObserver.observe(content);

      // `subtree` because the wrappers are re-created inside the column, and the row's own node
      // is what is being watched: React removes the old one and inserts the new one, so both
      // halves of a remount are recorded rather than only the arrival.
      mutationObserver?.disconnect();
      mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof Element && node.matches('[data-message-timestamp]')) {
              rowMutations.push({ t: Math.round(performance.now()), kind: 'added', stamp: node.getAttribute('data-message-timestamp') });
            }
          }
          for (const node of Array.from(record.removedNodes)) {
            if (node instanceof Element && node.matches('[data-message-timestamp]')) {
              rowMutations.push({ t: Math.round(performance.now()), kind: 'removed', stamp: node.getAttribute('data-message-timestamp') });
            }
          }
        }
      });
      mutationObserver.observe(content, { childList: true, subtree: true });
      watchedContent = content;
      contentHeightTrace.push({ t: Math.round(performance.now()), height: Math.round(content.getBoundingClientRect().height) });
    };

    const read = (): Sample | null => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      if (!pane) return null;
      aimProbes(pane);
      const paneIndex = panes.indexOf(pane);
      if (paneIndex === -1) {
        panes.push(pane);
      }
      // The lazy row wrapper, not `.chat-message`: a row scrolled out of the viewport band
      // swaps its content for a placeholder of the same height, so counting the content
      // would report what the viewport holds rather than how many messages there are.
      const rows = (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[])
        .filter((row) => !row.parentElement?.closest('[data-message-timestamp]'));
      const assistants = Array.from(pane.querySelectorAll('.chat-message.assistant')) as HTMLElement[];
      const last = assistants[assistants.length - 1];
      // The wrapper the row's content is drawn inside. Its inline height exists only while the
      // wrapper is standing in for that content, so reading it is how the placeholder state is
      // told from the mounted one.
      const wrapper = last?.closest('[data-message-timestamp]') as HTMLElement | null;
      const placeholder = wrapper && wrapper.style.height ? parseFloat(wrapper.style.height) : null;
      const content = contentColumnOf(pane);
      return {
        t: Math.round(performance.now()),
        gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
        rows: rows.length,
        lastRowHeight: last ? Math.round(last.getBoundingClientRect().height * 100) / 100 : 0,
        scrollTop: pane.scrollTop,
        scrollHeight: pane.scrollHeight,
        clientHeight: pane.clientHeight,
        pane: paneIndex === -1 ? panes.length - 1 : paneIndex,
        panes: document.querySelectorAll('.chat-messages-pane').length,
        lastRowText: last ? (last.textContent ?? '').length : 0,
        paneText: (pane.textContent ?? '').length,
        lastRowNode: last ? nodeId(last) : 0,
        lastRowStamp: wrapper?.getAttribute('data-message-timestamp') ?? null,
        lastRowPlaceholder: placeholder,
        contentHeight: content ? Math.round(content.getBoundingClientRect().height) : 0,
        scrollButton: pane.querySelector('[aria-label="Scroll to bottom"], [title="Scroll to bottom"]') !== null,
      };
    };
    const state = {
      samples: [] as Sample[],
      contentHeightTrace,
      rowMutations,
      running: true,
    };
    (window as unknown as { __ac108: typeof state }).__ac108 = state;
    const tick = () => {
      if (!state.running) return;
      requestAnimationFrame(() => {
        setTimeout(() => {
          const sample = read();
          if (sample) state.samples.push(sample);
          tick();
        }, 0);
      });
    };
    tick();
  });

/**
 * Waits until the sampler has read its first frame.
 *
 * A case that hands the app a row the moment the sampler is installed races the sampler's own
 * first tick: the row can be in the pane before any frame is read, which leaves the first growth
 * with no frame in front of it to be measured against — and the first frame of a run is exactly
 * the one a follow has no previous bottom to answer from. Waiting here makes every growth below
 * a growth *from* something rather than a state the run started in.
 */
const waitForFirstSample = (page: Page) =>
  page.waitForFunction(
    () => ((window as unknown as { __ac108?: { samples: unknown[] } }).__ac108?.samples.length ?? 0) > 0,
    undefined,
    { timeout: 5_000 },
  );

/**
 * Stops the sampler and returns everything it read.
 *
 * The two traces ride along with the per-frame samples because they are the same evidence at a
 * finer grain: the growth the rows produce is what the frame samples count, and the column's own
 * height, recorded the moment the browser re-laid it out, is what says whether a frame's reading
 * was taken against the real content or against a box that had briefly been something else.
 */
const stopFollowSampler = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as {
      __ac108: {
        running: boolean;
        samples: FollowSample[];
        contentHeightTrace: ContentHeightEntry[];
        rowMutations: RowMutationEntry[];
      };
    }).__ac108;
    state.running = false;
    return {
      samples: state.samples,
      contentHeightTrace: state.contentHeightTrace,
      rowMutations: state.rowMutations,
    };
  });

/* ────────────────────── AC-109: a small gesture is still a gesture ────────────────────── */

/**
 * The two replies this case delivers, one per window, and the marker that ends each.
 *
 * Two windows rather than one, because the case measures two gestures — a wheel and a keyboard
 * scroll — and each has to start from a pane the follow is holding at the bottom. A second
 * reply in the same conversation gives the second window something of its own to grow into,
 * while the app's own control walks the pane back to the bottom from the first. A marker per
 * reply is what makes "this window's reply has fully arrived" checkable from the pane.
 */
const AC109_WHEEL_COMPLETION_MARKER = 'AC109WHEELDONE';
const AC109_KEY_COMPLETION_MARKER = 'AC109KEYDONE';

/**
 * The reply behind each window: 24 deltas 250 ms apart, so the transport spans 5.75 s.
 *
 * The criterion's floor is twenty deltas over five seconds, and this case spends part of that
 * span on its own gesture: the detach window below has to sit inside the reply, so it must
 * still be arriving when the window ends. The deltas are fatter than AC-108's because a wheel
 * only moves a pane that has something to scroll, and the window cannot start until the
 * reply's own row has already filled more than a screen.
 */
const AC109_DELTA_COUNT = 24;
const AC109_DELTA_INTERVAL_MS = 250;

/** How far the pane has to be scrollable before the gesture is sent — see above. */
const AC109_SCROLLABLE_MIN_PX = 300;

/** The wheel this case sends: thirty pixels, inside the 50px band a distance rule calls "at the bottom". */
const AC109_WHEEL_PX = 30;

/**
 * How long the viewport is left alone after the gesture, in milliseconds.
 *
 * Long enough for the browser to finish the movement the gesture started — a wheel is animated —
 * and for the reply to grow the pane under it several times, which is what gives an
 * implementation that re-pins on the next growth the chance to. The window is closed by its own
 * liveness assertion rather than by this number: the reply must still be arriving when it ends.
 */
const AC109_DETACH_WINDOW_MS = 1_200;

/** How long the pane is sampled after the reply has fully arrived, in milliseconds. */
const AC109_PINNED_TAIL_MS = 400;

/** The gap the pane may show at a frame, in CSS pixels — the criterion's own bound. */
const AC109_GAP_PX = 1;

/**
 * The text each reply carries, one string per delta.
 *
 * Six sentences rather than AC-108's four: the reply has to make the pane scrollable by more
 * than `AC109_SCROLLABLE_MIN_PX` before the gesture is sent, and doing that in fewer, fatter
 * deltas is what keeps the window inside the reply.
 */
const ac109Deltas = (completionMarker: string) =>
  Array.from({ length: AC109_DELTA_COUNT }, (_, index) => {
    const body = `Delta ${index}. ${'The transcript pane keeps the newest line in view while a reply arrives one piece at a time. '.repeat(6)}`;
    return index === AC109_DELTA_COUNT - 1 ? `${body} ${completionMarker}` : body;
  });

const AC109_WHEEL_DELTAS = ac109Deltas(AC109_WHEEL_COMPLETION_MARKER);
const AC109_KEY_DELTAS = ac109Deltas(AC109_KEY_COMPLETION_MARKER);

/** The pane's geometry at one sampled frame of either AC-109 window. */
type Ac109Sample = {
  /** Milliseconds since the page's time origin. */
  t: number;
  /** `scrollHeight − scrollTop − clientHeight`: 0 means the last line is on screen. */
  gap: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * Starts sampling the pane once a frame's rendering steps have run, and keeps sampling until told
 * to stop.
 *
 * The read is taken from inside `requestAnimationFrame` plus a `setTimeout(0)`, which is after
 * the frame's layout and after the callbacks a `ResizeObserver` delivery queued for that frame.
 * That ordering is the point: a growth and the write that answers it land in the same frame, and
 * a sampler that read between them would report the un-repaired state as a gap the follow left.
 */
const startAc109Sampler = (page: Page) =>
  page.evaluate(() => {
    const state = { running: true, samples: [] as Ac109Sample[] };
    (window as unknown as { __ac109?: typeof state }).__ac109 = state;
    const tick = () => {
      if (!state.running) return;
      requestAnimationFrame(() => {
        setTimeout(() => {
          const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
          if (pane) {
            state.samples.push({
              t: performance.now(),
              gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
              scrollTop: pane.scrollTop,
              scrollHeight: pane.scrollHeight,
              clientHeight: pane.clientHeight,
            });
          }
          tick();
        }, 0);
      });
    };
    tick();
  });

/** Stops the sampler and returns every frame it saw since it was started. */
const stopAc109Sampler = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __ac109?: { running: boolean; samples: Ac109Sample[] } }).__ac109;
    if (!state) return [] as Ac109Sample[];
    state.running = false;
    return state.samples;
  });

/**
 * Counts the writes to *this pane's* offset, on the pane instance itself.
 *
 * The window-level instrument counts every element's assignments; what the criterion is about is
 * whether anything placed this pane's viewport while the user was holding it, so the count is
 * taken at the element. The descriptor forwards to the prototype's own — the one
 * `instrumentScrollSources` installed, so the write is counted there too and the native setter
 * still runs. A wheel, a key and the browser's own clamp never go through a JS setter, which is
 * what makes a non-empty record a record of the *app* writing the offset rather than of the
 * gesture.
 */
const installAc109PaneWriteCounter = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const state = { writes: [] as { value: number; t: number; frames: string[] }[] };
    (window as unknown as { __ac109PaneWrites?: typeof state }).__ac109PaneWrites = state;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get(this: Element) {
        return descriptor.get!.call(this);
      },
      set(this: Element, value: number) {
        // The caller's whole chain is kept with the value — the setter, the writer, and whatever
        // armed it — so a run that finds a write names what made it instead of only reporting that
        // something did. The frames are the dev server's own module lines, which the transform
        // renumbers; the writer is identified by mapping them back through the same transform.
        state.writes.push({
          value,
          t: performance.now(),
          frames: (new Error().stack ?? '').split('\n').slice(1, 10).map((line) => line.trim()),
        });
        descriptor.set!.call(this, value);
      },
    });
  });

/** The writes the pane itself received since its counter was installed. */
const readAc109PaneWrites = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __ac109PaneWrites?: { writes: { value: number; t: number; frames: string[] }[] } })
      .__ac109PaneWrites?.writes ?? []);

/**
 * The pane's geometry at the instant the user's own gesture was delivered to it.
 *
 * `scrollTop` here is the offset the gesture starts from, and it is correct for that role because
 * an input event's default action — the scroll a wheel or a PageUp performs — runs *after* the
 * event has been dispatched, so a synchronous read taken on the way through the event is the
 * pre-scroll value. That is only true of a *blocking* listener: a passive one lets the wheel's
 * scroll run first, and the same read then returns the offset the gesture has already moved to
 * (measured here — a passive listener read `539 − 30` where the pane stood at `539`). The
 * listener below is therefore registered `passive: false`, and the two halves of the case are what
 * the flag is measured against: the wheel anchors at the pane's standing offset and the keyboard
 * at the same one, with `movedUpBy` 30 and 402 respectively. `t` is the same clock the sampler and
 * the write counters use, which is what lets the window cut its records at the moment the user
 * moved.
 */
type Ac109InputAnchor = {
  /** Milliseconds since the page's time origin, taken as the input was dispatched. */
  t: number;
  /** The gesture's starting offset — read before the input's default scroll action runs. */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The input that anchored this window: `wheel` or `keydown`. */
  type: string;
};

/**
 * Anchors the window at the user's own input, rather than at the stub that set the window up.
 *
 * The window's claims are about what the *user's gesture* did — "the gesture moved the viewport
 * up", "nothing moved it back while the user was holding it" — so the frame of reference has to be
 * the gesture, not the moment a few CDP round trips earlier when the harness started reading. The
 * reply behind this case delivers a delta every 250 ms and each delta makes the row taller by more
 * than a hundred pixels, so a delta landing between the stub and the gesture leaves the follow
 * legitimately holding the pane and pushing the offset *down* before the user has touched
 * anything. Read against the stub-time offset, that arrival is indistinguishable from a gesture
 * the app ignored: the offset the samples start from is a whole delta below the reference, which
 * is the `-90` this window used to fail with. The arrival is not the window's behaviour, so it is
 * measured where it belongs — before the window — and the reference is taken here.
 *
 * A capture-phase listener on `window` is the earliest point the input is observable at, and the
 * first input of a window is the gesture: the case sends exactly one, and the harness aims and
 * focuses before it does. `wheel` and `keydown` are the two the criterion covers — the same pair
 * the case's own two halves send — and neither is re-delivered by the follow's own writes, which
 * go through `scrollTop` and therefore never look like an input.
 */
const installAc109InputAnchor = (page: Page) =>
  page.evaluate(() => {
    const state = { anchor: null as Ac109InputAnchor | null };
    (window as unknown as { __ac109Anchor?: typeof state }).__ac109Anchor = state;
    for (const type of ['wheel', 'keydown']) {
      window.addEventListener(type, () => {
        if (state.anchor) return;
        const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
        if (!pane) return;
        state.anchor = {
          t: performance.now(),
          scrollTop: pane.scrollTop,
          scrollHeight: pane.scrollHeight,
          clientHeight: pane.clientHeight,
          type,
        };
        // `passive: false` is load-bearing, not boilerplate: a passive wheel listener lets this
        // event's own scroll run before the listener does, and `scrollTop` above would then be the
        // offset the gesture already reached instead of the one it started from.
      }, { capture: true, passive: false });
    }
  });

/** The input the window was anchored at, or null if the gesture never arrived as one. */
const readAc109InputAnchor = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __ac109Anchor?: { anchor: Ac109InputAnchor | null } }).__ac109Anchor;
    return state?.anchor ?? null;
  });

/**
 * The offsets a window sampled, and the moment the gesture was dispatched in between them.
 *
 * Kept as the reading a red run needs: "a write landed" is only actionable once it is known
 * whether it landed before the gesture took effect or after it, and the frame times are what
 * say which — the input anchor is the same reading one step earlier, so a red run can show what
 * the reference was taken from as well as where the gesture landed against it.
 */
const describeAc109Window = (
  samples: Ac109Sample[],
  writes: { value: number; t: number; frames: string[] }[],
  gesture: { startedAt: number; endedAt: number; anchor?: Ac109InputAnchor | null },
  trace?: ScrollInstruments,
) => JSON.stringify({
  // The four geometry fields rather than the offset alone: a write whose value is past the pane's
  // own maximum is clamped by the browser, so "the offset never moved" and "nothing wrote it" are
  // different readings and only the max says which one happened.
  sampled: samples.map((sample) => [
    Math.round(sample.t),
    Math.round(sample.scrollTop),
    Math.round(sample.scrollHeight),
    Math.round(sample.clientHeight),
  ]),
  writes: writes.map((write) => ({ value: Math.round(write.value), t: Math.round(write.t), frames: write.frames })),
  gesture: {
    startedAt: Math.round(gesture.startedAt),
    endedAt: Math.round(gesture.endedAt),
    // The reference the window's two offset readings were actually taken against, and the input
    // that provided it. Without it a red run cannot say whether the baseline was the gesture's own
    // offset or one a pre-gesture arrival had already pushed away.
    anchor: gesture.anchor
      ? { t: Math.round(gesture.anchor.t), scrollTop: Math.round(gesture.anchor.scrollTop), type: gesture.anchor.type }
      : null,
  },
  // What the page saw the user do and what it reported back. The write above is only attributable
  // once it is placed against these: an input the app had seen and not yet acted on, a report that
  // arrived after the write, or a button that mounted before it are three different defects.
  inputs: trace?.__scrollInputs.map((input) => [Math.round(input.t), input.type]) ?? [],
  scrolls: trace?.__scrollEvents
    .filter((event) => event.target.includes('chat-messages-pane'))
    .map((event) => Math.round(event.t)) ?? [],
  scrollButtons: trace?.__scrollButtonAppearances.map((appearance) => Math.round(appearance.t)) ?? [],
});

/** One of AC-109's two detach windows, as it was measured. */
type Ac109WindowReading = {
  label: string;
  /** How far the gesture moved the viewport up, in CSS pixels. */
  movedUpBy: number;
  /** The highest offset any frame in the window showed, relative to where the gesture started. */
  highestOffsetDelta: number;
  /** Frames sampled between the gesture and the button. */
  detachFrames: number;
  /** Growths the stream delivered while the window was open. */
  growthsInWindow: number;
  /** Everything the pane's own offset was written with in the window. */
  paneWrites: { value: number; t: number; frames: string[] }[];
  /** Everything any element's offset was written with in the window. */
  pageWrites: { value: number; t: number }[];
  /** Whether the app's way back was on screen when the window ended. */
  buttonVisible: boolean;
  /** Mounts of that control inside the window — this gesture's detach, counted. */
  buttonAppearancesInWindow: number;
  /** Whether the reply had already fully arrived when the window ended. */
  completionPresent: boolean;
  /** Frames sampled from the click to the end of the reply. */
  pinnedFrames: number;
  /** Growths the remaining stream delivered in that second window. */
  pinnedGrowths: number;
  /** Frames left off the bottom that the following frame did not repair. */
  unpinned: { t: number; gap: number; grew: boolean; nextGap: number | null }[];
  /** The gap the pane showed once the reply had arrived. */
  settledGap: number;
};

/**
 * Measures one detach window: gesture, hold, and the app's own way back.
 *
 * The criterion's three claims are asserted here, in the order they happen:
 *
 *   1. the gesture detaches — a small upward wheel and a keyboard scroll are the same thing to
 *      the pane, so both go through this one path; the pane is asserted to be following *before*
 *      the gesture, and the control to have mounted *after* it, so the claim is about this
 *      gesture rather than about a pane that was already detached when the window opened;
 *   2. nothing places the viewport while the reply is still growing it — not the follow, not a
 *      deferred pin, not the frame a growth landed on;
 *   3. the control the app offers is what brings it back, and from the click to the end of the
 *      reply every frame is pinned.
 *
 * A headless browser cannot be asked what the user meant, so each claim is measured on what the
 * page did: offsets, writes, and the frames between them.
 */
const runAc109Window = async (page: Page, options: {
  label: string;
  sessionId: string;
  deltas: string[];
  completionMarker: string;
  gesture: () => Promise<void>;
}): Promise<Ac109WindowReading> => {
  const { label, sessionId, deltas, completionMarker, gesture } = options;

  // The window's transport: the reply starts arriving on the app's own socket, one delta at a
  // time, for as long as the window needs it. Nothing is sent, no provider is asked for a run
  // and no model is involved — the frame source is doubled, the consumer is not.
  const stream = startWireStream(page, sessionId, deltas, AC109_DELTA_INTERVAL_MS);

  // A wheel only moves a pane that has something to scroll, and this window is about a pane the
  // user took while a reply was still growing it: waiting for the reply to have filled more than
  // a screen — with the follow keeping the pane at the bottom — is what makes the gesture below a
  // real one rather than a no-op that a pane which never moved would pass for free.
  await expect
    .poll(async () => {
      const geometry = await readGeometry(page);
      return geometry.scrollHeight - geometry.clientHeight >= AC109_SCROLLABLE_MIN_PX
        && geometry.gap <= AC109_GAP_PX;
    }, { timeout: 30_000, message: `${label}: the reply never filled the pane while the follow kept it at the bottom` })
    .toBe(true);

  // The counters are installed here rather than earlier, and the *reference* is not taken here at
  // all: what the window measures is the window, and a write the app made while the reply was
  // filling the pane says nothing about whether the gesture was respected. The reference is the
  // one thing that cannot be read at this point — the probe above, the button count below, the
  // instrument clear and the sampler start are five to six round trips between here and the
  // gesture, and the reply delivers a delta every 250 ms, so a delta landing in that gap leaves the
  // follow legitimately pushing the offset down before the user has touched anything. Read against
  // this line's offset, that arrival is indistinguishable from a gesture the app ignored, which is
  // the false red this window used to produce. The reference is therefore taken from the gesture's
  // own input event (`installAc109InputAnchor`), and `stubOffset` is kept alongside it as the
  // diagnostic that says how far the pane travelled between the stub and the gesture.
  const stubOffset = (await readGeometry(page)).scrollTop;
  await installAc109PaneWriteCounter(page);
  await installAc109InputAnchor(page);
  // The window's premise, and the reason it is asserted before the gesture rather than trusted:
  // the claims below say "this gesture took the pane and nothing gave it back", which is only a
  // statement about this gesture if the pane arrived under the follow's control. A pane that was
  // already detached when the window opened passes every one of them — the hold, the absence of
  // writes, the control on screen — while the gesture it is supposed to be about was never the
  // thing that detached it.
  const buttonAtOpen = await page.locator(SCROLL_BUTTON).count();
  expect(
    buttonAtOpen,
    `${label}: the pane has to be following when the window opens, or the detach inside it is some other input's doing`,
  ).toBe(0);
  await clearInstruments(page);
  await startAc109Sampler(page);

  const gestureStartedAt = await page.evaluate(() => performance.now());
  await gesture();
  const gestureEndedAt = await page.evaluate(() => performance.now());
  await page.waitForTimeout(AC109_DETACH_WINDOW_MS);

  const detachSamples = await stopAc109Sampler(page);
  // The gesture's own frame of reference, read after the fact (it is recorded synchronously as the
  // input is dispatched, so nothing the gesture does can move what it says). Its absence is a
  // reading of its own rather than a reason to fall back to the stub: the gesture is delivered
  // through the browser's input path, and a window whose gesture never arrived as an input has no
  // reference that belongs to it.
  const anchor = await readAc109InputAnchor(page);
  expect(
    anchor,
    `${label}: the gesture has to arrive as an input event on the pane, or the window has no frame of reference of its own and its baseline would be the stub's`,
  ).not.toBeNull();
  // Every reading below is cut at the gesture's own input moment. `anchor.scrollTop` is the offset
  // the user's gesture started from — the input's default scroll has not run yet when it is read —
  // and the write records are filtered to `t >= anchor.t`, so a write the follow made *before* the
  // user touched the pane is "before the window" rather than the window's behaviour. Both are the
  // same defect seen from two sides: the stub is a few round trips wide, the reply fills that gap,
  // and what happened in it says nothing about whether the gesture was respected.
  const anchorOffset = anchor!.scrollTop;
  const anchorT = anchor!.t;
  const paneWrites = (await readAc109PaneWrites(page)).filter((write) => write.t >= anchorT);
  const detachTrace = await readInstruments(page);
  const pageWrites = detachTrace.__scrollWrites.filter((write) => write.t >= anchorT);
  const buttonVisible = await page.locator(SCROLL_BUTTON).isVisible().catch(() => false);
  // The mounts seen *inside* the window: the control is rendered from the intent the pane reports,
  // so one appearing here is this gesture's detach and not a state the window inherited.
  const buttonAppearancesInWindow = detachTrace.__scrollButtonAppearances.length;
  const completionPresent = ((await page.locator(PANE).textContent()) ?? '').includes(completionMarker);

  // The window's frames are the gesture's: the sampler is started before the gesture so that the
  // frames either side of it are visible, but a frame taken *before* the user moved is a frame of
  // the pane the follow was still holding, and one of those sitting a delta below the anchor is the
  // same pre-gesture arrival the anchor exists to exclude. Cutting here makes both readings
  // statements about what the pane did after the user took it.
  const windowSamples = detachSamples.filter((sample) => sample.t >= anchorT);
  const offsets = windowSamples.map((sample) => sample.scrollTop);
  const movedUpBy = offsets.length ? anchorOffset - Math.min(...offsets) : 0;
  const highestOffsetDelta = offsets.length ? Math.max(...offsets) - anchorOffset : 0;
  const growthsInWindow = windowSamples.filter((sample, index) => (
    index > 0 && sample.scrollHeight > windowSamples[index - 1].scrollHeight + AC109_GAP_PX
  )).length;

  expect(
    detachSamples.length,
    `${label}: the sampler has to have watched the window (it saw no frame at all)`,
  ).toBeGreaterThan(0);
  expect(
    movedUpBy,
    `${label}: the gesture has to have moved the viewport up, or "nothing wrote it back" is a statement about a pane the user never moved`,
  ).toBeGreaterThan(0);
  // The criterion's own reading. Thirty pixels and a PageUp both leave the pane inside the 50px
  // band a distance rule reads as "at the bottom", so an implementation that decided by distance
  // would re-pin on the next growth: it shows up here as a higher offset, or — if it wrote
  // without the offset moving — as a write.
  expect(
    highestOffsetDelta,
    `${label}: the pane must never be moved back down while the user is holding it, against the gesture's own baseline of ${Math.round(anchorOffset)} at t${Math.round(anchorT)} (the stub read ${Math.round(stubOffset)}; ${describeAc109Window(detachSamples, paneWrites, { startedAt: gestureStartedAt, endedAt: gestureEndedAt, anchor }, detachTrace)})`,
  ).toBeLessThanOrEqual(AC109_GAP_PX);
  expect(
    paneWrites,
    `${label}: the pane's own offset must not be written at all while the user holds it (${describeAc109Window(detachSamples, paneWrites, { startedAt: gestureStartedAt, endedAt: gestureEndedAt, anchor }, detachTrace)})`,
  ).toEqual([]);
  expect(
    pageWrites,
    `${label}: no element's offset may be written while the user holds the pane`,
  ).toEqual([]);
  // The window's liveness, from the stream's side: the reply was still arriving, and it really
  // did grow the pane under the held viewport.
  expect(
    completionPresent,
    `${label}: the reply had already fully arrived when the window ended, so the window measured a settled pane`,
  ).toBe(false);
  expect(
    stream.delivered(),
    `${label}: the reply was never handed to the app, so the window measured a pane nothing was growing`,
  ).toBeGreaterThan(0);
  expect(
    stream.finished(),
    `${label}: the reply must still have been arriving when the window ended, or the window measured a settled pane`,
  ).toBe(false);
  expect(
    growthsInWindow,
    `${label}: the reply has to have grown the pane while the window was open`,
  ).toBeGreaterThan(0);
  expect(
    buttonAppearancesInWindow,
    `${label}: the control has to mount inside the window — a gesture is what takes the pane, so the control coming back is this gesture's reading and a control that was already mounted belongs to whatever happened before it`,
  ).toBeGreaterThan(0);
  expect(buttonVisible, `${label}: the scroll-to-bottom control has to be on screen`).toBe(true);

  // The app's own way back, clicked as a user clicks it. The pane is pinned again before the
  // second window starts, so every frame of it is a reading of the follow rather than of the
  // click still travelling.
  await page.locator(SCROLL_BUTTON).click();
  await expect
    .poll(async () => Math.abs((await readGeometry(page)).gap), {
      timeout: 10_000,
      message: `${label}: the control never brought the pane back to the bottom`,
    })
    .toBeLessThanOrEqual(AC109_GAP_PX);

  await startAc109Sampler(page);
  await expect(page.locator(PANE)).toContainText(completionMarker, { timeout: 30_000 });
  // The content block's own end, delivered after the last delta. The sampler is left running
  // across it on purpose: the frame that finalizes the row is part of the reply's span, and a
  // follow that only holds the pane until the text stops arriving is not what the criterion says.
  await stream.done;
  await page.waitForTimeout(AC109_PINNED_TAIL_MS);
  const pinnedSamples = await stopAc109Sampler(page);
  const settled = await readGeometry(page);

  // Every frame from the click to the end of the reply, with the one exception a follow cannot
  // avoid: the frame a growth lands on may be painted before the write that answers it, and the
  // criterion's shape is that the *next* frame is already pinned — the same reading AC-108 keeps.
  // A frame with no growth on it is held to the bound with no exception at all, and both sides of
  // it: a pane placed past the bottom is as far from pinned as one left above it.
  const grew = (index: number) => index > 0
    && pinnedSamples[index].scrollHeight > pinnedSamples[index - 1].scrollHeight + AC109_GAP_PX;
  const unpinned = pinnedSamples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => Math.abs(sample.gap) > AC109_GAP_PX)
    .filter(({ index }) => (
      !grew(index)
      || index + 1 >= pinnedSamples.length
      || Math.abs(pinnedSamples[index + 1].gap) > AC109_GAP_PX
    ))
    .map(({ sample, index }) => ({
      t: Math.round(sample.t),
      gap: Math.round(sample.gap),
      grew: grew(index),
      nextGap: index + 1 < pinnedSamples.length ? Math.round(pinnedSamples[index + 1].gap) : null,
    }));
  const pinnedGrowths = pinnedSamples.filter((_, index) => grew(index)).length;

  expect(pinnedSamples.length, `${label}: the pinned window has to have been sampled`).toBeGreaterThan(0);
  expect(
    pinnedGrowths,
    `${label}: the reply has to keep growing the pane after the click, or "pinned to the end" is a statement about a stalled stream`,
  ).toBeGreaterThan(0);
  expect(
    unpinned,
    `${label}: after the control is clicked the pane has to stay pinned at the bottom for the rest of the reply`,
  ).toEqual([]);
  expect(
    Math.abs(settled.gap),
    `${label}: the pane has to settle at the bottom`,
  ).toBeLessThanOrEqual(AC109_GAP_PX);

  return {
    label,
    movedUpBy: Math.round(movedUpBy),
    highestOffsetDelta: Math.round(highestOffsetDelta),
    detachFrames: detachSamples.length,
    growthsInWindow,
    paneWrites,
    pageWrites,
    buttonVisible,
    buttonAppearancesInWindow,
    completionPresent,
    pinnedFrames: pinnedSamples.length,
    pinnedGrowths,
    unpinned,
    settledGap: Math.round(settled.gap),
  };
};

/* ------------------------------------------------------------------ */
/*  A whole row arriving                                              */
/* ------------------------------------------------------------------ */

/**
 * Viewport the whole-row case runs at.
 *
 * The same one AC-108 and AC-109 use, so the pane's height — the box a row has to be measured
 * against — is the height those cases already characterise.
 */
const WHOLE_ROW_VIEWPORT = { width: 1280, height: 720 };

/** How many whole rows the case appends, one at a time. The criterion reads a series of ≥5. */
const WHOLE_ROW_COUNT = 6;

/**
 * Paragraphs in one appended row.
 *
 * Every row has to be *markedly taller than the pane*: a row that lands near the fold leaves the
 * band the pane can skip on screen either side of it, and whether the placeholder box took part
 * in the layout stops being readable from the geometry. Twenty paragraphs of prose at this width
 * is a row an order of magnitude past the pane, so the row is either wholly in view or wholly
 * out of it and its height is never in question.
 */
const WHOLE_ROW_PARAGRAPHS = 20;

/**
 * How long each row is given before the next one is appended.
 *
 * Not a settle in the "wait for the follow" sense — the readings are taken from the frame samples
 * either way — but enough that each row is a separate arrival rather than one long growth, which
 * is what makes the per-row first-frame height and its own settled height separable.
 */
const WHOLE_ROW_SETTLE_MS = 400;

/**
 * The height the pane lays a row it has not drawn yet out at.
 *
 * `src/index.css` gives `.chat-message.assistant` a `contain-intrinsic-size` of this, and
 * `content-visibility: auto` is what makes the box stand in for the row's content on the layout
 * the row is inserted in: the row is below the fold at that moment, its contents are skipped, and
 * the pane's scrollHeight is computed against this box rather than the row's real height. It is
 * the whole subject of this case, so it is named here rather than inlined, and asserted against
 * (the criterion allows ±2px).
 */
const WHOLE_ROW_INTRINSIC_PX = 240;

/**
 * The tail row as the pane is showing it: how many rows there are and what the last one says.
 *
 * Both halves are read from the row wrappers, which stay in the DOM whether or not a row's
 * content is mounted, so an unmounted row is counted as the row it is rather than as the absence
 * of one. The text is the arrival's own evidence: `wholeRowText` numbers every row, so "the last
 * row is the one just injected" is a fact about the content rather than about the geometry.
 */
const readTailRow = (page: Page) =>
  page.evaluate(() => {
    const rows = (Array.from(document.querySelectorAll('.chat-messages-pane [data-message-timestamp]')) as HTMLElement[])
      .filter((row) => !row.parentElement?.closest('[data-message-timestamp]'));
    const last = rows[rows.length - 1];
    return { rows: rows.length, text: (last?.textContent ?? '').slice(0, 40) };
  });

/**
 * The text one appended row carries.
 *
 * Plain prose on purpose, for the same reason AC-108's reply is plain prose: the row goes through
 * the app's markdown renderer, and a construct whose layout can jump — a table, a fence, a list
 * that renumbers — would make "the row arrived" a claim about the renderer. The paragraphs are
 * numbered so the last row's text is a function of which row it is, which is what makes the
 * content assertion below about the arrival rather than about prose appearing somewhere.
 */
const wholeRowText = (index: number) => Array.from(
  { length: WHOLE_ROW_PARAGRAPHS },
  (_, paragraph) =>
    `Row ${index}, paragraph ${paragraph}. ${'The transcript pane keeps the newest line in view while whole rows arrive one at a time. '.repeat(2)}`,
).join('\n\n');

/** The row's own opening words, as the marker its arrival can be read from. */
const wholeRowMarker = (index: number) => `Row ${index}, paragraph 0.`;

/**
 * Hands the app one whole assistant row on its own chat socket, the way the backend hands over a
 * row a provider finished.
 *
 * A `kind: 'text'` frame with `role: 'assistant'` and no `seq` is the transport's own shape for a
 * completed assistant turn — the same frame the seeded transcript is made of, and the same one
 * the live path routes to the store for anything that is not a streaming delta. It is deliberately
 * not a `stream_delta`: a delta grows the row the previous delta made, and the case is about a row
 * that was not there before.
 *
 * The timestamp is the wall clock, which is what the row's `data-message-timestamp` carries and
 * what the app keys the row by; distinct values keep the rows from being folded into each other.
 */
const injectWholeRow = (page: Page, sessionId: string, index: number) =>
  page.evaluate(
    (payload) =>
      (window as unknown as { __injectStreamFrame: (frame: unknown) => number }).__injectStreamFrame({
        kind: 'text',
        sessionId: payload.sessionId,
        content: payload.content,
        id: `e2e-whole-row-${payload.index}-${payload.timestamp}`,
        timestamp: payload.timestamp,
        provider: 'claude',
        role: 'assistant',
      }),
    { sessionId, index, content: wholeRowText(index), timestamp: new Date().toISOString() },
  );

/**
 * How long this run's client is given to answer its own app entry before the criterion's startup path gives
 * up on it.
 *
 * Not a guess at the slow case, but the bound that turns "the client never came up" into this spec's own red:
 * the run already has two ceilings above it (the watchdog ends a browser-launch-or-cases run at 55s, the goal
 * gate kills at 60s), and both are *outside* the spec — an unbounded wait inside `beforeAll` would be
 * reported by whichever of them fired first, naming neither the url nor the status.
 */
const CLIENT_WARM_DEADLINE_MS = 30_000;

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's
 * entry module, and then one optimized dependency — all requested against this run's own client before any
 * page of this run exists.
 *
 * The dependency request is the one that carries the proof, and it is why the step is not just "warm the
 * cache". The imports of a transformed module are already rewritten to this run's own
 * `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` urls, and that url only answers 200 once the optimizer has
 * committed the bundle: while the bundle is still being built the request is held, and a url carrying a hash
 * from a superseded run is exactly what a page receives `504 Outdated Optimize Dep` for — the answer the
 * app's own Vite client reacts to with `location.reload()`, which is the way this criterion lost its page
 * mid-measurement. So a 200 there means the page below will not race the optimizer, and the geometry the
 * criterion samples will be sampled on a document that is still the document it navigated to.
 *
 * The proof needs the entry and nothing else. Walking the app's module graph first — 80 modules, breadth
 * first, the imports of each one read back out of its transformed body — was measured as well: it does not
 * change what the commit covers, because the optimizer's own scan already reaches the app's dependencies
 * through the entry (the runs that walked the graph logged the same single `[BABEL] … deps/react-scan.js`
 * line as the runs that did not, so neither run re-optimized at page time), and it cost 3-7s of the run's
 * budget against this step's 1.4-2.6s. What the fixture is missing is the commit proof, not the walk.
 *
 * Why the warm-up lives here rather than in `playwright.config.ts`'s `globalSetup`, which is where this
 * defect's proposal put it: Playwright resolves every `globalSetup` entry as a *script* — `resolveScript()`
 * turns it into a path and the file must default-export the function — so an inline warm-up is neither
 * type-legal nor loadable, and this task's write surface allows no new file. `beforeAll`, before
 * `browser.newPage()`, is the earliest point inside the criterion's own startup path, and it is strictly
 * before any page exists — the same requests the page would have made, made first.
 *
 * Every step is bounded, including each request: a client that accepts the connection and then never answers
 * fails here, by name, with the url and the status, rather than waiting out a timeout further up.
 */
const warmClientStartup = async (clientUrl: string): Promise<number> => {
  const startedAt = Date.now();
  const deadline = startedAt + CLIENT_WARM_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs());
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (error) {
      throw new Error(
        `the client did not answer ${url} inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget `
        + `(${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const shellUrl = new URL('/', clientUrl).href;
  const shell = await fetchWithin(shellUrl);
  if (!shell.ok) throw new Error(`the client's shell did not load: ${shellUrl} answered HTTP ${shell.status}`);
  await shell.text();

  const entryUrl = new URL('/src/main.tsx', clientUrl).href;
  const entry = await fetchWithin(entryUrl);
  if (!entry.ok) throw new Error(`the app entry did not transform: ${entryUrl} answered HTTP ${entry.status}`);
  await entry.text();

  // The proof: a dependency url current for this run — re-read from the entry each attempt, because the hash a
  // url carries is the one its writer committed, and the entry is where the current one is written.
  let lastAnswer = 'no dependency url was ever served';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await (await fetchWithin(entryUrl)).text())?.[1];
    if (!specifier) break;
    const depUrl = new URL(specifier, clientUrl).href;
    const dep = await fetchWithin(depUrl);
    if (dep.ok) {
      console.log(`[e2e] client warm-up: pre-bundle committed in ${Date.now() - startedAt}ms`);
      return Date.now() - startedAt;
    }
    lastAnswer = `${depUrl} answered HTTP ${dep.status}`;
    await dep.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `this run's dependency pre-bundle never committed, so the criterion cannot measure on a stable document: `
    + lastAnswer,
  );
};

/** How long the app's own service worker is given to take control of the first document. */
const SERVICE_WORKER_SETTLE_MS = 10_000;

/**
 * Waits, bounded, for the service worker the app registers to finish claiming the document that registered it.
 *
 * `src/main.tsx` registers `/sw.js` on every load, and `public/sw.js` installs with `skipWaiting()` and claims
 * its clients from its own `activate` handler — so the claim lands on *whatever document is loading at that
 * moment*. The browser cancels that document's in-flight subresource requests and re-issues them under the new
 * controller; the app's worker answers a request that failed inside it with its cache, which holds only the
 * manifest, so those module requests end as network errors and the document is left with a module graph that has
 * holes in it. React never mounts, the page stays white, and the next thing to touch it is a locator await with
 * nothing under it. That is the white page behind the red runs whose failure predates the geometry — the second
 * navigation is a full document load, so it is the load the claim tends to land inside.
 *
 * The claim is a one-off per registration. Waiting for it here, on the first document and before the session the
 * criterion measures on, keeps it out of the measurement the same way the warm-up keeps the dependency build out.
 * Never throws: a page the app put no worker on is a page nothing can claim mid-load either, and the guard around
 * each navigation is what covers anything left.
 */
const settleServiceWorker = async (page: Page): Promise<string> => {
  const supported = await page.evaluate(() => 'serviceWorker' in navigator).catch(() => false);
  if (!supported) return 'no service worker api on this page';
  const startedAt = Date.now();
  const controlling = () =>
    page.evaluate(() => navigator.serviceWorker.controller !== null).catch(() => false);
  if (await controlling()) return 'already controlling the first document';
  const claimed = await page
    .waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: SERVICE_WORKER_SETTLE_MS,
      polling: 250,
    })
    .then(() => true, () => false);
  return claimed
    ? `claimed the first document after ${Date.now() - startedAt}ms`
    : `did not claim the first document within ${SERVICE_WORKER_SETTLE_MS}ms`;
};

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('transcript follow in a real browser', () => {
  let page: Page;
  let workspace = '';

  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });
  /** The project row is a toggle whose accessible name starts with the workspace's display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }).first();

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const dataDir = process.env.QUAY_E2E_DATA_DIR!;
    // Seeded (with its transcript) by playwright.config.ts before the server booted.
    workspace = path.join(dataDir, 'transcript-follow-workspace');

    // The run's own client, as playwright.config.ts declared it for this project: the url the page below
    // navigates to relatively, so the warm-up cannot address a server some other run started.
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up to address');
    // Before the page exists, so this run's optimize/re-optimize is over before the criterion's first
    // navigation — see the helper for why the cost cannot be left inside the measurement window.
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    // Before the first script runs, so AC-111 counts every input and every
    // offset write the spec's own setup performs, not just the ones after it
    // remembered to start watching.
    await page.addInitScript(instrumentScrollSources);
    await page.addInitScript(installWireDouble);
    // A tab that loses focus pauses the scroll animation the gestures rely on.
    await page.bringToFront();

    // What the page said, kept for one purpose: the guards have to be able to *explain* a client that never
    // rendered instead of reporting that a wait ran out.
    page.on('console', (message) => {
      if (message.type() === 'error') pageEvidence.consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      pageEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });

    // First run on a fresh database: create the single account, then finish onboarding.
    await page.goto('/');
    // The wait this fixture used to have no bound on. A page pulled out from under the navigation — the app's
    // own `location.reload()` after `504 Outdated Optimize Dep`, or any other restart of the document — leaves
    // this locator waiting on a document that no longer exists, and the run then dies in whichever ceiling is
    // above it (55s watchdog, 60s gate) with nothing to read. So: probe with a short budget, reload a bounded
    // number of times, and if the form is still absent, end here with what the page and the console said.
    const appears = async (timeoutMs: number) =>
      page.locator('#username').waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);
    let onboarded = await appears(5_000);
    for (let attempt = 0; !onboarded && attempt < 2; attempt += 1) {
      await page.reload().catch(() => undefined);
      onboarded = await appears(3_000);
    }
    if (!onboarded) {
      throw new Error(
        'the account form never rendered, so this run\'s client never came up to a document that stays: '
        + await readPageEvidence(page, pageEvidence),
      );
    }
    // The app's service worker, settled on this document — see the helper for why a claim must not be left to
    // land inside a later load. Logged so a run's log carries what the worker did, not just that it was waited on.
    console.log(`[e2e] client service worker: ${await settleServiceWorker(page)}`);
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();

    // Indexing a session auto-registers its project, so the seeded workspace is already a project here — the
    // sidebar is the proof, and no project is created over the API or through the UI.
    await expect(projectRow()).toBeVisible({ timeout: 30_000 });

    // Signed in means the app shell is up. The "Choose Your Project" empty state never renders here (the
    // project above exists), so anchoring on that is a race; Settings is not.
    await expect(page.getByRole('button', { name: 'Settings' }).first()).toBeVisible({ timeout: 30_000 });

    // The row is a toggle, so a click that lands while the sidebar is still re-rendering would leave it
    // collapsed — retry until the rows are really on screen.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) {
        break;
      }
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        break;
      } catch {
        // Collapsed again (or the click missed); the loop clicks once more.
      }
    }
    await expect(sessionLink()).toBeVisible({ timeout: 30_000 });

    // Into the transcript through the sidebar's own link — never by writing the store or the URL. Bounded:
    // this is the wait that a document replaced mid-click would otherwise never leave — see `clickSessionLink`.
    await clickSessionLink(page, sessionLink(), pageEvidence);
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
    // The initial scroll-to-bottom settles on its own; the gestures below have to start from rest.
    const initial = await waitForSettledPane(page);
    // Liveness: a transcript that does not scroll could not tell a follow from a no-op.
    expect(
      initial.scrollHeight - initial.clientHeight,
      'the seeded transcript must be taller than the pane for this spec to measure anything',
    ).toBeGreaterThan(AWAY_PX * 2);
    await pointAtPane(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('AC-106 a row that grows in place stays pinned at the bottom, and a scrolled-away transcript is left alone', async () => {
    // Arrive at the bottom by gesture rather than by assertion: leave it first, so the wheel below is what
    // really puts the viewport there.
    await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    const reachedBottom = await wheelUntil(page, WHEEL_STEP_PX, (geometry) => geometry.gap <= AT_BOTTOM_PX);
    expect(
      reachedBottom.gap,
      `a wheel gesture must be able to reach the bottom; stopped ${reachedBottom.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // (a) The row already on screen grows. No row is added and nothing is written to the store.
    const grownByAppending = await growLastAssistantRow(page, GROWTH_PX);
    expect(grownByAppending, 'the transcript needs a last assistant row to grow').not.toBeNull();
    expect(grownByAppending!).toBeGreaterThan(reachedBottom.scrollHeight);
    const afterAppend = await waitForSettledPane(page);
    expect(
      afterAppend.gap,
      `a pinned transcript must stay on the bottom when the last row grows; it sat ${afterAppend.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // (b) The same row grows by replacing its last block — the markdown-re-render shape of the same event.
    const grownByReplacing = await replaceLastAssistantSegment(page, GROWTH_PX);
    expect(grownByReplacing, 'the last assistant row needs a content block to replace').not.toBeNull();
    expect(grownByReplacing!).toBeGreaterThan(afterAppend.scrollHeight);
    const afterReplace = await waitForSettledPane(page);
    expect(
      afterReplace.gap,
      `a pinned transcript must stay on the bottom when the last row is replaced by a taller one; it sat ${afterReplace.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // Control half: the user leaves the bottom, and the very same growth must not move the viewport.
    const away = await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    expect(away.gap).toBeGreaterThan(AWAY_PX);
    const before = away;
    const scrollHeightAfterGrowth = await growLastAssistantRow(page, GROWTH_PX);
    expect(scrollHeightAfterGrowth, 'the control case needs a last assistant row to grow').not.toBeNull();
    const growth = scrollHeightAfterGrowth! - before.scrollHeight;
    expect(growth, 'the growth half of the control case must really have grown the content').toBeGreaterThan(0);
    const after = await waitForSettledPane(page);

    expect(
      Math.abs(after.scrollTop - before.scrollTop),
      `growth under a viewport the user moved must not scroll it (scrollTop ${before.scrollTop} → ${after.scrollTop})`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((after.gap - before.gap) - growth),
      `the gap must open by exactly the growth and nothing else (${before.gap} → ${after.gap}, growth ${growth})`,
    ).toBeLessThanOrEqual(1);
  });

  // AC-107: the pane the transcript scrolls in getting *shorter* is the other half of "the transcript
  // grew and the viewport followed". Nothing about the content changes here — the content column keeps the
  // box it had — so an implementation that watches only the content's geometry cannot see it at all. And
  // the shrink raises no `scroll` either: the scrollable range only gets longer, so scrollTop is never
  // clamped and the pane reports nothing. The only thing left to go on is the container's own box, and the
  // only thing that can say whether the viewport should follow is the user's intent — by the time any
  // observer runs, the gap the shrink opened is already there, so asking the geometry "are we at the
  // bottom?" answers no for exactly the case this exists for.
  test('AC-107 a pane that gets shorter is followed by a pinned transcript and left alone by one the user took over', async () => {
    // A phone-sized viewport, so the pane is a large fraction of the screen and the shrink below moves it by
    // hundreds of pixels rather than a few. The wheel gestures need the pointer over the pane at this size.
    await page.setViewportSize(AC107_VIEWPORT);
    await pointAtPane(page);

    // Arrive at the bottom by gesture rather than by assertion: leave it first, so the wheel below is what
    // really puts the viewport there.
    await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    const reachedBottom = await wheelUntil(page, WHEEL_STEP_PX, (geometry) => geometry.gap <= AT_BOTTOM_PX);
    expect(
      reachedBottom.gap,
      `a wheel gesture must be able to reach the bottom; stopped ${reachedBottom.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);
    await waitForSettledPane(page);

    // ── (a) the pinned half: the pane itself gets shorter ─────────────────────────────────────────────
    await clearInstruments(page);
    const beforeShrink = await readGeometry(page);
    // Armed before the change: the probe's observer is created after the app's, so it is notified after the
    // follow has decided, and it resolves on the far side of the frame the follow deferred its write to.
    await armLayoutProbe(page, PANE);
    await page.setViewportSize(AC107_SHRUNK_VIEWPORT);
    await awaitLayoutProbe(page);
    const afterShrink = await readGeometry(page);
    const paneLost = beforeShrink.clientHeight - afterShrink.clientHeight;

    expect(
      paneLost,
      `the shrink has to really shorten the pane, or this case measures nothing (clientHeight ${beforeShrink.clientHeight} → ${afterShrink.clientHeight})`,
    ).toBeGreaterThan(AWAY_PX);
    expect(
      afterShrink.scrollHeight,
      'the content itself must not have changed height — this half is about the container, not the column',
    ).toBe(beforeShrink.scrollHeight);

    // The readings first, so a failing run carries the numbers instead of only the verdict.
    console.log(`AC-107 pinned readings ${JSON.stringify({
      viewport: AC107_VIEWPORT,
      shrunkViewport: AC107_SHRUNK_VIEWPORT,
      paneClientHeightBefore: Math.round(beforeShrink.clientHeight),
      paneClientHeightAfter: Math.round(afterShrink.clientHeight),
      paneLostPx: Math.round(paneLost),
      scrollHeightBefore: Math.round(beforeShrink.scrollHeight),
      scrollHeightAfter: Math.round(afterShrink.scrollHeight),
      scrollTopBefore: Math.round(beforeShrink.scrollTop),
      scrollTopAfter: Math.round(afterShrink.scrollTop),
      gapBeforePx: Math.round(beforeShrink.gap),
      gapAfterPx: Math.round(afterShrink.gap),
    })}`);

    expect(
      afterShrink.gap,
      `a transcript that was on the bottom must be put back on it when the pane gets shorter; it sat ${afterShrink.gap}px above the bottom`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // ── (b) the control half: the user has taken the viewport over, and the same shrink leaves it alone ──
    // Back to the tall pane first: the same shrink is what the control half has to be measured against.
    await page.setViewportSize(AC107_VIEWPORT);
    await waitForSettledPane(page);
    await pointAtPane(page);
    const away = await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    expect(away.gap).toBeGreaterThan(AWAY_PX);
    await waitForSettledPane(page);

    await clearInstruments(page);
    const beforeControl = await readGeometry(page);
    await armLayoutProbe(page, PANE);
    await page.setViewportSize(AC107_SHRUNK_VIEWPORT);
    await awaitLayoutProbe(page);
    const afterControl = await readGeometry(page);
    const controlReadings = await readInstruments(page);
    const controlLost = beforeControl.clientHeight - afterControl.clientHeight;
    const paneScrolls = controlReadings.__scrollEvents
      .filter((event) => event.target.includes('chat-messages-pane'));

    console.log(`AC-107 control readings ${JSON.stringify({
      paneClientHeightBefore: Math.round(beforeControl.clientHeight),
      paneClientHeightAfter: Math.round(afterControl.clientHeight),
      paneLostPx: Math.round(controlLost),
      scrollTopBefore: Math.round(beforeControl.scrollTop),
      scrollTopAfter: Math.round(afterControl.scrollTop),
      gapBeforePx: Math.round(beforeControl.gap),
      gapAfterPx: Math.round(afterControl.gap),
      scrollWritesInWindow: controlReadings.__scrollWrites.map((write) => Math.round(write.value)),
      paneScrollEventsInWindow: paneScrolls.length,
    })}`);

    expect(
      controlLost,
      `the control half has to shrink the pane by the same amount as the pinned half (${controlLost}px)`,
    ).toBeGreaterThan(AWAY_PX);
    expect(
      controlReadings.__scrollWrites.length,
      `a shrink under a viewport the user moved must not be written to at all (${JSON.stringify(controlReadings.__scrollWrites)})`,
    ).toBe(0);
    expect(
      Math.abs(afterControl.scrollTop - beforeControl.scrollTop),
      `the shrink must not scroll a transcript the user took over (scrollTop ${beforeControl.scrollTop} → ${afterControl.scrollTop})`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((afterControl.gap - beforeControl.gap) - controlLost),
      `the gap must open by exactly what the pane lost and nothing else (${beforeControl.gap} → ${afterControl.gap}, lost ${controlLost})`,
    ).toBeLessThanOrEqual(1);
    expect(
      paneScrolls.length,
      `a shrink the browser never had to clamp must not be reported as a scroll (${JSON.stringify(paneScrolls)})`,
    ).toBe(0);
  });

  test('AC-111 a scroll the browser made on its own does not detach a pinned transcript', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // Arrive at the bottom by gesture, from away from it, so a wheel is what put
    // the viewport there rather than a position inherited from the case above.
    await wheelUntil(page, -WHEEL_STEP_PX, (geometry) => geometry.gap > AWAY_PX);
    const reachedBottom = await wheelUntil(page, WHEEL_STEP_PX, (geometry) => geometry.gap <= AT_BOTTOM_PX);
    expect(
      reachedBottom.gap,
      `a wheel gesture must be able to reach the bottom; stopped ${reachedBottom.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);
    // The gesture's own reports have to be over: a scroll still arriving from it
    // would be counted in the window below, and it belongs to the wheel.
    await waitForSettledPane(page);

    // From here to the end of the case the page receives no input of any kind.
    await clearInstruments(page);
    const button = () => page.locator(SCROLL_BUTTON).count();
    expect(
      await button(),
      'a transcript the user just wheeled to the bottom is following, and offers no way back',
    ).toBe(0);

    // (a) A box above the viewport collapses. The browser has to move the offset
    // itself — there is no input and no write from the app — for its anchor to
    // stay where the user is looking.
    const before = await readGeometry(page);
    const shrunk = await shrinkRowsAboveViewport(page, SHRINK_PX);
    expect(
      shrunk?.lost ?? 0,
      'the shrink half needs boxes above the viewport tall enough to lose the height the criterion names',
    ).toBeGreaterThanOrEqual(SHRINK_PX);
    const afterShrink = await waitForSettledPane(page);
    const panned = before.scrollTop - afterShrink.scrollTop;
    expect(
      panned,
      `the browser must have moved the offset by what the content lost (${before.scrollTop} → ${afterShrink.scrollTop})`,
    ).toBeGreaterThanOrEqual(SHRINK_PX - 1);

    const shrinkReadings = await readInstruments(page);
    const paneScrolls = shrinkReadings.__scrollEvents
      .filter((event) => event.target.includes('chat-messages-pane'));
    expect(
      paneScrolls.length,
      'the browser really did scroll the pane, or this scenario is empty and proves nothing',
    ).toBeGreaterThanOrEqual(1);
    expect(
      shrinkReadings.__scrollWrites.length,
      `that movement must not be the app writing the offset (${JSON.stringify(shrinkReadings.__scrollWrites)})`,
    ).toBe(0);
    expect(
      shrinkReadings.__scrollButtonAppearances.length,
      'the scroll button must not appear for a scroll nobody asked for',
    ).toBe(0);
    expect(await button(), 'and must not be on screen when the shrink half is sampled').toBe(0);

    // (b) The last row then grows in place. The viewport never left the bottom,
    // so there is no gap for the growth to open.
    await armLayoutProbe(page, `${PANE} .chat-message.assistant`);
    const grown = await growLastAssistantRow(page, GROWTH_PX);
    expect(grown, 'the transcript needs a last assistant row to grow').not.toBeNull();
    expect(grown!).toBeGreaterThan(afterShrink.scrollHeight);
    await awaitLayoutProbe(page);
    const afterGrowth = await readGeometry(page);
    expect(
      afterGrowth.gap,
      `the growth must be followed: the pan was the browser's, never the user's (gap ${afterGrowth.gap}px)`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    const finalReadings = await readInstruments(page);
    expect(
      finalReadings.__scrollButtonAppearances.length,
      'the scroll button must not appear anywhere in the window the criterion covers',
    ).toBe(0);
    expect(await button(), 'and must not be on screen at the end of it').toBe(0);
    expect(
      finalReadings.__scrollInputs,
      `the window must contain no input at all (${JSON.stringify(finalReadings.__scrollInputs)})`,
    ).toEqual([]);

    // The readings themselves, so the run's own output carries them instead of
    // leaving them inferable only from a green check.
    console.log(`AC-111 readings ${JSON.stringify({
      shrinkLostPx: shrunk?.lost ?? 0,
      pannedPx: Math.round(panned),
      paneScrollEventsInShrinkWindow: paneScrolls.length,
      programmaticWritesInShrinkWindow: shrinkReadings.__scrollWrites.length,
      buttonAppearancesInWindow: finalReadings.__scrollButtonAppearances.length,
      inputEventsInWindow: finalReadings.__scrollInputs.length,
      gapAfterGrowthPx: afterGrowth.gap,
      gapAfterShrinkPx: afterShrink.gap,
    })}`);
  });

  // AC-110: a prepend the user's wheel asked for must not be handed back to the follow by the restore
  // that prepend itself ends with.
  //
  // The state this case is built on is a first screen with nothing to scroll. The restore a prepend runs
  // is `scrollTop += nextAnchorOffset - anchorOffset`, and a pane that had no scrollable height cannot
  // keep the anchor's offset: the browser clamps the write to the bottom — exactly where a user who
  // scrolled there sits. So where the restore *lands* says nothing about who wants the viewport there, and
  // anything that reads the offset (or the `scroll` report the write raises) reads the app's own write as
  // the user's intent. The only thing that can still tell the two apart is what the next growth does: a
  // follow moves the viewport for it, a transcript the user took over does not.
  //
  // (The clamp is not the defect and is not what this case asserts against — the restore is necessarily at
  // the bottom here. What is asserted is that a gesture the pane could not report still leaves the
  // viewport the user's.)
  test('AC-110 a prepend the wheel asked for stays the user\'s across the restore that lands at the bottom', async () => {
    // ── the fixture: the seeded transcript's first page, at a viewport tall enough to leave nothing to scroll ──
    await page.setViewportSize(AC110_VIEWPORT);
    // The app's clock is moved past the transcript's last turn so a row it adds now sorts *after* the
    // seeded ones. It is still running — this fixes the wall clock, not the timers the app waits on.
    await page.clock.setFixedTime(new Date(seededTranscriptEndsAt() + 3_600_000));
    await page.goto('/');
    // The second navigation of this spec, and the one the startup guard never covered — see
    // `settleSecondDocument` for why an unguarded document here is the criterion's own red.
    await settleSecondDocument(page, pageEvidence);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) {
        break;
      }
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        break;
      } catch {
        // Collapsed again (or the click missed); the loop clicks once more.
      }
    }
    await clickSessionLink(page, sessionLink(), pageEvidence);
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
    await waitForSettledPane(page);
    await pointAtPane(page);

    const fixture = await readFixture(page);
    expect(
      fixture.scrollHeight,
      `the first screen has to leave nothing to scroll, or the gesture would be reported by the pane itself (${fixture.scrollHeight} > ${fixture.clientHeight})`,
    ).toBeLessThanOrEqual(fixture.clientHeight);
    expect(
      fixture.rows,
      'the seeded transcript must open on exactly one page of rows, so the wheel has an older page to ask for',
    ).toBe(AC110_FIRST_PAGE_ROWS);
    expect(fixture.hasMore, 'the first page must not be the whole transcript').toBe(true);
    const originalFirst = fixture.firstStamp;
    expect(originalFirst, 'the first row must carry a timestamp to be found again by').not.toBeNull();

    // ── the prepend, from a real gesture over the pane and from nothing else ──
    await clearInstruments(page);
    const prepended = await wheelUntilPrepended(page, originalFirst!, fixture.rows);
    expect(
      prepended.rows,
      `the older page has to arrive as rows (${fixture.rows} → ${prepended.rows})`,
    ).toBeGreaterThan(fixture.rows);
    expect(
      Date.parse(prepended.firstStamp!),
      'the rows that arrived must be older than the ones that were there',
    ).toBeLessThan(Date.parse(originalFirst!));
    const gestureReadings = await readInstruments(page);
    expect(
      gestureReadings.__scrollInputs.some((event) => event.type === 'wheel'),
      'the prepend must be the wheel\'s doing — the criterion forbids reaching the pagination any other way',
    ).toBe(true);

    // The restore is a single write, and the settle is what says it has landed;
    // the offset below is read after it, because it is the offset the window under
    // test starts from.
    const restored = await waitForSettledPane(page);
    const offset0 = await readRowOffset(page, originalFirst!);
    expect(
      offset0,
      'the original first row has to be on screen for the window below to measure its place',
    ).not.toBeNull();
    const before = await readGeometry(page);
    await clearInstruments(page);

    // ── the growth: one real re-render adds a row below the anchored one ──
    await armLayoutProbe(page, CONTENT_COLUMN);
    expect(
      await appendRowThroughComposer(page),
      'the composer has to be able to add a row, or the window below measures nothing',
    ).toBe(true);
    // The probe resolves on the layout the growth caused; the race only keeps a
    // growth the app refused to render from hanging the case.
    await Promise.race([awaitLayoutProbe(page), page.waitForTimeout(5_000)]);

    // ── the window: ~2s of samples, each after layout and the observers' callbacks ──
    const samples: AnchorSample[] = [await sampleAnchor(page, originalFirst!)];
    const deadline = Date.now() + AC110_SAMPLE_WINDOW_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(160);
      samples.push(await sampleAnchor(page, originalFirst!));
    }

    const offsets = samples.map((sample) => sample.offset);
    expect(
      offsets.every((offset) => offset !== null),
      'the anchored row has to stay in the transcript for the window to be measurable',
    ).toBe(true);
    const drift = Math.max(...offsets.map((offset) => Math.abs(offset! - offset0!)));
    const highest = Math.max(...samples.map((sample) => sample.scrollTop));
    const smallestGap = Math.min(...samples.map((sample) => sample.gap));

    // The mechanism, read back: the app's own writes are the only thing that could
    // have moved the offset, and none of them went down.
    const readings = await readInstruments(page);
    const downwardWrites = readings.__scrollWrites.filter((write) => write.value > before.scrollTop + 1);

    // The readings, printed before the assertions so a run that fails still
    // carries the numbers that say which writer moved the viewport, and so the
    // green run's output is evidence rather than a bare check mark.
    console.log(`AC-110 readings ${JSON.stringify({
      viewport: AC110_VIEWPORT,
      rowsBeforePrepend: fixture.rows,
      rowsAfterPrepend: prepended.rows,
      scrollHeightBefore: Math.round(fixture.scrollHeight),
      scrollHeightAfterPrepend: Math.round(prepended.scrollHeight),
      paneClientHeight: Math.round(fixture.clientHeight),
      restoreWrite: gestureReadings.__scrollWrites.map((write) => Math.round(write.value)),
      gapAfterRestorePx: Math.round(restored.gap),
      scrollTopAfterRestore: Math.round(restored.scrollTop),
      offset0Px: Math.round(offset0!),
      samples: samples.length,
      offsets,
      scrollTops: samples.map((sample) => Math.round(sample.scrollTop)),
      gaps: samples.map((sample) => Math.round(sample.gap)),
      driftPx: Math.round(drift * 100) / 100,
      scrollTopRisePx: Math.round((highest - before.scrollTop) * 100) / 100,
      smallestGapPx: Math.round(smallestGap),
      scrollWritesInWindow: readings.__scrollWrites.map((write) => Math.round(write.value)),
      downwardWritesInWindow: downwardWrites.length,
    })}`);

    expect(
      drift,
      `a prepend the user asked for must leave the row where it was: the offset moved ${drift}px over the window (${JSON.stringify(offsets)})`,
    ).toBeLessThanOrEqual(AC110_DRIFT_PX);
    expect(
      highest - before.scrollTop,
      `the viewport must not be pulled back down by the growth (scrollTop ${before.scrollTop} → ${highest})`,
    ).toBeLessThanOrEqual(1);
    expect(
      smallestGap,
      `the transcript must stay off the bottom, where the restore left it on its own (smallest gap ${smallestGap}px)`,
    ).toBeGreaterThan(2);

    expect(
      downwardWrites,
      `nothing may write the offset towards the bottom in the window (${JSON.stringify(downwardWrites)})`,
    ).toEqual([]);

    // The clock this case fixed belongs to the context, not to the case: `setFixedTime` installs
    // the emulation for every page that follows in this file, and it changes what the cases after
    // this one can read. Two ways, both of them AC-108's instrument rather than its subject:
    //
    //   * a fixed wall clock never moves, so a row the app re-stamps on every flush carries one
    //     timestamp for the whole turn — and AC-108 reads the row's identity out of exactly that
    //     attribute, so a fixed clock makes "the row was re-projected once per delta"
    //     unobservable rather than false;
    //   * the emulated `requestAnimationFrame` fires from the clock's own timer queue instead of
    //     from a rendering update, so a reader sampling the pane from its own frame callback can
    //     land between a commit and the resize observer that answers it — a window a real frame
    //     callback cannot enter, and one that reads as a follow that arrived a frame late.
    //
    // Handing it back running from the real time is this case's teardown: nothing after it asks
    // for a fixed clock, and the emulation's frame clock is what AC-108 samples through.
    await page.clock.setSystemTime(new Date());
  });

  test('AC-108 a reply that streams in keeps the pane pinned while one row grows in place', async () => {
    // A conversation the app creates and opens — and one nothing is ever asked of. The reply
    // this case measures is delivered below on the app's own socket, so no provider run, no CLI
    // and no model is involved at any point here: what is doubled is the frame source, never the
    // consumer.
    await page.setViewportSize(AC108_VIEWPORT);
    const sessionId = await openAppSession(page, workspace);

    // An empty conversation, asserted rather than assumed: every reading below treats "the last
    // row" and "the reply" as the same thing, which is only true while the reply is the only row
    // there is.
    expect(
      await page.locator(`${PANE} .chat-message`).count(),
      'the streaming case has to start from an empty conversation',
    ).toBe(0);
    // The case measures a follow, so the pane has to be at the bottom before the reply starts:
    // the follow holds a viewport that is already there and deliberately leaves one that is not.
    const start = await waitForSettledPane(page);
    expect(
      start.gap,
      `the streaming case must begin at the bottom; the pane settled ${start.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);
    // Non-vacuity of the window: the reply must not have started growing before the sampler was
    // watching, or every sample below is a reading of a reply that was already on screen.
    expect(
      await page.locator(`${PANE} .chat-message.assistant`).count(),
      'the sampler must be watching before the reply starts; the reply was already on screen',
    ).toBe(0);

    const before = await readFixture(page);

    await startFollowSampler(page);

    // The reply, delivered through the app's own socket: one piece every 250ms, then the end of
    // the content block. Nothing is sent and nothing is asked for anywhere in this case — the
    // frames arrive the way a real reply's frames do, as a `message` event at the socket the app
    // made for itself, and the app's own consumer is what turns them into the row below.
    const stream = startWireStream(page, sessionId, AC108_DELTAS, AC108_DELTA_INTERVAL_MS);

    await expect(page.locator(PANE)).toContainText(AC108_COMPLETION_MARKER, { timeout: 30_000 });
    await stream.done;
    // Liveness of the fixture, and the reading that makes the geometry below mean anything: a
    // reply that was never handed over looks exactly like one the app ignored.
    expect(
      stream.delivered(),
      `every delta has to reach the app (${stream.delivered()} of ${AC108_DELTA_COUNT} were delivered)`,
    ).toBe(AC108_DELTA_COUNT);
    // Long enough that the samples cover the content block ending as well as the reply
    // arriving: the pane has to be back at the bottom once there is nothing left to arrive.
    await page.waitForTimeout(900);
    const { samples, contentHeightTrace, rowMutations } = await stopFollowSampler(page);
    // Every assignment to `scrollTop` the page made while the reply was arriving, as the
    // instrument installed before the app's first script recorded them.
    const scrollWrites = await page.evaluate(() =>
      ((window as unknown as { __scrollWrites?: { value: number; t: number }[] }).__scrollWrites ?? [])
        .map((write) => ({ value: Math.round(write.value), t: Math.round(write.t) })));
    const streamFrames = await page.evaluate(() =>
      (window as unknown as { __streamFrames?: { kind: string; t: number }[] }).__streamFrames ?? []);

    const paneHeight = start.clientHeight;

    // A growth step is the last row getting taller — or appearing taller than nothing when
    // the first delta is what brought the row into being. Both are the same event to the
    // follow: a box it has to keep in view.
    const growth = samples.map((sample, index) => {
      if (index === 0) {
        return false;
      }
      const previous = samples[index - 1];
      if (sample.rows > previous.rows) {
        return sample.lastRowHeight > AC108_GAP_PX;
      }
      return sample.lastRowHeight > previous.lastRowHeight + AC108_GAP_PX;
    });
    const growthSteps = growth.filter(Boolean).length;
    const firstGrowth = growth.indexOf(true);
    const lastGrowth = growth.lastIndexOf(true);
    const growthOrigin = Math.max(firstGrowth, 0);

    // The span the criterion names — "流式全程" — is the reply's arrival, and the arrival is the
    // transport's: it ends with the last growth the last delta the gateway sent produced,
    // however long the turn then takes to settle. The clock is what says where that is: a
    // delta is painted a flush plus a frame after the frame that carried it, so its own growth
    // legitimately lands up to `AC108_STREAM_SETTLE_MS` late.
    const deltaTimes = streamFrames
      .filter((frame) => frame.kind === 'stream_delta')
      .map((frame) => frame.t);
    const lastDeltaAt = deltaTimes.length ? deltaTimes[deltaTimes.length - 1] : 0;
    // The first frame the reply's row lost its content on, read as the shape that failure has:
    // the pane stopped having anything to scroll, i.e. `scrollHeight` fell back to the pane's
    // own height on a frame the row had been taller than the pane. Text arriving only ever
    // *adds* height, so the only ways there are for that to happen are the row being re-created
    // under a new React key and measured at its `content-visibility` intrinsic height (which is
    // what this task fixed), or the row being dropped outright.
    //
    // A pane that merely loses height is not this: the turn settling drops the activity
    // indicator's padding, the pane's own content height follows it down, and the follow
    // re-pins in the same frame. That frame is a reading of the geometry working, not of the
    // reply collapsing, so it is deliberately not counted here.
    const firstCollapse = samples.findIndex((sample, index) => (
      index > growthOrigin
      && samples[index - 1].scrollHeight - sample.scrollHeight > AC108_GAP_PX
      && sample.scrollHeight <= sample.clientHeight + AC108_GAP_PX
    ));
    const lastStreamGrowth = samples.reduce((last, sample, index) => (
      growth[index] && sample.t <= lastDeltaAt + AC108_STREAM_SETTLE_MS ? index : last
    ), growthOrigin);
    const streamEnd = Math.max(growthOrigin, lastStreamGrowth + 1);
    const inStream = (index: number) => index >= firstGrowth && index <= streamEnd;
    const streamWindow = samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ index }) => inStream(index));
    const growthStepsInStream = growth.slice(growthOrigin, streamEnd + 1).filter(Boolean).length;

    // The turn's own end, told apart from the reply's: the client's terminal frames, and the
    // first sample taken after them. It is the frame the row stops being a stream and becomes a
    // settled message, which is the one that used to re-key it.
    const finalizeAt = streamFrames
      .filter((frame) => frame.kind === 'stream_end' || frame.kind === 'complete')
      .reduce((first: number, frame) => (first < 0 || frame.t < first ? frame.t : first), -1);
    const settleFrame = finalizeAt < 0 ? -1 : samples.findIndex((sample) => sample.t >= finalizeAt);

    // The rows the transcript held while the reply was arriving. One entry per message,
    // mounted or not, so this is the DOM's reading of `chatMessages.length`.
    const rowsDuringStream = samples.slice(growthOrigin, streamEnd + 1).map((sample) => sample.rows);
    const rowCountsSeen = Array.from(new Set(rowsDuringStream));

    // Every frame of the reply's span, with no exception carved out for the frame a growth
    // landed on: the criterion is "流式全程逐帧 gap ≤1px", and the two collapses that used to
    // make that unachievable — the row re-created under a new React key on every flush, and
    // again when the turn settled — are what this task fixed. Bounded on both sides, since a
    // pane placed *past* the bottom is as far from pinned as one left above it.
    const unpinned = samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ index }) => index >= firstGrowth)
      .filter(({ sample }) => Math.abs(sample.gap) > AC108_GAP_PX);
    // The same reading kept as its two halves, so a red run still says which shape the failure
    // had: frames with no growth on them that were left above the bottom (drift), and growth
    // frames the next frame did not repair (a lag rather than a jump).
    const offBottom = streamWindow
      .filter(({ sample, index }) => !growth[index] && Math.abs(sample.gap) > AC108_GAP_PX);
    const unrepaired = streamWindow
      .filter(({ sample, index }) => growth[index] && Math.abs(sample.gap) > AC108_GAP_PX)
      .filter(({ index }) => index + 1 >= samples.length || Math.abs(samples[index + 1].gap) > AC108_GAP_PX)
      .map(({ index }) => ({
        t: samples[index].t,
        gap: Math.round(samples[index].gap),
        nextGap: index + 1 < samples.length ? Math.round(samples[index + 1].gap) : null,
      }));
    // The mechanism, from the DOM's side: how many distinct nodes the last assistant row was
    // drawn into between the reply's first growth and the end of the sample, and in how many
    // frames the row's own identity changed under it. One node with the stamp moving is one row
    // re-projected in place, which is what a key that does not change buys; more than one node
    // is the unmount/mount that used to clamp the pane, and a stamp that never moves is a run
    // that never re-projected the row at all — and so cannot say the remount was survived.
    const nodeRuns = samples.slice(growthOrigin).reduce<number[]>((runs, sample) => {
      if (runs[runs.length - 1] !== sample.lastRowNode) runs.push(sample.lastRowNode);
      return runs;
    }, []);
    const stampChanges = samples
      .slice(growthOrigin)
      .reduce((changes, sample, index) => {
        const previous = index === 0 ? null : samples[growthOrigin + index - 1];
        return previous && previous.lastRowStamp !== sample.lastRowStamp ? changes + 1 : changes;
      }, 0);
    // How far the pane sits below the bottom at any frame — a follow that overshot would show
    // it, and an overshoot is the one excursion a deferral cannot explain. Its sign is the
    // whole assertion: the sampled gap is `scrollHeight - scrollTop - clientHeight`, so a
    // negative reading is an offset past the end, which no growth can produce.
    const minGap = Math.min(...streamWindow.map(({ sample }) => sample.gap));
    // How far it sits above it at a frame a growth landed on — the frames the criterion used to
    // have to exempt. Kept per-frame because they are what a regression would bring back, and
    // because their `top` is the reading that told the two failures apart: an offset left at the
    // previous bottom is a write that arrived a frame late, while an offset of 0 on a frame the
    // pane had 1671px of content is the browser's own clamp after the row was re-created.
    const growthFrameGaps = streamWindow
      .filter(({ index }) => growth[index])
      .map(({ sample, index }) => ({ t: sample.t, gap: Math.round(sample.gap), top: Math.round(sample.scrollTop) }));
    const maxGrowthFrameGap = growthFrameGaps.length ? Math.max(...growthFrameGaps.map((entry) => entry.gap)) : 0;
    const maxLastRowHeight = Math.max(...samples.map((sample) => sample.lastRowHeight));

    // What the pane does once the reply has fully arrived. It is inside the asserted span, so
    // this reading is what says how much of the settle the run actually covered.
    const postArrival = samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ sample, index }) => index > streamEnd && Math.abs(sample.gap) > AC108_GAP_PX);
    const recoveredAt = samples.findIndex((sample, index) => index > streamEnd && Math.abs(sample.gap) <= AC108_GAP_PX);

    // What the recorder saw arrive at the app, counted by kind: the transport's own account of
    // the reply, and the reading that says the frames were delivered exactly once — a frame
    // handed to two open chat sockets would be counted twice here.
    const frameCount = (kind: string) => streamFrames.filter((frame) => frame.kind === kind).length;

    // Printed before the assertions, so a red run still carries the readings that say which
    // one failed, and a green run's output is evidence rather than a check mark.
    console.log(`AC-108 readings ${JSON.stringify({
      viewport: AC108_VIEWPORT,
      paneClientHeight: Math.round(paneHeight),
      deltasDelivered: stream.delivered(),
      deltaIntervalMs: AC108_DELTA_INTERVAL_MS,
      sessionId,
      samples: samples.length,
      sampledSpanMs: samples.length ? samples[samples.length - 1].t - samples[0].t : 0,
      growthSteps,
      growthStepsInStream,
      maxLastRowHeightPx: Math.round(maxLastRowHeight),
      rowCountsDuringStream: rowCountsSeen,
      rowsBefore: before.rows,
      minGapPx: Math.round(minGap * 100) / 100,
      maxGrowthFrameGapPx: maxGrowthFrameGap,
      growthFrameGaps,
      // Where the reply's span was cut, and by which signature: the delta the gateway last sent,
      // the growth that came from it, and the first frame the pane lost height on.
      lastDeltaAt,
      lastStreamGrowth,
      firstCollapse,
      finalizeAt,
      settleFrame,
      streamSpanFrames: streamWindow.length,
      // ── the criterion itself: every frame from the reply's first growth on. ────────────────
      unpinnedFrames: unpinned.map(({ sample, index }) => ({
        index,
        t: sample.t,
        gap: Math.round(sample.gap),
        top: Math.round(sample.scrollTop),
        height: Math.round(sample.scrollHeight),
        grew: growth[index] === true,
      })),
      // One node and a stamp that moved: the row was re-projected in place rather than
      // replaced, over the frames where the old key would have replaced it once per flush.
      nodeRuns,
      stampChanges,
      offBottomFrames: offBottom.length,
      offBottomGaps: offBottom.map(({ sample }) => Math.round(sample.gap)),
      unrepairedFrames: unrepaired,
      // The turn ending, told apart from the reply arriving: how many frames the pane spent
      // off the bottom after the reply's span closed, how far, and which frame it was pinned
      // again on — or -1 if it was not, inside the sampled window. Recorded rather than
      // asserted: see the note at the assertions below.
      postArrivalFrames: postArrival.length,
      postArrivalMaxGap: postArrival.length ? Math.max(...postArrival.map(({ sample }) => Math.round(sample.gap))) : 0,
      postArrivalSpanMs: postArrival.length
        ? postArrival[postArrival.length - 1].sample.t - postArrival[0].sample.t
        : 0,
      postArrivalRecoveredAtFrame: recoveredAt,
      lastSampleGap: Math.round(samples[samples.length - 1].gap),
      // `index:+growth@gap` for every frame the last row grew on, and the frames around the
      // first few excursions, so a red run says which growth a gap belongs to rather than
      // only how large it was.
      growthTimeline: growth
        .map((grew, index) => ({ grew, index }))
        .filter(({ grew }) => grew)
        .map(({ index }) => {
          const before = index > 0 ? samples[index - 1].lastRowHeight : 0;
          return `${index}:+${Math.round(samples[index].lastRowHeight - before)}@gap${Math.round(samples[index].gap)}`;
        }),
      offBottomDetail: offBottom.slice(0, 3).map(({ index }) => {
        const from = Math.max(0, index - 3);
        return samples.slice(from, index + 3).map((sample, offset) => describeSample(sample, from + offset, from + offset === index));
      }),
      // The frames around the first and last growth, whole: the gap, the offset it was taken at,
      // and the box it was taken against, so a pane that is behind can be told from one that was
      // never placed.
      firstGrowthTrace: samples
        .slice(Math.max(0, firstGrowth - 2), firstGrowth + 14)
        .map((sample, offset) => describeSample(sample, Math.max(0, firstGrowth - 2) + offset)),
      postArrivalDetail: samples
        .slice(Math.max(0, streamEnd - 2), Math.min(samples.length, streamEnd + 10))
        .map((sample, offset) => describeSample(sample, Math.max(0, streamEnd - 2) + offset, Math.max(0, streamEnd - 2) + offset > streamEnd)),
      tailTrace: samples.slice(-8).map((sample, offset) => describeSample(sample, samples.length - 8 + offset)),
      // What the page wrote to `scrollTop`, restricted to the offsets the excursions were
      // sampled at — a pane that reads zero because something placed it there is a different
      // finding from one whose own follow never got there.
      writesAtExcursions: offBottom.flatMap(({ sample }) => scrollWrites
        .filter((write) => Math.abs(write.t - sample.t) < 60)
        .map((write) => `${sample.t}<-t${write.t}:${write.value}`)),
      zeroWrites: scrollWrites.filter((write) => write.value === 0).length,
      paneSwaps: Array.from(new Set(samples.map((sample) => `${sample.pane}/${sample.panes}`))),
      // ── the mechanism probe ────────────────────────────────────────────────────────────────
      // The last assistant row's DOM node, as numbered on first sight: a run of one number is a
      // row that kept its node, a new number is the unmount+mount a React key change produces.
      // Paired with the placeholder column, this separates the two ways the row can lose height —
      // a fresh node carrying the same content (re-keyed) from a wrapper standing in for it
      // (lazy placeholder) — which the geometry alone cannot tell apart.
      lastRowNodeRun: samples.reduce<{ node: number; from: number; to: number }[]>((runs, sample, index) => {
        const last = runs[runs.length - 1];
        if (last && last.node === sample.lastRowNode) {
          last.to = index;
        } else {
          runs.push({ node: sample.lastRowNode, from: index, to: index });
        }
        return runs;
      }, []).map((run) => `${run.node}:${run.from}-${run.to}`),
      // Every frame the row sat in the lazy placeholder rather than on its content.
      placeholderFrames: samples
        .map((sample, index) => ({ sample, index }))
        .filter(({ sample }) => sample.lastRowPlaceholder !== null)
        .map(({ sample, index }) => `${index}@t${sample.t}:h${sample.lastRowPlaceholder}`),
      // Every layout the content column went through, as the observer the follow itself is driven
      // by saw it. Printed as a delta from the previous entry so a dip that begins and ends inside
      // one frame is visible as an excursion rather than buried in an absolute list — and bounded
      // to the entries that actually moved, because the column re-lays out on every flush.
      contentHeightMoves: contentHeightTrace
        .map((entry, index) => ({ entry, index, previous: index > 0 ? contentHeightTrace[index - 1] : null }))
        .filter(({ entry, previous }) => !previous || previous.height !== entry.height)
        .map(({ entry, previous }) => `${entry.t}:${previous ? previous.height : 0}->${entry.height}`),
      // Every row added to or removed from the transcript, which is the DOM's own account of a
      // mount: nothing else in this file can see the node being created or destroyed.
      rowMutationCount: rowMutations.length,
      rowMutationTrace: rowMutations.map((entry) => `${entry.t}:${entry.kind}:${entry.stamp ?? '-'}`),
      // What the client was handed, and when, over the sampled window: the transport's own
      // account of the reply, next to the geometry it produced.
      frameKinds: streamFrames.reduce<Record<string, number>>((counts, frame) => {
        counts[frame.kind] = (counts[frame.kind] ?? 0) + 1;
        return counts;
      }, {}),
      streamEndTimes: streamFrames.filter((frame) => frame.kind === 'stream_end').map((frame) => frame.t),
      finalizeFrames: streamFrames
        .filter((frame) => ['stream_end', 'complete', 'session_created', 'assistant'].includes(frame.kind))
        .map((frame) => `${frame.t}:${frame.kind}`),
    })}`);

    // Every delta reached the app exactly once, and the content block ended exactly once. The
    // app's own recorder is what says so: a reply the pump thought it had delivered but the
    // socket never carried would be missing here, and a frame handed to two open chat sockets
    // would be counted twice.
    expect(
      frameCount('stream_delta'),
      `every delta has to arrive at the app once (${frameCount('stream_delta')} of ${AC108_DELTA_COUNT} were received)`,
    ).toBe(AC108_DELTA_COUNT);
    expect(
      frameCount('stream_end'),
      'the content block has to end exactly once',
    ).toBe(1);

    // Non-vacuity: the reply arrived in one row that grew in place, in as many steps as the
    // reply had pieces. Without this a single settled render would pass every gap
    // assertion below by never changing anything. Counted over the reply's own span, so the
    // growth the turn's finalize contributes cannot stand in for a delta that never arrived.
    expect(
      growthStepsInStream,
      `the last row must grow once per delta (${AC108_DELTA_COUNT} deltas, ${growthStepsInStream} growth steps inside the reply's span of ${streamWindow.length} frames; ${growthSteps} in the whole sample)`,
    ).toBeGreaterThanOrEqual(AC108_DELTA_COUNT - 1);
    expect(
      stream.finished(),
      'the whole reply has to have been delivered, or the span below ends at nothing in particular',
    ).toBe(true);
    expect(
      lastGrowth,
      'the sampler must have watched the reply grow; it saw no growth at all',
    ).toBeGreaterThan(firstGrowth);
    expect(
      maxLastRowHeight,
      `the last row must outgrow one screen (${Math.round(maxLastRowHeight)}px against a ${Math.round(paneHeight)}px pane)`,
    ).toBeGreaterThan(paneHeight);
    expect(
      rowCountsSeen,
      `the reply must be one row rewritten in place, not rows appended; the row count moved through ${JSON.stringify(rowCountsSeen)} while it streamed`,
    ).toHaveLength(1);

    // The follow itself, in the form the criterion is written in now that the two collapses
    // are fixed: from the frame the reply's row first grew on until the sample ends, every
    // frame is at the bottom, with no exemption for the frame a growth landed on. The turn
    // settling is inside that span too — it no longer re-keys the row, so it no longer opens a
    // gap the span would have to exclude.
    expect(
      unpinned.map(({ index, t, gap, top, grew }) => ({ index, t, gap, top, grew })),
      `the pane must be at the bottom at every frame of the reply (${samples.length} frames sampled, ${unpinned.length} off it)`,
    ).toEqual([]);
    // The same reading as its two halves. Kept because they fail differently and a red run
    // should say which: `offBottom` is drift on frames nothing grew on, `unrepaired` is a
    // growth frame the next frame did not pin again.
    expect(
      offBottom.map(({ sample, index }) => ({ t: sample.t, index, gap: Math.round(sample.gap) })),
      'the pane must be at the bottom at every frame of the stream the last row did not just grow on',
    ).toEqual([]);
    expect(
      unrepaired,
      'a frame that received a growth must be pinned again by the next frame',
    ).toEqual([]);

    // ...and the mechanism behind that, asserted rather than left to the geometry, because the
    // geometry alone cannot tell a row that was re-projected from one that never was: a run in
    // which the reply arrived in a single settled render would show every frame pinned while
    // proving nothing about the remount.
    //
    // Two readings, and the pair is the point. The reply's row has to have been re-projected
    // over and over — its `data-message-timestamp` moves on every flush, and the transcript's
    // key used to be derived from exactly that plus the row's text, which is what re-keyed it
    // per delta — *while* the node it is drawn into stays the same one. A new node is the
    // unmount/mount whose fresh `content-visibility` box is laid out at its intrinsic height,
    // measured, for the frame the pane then has to survive.
    expect(
      stampChanges,
      `the reply's row must be re-projected once per delta (${stampChanges} identity changes over ${samples.length - growthOrigin} frames; ${AC108_DELTA_COUNT} deltas were sent)`,
    ).toBeGreaterThanOrEqual(AC108_DELTA_COUNT - 1);
    expect(
      nodeRuns,
      `the reply's row must keep the node it is drawn into while it is re-projected (node identities seen: ${JSON.stringify(nodeRuns)})`,
    ).toHaveLength(1);

    // The turn's own end has to be inside the sample, or "pinned from the settle on" is a
    // statement about a window in which nothing settled — the liveness half of the assertion
    // that the row stopped being a stream without being replaced.
    expect(
      finalizeAt,
      'the turn must settle inside the sampled window; the client reported no terminal frame',
    ).toBeGreaterThan(0);
    expect(
      settleFrame,
      `the sample must cover the frame the turn settled on (settled at t${finalizeAt}, last sample at t${samples[samples.length - 1].t})`,
    ).toBeGreaterThan(streamEnd);

    // And the one thing a deferral cannot explain: an offset *past* the end. The gap is
    // `scrollHeight - scrollTop - clientHeight`, so a negative reading means the pane was
    // placed beyond the bottom — a write that overshot, which no amount of arriving content
    // accounts for. Bounded on both sides rather than one, so "never off the bottom" is not
    // satisfied by a pane that is off it in the other direction.
    expect(
      minGap,
      `the pane may never be placed past the bottom (${Math.round(minGap)}px at the worst frame)`,
    ).toBeGreaterThanOrEqual(-AC108_GAP_PX);

    // What the two collapses were, and why the offsets they produced are no longer exempt
    // from the bound asserted above.
    //
    // Both had the same cause, and it is the row's React key rather than either observer. A
    // key change is an unmount followed by a mount, and the freshly inserted `.chat-message`
    // carries `content-visibility: auto` with `contain-intrinsic-size: auto 240px`, so for the
    // frame it is laid out in it is a 240px box standing where a 1671px row was: the pane's
    // content collapses under a viewport that is still on the bottom, the browser clamps the
    // offset to the top, and the row is back at its real height before anything can report it.
    // The follow then reads the clamped offset as a viewport the user moved and declines to
    // pin it, which is why the excursions were offsets of 0 rather than `bottom - step`.
    //
    // The key came from the row's own identity, which changed twice over:
    //
    //   * on every flush — `updateStreaming` re-mints the live row's timestamp and its text, and
    //     `getIntrinsicMessageKey` falls back to exactly that pair, so each delta re-keyed the
    //     row it was streaming into;
    //   * when the turn settled — `finalizeStreaming` re-keyed the row to a fresh id so the next
    //     turn could not overwrite the reply it had just settled.
    //
    // Both are fixed at the source rather than worked around: the live row is minted one id per
    // turn and keeps it across the settle (`liveRowIdentity.ts`, `useSessionStore`), the
    // transcript carries it onto the rendered message (`useChatMessages`), and the follow is
    // asked again in the commit task that landed the growth — a layout effect in
    // `useChatSessionState` writes the new offset in the same task as the DOM change it followed,
    // so the growth frame is painted already pinned — while the resize observer keeps its own
    // path deferred by one frame, so a gesture landing inside that frame still wins over the
    // pin. The readings above are the evidence that the cause is gone —
    // `nodeRuns` of length 1 with `stampChanges` at one per delta, and `firstCollapse` at -1,
    // where before the fix it fired on the settling frame with the pane sitting at exactly its
    // own height and the last row measured at 240px.
    //
    // There is a third identity change the first two hid, and it only became visible once the
    // row's key stopped being derived from its content: the transcript holds the reply twice —
    // the row this client streamed it into and the server's persisted echo of it, which the
    // reconciliation collapses into one. Which of the pair survives that collapse decides the
    // row's key, and it used to be whichever sorted first, so the row changed hands as the echo
    // arrived and again on the refresh `complete` triggers. `useSessionStore` now keeps the
    // client's row and folds the echo's fields into it
    // (`dedupeAdjacentAssistantEchoes`, `pruneRealtimeSupersededByServer`).
    //
    // `growthFrameGaps` and `postArrival*` are kept as readings: they are the shape the run had
    // when this criterion could not be written this way, and they are what a regression would
    // bring back. They are no longer exempt from anything.

    // The conversation the pane is showing is the one the frames were addressed to, or the
    // readings above are of some other session's row.
    expect(new URL(page.url()).pathname).toBe(`/session/${sessionId}`);
  });

  test('AC-109 a small gesture still detaches, and the control comes back for the rest of the reply', async () => {
    await page.setViewportSize(AC108_VIEWPORT);

    // A conversation the app creates and opens — and one nothing is ever asked of, for the same
    // reason as AC-108's: each window's reply is delivered on the app's own socket, so no
    // provider run, no CLI and no model is involved at any point in this case.
    const sessionId = await openAppSession(page, workspace);

    const readings: Ac109WindowReading[] = [];

    // The wheel half: thirty pixels up, from a pane the follow is holding at the bottom.
    readings.push(await runAc109Window(page, {
      label: 'wheel',
      sessionId,
      deltas: AC109_WHEEL_DELTAS,
      completionMarker: AC109_WHEEL_COMPLETION_MARKER,
      gesture: async () => {
        await pointAtPane(page);
        await page.mouse.wheel(0, -AC109_WHEEL_PX);
      },
    }));

    // The keyboard half: the same pane, the same stream, and the one input a wheel-based rule
    // cannot see. The pane takes focus and the key is pressed through the browser's own input
    // path — no synthetic wheel or touch event is dispatched anywhere in this case, and the
    // page's instruments are what say so: the window contains a `keydown` and no `wheel`.
    readings.push(await runAc109Window(page, {
      label: 'keyboard',
      sessionId,
      deltas: AC109_KEY_DELTAS,
      completionMarker: AC109_KEY_COMPLETION_MARKER,
      gesture: async () => {
        await page.locator(PANE).focus();
        await page.keyboard.press('PageUp');
      },
    }));

    // Both windows ran, in the order they are written, so neither reading below stands in for
    // the other one.
    expect(readings.map((reading) => reading.label)).toEqual(['wheel', 'keyboard']);
    // The readings, kept in the run's output: a red run should still show what each window saw.
    console.log(`AC-109 readings: ${JSON.stringify(readings)}`);
  });

  test('a whole row arriving while pinned keeps the pane at the bottom', async () => {
    await page.setViewportSize(WHOLE_ROW_VIEWPORT);

    // A conversation the app creates and opens, exactly as AC-108 and AC-109 do. Every row this
    // case appends is delivered on the app's own socket, so no provider run, no CLI and no model
    // is involved at any point here: what is doubled is the frame source, never the consumer.
    const sessionId = await openAppSession(page, workspace);

    // An empty conversation, asserted rather than assumed: every reading below treats "the last
    // row" and "the row that just arrived" as the same thing, which is only true while there is
    // nothing else in the transcript.
    expect(
      await page.locator(`${PANE} .chat-message`).count(),
      'the whole-row case has to start from an empty conversation',
    ).toBe(0);

    // The case measures a follow, so the pane has to be pinned before the first row arrives: the
    // follow holds a viewport that is already there and deliberately leaves one that is not.
    const start = await waitForSettledPane(page);
    expect(
      start.gap,
      `the whole-row case must begin at the bottom; the pane settled ${start.gap}px above it`,
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    await startFollowSampler(page);
    await waitForFirstSample(page);

    /** What one appended row did to the pane, read once it had stopped moving. */
    type Arrival = {
      index: number;
      /** Rows the transcript held once this one had arrived. */
      rows: number;
      /** The delivery count for its frame: 0 would be a row the app was never handed. */
      delivered: number;
      /** The last row's own opening words, which is how "the row that arrived is this one" is read. */
      tail: string;
      /** The gap the pane settled at after this row, in CSS pixels. */
      settledGap: number;
      /** Whether the scroll-to-bottom control was on screen once it had settled. */
      button: boolean;
    };
    const arrivals: Arrival[] = [];
    const settledGaps: number[] = [];

    for (let index = 0; index < WHOLE_ROW_COUNT; index += 1) {
      const delivered = await injectWholeRow(page, sessionId, index);
      // Liveness of the fixture, and what makes the geometry below mean anything: a row that was
      // never handed over looks exactly like a row the app ignored.
      expect(delivered, `row ${index} never reached the app (${delivered} deliveries)`).toBeGreaterThan(0);

      // Long enough that this row's arrival and the one after it are separate events rather than
      // one long growth, which is what the per-row first-frame height is read against.
      await page.waitForTimeout(WHOLE_ROW_SETTLE_MS);

      const tail = await readTailRow(page);
      const geometry = await readGeometry(page);
      const button = await page.locator(SCROLL_BUTTON).count() > 0;
      arrivals.push({ index, rows: tail.rows, delivered, tail: tail.text, settledGap: geometry.gap, button });
      settledGaps.push(geometry.gap);
    }

    // A last moment of quiet, so the samples cover the pane after the final row as well as while
    // the rows were arriving.
    await page.waitForTimeout(400);
    const { samples, contentHeightTrace, rowMutations } = await stopFollowSampler(page);

    /* ---------------------------------------------------------------- */
    /*  Content, before geometry                                          */
    /* ---------------------------------------------------------------- */

    // The rows are counted and named by their own text, not by the geometry: a pane that produced
    // a box without producing a row has satisfied every geometric reading below and still shown
    // the reader nothing.
    expect(
      arrivals.map((arrival) => arrival.rows),
      'the transcript has to grow by exactly one row per injection',
    ).toEqual(arrivals.map((_, index) => index + 1));
    for (const arrival of arrivals) {
      expect(
        arrival.tail,
        `the last row of ${arrival.rows} has to be the row that just arrived (row ${arrival.index})`,
      ).toContain(wholeRowMarker(arrival.index));
    }
    expect(
      arrivals[arrivals.length - 1].tail,
      'the last row has to be the last one injected, or the readings below are of some earlier row',
    ).toContain(wholeRowMarker(WHOLE_ROW_COUNT - 1));

    /* ---------------------------------------------------------------- */
    /*  Per-arrival readings                                              */
    /* ---------------------------------------------------------------- */

    /**
     * The frames each row's arrival occupies, and the height its box went through while they ran.
     *
     * The first frame is the placeholder the pane lays a row it has not drawn yet out at: the box
     * is the row's intrinsic size until the row's own content is rendered, and that box is what
     * the pane's geometry was computed against before the row's real height existed. The settled
     * value is the last one the row had while it was the tail, which is its real height.
     */
    const layout = samples.map((sample, index) => ({ sample, index }));
    const perRow = arrivals.map((arrival) => {
      const window = layout.filter(({ sample }) => sample.rows === arrival.rows);
      const first = window.find(({ sample }) => sample.lastRowHeight > 0) ?? null;
      const last = window[window.length - 1] ?? null;
      return {
        index: arrival.index,
        firstHeight: first ? first.sample.lastRowHeight : null,
        firstGap: first ? first.sample.gap : null,
        firstPlaceholder: first ? first.sample.lastRowPlaceholder : null,
        settledHeight: last ? last.sample.lastRowHeight : null,
        frames: window.length,
      };
    });

    // Every frame the sampler saw, as one line each: the criterion is about what the pane did
    // frame by frame, so the run's output has to carry the frames rather than a summary of them.
    console.log(`whole-row frames (${samples.length}):`);
    for (let index = 0; index < samples.length; index += 1) {
      console.log(`  ${describeSample(samples[index], index)}`);
    }
    console.log(`whole-row arrivals: ${JSON.stringify(arrivals.map((arrival) => ({
      row: arrival.index,
      rows: arrival.rows,
      delivered: arrival.delivered,
      gap: Math.round(arrival.settledGap),
      button: arrival.button,
      firstHeight: perRow[arrival.index].firstHeight,
      firstGap: perRow[arrival.index].firstGap === null ? null : Math.round(perRow[arrival.index].firstGap),
      firstPlaceholder: perRow[arrival.index].firstPlaceholder,
      settledHeight: perRow[arrival.index].settledHeight,
      frames: perRow[arrival.index].frames,
    })))}`);
    console.log(`whole-row settled gaps: ${settledGaps.map((gap) => Math.round(gap)).join(' → ')}`);
    console.log(`whole-row content heights: ${contentHeightTrace.map((entry) => entry.height).join(' → ')}`);
    console.log(`whole-row row mutations: ${rowMutations.length} `
      + `${rowMutations.map((entry) => `${entry.kind}@${entry.t}:${entry.stamp === null ? '-' : entry.stamp.slice(11, 23)}`).join(' ')}`);
    console.log(`whole-row pane height: ${start.clientHeight}`);
    console.log(`whole-row drift: worst settled gap ${Math.max(...settledGaps.map((gap) => Math.abs(gap)))}px; `
      + `arrival-frame shortfall off the intrinsic box `
      + `${perRow.slice(1).map((row) => `${Math.round((row.firstGap ?? 0) - ((row.firstHeight ?? 0) - WHOLE_ROW_INTRINSIC_PX))}`).join(',')}px`);

    /* ---------------------------------------------------------------- */
    /*  The placeholder box took part                                     */
    /* ---------------------------------------------------------------- */

    // The red this case exists for is a layout mechanism, not a slow frame: while a row the pane has
    // never drawn is being laid out, its box is the intrinsic size the stylesheet gives it, and the
    // pane's geometry — including the scroll position the follow writes — is computed against that
    // box. A run in which the box never entered the geometry cannot say anything about a follow that
    // misread it, so its participation is asserted here rather than assumed.
    //
    // What the participation looks like from the sampler's chair is a *shortfall*, not a row height:
    // the commit-time pin answers the placeholder's growth inside the same frame, which drags the
    // row into view and lets the browser render it for real before the frame is sampled. So by the
    // time a frame can be read, the row is already at its own height — and the placeholder is
    // visible only as the distance the pane was left behind by: the row's real height minus the
    // intrinsic box it was standing in for. (Drop `contain-intrinsic-size` and the same frame reads
    // the row's whole height as the shortfall instead; 1135 - 240 = 895 is the box's fingerprint.)
    //
    // The first row of the run is exempt and read separately: an empty conversation has no bottom
    // to have been pinned to, so its arrival frame measures the content against the pane rather
    // than one bottom against the next.
    for (const row of perRow.slice(1)) {
      expect(
        row.firstGap === null || row.firstHeight === null
          ? Number.NaN
          : Math.abs(row.firstGap - (row.firstHeight - WHOLE_ROW_INTRINSIC_PX)),
        `row ${row.index} has to leave the pane behind by exactly its own height minus the intrinsic `
        + `box the pane laid it out at (${WHOLE_ROW_INTRINSIC_PX}px), or the box was not in the `
        + `geometry the pane's scroll was placed against (${JSON.stringify(row)})`,
      ).toBeLessThanOrEqual(2);
    }
    for (const row of perRow) {
      expect(
        row.firstHeight ?? 0,
        `row ${row.index} has to arrive taller than the pane it arrives in, or it lands at the fold, `
        + `the intrinsic box is never what stands in for it, and the family cannot separate `
        + `(${JSON.stringify(row)} vs pane ${start.clientHeight})`,
      ).toBeGreaterThan(start.clientHeight);
      expect(
        Math.abs((row.settledHeight ?? 0) - (row.firstHeight ?? 0)),
        `row ${row.index} may not change height between its first sampled frame and the last — that `
        + `spread is what a re-laid-out row looks like, and it would make the shortfall above a `
        + `moving target (${JSON.stringify(row)})`,
      ).toBeLessThanOrEqual(2);
    }

    /* ---------------------------------------------------------------- */
    /*  The pane stayed pinned                                            */
    /* ---------------------------------------------------------------- */

    // The criterion's bound, read once per row after it had stopped moving. This is the reading a
    // reader would make: the row arrived, the pane is showing its last line.
    const aboveBottom = arrivals
      .filter((arrival) => Math.abs(arrival.settledGap) > AT_BOTTOM_PX)
      .map((arrival) => ({ row: arrival.index, gap: Math.round(arrival.settledGap), button: arrival.button }));
    expect(
      aboveBottom,
      `the pane has to be at the bottom after each whole row arrives (gaps: `
      + `${settledGaps.map((gap) => Math.round(gap)).join(' → ')})`,
    ).toEqual([]);

    // And the same bound frame by frame, with the one exception a follow cannot avoid: the frame a
    // growth lands on may be painted before the write that answers it. That frame is allowed, and
    // only that frame — the next one has to be pinned, which is what separates a growth being
    // followed from a gap being kept.
    const grew = (index: number) => index > 0
      && samples[index].scrollHeight > samples[index - 1].scrollHeight + AT_BOTTOM_PX;
    const unpinnedFrames = samples
      .map((sample, index) => ({ sample, index }))
      .filter(({ sample }) => Math.abs(sample.gap) > AT_BOTTOM_PX)
      .filter(({ index }) => (
        !grew(index)
        || index + 1 >= samples.length
        || Math.abs(samples[index + 1].gap) > AT_BOTTOM_PX
      ))
      .map(({ sample, index }) => `${describeSample(sample, index, grew(index))}`
        + `,next${index + 1 < samples.length ? Math.round(samples[index + 1].gap) : 'n/a'}`);
    expect(
      unpinnedFrames,
      `the pane has to stay pinned while whole rows arrive, allowing one frame per growth`,
    ).toEqual([]);

    // Non-vacuity: the run has to have contained growths to follow and frames to read, or every
    // bound above is a statement about an empty window.
    expect(samples.length, 'the run has to have been sampled').toBeGreaterThan(WHOLE_ROW_COUNT);
    expect(
      samples.filter((_, index) => grew(index)).length,
      'rows have to have kept arriving while the sampler watched',
    ).toBeGreaterThanOrEqual(WHOLE_ROW_COUNT);

    // The conversation the pane is showing is the one the rows were addressed to, or the readings
    // above are of some other session's transcript.
    expect(new URL(page.url()).pathname).toBe(`/session/${sessionId}`);
  });
});
