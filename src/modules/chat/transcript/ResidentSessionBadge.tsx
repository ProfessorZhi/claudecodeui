import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown } from 'lucide-react';

import ResidentPanel from '@/modules/chat/transcript/ResidentStatusBar';
import {
  findSessionHost,
  findSessionHostState,
  readResidentProcessState,
  useSessionHosts,
} from '@/shared/hooks/useSessionHosts';
import type { ResidentProcessState } from '@/shared/types';
import { findBackgroundTaskLeases } from '@/shared/utils';

/** The panel's width in CSS pixels: `w-72`, which `ResidentPanel` sets on its own root. */
const PANEL_WIDTH_PX = 288;
/** Gap kept between the panel and the viewport's edge, and between the panel and its pill. */
const PANEL_MARGIN_PX = 8;
const PANEL_GAP_PX = 4;

/**
 * What the pill's dot says about the process, which is less than the sidebar's mark says.
 *
 * The sidebar draws five states, including `busy` with a spinner. The pill draws four, and `idle`
 * and `busy` are one of them: both mean "there is a process holding this conversation". Whether it
 * is working *right now* is the activity dock's question, answered from the server's own frames, and
 * this pill is the reason the dock lost its second answer — the busy/idle word that used to sit in
 * the resident status bar, read off a different poll, was the page saying "idle" in one place and
 * "busy" in another. The pill keeps to the part only the process can tell: is there one.
 */
type BadgeState = 'running' | 'stopped' | 'exited' | 'unknown';

const BADGE_STATE_BY_PROCESS_STATE: Record<ResidentProcessState, BadgeState> = {
  unstarted: 'stopped',
  idle: 'running',
  busy: 'running',
  exited: 'exited',
  unknown: 'unknown',
};

/**
 * The dot beside the word: a solid green circle for a live process, an outline for one that is not
 * running, a warning triangle for one that exited, a dashed amber outline for "no reading".
 *
 * The shapes are the sidebar mark's (same colours, same meanings), so a session reads the same in
 * the list and in its own header. The unknown one is deliberately neither of the others: a dot that
 * looked like `running` for a state nothing has confirmed would be a claim about a process.
 */
function BadgeDot({ state }: { state: BadgeState }) {
  if (state === 'exited') {
    return <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-red-500" aria-hidden="true" />;
  }

  if (state === 'unknown') {
    return (
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full border border-dashed border-amber-500" />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={
        state === 'running'
          ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500'
          : 'h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground'
      }
    />
  );
}

/**
 * The "this is a resident session" pill, and the door to the resident process's own facts.
 *
 * Used by project-workspace's WorkspaceTitle, on the line under the session title and to the right
 * of the project name, because that is where a user looks for "what is this session" and the one
 * place that is the same on every viewport. It renders nothing for a session that is not stored
 * `resident`.
 *
 * It replaces the arrow on the activity dock. The dock was the only thing that could open the facts,
 * so it had to stay on screen between turns, in the message flow on a phone — and a panel that opens
 * inside the flow grows the transcript instead of floating over it: measured at 390x844, opening it
 * pushed its own lower ~140px past the bottom of the scroll area, with only an edge showing. The pill
 * lives in the header, outside the transcript, and the panel is a portal anchored under it, so
 * opening it moves nothing and nothing can clip it.
 */
export default function ResidentSessionBadge({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation('chat');
  const { snapshot, error } = useSessionHosts();
  // Whether the facts panel is showing. It cannot be derived: it is a disclosure the user opens and
  // closes, and nothing else on the page knows. A new session gets a fresh pill (the caller keys it
  // by session id), so this resets without an effect.
  const [open, setOpen] = useState(false);
  // Where the panel goes, in viewport coordinates, read off the pill when it opens and again when
  // the viewport changes. State rather than computed in render because it comes from a layout
  // measurement of a node the render does not yet have.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    // Clamped to the viewport on both sides: a pill near the right edge would otherwise push a
    // 288px panel off-screen, and its Close control with it.
    const left = Math.min(
      Math.max(PANEL_MARGIN_PX, rect.left),
      Math.max(PANEL_MARGIN_PX, window.innerWidth - PANEL_WIDTH_PX - PANEL_MARGIN_PX),
    );
    setAnchor({ top: rect.bottom + PANEL_GAP_PX, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, place]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Closes on a press anywhere outside the pill and the panel, and on Escape. The listener is on
    // the document in the capture phase so a control that stops propagation cannot keep the panel
    // open behind it; the pill is excluded because its own click already toggles, and closing here
    // as well would make a press on it close and immediately reopen.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const stateView = sessionId ? findSessionHostState(snapshot, sessionId) : null;
  if (!sessionId || stateView?.lifecycleMode !== 'resident') {
    return null;
  }

  const processState = readResidentProcessState(findSessionHost(snapshot, sessionId), error !== null);
  const badgeState = BADGE_STATE_BY_PROCESS_STATE[processState];
  // How many background tasks the process is being held for — the host's own
  // held-work leases, which is a fact about the process rather than about the
  // session's task table. The activity dock answers "what is running now" from
  // that table; this pill answers "is this process being kept alive for work",
  // so the two readings are deliberately independent. Zero draws no chip: the
  // pill's job here is the count that is not nothing.
  const heldTaskCount = error === null ? findBackgroundTaskLeases(snapshot, sessionId).length : 0;
  const label = t('resident.badge.label', { defaultValue: 'Resident' });
  const stateWord = t(`resident.badge.state.${badgeState}`, {
    defaultValue:
      badgeState === 'running'
        ? 'process running'
        : badgeState === 'stopped'
          ? 'process not running'
          : badgeState === 'exited'
            ? 'process exited'
            : 'state unknown',
  });
  const accessibleName = t('resident.badge.aria', {
    state: stateWord,
    defaultValue: 'Resident session ({{state}}): show details',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-resident-badge={badgeState}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={accessibleName}
        title={accessibleName}
        onClick={() => setOpen((current) => !current)}
        // 14px tall — the project name's own line is 13.75px (11px at `leading-tight`) — so the second
        // line keeps the height the name alone gave it and the header does not grow. A taller pill
        // measured +1.5px of header, and a negative margin to cancel it would only turn that into
        // overflow. The hit area is 24px (WCAG 2.5.8) by an invisible extension upward and to the left
        // only: the title block scrolls horizontally, so anything this pill paints past its right or
        // bottom edge would become scrollable overflow of that container.
        className={`relative inline-flex h-3.5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] leading-none transition-colors before:absolute before:-left-2 before:-top-2.5 before:bottom-0 before:right-0 hover:bg-accent/60 ${
          badgeState === 'exited'
            ? 'border-red-500/40 text-red-600 dark:text-red-400'
            : 'border-border/60 text-muted-foreground'
        }`}
      >
        <BadgeDot state={badgeState} />
        <span>{label}</span>
        {heldTaskCount > 0 && (
          <span
            data-resident-badge-task-count={heldTaskCount}
            className="rounded-full bg-muted px-1 tabular-nums"
          >
            {t('resident.backgroundTasks.count', { n: heldTaskCount, defaultValue: '{{n}} tasks' })}
          </span>
        )}
        <ChevronDown className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && anchor
        ? createPortal(
            // A portal to `body`, outside every `overflow` and `contain` the transcript and the
            // header carry: the title block scrolls horizontally, so a panel rendered inside it
            // would be clipped to it. `fixed` against the viewport, with the position measured off
            // the pill, is what keeps it where the pill is without taking space in any flow.
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label={label}
              data-resident-badge-panel="true"
              className="fixed z-[60] max-w-[calc(100vw-1rem)]"
              style={{ top: anchor.top, left: anchor.left }}
            >
              <ResidentPanel sessionId={sessionId} t={t} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
