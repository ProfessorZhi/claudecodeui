import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { ACCESS_TOKEN_SCOPE_OPTIONS } from '@/shared/constants';
import type {
  AccessTokenItem,
  CreatedAccessToken,
  GithubCredentialItem,
  McpGatewayStatus,
  OAuthTokenItem,
} from '@/shared/types';
import { copyTextToClipboard } from '@/shared/utils';

type AccessTokensResponse = {
  tokens?: AccessTokenItem[];
  success?: boolean;
  error?: string;
  token?: CreatedAccessToken;
};

/** The advanced read-only OAuth-token list's own response, kept separate from the PAT one. */
type OAuthTokensResponse = {
  tokens?: OAuthTokenItem[];
};

type GithubCredentialsResponse = {
  credentials?: GithubCredentialItem[];
  success?: boolean;
  error?: string;
};

type UseCredentialsSettingsArgs = {
  confirmRevokeAccessTokenText: string;
  confirmDeleteGithubCredentialText: string;
};

/** The lifetime a new token gets when the user does not pick one; the form offers exactly 7/30/90. */
const DEFAULT_ACCESS_TOKEN_EXPIRY_DAYS = 30;

/** The scopes a fresh create-token form starts with: the required read baseline, and nothing writable. */
const defaultNewTokenScopes = (): string[] =>
  ACCESS_TOKEN_SCOPE_OPTIONS.filter((option) => !option.writable).map((option) => option.scope);

const getApiError = (payload: { error?: string } | undefined, fallback: string) => (
  payload?.error || fallback
);

export function useCredentialsSettings({
  confirmRevokeAccessTokenText,
  confirmDeleteGithubCredentialText,
}: UseCredentialsSettingsArgs) {
  const [accessTokens, setAccessTokens] = useState<AccessTokenItem[]>([]);
  // The read-only OAuth tokens the advanced section lists. Kept apart from
  // `accessTokens` because the two are different resources: the PAT list is the
  // user's own created tokens, this is what the OAuth flows issued.
  const [oauthTokens, setOauthTokens] = useState<OAuthTokenItem[]>([]);
  const [githubCredentials, setGithubCredentials] = useState<GithubCredentialItem[]>([]);
  // True until the first list has been read; the tab shows a loading line rather than an empty list that looks real.
  const [loading, setLoading] = useState(true);

  // The create form's own fields, held here so the submit handler can read them together.
  const [showNewTokenForm, setShowNewTokenForm] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  // ! Possibly unnecessary - could live in the section, but the create handler reads it alongside the name, so the hook owns the whole form.
  const [newTokenExpiryDays, setNewTokenExpiryDays] = useState(DEFAULT_ACCESS_TOKEN_EXPIRY_DAYS);
  // The scope set the create form will submit. The read baseline is checked by
  // default; the write scopes start unchecked, and the section derives its risk
  // note from this same set rather than keeping a second copy of the selection.
  const [newTokenScopes, setNewTokenScopes] = useState<string[]>(defaultNewTokenScopes);

  // The CloudCLI MCP block's status; null until the first read answers, so the
  // section can distinguish "still loading" from a real enabled/disabled reading.
  const [mcpGatewayStatus, setMcpGatewayStatus] = useState<McpGatewayStatus | null>(null);

  const [showNewGithubForm, setShowNewGithubForm] = useState(false);
  const [newGithubName, setNewGithubName] = useState('');
  const [newGithubToken, setNewGithubToken] = useState('');
  const [newGithubDescription, setNewGithubDescription] = useState('');

  const [showToken, setShowToken] = useState<Record<string, boolean>>({});
  // The one-time plaintext of a just-created token. It must never be persisted: it
  // lives only in this state until the user dismisses it, and is gone on reload.
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<CreatedAccessToken | null>(null);
  // Whether the plaintext's copy button currently shows its "copied" tick.
  const [copiedToken, setCopiedToken] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);

      const [tokensResponse, oauthTokensResponse, credentialsResponse, mcpGatewayResponse] = await Promise.all([
        api.settings.accessTokens(),
        api.settings.oauthTokens(),
        api.settings.credentials('github_token'),
        api.settings.mcpGatewayStatus(),
      ]);

      const [tokensPayload, oauthTokensPayload, credentialsPayload, mcpGatewayPayload] = await Promise.all([
        tokensResponse.json() as Promise<AccessTokensResponse>,
        oauthTokensResponse.json() as Promise<OAuthTokensResponse>,
        credentialsResponse.json() as Promise<GithubCredentialsResponse>,
        mcpGatewayResponse.json() as Promise<McpGatewayStatus>,
      ]);

      setAccessTokens(tokensPayload.tokens || []);
      setOauthTokens(oauthTokensPayload.tokens || []);
      setGithubCredentials(credentialsPayload.credentials || []);
      setMcpGatewayStatus(mcpGatewayPayload);
    } catch (error) {
      console.error('Error fetching settings:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const createAccessToken = useCallback(async () => {
    if (!newTokenName.trim()) {
      return;
    }

    try {
      const response = await api.settings.createAccessToken({
        name: newTokenName.trim(),
        expiresInDays: newTokenExpiryDays,
        scopes: newTokenScopes,
      });

      const payload = await response.json() as AccessTokensResponse;
      if (!response.ok || !payload.token) {
        console.error('Error creating access token:', getApiError(payload, 'Failed to create access token'));
        return;
      }

      setNewlyCreatedToken(payload.token);
      setNewTokenName('');
      setNewTokenExpiryDays(DEFAULT_ACCESS_TOKEN_EXPIRY_DAYS);
      setNewTokenScopes(defaultNewTokenScopes());
      setShowNewTokenForm(false);
      await fetchData();
    } catch (error) {
      console.error('Error creating access token:', error);
    }
  }, [fetchData, newTokenExpiryDays, newTokenName, newTokenScopes]);

  const revokeAccessToken = useCallback(async (tokenId: number) => {
    if (!window.confirm(confirmRevokeAccessTokenText)) {
      return;
    }

    try {
      const response = await api.settings.revokeAccessToken(tokenId);

      if (!response.ok) {
        const payload = await response.json() as AccessTokensResponse;
        console.error('Error revoking access token:', getApiError(payload, 'Failed to revoke access token'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error revoking access token:', error);
    }
  }, [confirmRevokeAccessTokenText, fetchData]);

  const createGithubCredential = useCallback(async () => {
    if (!newGithubName.trim() || !newGithubToken.trim()) {
      return;
    }

    try {
      const response = await api.settings.createCredential({
        credentialName: newGithubName.trim(),
        credentialType: 'github_token',
        credentialValue: newGithubToken,
        description: newGithubDescription.trim(),
      });

      const payload = await response.json() as GithubCredentialsResponse;
      if (!response.ok || !payload.success) {
        console.error('Error creating GitHub credential:', getApiError(payload, 'Failed to create GitHub credential'));
        return;
      }

      setNewGithubName('');
      setNewGithubToken('');
      setNewGithubDescription('');
      setShowNewGithubForm(false);
      setShowToken((prev) => ({ ...prev, new: false }));
      await fetchData();
    } catch (error) {
      console.error('Error creating GitHub credential:', error);
    }
  }, [fetchData, newGithubDescription, newGithubName, newGithubToken]);

  const deleteGithubCredential = useCallback(async (credentialId: string) => {
    if (!window.confirm(confirmDeleteGithubCredentialText)) {
      return;
    }

    try {
      const response = await api.settings.deleteCredential(credentialId);

      if (!response.ok) {
        const payload = await response.json() as GithubCredentialsResponse;
        console.error('Error deleting GitHub credential:', getApiError(payload, 'Failed to delete GitHub credential'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error deleting GitHub credential:', error);
    }
  }, [confirmDeleteGithubCredentialText, fetchData]);

  const toggleGithubCredential = useCallback(async (credentialId: string, isActive: boolean) => {
    try {
      const response = await api.settings.toggleCredential(credentialId, !isActive);

      if (!response.ok) {
        const payload = await response.json() as GithubCredentialsResponse;
        console.error('Error toggling GitHub credential:', getApiError(payload, 'Failed to toggle GitHub credential'));
        return;
      }

      await fetchData();
    } catch (error) {
      console.error('Error toggling GitHub credential:', error);
    }
  }, [fetchData]);

  const copyTokenToClipboard = useCallback(async (text: string) => {
    try {
      await copyTextToClipboard(text);
      setCopiedToken(true);
      window.setTimeout(() => setCopiedToken(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }, []);

  const dismissNewlyCreatedToken = useCallback(() => {
    setNewlyCreatedToken(null);
    setCopiedToken(false);
  }, []);

  const cancelNewAccessTokenForm = useCallback(() => {
    setShowNewTokenForm(false);
    setNewTokenName('');
    setNewTokenExpiryDays(DEFAULT_ACCESS_TOKEN_EXPIRY_DAYS);
    setNewTokenScopes(defaultNewTokenScopes());
  }, []);

  /** Adds or removes one scope from the create form's selection; the read baseline is rendered disabled. */
  const toggleNewTokenScope = useCallback((scope: string, checked: boolean) => {
    setNewTokenScopes((previous) => (checked
      ? [...new Set([...previous, scope])]
      : previous.filter((selected) => selected !== scope)));
  }, []);

  const cancelNewGithubForm = useCallback(() => {
    setShowNewGithubForm(false);
    setNewGithubName('');
    setNewGithubToken('');
    setNewGithubDescription('');
    setShowToken((prev) => ({ ...prev, new: false }));
  }, []);

  const toggleNewGithubTokenVisibility = useCallback(() => {
    setShowToken((prev) => ({ ...prev, new: !prev.new }));
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    accessTokens,
    oauthTokens,
    githubCredentials,
    loading,
    showNewTokenForm,
    setShowNewTokenForm,
    newTokenName,
    setNewTokenName,
    newTokenExpiryDays,
    setNewTokenExpiryDays,
    newlyCreatedToken,
    copiedToken,
    createAccessToken,
    revokeAccessToken,
    mcpGatewayStatus,
    newTokenScopes,
    toggleNewTokenScope,
    showNewGithubForm,
    setShowNewGithubForm,
    newGithubName,
    setNewGithubName,
    newGithubToken,
    setNewGithubToken,
    newGithubDescription,
    setNewGithubDescription,
    showToken,
    createGithubCredential,
    deleteGithubCredential,
    toggleGithubCredential,
    copyTokenToClipboard,
    dismissNewlyCreatedToken,
    cancelNewAccessTokenForm,
    cancelNewGithubForm,
    toggleNewGithubTokenVisibility,
  };
}
