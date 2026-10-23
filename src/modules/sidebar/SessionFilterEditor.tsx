import { useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { Project } from '@/shared/types';
import { deriveSimilarNamePattern } from '@/modules/sidebar/utils/deriveSimilarNamePattern';

const PREVIEW_DEBOUNCE_MS = 300;

type SessionFilterPreview = {
  matchedCount: number;
  unmatchedCount: number;
  matchedSessionNames: string[];
  unmatchedSessionNames: string[];
};

type RuleLine = { text: string; lineNumber: number };

type ApiErrorPayload = {
  error?: string | { message?: string; details?: { line?: number | null } };
  message?: string;
};

/** Blank lines are not rules; each kept rule remembers its textarea line so server line numbers map back. */
const toRuleLines = (draft: string): RuleLine[] =>
  draft
    .split('\n')
    .map((text, index) => ({ text: text.replace(/\r$/, ''), lineNumber: index + 1 }))
    .filter((line) => line.text.length > 0);

const readApiError = async (response: Response, fallback: string, rules: RuleLine[]) => {
  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
  const error = payload.error;
  const message = typeof error === 'string' ? error : error?.message ?? payload.message ?? fallback;
  const serverLine = typeof error === 'object' ? error?.details?.line : null;
  // The server counts rules, not textarea lines.
  const invalidLine = serverLine ? rules[serverLine - 1]?.lineNumber ?? null : null;
  return { message, invalidLine };
};

/**
 * Rendered by Sidebar (through SidebarModals) for the "session filter" action of a project row:
 * one regex per line, live preview of what would be hidden, and save/cancel.
 */
export default function SessionFilterEditor({
  project,
  seedSessionName = null,
  onClose,
  onSaved,
  t,
}: {
  project: Project;
  /** "Hide similar": a session name whose derived rule is appended to the draft for the user to confirm. */
  seedSessionName?: string | null;
  onClose: () => void;
  /** Called after the rules were persisted; the owner reloads the project's sessions. */
  onSaved: (projectId: string, hide: string[]) => Promise<void> | void;
  t: TFunction;
}) {
  // The rules text being edited; seeded once from the project's stored rules.
  const [seed] = useState(() => {
    const stored = project.sessionFilter?.hide ?? [];
    const pattern = seedSessionName ? deriveSimilarNamePattern(seedSessionName) : '';
    if (!pattern) return { draft: stored.join('\n'), alreadyExists: false };
    if (stored.includes(pattern)) return { draft: stored.join('\n'), alreadyExists: true };
    return { draft: [...stored, pattern].join('\n'), alreadyExists: false };
  });
  const [draft, setDraft] = useState(seed.draft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Latest preview answer for the draft, shown as counts and sample names.
  const [preview, setPreview] = useState<SessionFilterPreview | null>(null);
  // Textarea line the server rejected (from preview or save); drives the red line marker.
  const [invalidLine, setInvalidLine] = useState<number | null>(null);
  // Server error text for the current draft or failed save, kept so the panel stays open on failure.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Blocks double submits and disables the save button while the PUT is in flight.
  const [isSaving, setIsSaving] = useState(false);
  const requestSeqRef = useRef(0);
  // Keeps the effect below independent of the translator's identity.
  const tRef = useRef(t);
  tRef.current = t;
  const rules = useMemo(() => toRuleLines(draft), [draft]);

  // A seeded rule is what the user came to confirm, so put the caret after it.
  useEffect(() => {
    if (!seedSessionName) return;
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    // Mount-only: later edits must not steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const seq = (requestSeqRef.current += 1);
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.previewProjectSessionFilter(project.projectId, rules.map((rule) => rule.text));
        if (seq !== requestSeqRef.current) return;
        if (!response.ok) {
          const failure = await readApiError(response, tRef.current('sessionFilter.saveFailed'), rules);
          if (seq !== requestSeqRef.current) return;
          setPreview(null);
          setInvalidLine(failure.invalidLine);
          setErrorMessage(failure.message);
          return;
        }
        const body = (await response.json()) as { data?: { preview?: SessionFilterPreview } };
        if (seq !== requestSeqRef.current) return;
        setPreview(body.data?.preview ?? null);
        setInvalidLine(null);
        setErrorMessage(null);
      } catch (error) {
        console.error('Error previewing session filter:', error);
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [project.projectId, rules]);

  const handleSave = async () => {
    setIsSaving(true);
    // A save answer supersedes any preview still in flight.
    requestSeqRef.current += 1;
    try {
      const hide = rules.map((rule) => rule.text);
      const response = await api.saveProjectSessionFilter(project.projectId, hide);
      if (!response.ok) {
        const failure = await readApiError(response, t('sessionFilter.saveFailed'), rules);
        setInvalidLine(failure.invalidLine);
        setErrorMessage(failure.message);
        return;
      }
      await onSaved(project.projectId, hide);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('sessionFilter.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg p-4" onEscapeKeyDown={onClose}>
        <DialogTitle>{t('sessionFilter.editorTitle')} · {project.displayName}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('sessionFilter.editorDescription')}</p>

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
          spellCheck={false}
          aria-label={t('sessionFilter.editorTitle')}
          aria-invalid={invalidLine !== null}
          placeholder={t('sessionFilter.editorPlaceholder')}
          className="mt-3 w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground focus:ring-2 focus:ring-primary/20"
        />

        {seed.alreadyExists && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">{t('sessionFilter.ruleAlreadyExists')}</p>
        )}

        {invalidLine !== null && (
          <ol className="mt-1 space-y-0.5 font-mono text-[11px]" data-testid="session-filter-lines">
            {draft.split('\n').map((text, index) => (
              <li
                key={index}
                data-testid={`session-filter-line-${index + 1}`}
                data-invalid={index + 1 === invalidLine ? 'true' : undefined}
                className={cn('truncate', index + 1 === invalidLine ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}
              >
                {index + 1}: {text}
                {index + 1 === invalidLine && ` — ${t('sessionFilter.lineError', { line: invalidLine })}`}
              </li>
            ))}
          </ol>
        )}

        {errorMessage && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
        )}

        {preview && (
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs" data-testid="session-filter-preview">
            <div>
              <div className="font-medium">{t('sessionFilter.matched', { count: preview.matchedCount })}</div>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {preview.matchedSessionNames.map((name, index) => (
                  <li key={`m-${index}`} className="truncate" title={name}>{name}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="font-medium">{t('sessionFilter.unmatched', { count: preview.unmatchedCount })}</div>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {preview.unmatchedSessionNames.map((name, index) => (
                  <li key={`u-${index}`} className="truncate" title={name}>{name}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('sessionFilter.cancel')}</Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? t('sessionFilter.saving') : t('sessionFilter.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
