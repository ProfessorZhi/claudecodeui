import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  Braces,
  Brain,
  Check,
  CornerDownLeft,
  Eye,
  FileCode2,
  FileText,
  Loader2,
  Mic,
  MoreHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useSetUiPreference, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useTranscriptExport } from '@/shared/context/TranscriptExportContext';
import { SETTING_ROW_CLASS } from '@/shared/constants';
import type { UiPreferenceKey } from '@/shared/uiPreferences';
import { DarkModeToggle } from '@/shared/ui';
import { cn } from '@/shared/utils';
import { LanguageSelector } from '@/modules/i18n';

/** One export format the menu offers; chat's `runExport` accepts the same ids. */
type ExportFormatId = 'html' | 'markdown' | 'json';

/** The three formats, labelled from chat's own copy so the menu and the exporter never disagree. */
const EXPORT_FORMATS: Array<{ id: ExportFormatId; icon: LucideIcon; labelKey: string; descriptionKey: string }> = [
  { id: 'html', icon: FileCode2, labelKey: 'export.html.label', descriptionKey: 'export.html.description' },
  { id: 'markdown', icon: FileText, labelKey: 'export.markdown.label', descriptionKey: 'export.markdown.description' },
  { id: 'json', icon: Braces, labelKey: 'export.json.label', descriptionKey: 'export.json.description' },
];

/** Preference rows read from the shared UI-preferences store; the voice row is offered only when voice is already enabled. */
const TOOL_DISPLAY_TOGGLES: Array<{ key: UiPreferenceKey; labelKey: string; icon: LucideIcon }> = [
  { key: 'showRawParameters', labelKey: 'quickSettings.showRawParameters', icon: Eye },
  { key: 'showThinking', labelKey: 'quickSettings.showThinking', icon: Brain },
];
const INPUT_TOGGLES: Array<{ key: UiPreferenceKey; labelKey: string; icon: LucideIcon }> = [
  { key: 'sendByCtrlEnter', labelKey: 'quickSettings.sendByCtrlEnter', icon: CornerDownLeft },
  { key: 'voiceEnabled', labelKey: 'quickSettings.voiceEnabled', icon: Mic },
];

/** The widest the dropdown draws; narrower viewports cap it to their own width less a margin. */
const MENU_WIDTH_PX = 288;
/** A rough menu height, used to decide whether it opens below the trigger or above it. */
const MENU_ESTIMATED_HEIGHT_PX = 470;

const ITEM_CLASS =
  'flex w-full min-h-[44px] items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus:outline-none focus-visible:bg-accent';

const SECTION_TITLE_CLASS =
  'px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground';

/** Where the dropdown is pinned, in viewport pixels, measured from the trigger when it opened. */
type MenuPosition = { top: number; left: number };

type WorkspaceMenuPanelProps = {
  position: MenuPosition;
  /** The dropdown's own node, read by the trigger's outside-click dismissal. */
  menuRef: RefObject<HTMLDivElement>;
  /** Clears the trigger's open state; every terminating action (an export, Escape, an outside click) closes through it. */
  onClose: () => void;
};

/**
 * The dropdown's contents, mounted only while the menu is open.
 *
 * Keeping this a separate component is what keeps the *closed* header free of
 * the preferences store: the trigger is drawn on every session page, but these
 * rows need a `UiPreferencesProvider` that a header rendered on its own — a
 * layout test, an isolated shell — does not carry.
 */
function WorkspaceMenuPanel({ position, menuRef, onClose }: WorkspaceMenuPanelProps) {
  const { t } = useTranslation(['common', 'chat', 'settings']);
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const { available, getAction } = useTranscriptExport();
  // Which export is building, so its row can show a spinner.
  const [busyFormat, setBusyFormat] = useState<ExportFormatId | null>(null);

  const runExport = useCallback(async (format: ExportFormatId) => {
    // Close first: selecting an export is a terminating action, as the old menu did.
    onClose();
    const action = getAction();
    if (!action) return;
    setBusyFormat(format);
    try {
      await action.runExport(format);
    } catch (error) {
      console.error('Failed to export conversation:', error);
    } finally {
      setBusyFormat(null);
    }
  }, [getAction, onClose]);

  const togglePreference = useCallback((key: UiPreferenceKey) => {
    setPreference(key, !preferences[key]);
  }, [preferences, setPreference]);

  const renderToggleRow = ({ key, labelKey, icon: Icon }: { key: UiPreferenceKey; labelKey: string; icon: LucideIcon }) => (
    <button
      key={key}
      type="button"
      role="menuitemcheckbox"
      aria-checked={preferences[key]}
      data-workspace-menu-item={key}
      onClick={() => togglePreference(key)}
      className={cn(ITEM_CLASS, 'items-center justify-between')}
    >
      <span className="flex items-center gap-2 text-sm text-foreground">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {t(labelKey, { ns: 'settings' })}
      </span>
      <span
        aria-hidden
        className={cn(
          'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border',
          preferences[key] ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
        )}
      >
        {preferences[key] && <Check className="h-3 w-3" />}
      </span>
    </button>
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      data-workspace-menu
      aria-label={t('workspaceMenu.trigger', { ns: 'chat' })}
      className={cn(
        'fixed z-[70] max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl',
        'animate-in fade-in-0 zoom-in-95',
      )}
      style={position
        ? { top: position.top, left: position.left, width: Math.min(MENU_WIDTH_PX, window.innerWidth - 16) }
        : undefined}
    >
      {available && (
        <>
          <p role="presentation" className={SECTION_TITLE_CLASS}>{t('export.heading', { ns: 'chat' })}</p>
          {EXPORT_FORMATS.map(({ id, icon: Icon, labelKey, descriptionKey }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              data-workspace-menu-item={`export-${id}`}
              onClick={() => { void runExport(id); }}
              className={ITEM_CLASS}
            >
              {busyFormat === id ? (
                <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
              ) : (
                <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-medium leading-5">{t(labelKey, { ns: 'chat' })}</span>
                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                  {t(descriptionKey, { ns: 'chat' })}
                </span>
              </span>
            </button>
          ))}
        </>
      )}

      <p role="presentation" className={SECTION_TITLE_CLASS}>{t('quickSettings.sections.toolDisplay', { ns: 'settings' })}</p>
      {TOOL_DISPLAY_TOGGLES.map(renderToggleRow)}

      <p role="presentation" className={SECTION_TITLE_CLASS}>{t('quickSettings.sections.inputSettings', { ns: 'settings' })}</p>
      {INPUT_TOGGLES.filter((item) => item.key !== 'voiceEnabled' || preferences.voiceEnabled).map(renderToggleRow)}

      <p role="presentation" className={SECTION_TITLE_CLASS}>{t('quickSettings.sections.appearance', { ns: 'settings' })}</p>
      <div role="none" data-workspace-menu-item="darkMode" className={cn(SETTING_ROW_CLASS, 'min-h-[44px]')}>
        <span className="text-sm text-foreground">{t('quickSettings.darkMode', { ns: 'settings' })}</span>
        <DarkModeToggle ariaLabel={t('quickSettings.darkMode', { ns: 'settings' })} />
      </div>
      <div role="none" data-workspace-menu-item="language">
        <LanguageSelector compact />
      </div>
    </div>
  );
}

/**
 * Rendered by WorkspaceHeader at the far right of the top bar, outside the tab
 * strip, on both mobile and desktop.
 *
 * A single dropdown holds what used to be two edge controls that no longer
 * exist: the transcript export (only when the open conversation has messages,
 * read from the shared transcript-export seam) and the quick settings, whose
 * content moved here from the retired drawer. Switches apply immediately and
 * keep the menu open; the export items run a download and close it.
 */
export default function WorkspaceMenu() {
  const { t } = useTranslation(['common', 'chat', 'settings']);
  // Whether the dropdown is open; the trigger flips it and every dismissal path clears it.
  const [isOpen, setIsOpen] = useState(false);
  // Where the portalled menu is pinned, in viewport pixels, measured from the trigger on open.
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH_PX, window.innerWidth - 16);
    const estimatedHeight = Math.min(window.innerHeight - 16, MENU_ESTIMATED_HEIGHT_PX);
    setPosition({
      top: rect.bottom + 6 + estimatedHeight <= window.innerHeight - 8
        ? rect.bottom + 6
        : Math.max(8, rect.top - estimatedHeight - 6),
      // Right-aligned to the trigger, then nudged back inside the viewport so the
      // menu never runs off the left edge on a narrow phone.
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    });
    setIsOpen(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeMenu();
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', closeMenu);
    };
  }, [isOpen, closeMenu]);

  return (
    <div ref={rootRef} className="relative inline-flex flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        data-workspace-menu-trigger
        aria-label={t('workspaceMenu.trigger', { ns: 'chat' })}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>

      {isOpen && position && typeof document !== 'undefined'
        ? createPortal(
            <WorkspaceMenuPanel position={position} menuRef={menuRef} onClose={closeMenu} />,
            document.body,
          )
        : null}
    </div>
  );
}
