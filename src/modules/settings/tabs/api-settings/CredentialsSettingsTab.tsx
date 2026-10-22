import { useTranslation } from 'react-i18next';

import { useCredentialsSettings } from '@/modules/settings/hooks/useCredentialsSettings';
import { useOAuthSettings } from '@/modules/settings/hooks/useOAuthSettings';
import AccessTokensSection from '@/modules/settings/tabs/api-settings/sections/AccessTokensSection';
import ConnectedAppsSection from '@/modules/settings/tabs/api-settings/sections/ConnectedAppsSection';
import GithubCredentialsSection from '@/modules/settings/tabs/api-settings/sections/GithubCredentialsSection';
import McpGatewaySection from '@/modules/settings/tabs/api-settings/sections/McpGatewaySection';
import McpNavigationSection from '@/modules/settings/tabs/api-settings/sections/McpNavigationSection';
import NewAccessTokenAlert from '@/modules/settings/tabs/api-settings/sections/NewAccessTokenAlert';
import NewOAuthClientAlert from '@/modules/settings/tabs/api-settings/sections/NewOAuthClientAlert';
import OAuthClientsSection from '@/modules/settings/tabs/api-settings/sections/OAuthClientsSection';

/** Rendered by Settings for the "api" tab, managing CloudCLI personal access tokens, connected apps (OAuth grants and clients) and GitHub credentials. */
export default function CredentialsSettingsTab() {
  const { t } = useTranslation('settings');
  const {
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
  } = useCredentialsSettings({
    confirmRevokeAccessTokenText: t('accessTokens.list.revokeConfirm'),
    confirmDeleteGithubCredentialText: t('apiKeys.github.confirmDelete'),
  });
  const {
    grants,
    clients,
    loading: oauthLoading,
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
  } = useOAuthSettings({
    confirmRevokeGrantText: t('connectedApps.list.revokeConfirm'),
    confirmDisableClientText: t('oauthClients.list.disableConfirm'),
  });

  if (loading) {
    return <div className="text-muted-foreground">{t('apiKeys.loading')}</div>;
  }

  return (
    <div className="space-y-8">
      {newlyCreatedToken && (
        <NewAccessTokenAlert
          token={newlyCreatedToken}
          copied={copiedToken}
          onCopy={copyTokenToClipboard}
          onDismiss={dismissNewlyCreatedToken}
        />
      )}

      <McpGatewaySection status={mcpGatewayStatus} />

      <McpNavigationSection />

      <AccessTokensSection
        accessTokens={accessTokens}
        oauthTokens={oauthTokens}
        showNewTokenForm={showNewTokenForm}
        newTokenName={newTokenName}
        newTokenExpiryDays={newTokenExpiryDays}
        newTokenScopes={newTokenScopes}
        onShowNewTokenFormChange={setShowNewTokenForm}
        onNewTokenNameChange={setNewTokenName}
        onNewTokenExpiryChange={setNewTokenExpiryDays}
        onToggleNewTokenScope={toggleNewTokenScope}
        onCreateAccessToken={createAccessToken}
        onCancelCreateAccessToken={cancelNewAccessTokenForm}
        onRevokeAccessToken={revokeAccessToken}
      />

      {newlyCreatedClient && (
        <NewOAuthClientAlert client={newlyCreatedClient} onDismiss={dismissNewClient} />
      )}

      {!oauthLoading && (
        <>
          <ConnectedAppsSection grants={grants} onRevokeGrant={revokeGrant} />

          <OAuthClientsSection
            clients={clients}
            showNewClientForm={showNewClientForm}
            newClientName={newClientName}
            newClientRedirectUris={newClientRedirectUris}
            onShowNewClientFormChange={setShowNewClientForm}
            onNewClientNameChange={setNewClientName}
            onNewClientRedirectUrisChange={setNewClientRedirectUris}
            onCreateClient={createManualClient}
            onCancelCreateClient={cancelNewClientForm}
            onDisableClient={disableClient}
          />
        </>
      )}

      <GithubCredentialsSection
        githubCredentials={githubCredentials}
        showNewGithubForm={showNewGithubForm}
        showNewTokenPlainText={Boolean(showToken.new)}
        newGithubName={newGithubName}
        newGithubToken={newGithubToken}
        newGithubDescription={newGithubDescription}
        onShowNewGithubFormChange={setShowNewGithubForm}
        onNewGithubNameChange={setNewGithubName}
        onNewGithubTokenChange={setNewGithubToken}
        onNewGithubDescriptionChange={setNewGithubDescription}
        onToggleNewTokenVisibility={toggleNewGithubTokenVisibility}
        onCreateGithubCredential={createGithubCredential}
        onCancelCreateGithubCredential={cancelNewGithubForm}
        onToggleGithubCredential={toggleGithubCredential}
        onDeleteGithubCredential={deleteGithubCredential}
      />

    </div>
  );
}
