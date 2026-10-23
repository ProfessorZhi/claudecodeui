import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import type { McpNavigationPolicy } from '@/modules/settings/hooks/useMcpNavigationSettings';
import { useMcpNavigationSettings } from '@/modules/settings/hooks/useMcpNavigationSettings';

/** The policies the section offers, in display order; their labels are `mcpNavigation.policy.*`. */
const POLICY_OPTIONS: readonly McpNavigationPolicy[] = ['accept', 'ask', 'reject'];

/**
 * Rendered by CredentialsSettingsTab beside McpGatewaySection in the Settings → API tab:
 * this device's answer to an incoming MCP navigation request, and the name it reports.
 * Both live in this browser's localStorage only, which is why the section says so on the page.
 */
export default function McpNavigationSection() {
  const { t } = useTranslation('settings');
  const { policy, deviceName, setPolicy, setDeviceName } = useMcpNavigationSettings();

  return (
    <div data-testid="mcp-navigation-section">
      <div className="mb-4 flex items-center gap-2">
        <Compass className="h-5 w-5" />
        <h3 className="text-lg font-semibold">{t('mcpNavigation.title')}</h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('mcpNavigation.description')}</p>

      <fieldset className="mb-4 rounded-lg border bg-card p-3">
        <legend className="px-1 text-sm font-medium text-foreground">
          {t('mcpNavigation.policy.label')}
        </legend>
        <div className="flex flex-col gap-2">
          {POLICY_OPTIONS.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
            >
              <input
                type="radio"
                name="mcp-navigation-policy"
                value={option}
                checked={policy === option}
                onChange={() => setPolicy(option)}
                data-testid={`mcp-navigation-policy-${option}`}
                className="h-4 w-4"
              />
              <span>{t(`mcpNavigation.policy.${option}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-lg border bg-card p-3">
        <label htmlFor="mcp-device-name" className="mb-2 block text-sm font-medium text-foreground">
          {t('mcpNavigation.deviceName.label')}
        </label>
        <Input
          id="mcp-device-name"
          name="mcp-device-name"
          data-testid="mcp-device-name"
          type="text"
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          className="w-full"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t('mcpNavigation.deviceName.description')}
        </p>
      </div>

      <p data-testid="mcp-navigation-device-only" className="mt-3 text-xs text-muted-foreground">
        {t('mcpNavigation.deviceOnly')}
      </p>
    </div>
  );
}
