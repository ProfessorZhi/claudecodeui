import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { ConnectedAppGrant, CreatedOAuthClient, OAuthClientItem } from '@/shared/types';

type GrantsResponse = {
  grants?: ConnectedAppGrant[];
  error?: string;
};

type ClientsResponse = {
  clients?: OAuthClientItem[];
  error?: string;
};

/** The `POST /api/oauth/clients` success body is snake_case on the wire; this is the only place it is mapped to the camelCase shape the UI renders. */
type CreateClientResponse = {
  client_id?: string;
  client_secret?: string;
  error?: string;
  error_description?: string;
};

type UseOAuthSettingsArgs = {
  confirmRevokeGrantText: string;
  confirmDisableClientText: string;
};

const getApiError = (payload: { error?: string } | undefined, fallback: string) => (
  payload?.error || fallback
);

/**
 * The settings page's OAuth state: the signed-in user's consent grants and the
 * registered clients, plus the three write actions the "connected apps" and
 * "OAuth clients (advanced)" sections drive. Consumers: `CredentialsSettingsTab`,
 * which feeds the two sections and the one-time secret alert from this hook.
 *
 * The manual client's plaintext secret is held ONLY here, in `newlyCreatedClient`,
 * until the user dismisses the alert: it is never written to storage and never
 * folded into the client list, so a reload cannot re-expose it.
 */
export function useOAuthSettings({
  confirmRevokeGrantText,
  confirmDisableClientText,
}: UseOAuthSettingsArgs) {
  // The signed-in user's own consent grants, as the server last reported them.
  const [grants, setGrants] = useState<ConnectedAppGrant[]>([]);
  // Every registered client (not only this user's), so an operator can disable one.
  const [clients, setClients] = useState<OAuthClientItem[]>([]);
  // True until the first list has been read, so the sections show a loading line
  // rather than an empty list that would look like a real "nothing connected yet".
  const [loading, setLoading] = useState(true);

  // The create form's own fields, held here so the submit handler reads them together.
  const [showNewClientForm, setShowNewClientForm] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientRedirectUris, setNewClientRedirectUris] = useState('');

  // The one-time plaintext of a just-created manual client. It must never be
  // persisted: it lives only in this state until the user dismisses the alert,
  // and is gone on reload.
  const [newlyCreatedClient, setNewlyCreatedClient] = useState<CreatedOAuthClient | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);

      const [grantsResponse, clientsResponse] = await Promise.all([
        api.settings.oauthGrants(),
        api.settings.oauthClients(),
      ]);

      const [grantsPayload, clientsPayload] = await Promise.all([
        grantsResponse.json() as Promise<GrantsResponse>,
        clientsResponse.json() as Promise<ClientsResponse>,
      ]);

      setGrants(grantsPayload.grants || []);
      setClients(clientsPayload.clients || []);
    } catch (error) {
      console.error('Error fetching OAuth settings:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const revokeGrant = useCallback(async (grantId: number) => {
    if (!window.confirm(confirmRevokeGrantText)) {
      return;
    }

    try {
      const response = await api.settings.revokeOAuthGrant(grantId);

      if (!response.ok) {
        const payload = await response.json() as GrantsResponse;
        console.error('Error revoking OAuth grant:', getApiError(payload, 'Failed to revoke grant'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error revoking OAuth grant:', error);
    }
  }, [confirmRevokeGrantText, fetchData]);

  const disableClient = useCallback(async (clientId: string) => {
    if (!window.confirm(confirmDisableClientText)) {
      return;
    }

    try {
      const response = await api.settings.disableOAuthClient(clientId);

      if (!response.ok) {
        const payload = await response.json() as ClientsResponse;
        console.error('Error disabling OAuth client:', getApiError(payload, 'Failed to disable client'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error disabling OAuth client:', error);
    }
  }, [confirmDisableClientText, fetchData]);

  const createManualClient = useCallback(async () => {
    const redirectUris = newClientRedirectUris
      .split(/[\s,]+/)
      .map((uri) => uri.trim())
      .filter((uri) => uri !== '');
    if (!newClientName.trim() || redirectUris.length === 0) {
      return;
    }

    try {
      const response = await api.settings.createOAuthClient({
        clientName: newClientName.trim(),
        redirectUris,
      });

      const payload = await response.json() as CreateClientResponse;
      if (!response.ok || !payload.client_id || !payload.client_secret) {
        console.error(
          'Error creating OAuth client:',
          payload.error_description || getApiError(payload, 'Failed to create OAuth client'),
        );
        return;
      }

      setNewlyCreatedClient({
        clientId: payload.client_id,
        clientName: newClientName.trim(),
        redirectUris,
        clientSecret: payload.client_secret,
      });
      setNewClientName('');
      setNewClientRedirectUris('');
      setShowNewClientForm(false);
      await fetchData();
    } catch (error) {
      console.error('Error creating OAuth client:', error);
    }
  }, [fetchData, newClientName, newClientRedirectUris]);

  const dismissNewClient = useCallback(() => {
    setNewlyCreatedClient(null);
  }, []);

  const cancelNewClientForm = useCallback(() => {
    setShowNewClientForm(false);
    setNewClientName('');
    setNewClientRedirectUris('');
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    grants,
    clients,
    loading,
    showNewClientForm,
    setShowNewClientForm,
    newClientName,
    setNewClientName,
    newClientRedirectUris,
    setNewClientRedirectUris,
    newlyCreatedClient,
    createManualClient,
    revokeGrant,
    disableClient,
    dismissNewClient,
    cancelNewClientForm,
  };
}
