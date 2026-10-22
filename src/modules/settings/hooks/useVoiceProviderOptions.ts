import { useEffect, useState } from 'react';

import type { AsrCredentialFields, AsrRuntimeStatus } from '@shared/asr/asrRegistry';
import { api } from '@/shared/api';

/**
 * The recognisers the settings form can offer, as the health payload publishes them.
 *
 * THE LIST IS THE SERVER'S, NOT A TABLE IN THE CLIENT. Which recognisers exist, what they are
 * called and — the field this hook exists for — WHICH SETTINGS FIELDS ARE EACH ONE'S OWN are all
 * facts the registry holds and the health reading republishes. A client-side map from id to field
 * names would be a second source of truth for the same fact, and the failure it produces is
 * silent: a provider that renames a field, or a new one that declares none, would keep being shown
 * the old form while every request it made used the new declaration.
 *
 * The declaration arrives as `credentialFields`; `null` is this hook's spelling of the payload's
 * own "this provider declares none of its own" (the field is absent for a provider reached
 * through the shared backend). The distinction matters to the form: `null` means "the shared
 * fields apply", while an empty declaration would be a provider with nothing to configure.
 */
export type VoiceProviderOption = {
  id: string;
  label: string;
  /** Whether this provider, if it were the effective one, could serve a request right now. */
  configured: boolean;
  /** The stored-settings fields this provider declares as its own, or `null` when it declares none. */
  credentialFields: AsrCredentialFields | null;
  /**
   * What this provider says about its own ability to run, or `null` when it says nothing.
   *
   * THE SECOND KIND OF ROW, and the reason this hook carries two nullable readings rather than one.
   * `credentialFields` answers "what do I have to configure"; this one answers "can it run at all",
   * and for a recogniser that runs on the machine hosting the server the second question has no
   * answer in the user's settings — the answer is the deployment's. A remote provider declares
   * neither and stays `null` here, which is exactly the shape the payload uses (the key is ABSENT
   * rather than null for those rows), so the form can tell "says nothing" from "says unavailable".
   */
  runtime: AsrRuntimeStatus | null;
};

/**
 * Reads one row's declaration, keeping only what a form can act on.
 *
 * A field name that is not a string (or is empty) is not a field, and a declaration missing either
 * of its two required halves is not a declaration: `AsrCredentialFields` requires an address and a
 * credential, so a payload claiming one without the other is refused as a whole rather than
 * rendered as a half-filled form the user could save into.
 */
function readDeclaration(value: unknown): AsrCredentialFields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const { endpointField, apiKeyField, modelField, defaultModel } = value as Record<string, unknown>;
  if (typeof endpointField !== 'string' || !endpointField) return null;
  if (typeof apiKeyField !== 'string' || !apiKeyField) return null;

  return {
    endpointField,
    apiKeyField,
    ...(typeof modelField === 'string' && modelField ? { modelField } : {}),
    ...(typeof defaultModel === 'string' && defaultModel ? { defaultModel } : {}),
  };
}

/**
 * Reads one row's runtime reading, or `null` when the row carries none.
 *
 * BOTH BRANCHES ARE READ, and the difference between them is what the form shows: an unavailable
 * engine has a `reason` worth putting on screen, a usable one has the `buildId` of the artifacts the
 * deployment is pinned to. A row whose `available` is neither `true` nor `false` is not a reading at
 * all and is dropped — the server's own union has no third case, so a payload that invents one is
 * describing something this client cannot render a claim about.
 */
function readRuntime(value: unknown): AsrRuntimeStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const { available, state, buildId, reason } = value as Record<string, unknown>;
  if (available === false) {
    return {
      available: false,
      state: 'unavailable',
      reason: typeof reason === 'string' ? reason : '',
    };
  }
  if (available !== true) {
    return null;
  }
  const usable = state === 'ready' || state === 'starting' || state === 'stopped' ? state : 'stopped';
  return { available: true, state: usable, buildId: typeof buildId === 'string' ? buildId : '' };
}

/** Reads the payload's `providers` array, tolerating a server too old to send one. */
export function readVoiceProviderOptions(payload: unknown): VoiceProviderOption[] {
  const rows = (payload as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(rows)) {
    return [];
  }

  const options: VoiceProviderOption[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { id, label, configured, credentialFields, runtime } = row as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    options.push({
      id,
      // The label is the server's to choose; an id is the honest fallback when it sent none,
      // rather than a name this client would have to keep in step with the registry.
      label: typeof label === 'string' && label ? label : id,
      configured: configured === true,
      credentialFields: readDeclaration(credentialFields),
      runtime: readRuntime(runtime),
    });
  }
  return options;
}

/**
 * Fetches the provider list once per mount.
 *
 * Failure is not an error state on purpose: the form still renders the shared backend fields it
 * always had, and a select with nothing to choose from is a visibly unavailable control rather
 * than a settings page that refuses to load. The select is the only consumer, so a retry belongs
 * to whatever re-opens the page rather than to a second polling loop here.
 */
export function useVoiceProviderOptions(): { providers: VoiceProviderOption[] } {
  const [providers, setProviders] = useState<VoiceProviderOption[]>([]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await api.voice.health();
        if (!response.ok) {
          return;
        }
        const options = readVoiceProviderOptions(await response.json());
        if (!cancelled) {
          setProviders(options);
        }
      } catch (error) {
        console.error('Failed to load voice providers:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { providers };
}
