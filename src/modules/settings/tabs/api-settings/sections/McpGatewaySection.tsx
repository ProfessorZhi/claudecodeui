import { CheckCircle2, Copy, Server, XCircle } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import type { McpGatewayStatus } from '@/shared/types';
import { copyTextToClipboard } from '@/shared/utils';

type McpGatewaySectionProps = {
  /** The gateway's status from the server, or null until the first read answers. */
  status: McpGatewayStatus | null;
};

/**
 * Rendered by CredentialsSettingsTab above the personal access token section: the
 * CloudCLI MCP endpoint, its enabled/disabled state, a copy button and — only
 * while the gateway is enabled — the local connect command. The command carries
 * a literal `Bearer <token>` placeholder and never a real token, so nothing on
 * the page leaks a credential.
 */
export default function McpGatewaySection({ status }: McpGatewaySectionProps) {
  const { t } = useTranslation('settings');
  // Whether the endpoint's copy button currently shows its "copied" tick; reset by a timer.
  const [copied, setCopied] = useState(false);

  const copyEndpoint = useCallback(async (endpoint: string) => {
    try {
      await copyTextToClipboard(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy MCP endpoint:', error);
    }
  }, []);

  if (!status) {
    return <div className="text-muted-foreground">{t('apiKeys.loading')}</div>;
  }

  const endpoint = `${status.baseUrl}${status.path}`;
  // The connect command a user runs on their own machine. The token is a
  // placeholder the user replaces with their own personal access token.
  const connectCommand =
    `claude mcp add --transport http cloudcli ${endpoint} `
    + '--header "Authorization: Bearer <token>"';

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Server className="h-5 w-5" />
        <h3 className="text-lg font-semibold">{t('mcpGateway.title')}</h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('mcpGateway.description')}</p>

      <div className="mb-3 flex items-center gap-2 text-sm text-foreground">
        {status.enabled ? (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        ) : (
          <XCircle className="h-4 w-4 text-muted-foreground" />
        )}
        <span data-testid="mcp-gateway-status" data-enabled={status.enabled}>
          {status.enabled ? t('mcpGateway.status.enabled') : t('mcpGateway.status.disabled')}
        </span>
      </div>

      {status.enabled ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <code
              data-testid="mcp-gateway-endpoint"
              className="rounded bg-muted px-2 py-1 text-xs text-foreground"
            >
              {endpoint}
            </code>
            <Button
              size="sm"
              variant="outline"
              data-testid="mcp-gateway-copy"
              onClick={() => copyEndpoint(endpoint)}
            >
              <Copy className="mr-1 h-4 w-4" />
              {copied ? t('mcpGateway.copied') : t('mcpGateway.copy')}
            </Button>
          </div>

          <div className="rounded-lg border bg-card p-3">
            <div className="mb-1 text-xs text-muted-foreground">{t('mcpGateway.connectLabel')}</div>
            <pre
              data-testid="mcp-gateway-command"
              className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-foreground"
            >
              {connectCommand}
            </pre>
          </div>
        </>
      ) : (
        <p data-testid="mcp-gateway-enable-hint" className="text-sm text-muted-foreground">
          {t('mcpGateway.enableHint')}
        </p>
      )}
    </div>
  );
}
