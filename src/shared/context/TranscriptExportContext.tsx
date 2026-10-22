import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { TranscriptExportAction, TranscriptExportRegistration } from '@/shared/types';

type TranscriptExportContextValue = TranscriptExportRegistration & {
  /** Publishes chat's export accessor, or clears it with null when the conversation empties or chat unmounts. */
  register: (getAction: (() => TranscriptExportAction | null) | null) => void;
};

const TranscriptExportContext = createContext<TranscriptExportContextValue | null>(null);

/** An inert reading for a header rendered outside the provider, so the menu draws without an export group rather than throwing. */
const INERT: TranscriptExportContextValue = {
  available: false,
  register: () => {},
  getAction: () => null,
};

/**
 * The shared seam between the chat module and the workspace header's overflow
 * menu.
 *
 * Chat owns the conversation and its exporter; the header owns the menu. They
 * may not import each other, so chat registers an export *accessor* here and the
 * menu reads it. The accessor is a getter rather than the action itself so a
 * streaming transcript can hand over the latest messages without re-registering
 * — and re-rendering the header — on every token.
 */
export function TranscriptExportProvider({ children }: { children: ReactNode }) {
  // The latest accessor chat registered; a ref rather than state because the
  // header menu only reads it on a click, never during render.
  const getterRef = useRef<(() => TranscriptExportAction | null) | null>(null);
  // Whether an export is registered. This, not the action, is what re-renders
  // the provider's consumers, and it changes only as a conversation opens/closes.
  const [available, setAvailable] = useState(false);

  const register = useCallback((getter: (() => TranscriptExportAction | null) | null) => {
    getterRef.current = getter;
    setAvailable(getter !== null);
  }, []);

  const getAction = useCallback(() => getterRef.current?.() ?? null, []);

  const value = useMemo(
    () => ({ available, register, getAction }),
    [available, getAction, register],
  );

  return <TranscriptExportContext.Provider value={value}>{children}</TranscriptExportContext.Provider>;
}

/** Reads the seam; an outer component (the workspace header) uses it to draw and run the export group. */
export function useTranscriptExport(): TranscriptExportContextValue {
  return useContext(TranscriptExportContext) ?? INERT;
}

/** Used by the chat module to publish its export for the open conversation, clearing it on unmount. */
export function useRegisterTranscriptExport(action: TranscriptExportAction | null): void {
  const { register } = useTranscriptExport();
  const available = action !== null;
  // The latest action, so the registered getter always answers with this render's
  // conversation even though the registration itself only re-runs on availability.
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  }, [action]);
  useEffect(() => {
    register(available ? () => actionRef.current : null);
    return () => register(null);
  }, [available, register]);
}
