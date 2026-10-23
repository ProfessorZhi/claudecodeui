import { GitBranch } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';

type SessionBranchBadgeProps = {
  /** 1-based position of this branch among its source's branches, newest first. */
  siblingIndex?: number;
  /** How many branches the source has; above one the badge shows the ordinal. */
  siblingCount?: number;
  t: TFunction;
};

/**
 * Marks a session row as a branch of another session.
 *
 * Rendered by SidebarSessionItem (project rows) and SidebarRecentConversations
 * (the cross-project recents list), so both lists say "this row is a branch of
 * another conversation" identically.
 *
 * It is placed outside the row's truncating name box on purpose. The marker it
 * replaces — a "(fork)" suffix inside the name — is the first thing an ellipsis
 * removes from a narrow sidebar row, which is exactly what left a fork pair
 * rendering as two identical lines.
 */
export default function SessionBranchBadge({ siblingIndex, siblingCount, t }: SessionBranchBadgeProps) {
  // A source with several branches needs a number: one glyph cannot say which
  // of them a row is. A lone branch is unambiguous from the glyph alone.
  const showOrdinal = (siblingCount ?? 1) > 1;

  return (
    <Tooltip content={t('tooltips.branchedSession', 'Branched from another session')} position="top">
      <span
        role="img"
        aria-label={showOrdinal
          ? t('tooltips.branchedSessionOrdinal', {
            defaultValue: 'Branch {{index}} of {{count}}',
            index: siblingIndex,
            count: siblingCount,
          })
          : t('tooltips.branchedSession', 'Branched from another session')}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground"
      >
        {showOrdinal
          ? <span className="text-[11px] font-medium leading-none">{siblingIndex}</span>
          : <GitBranch className="h-3 w-3" />}
      </span>
    </Tooltip>
  );
}
