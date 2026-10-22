import { Link2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import type { ConnectedAppGrant } from '@/shared/types';

type ConnectedAppsSectionProps = {
  grants: ConnectedAppGrant[];
  onRevokeGrant: (grantId: number) => void;
};

/** Rendered by CredentialsSettingsTab to list the signed-in user's OAuth consent grants and revoke one; a revocation takes effect on that grant's tokens at the server, not merely in this list. */
export default function ConnectedAppsSection({ grants, onRevokeGrant }: ConnectedAppsSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Link2 className="h-5 w-5" />
        <h3 className="text-lg font-semibold">{t('connectedApps.title')}</h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('connectedApps.description')}</p>

      <div className="space-y-2">
        {grants.length === 0 ? (
          <p data-testid="connected-apps-empty" className="text-sm italic text-muted-foreground">
            {t('connectedApps.list.empty')}
          </p>
        ) : (
          grants.map((grant) => (
            <div
              key={grant.id}
              data-testid="connected-app-row"
              data-grant-id={grant.id}
              data-client-id={grant.clientId}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{grant.clientName || grant.clientId}</div>
                <div data-testid="connected-app-redirect-host" className="text-xs text-muted-foreground">
                  {t('connectedApps.list.redirectHost')} {grant.redirectHost ?? t('connectedApps.list.never')}
                </div>
                <div data-testid="connected-app-scopes" className="text-xs text-muted-foreground">
                  {t('connectedApps.list.scopes')} {grant.scopes.join(', ')}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('connectedApps.list.createdAt')}{' '}
                  {grant.createdAt ? new Date(grant.createdAt).toLocaleDateString() : t('connectedApps.list.never')}
                  {` - ${t('connectedApps.list.lastUsed')} `}
                  {grant.lastUsed ? new Date(grant.lastUsed).toLocaleDateString() : t('connectedApps.list.never')}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('connectedApps.list.revokeButton')}
                onClick={() => onRevokeGrant(grant.id)}
              >
                <Trash2 className="h-4 w-4" />
                {t('connectedApps.list.revokeButton')}
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
