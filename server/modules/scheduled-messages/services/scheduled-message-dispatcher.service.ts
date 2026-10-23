import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { createChatControlService } from '@/modules/websocket/index.js';

/**
 * The slice of the process-wide chat control service the dispatcher drives.
 *
 * A scheduled turn and an interactive `chat.send` must be the *same* run — same
 * registry, same busy semantics, same abort path — so the timer does not get a
 * dispatch path of its own; it takes the shared control service the composition
 * root builds (`server/index.ts`) and calls its `send`, exactly as the WebSocket
 * gateway does. Only `send` is named here: a timer sends, it does not abort or
 * withdraw, and narrowing the seam keeps the wiring criterion's spy honest.
 */
type ScheduledMessageControl = Pick<ReturnType<typeof createChatControlService>, 'send'>;

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments };
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  control: ScheduledMessageControl,
): Promise<void> {
  const message = readQueuedMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await control.send(
    { userId: candidate.userId, via: 'scheduled' },
    {
      sessionId: candidate.sessionId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again.
  if (!result.ok) {
    if (result.code === 'RUN_IN_PROGRESS') {
      sessionDraftsDb.restoreQueuedMessage(candidate);
      return;
    }
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  // Wait for the turn to settle — the same barrier the old detached-turn helper
  // gave — so a queued message is not retired from the drafts table while its
  // run is still being admitted. The failure itself is not recorded here: a
  // queue entry that the provider drops is re-tried by a later draft save, not
  // surfaced as a failed schedule.
  await result.completion;
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/** Sends every persisted queued turn whose session is currently idle. */
export async function dispatchQueuedMessages(control: ScheduledMessageControl): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    if (chatRunRegistry.isProcessing(candidate.sessionId)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, control);
  }));

  return claimed;
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  control: ScheduledMessageControl,
): Promise<void> {
  try {
    const result = await control.send(
      { userId: row.user_id, via: 'scheduled' },
      {
        sessionId: row.session_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
    );

    if (!result.ok) {
      // Refused before any run was registered: a deleted session, an
      // unavailable provider, a run the provider would not supersede. The
      // refusal's own message is what the user is told.
      scheduledMessagesDb.markFailed(row.id, result.message);
      return;
    }

    // Registered; wait for the provider turn to settle so a failure *after*
    // registration is recorded on the row rather than vanishing. Silently
    // dropping a message the user scheduled is worse than telling them it did
    // not go.
    const outcome = await result.completion;
    if (!outcome.started || outcome.error) {
      scheduledMessagesDb.markFailed(row.id, outcome.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  control: ScheduledMessageControl,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, control);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(control: ScheduledMessageControl): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(control)
      .then(() => dispatchQueuedMessages(control))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
