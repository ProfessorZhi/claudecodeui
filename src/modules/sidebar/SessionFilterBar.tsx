import type { TFunction } from 'i18next';

/** Rendered by SidebarProjectSessions under an expanded project's session list when name-filtered sessions exist, to reveal them or open the rules editor. */
export default function SessionFilterBar({
  hiddenCount,
  isShowingHidden,
  onToggleShowHidden,
  onEditRules,
  t,
}: {
  hiddenCount: number;
  isShowingHidden: boolean;
  onToggleShowHidden: () => void;
  onEditRules: () => void;
  t: TFunction;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 px-3 py-1 text-[11px] text-muted-foreground"
      data-testid="session-filter-bar"
    >
      <span>{t('sessionFilter.hidden', { count: hiddenCount })}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="underline-offset-2 hover:text-foreground hover:underline"
        aria-pressed={isShowingHidden}
        onClick={onToggleShowHidden}
      >
        {isShowingHidden ? t('sessionFilter.hideAgain') : t('sessionFilter.show')}
      </button>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="underline-offset-2 hover:text-foreground hover:underline"
        onClick={onEditRules}
      >
        {t('sessionFilter.editRules')}
      </button>
    </div>
  );
}
