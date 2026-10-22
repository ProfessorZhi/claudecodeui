import { AlertTriangle, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import {
  RESIDENT_MARK_SHAPES,
  findSessionHost,
  findSessionHostState,
  readResidentProcessState,
  useSessionHosts,
} from '@/shared/hooks/useSessionHosts';
import { Tooltip } from '@/shared/ui';

/**
 * Draws a resident session's process state beside its provider logo.
 *
 * Used by SidebarSessionItem (project rows) and SidebarRecentConversations (the
 * cross-project recents list), so both lists describe the same process the same
 * way. It renders nothing at all for a session that is not stored `resident`:
 * a per-run session has no process between turns, and a mark for one would be a
 * claim about a lifetime nothing owns.
 *
 * It is a static icon and not a control (the proposal is explicit): starting,
 * closing and copying the address all live in the status bar's popover, where
 * they can be labelled. A mark that also acted would make "click the dot beside
 * the name" mean something different from "select this session".
 *
 * The state is read through the shared translation rather than derived here, so
 * the word this mark draws and the sentence the status bar shows come from one
 * reading of one host. Its shape and its state are both published as data
 * attributes, because they are the two things a reader outside the component can
 * check a rendered row against.
 */
export default function ResidentMark({ sessionId, t }: { sessionId: string; t: TFunction }) {
  const { snapshot, error } = useSessionHosts();
  const state = findSessionHostState(snapshot, sessionId);

  if (state?.lifecycleMode !== 'resident') {
    return null;
  }

  const host = findSessionHost(snapshot, sessionId);
  // The same fold the status bar makes, through the same function: a failed read
  // reads as `unknown` in both places, from one translation of one store.
  const processState = readResidentProcessState(host, error !== null);
  const shape = RESIDENT_MARK_SHAPES[processState];
  const label = t(`resident.mark.${processState}`, {
    defaultValue:
      processState === 'exited'
        ? 'Resident process exited'
        : processState === 'unknown'
          ? 'Resident state unknown'
          : 'Resident session',
  });

  return (
    <Tooltip content={label} position="top">
      <span
        role="img"
        aria-label={label}
        data-resident-mark={shape}
        data-resident-state={processState}
        data-resident-exit-detail={processState === 'exited' ? host?.closeDetail ?? null : null}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
      >
        {processState === 'exited' ? (
          <AlertTriangle className="h-3 w-3 text-red-500" aria-hidden="true" />
        ) : processState === 'busy' ? (
          <span className="flex items-center gap-0.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
            <Loader2
              data-resident-spinner="true"
              className="h-3 w-3 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          </span>
        ) : processState === 'unknown' ? (
          // Not the busy spinner and not the idle solid dot: an unconfirmed state
          // must not wear either shape. A muted outline says "no reading" without
          // claiming a process is running or stopped.
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full border border-dashed border-amber-500"
          />
        ) : (
          <span
            aria-hidden="true"
            className={
              shape === 'solid'
                ? 'h-2 w-2 rounded-full bg-emerald-500'
                : 'h-2 w-2 rounded-full border border-muted-foreground'
            }
          />
        )}
      </span>
    </Tooltip>
  );
}
