import { AppWindow, Plus, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import type { OAuthClientItem } from '@/shared/types';

type OAuthClientsSectionProps = {
  clients: OAuthClientItem[];
  showNewClientForm: boolean;
  newClientName: string;
  newClientRedirectUris: string;
  onShowNewClientFormChange: (value: boolean) => void;
  onNewClientNameChange: (value: string) => void;
  onNewClientRedirectUrisChange: (value: string) => void;
  onCreateClient: () => void;
  onCancelCreateClient: () => void;
  onDisableClient: (clientId: string) => void;
};

/** Rendered by CredentialsSettingsTab to list every registered OAuth client, create a manual one, and disable a client — which cascades to every grant and token under it. */
export default function OAuthClientsSection({
  clients,
  showNewClientForm,
  newClientName,
  newClientRedirectUris,
  onShowNewClientFormChange,
  onNewClientNameChange,
  onNewClientRedirectUrisChange,
  onCreateClient,
  onCancelCreateClient,
  onDisableClient,
}: OAuthClientsSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AppWindow className="h-5 w-5" />
          <h3 className="text-lg font-semibold">{t('oauthClients.title')}</h3>
        </div>
        <Button
          size="sm"
          onClick={() => onShowNewClientFormChange(!showNewClientForm)}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t('oauthClients.newButton')}
        </Button>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('oauthClients.description')}</p>

      {showNewClientForm && (
        <div className="mb-4 rounded-lg border bg-card p-4">
          <Input
            data-testid="oauth-client-name-input"
            placeholder={t('oauthClients.form.namePlaceholder')}
            value={newClientName}
            onChange={(event) => onNewClientNameChange(event.target.value)}
            className="mb-2"
          />
          <Input
            data-testid="oauth-client-redirect-input"
            placeholder={t('oauthClients.form.redirectUrisPlaceholder')}
            value={newClientRedirectUris}
            onChange={(event) => onNewClientRedirectUrisChange(event.target.value)}
            className="mb-3"
          />
          <div className="flex gap-2">
            <Button
              data-testid="oauth-client-create-submit"
              onClick={onCreateClient}
            >
              {t('oauthClients.form.createButton')}
            </Button>
            <Button variant="outline" onClick={onCancelCreateClient}>
              {t('oauthClients.form.cancelButton')}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {clients.length === 0 ? (
          <p data-testid="oauth-clients-empty" className="text-sm italic text-muted-foreground">
            {t('oauthClients.list.empty')}
          </p>
        ) : (
          clients.map((client) => {
            const isDisabled = client.disabledAt !== null;
            return (
              <div
                key={client.clientId}
                data-testid="oauth-client-row"
                data-client-id={client.clientId}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{client.clientName || client.clientId}</div>
                  <div data-testid="oauth-client-redirect-host" className="text-xs text-muted-foreground">
                    {t('oauthClients.list.redirectHost')} {client.redirectHost ?? t('oauthClients.list.empty')}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('oauthClients.list.createdVia')}{' '}
                    {client.createdVia === 'dcr' ? t('oauthClients.list.dcr') : t('oauthClients.list.manual')}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {isDisabled ? t('oauthClients.list.disabled') : t('oauthClients.list.active')}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isDisabled}
                    aria-label={t('oauthClients.list.disableButton')}
                    onClick={() => onDisableClient(client.clientId)}
                  >
                    <ShieldOff className="h-4 w-4" />
                    {t('oauthClients.list.disableButton')}
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
