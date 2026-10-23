import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import type { CreatedOAuthClient } from '@/shared/types';
import { copyTextToClipboard } from '@/shared/utils';

type NewOAuthClientAlertProps = {
  client: CreatedOAuthClient;
  onDismiss: () => void;
};

/**
 * Rendered by CredentialsSettingsTab to show a freshly created manual OAuth
 * client's id and plaintext secret once, before the user dismisses it. The
 * secret is a prop held in the hook's state — it is never written to
 * localStorage/sessionStorage and never rendered in the client list, so this
 * alert is the only place it ever appears.
 */
export default function NewOAuthClientAlert({ client, onDismiss }: NewOAuthClientAlertProps) {
  const { t } = useTranslation('settings');
  // Whether the secret's copy button currently shows its "copied" tick; reset by a timer.
  const [copied, setCopied] = useState(false);

  const copySecret = useCallback(async (secret: string) => {
    try {
      await copyTextToClipboard(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy OAuth client secret:', error);
    }
  }, []);

  return (
    <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4">
      <h4 className="mb-2 font-semibold text-yellow-500">{t('oauthClients.newClient.alertTitle')}</h4>
      <p className="mb-3 text-sm text-muted-foreground">{t('oauthClients.newClient.alertMessage')}</p>
      <div className="mb-2 text-xs text-muted-foreground">
        client_id <code data-testid="new-oauth-client-id" className="break-all">{client.clientId}</code>
      </div>
      <div className="flex items-center gap-2">
        <code
          data-testid="new-oauth-client-secret"
          className="flex-1 break-all rounded bg-background/50 px-3 py-2 font-mono text-sm"
        >
          {client.clientSecret}
        </code>
        <Button
          size="sm"
          variant="outline"
          aria-label={t('oauthClients.newClient.copy')}
          onClick={() => copySecret(client.clientSecret)}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <Button size="sm" variant="ghost" className="mt-3" onClick={onDismiss}>
        {t('oauthClients.newClient.iveSavedIt')}
      </Button>
    </div>
  );
}
