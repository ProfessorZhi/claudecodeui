import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy, Check } from 'lucide-react';

import { cn,copyTextToClipboard } from '@/shared/utils';
import { ToolStatusBadge } from '@/modules/chat/tools/ToolStatusBadge';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import type { ToolStatus } from '@/shared/types';

type BashCommandDisplayProps = {
  command: string;
  description?: string;
  /** Combined stdout/stderr from the tool result (empty while running). */
  output?: string;
  isError?: boolean;
  status?: ToolStatus;
  defaultOpen?: boolean;
  /**
   * The transcript's own reading of the command's lifecycle, published as a
   * second attribute so a reader can compare it with the Task entity's state.
   * The two differ exactly where a background shell's task outlives its result
   * row — the discrimination AC-194's false-form arm turns on.
   */
  foldedStatus?: ToolStatus;
  /**
   * The lifecycle state of the Task entity this command launched, read by the
   * card's `tool_use` id (AC-194). When present it is the header's status — the
   * command row reads the backend's task table rather than showing `running`
   * forever because no result row was ever folded in. Absent falls back to the
   * transcript's own status.
   */
  taskState?: string | null;
};

/**
 * Codex-in-VSCode style command row: a compact, single-line command with a
 * chevron on the left. When the command produced output, the row becomes a
 * dropdown that expands to reveal the output inline. Theme-integrated surfaces
 * keep it clean in both light and dark mode; consecutive commands stack tightly
 * into a clean list.
 *
 * Rendered by chat's ToolRenderer for shell tools (Bash and friends).
 */
export const BashCommandDisplay: React.FC<BashCommandDisplayProps> = ({
  command,
  description,
  output,
  isError = false,
  status,
  defaultOpen = false,
  foldedStatus,
  taskState = null,
}) => {
  const { t } = useTranslation();
  const trimmedOutput = (output || '').replace(/\s+$/, '');
  const hasOutput = trimmedOutput.length > 0;
  const outputLineCount = hasOutput ? trimmedOutput.split('\n').length : 0;
  // The header's running reading comes from the Task entity when the card has
  // one (AC-194): a background shell carries a task whose state the entity
  // updates, so the row is not painted `running` forever just because no result
  // was folded in. Without an entity the transcript's own status is used.
  const isRunning = taskState !== null ? taskState === 'running' || taskState === 'blocked' : status === 'running';
  // `open` is raised by an effect once output arrives (below). A document is
  // rendered without effects, so it would show every command and no output.
  const isExporting = useIsExportingTranscript();
  const [openState, setOpen] = useState(false);
  const open = openState || isExporting;
  const [copied, setCopied] = useState(false);

  // Output often arrives after this component first mounts, so apply the
  // auto-open intent once when there is finally something to show. After that
  // the user is in control of the toggle. Errors intentionally do NOT
  // auto-expand — the red border and status badge already signal the failure,
  // and the output stays one click away.
  const autoAppliedRef = useRef(false);
  useEffect(() => {
    if (!autoAppliedRef.current && hasOutput && defaultOpen) {
      autoAppliedRef.current = true;
      setOpen(true);
    }
  }, [hasOutput, defaultOpen]);

  const toggle = () => {
    if (hasOutput) {
      setOpen((prev) => !prev);
    }
  };

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const didCopy = await copyTextToClipboard(command);
    if (!didCopy) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      data-card-folded-status={foldedStatus ?? status ?? 'running'}
      className={cn(
        'group/cmd overflow-hidden rounded-lg border bg-muted/40 backdrop-blur-sm transition-all duration-200',
        isError ? 'border-red-500/30' : 'border-border/60',
        hasOutput && !open && 'hover:border-border hover:bg-muted/60',
        open && 'bg-muted/50 shadow-sm',
      )}
    >
      {/* Command header — clickable when there is output to expand */}
      <div
        role={hasOutput ? 'button' : undefined}
        tabIndex={hasOutput ? 0 : undefined}
        aria-expanded={hasOutput ? open : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (hasOutput && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            toggle();
          }
        }}
        className={cn(
          'flex items-center gap-2 px-2.5 py-1.5 outline-none',
          hasOutput && 'cursor-pointer focus-visible:ring-1 focus-visible:ring-ring',
        )}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70 transition-transform duration-200',
            open && 'rotate-90',
            !hasOutput && 'opacity-0',
          )}
        />
        <span className="flex-shrink-0 select-none font-mono text-xs font-semibold text-emerald-500 dark:text-emerald-400">
          $
        </span>
        {/* Not a <code> tag: the global `.chat-message code` rule forces
            `white-space: pre-wrap !important`, which would defeat `truncate`
            and render collapsed multi-line commands in full. */}
        <span
          className={cn(
            'min-w-0 flex-1 font-mono text-xs text-foreground',
            open ? 'whitespace-pre-wrap break-all' : 'truncate',
          )}
        >
          {command}
        </span>

        {isRunning && (
          <span className="h-2.5 w-2.5 flex-shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-emerald-400" />
        )}
        {/* The Task entity's state, when this command launched one (AC-194). Read
            by `toolUseId` from the activity snapshot; the row's state changes when
            the task does, without the result having to arrive. */}
        {taskState !== null && (
          <span
            data-card-task-state={taskState}
            className="flex-shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground/80"
          >
            {taskState}
          </span>
        )}
        {taskState === null && status && status !== 'running' && (
          <ToolStatusBadge status={status} className="flex-shrink-0" />
        )}
        {!open && hasOutput && !isRunning && (
          <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/70 transition-opacity group-hover/cmd:opacity-0">
            {outputLineCount} {outputLineCount === 1 ? 'line' : 'lines'}
          </span>
        )}

        <button
          onClick={handleCopy}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex-shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-all hover:bg-foreground/10 hover:text-foreground focus:opacity-100 group-hover/cmd:opacity-100"
          title={t('chat:misc.copyCommand')}
          aria-label={t('chat:misc.copyCommand')}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>

      {description && !open && (
        <div className="truncate px-2.5 pb-1.5 pl-[2.4rem] text-[11px] italic text-muted-foreground/70">
          {description}
        </div>
      )}

      {/* Expanded output */}
      {open && hasOutput && (
        <div className="settings-content-enter border-t border-border/50 bg-background/50">
          {description && (
            <div className="px-3 pt-2 text-[11px] italic text-muted-foreground/70">{description}</div>
          )}
          <pre
            className={cn(
              'max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-relaxed',
              isError ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
            )}
          >
            {trimmedOutput}
          </pre>
        </div>
      )}
    </div>
  );
};
