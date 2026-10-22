import { ChevronRight, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ACCESS_TOKEN_SCOPE_OPTIONS } from '@/shared/constants';
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Input } from '@/shared/ui';
import type { AccessTokenItem, OAuthTokenItem } from '@/shared/types';

/** The only lifetimes a personal access token may be created with; the server rejects anything else. */
const EXPIRY_DAY_OPTIONS = [7, 30, 90] as const;

type AccessTokensSectionProps = {
  accessTokens: AccessTokenItem[];
  oauthTokens: OAuthTokenItem[];
  showNewTokenForm: boolean;
  newTokenName: string;
  newTokenExpiryDays: number;
  newTokenScopes: string[];
  onShowNewTokenFormChange: (value: boolean) => void;
  onNewTokenNameChange: (value: string) => void;
  onNewTokenExpiryChange: (days: number) => void;
  onToggleNewTokenScope: (scope: string, checked: boolean) => void;
  onCreateAccessToken: () => void;
  onCancelCreateAccessToken: () => void;
  onRevokeAccessToken: (tokenId: number) => void;
};

/**
 * The relative-age text for a timestamp ("3 minutes ago"), so recent activity reads
 * at a glance. `toLocaleDateString` alone cannot express "a few minutes ago". `now`
 * is passed in rather than read here, so the component's clock is the single source.
 */
function relativeTime(iso: string, now: number): string {
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const diffSeconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, secondsPerUnit] of units) {
    if (Math.abs(diffSeconds) >= secondsPerUnit) {
      return formatter.format(Math.round(diffSeconds / secondsPerUnit), unit);
    }
  }
  return formatter.format(diffSeconds, 'second');
}

/** The absolute instant behind a relative timestamp, shown through the row's `title` tooltip. */
function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Today as `YYYY-MM-DD`, for the default token name below. */
function isoToday(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Rendered by CredentialsSettingsTab to list, create and revoke personal access tokens, and to show the OAuth tokens the OAuth flows issued in a read-only advanced section. */
export default function AccessTokensSection({
  accessTokens,
  oauthTokens,
  showNewTokenForm,
  newTokenName,
  newTokenExpiryDays,
  newTokenScopes,
  onShowNewTokenFormChange,
  onNewTokenNameChange,
  onNewTokenExpiryChange,
  onToggleNewTokenScope,
  onCreateAccessToken,
  onCancelCreateAccessToken,
  onRevokeAccessToken,
}: AccessTokensSectionProps) {
  const { t } = useTranslation('settings');
  // The risk note is derived from the same selection the form submits: shown
  // exactly when at least one write scope is checked, absent otherwise.
  const hasWriteScope = ACCESS_TOKEN_SCOPE_OPTIONS.some(
    (option) => option.writable && newTokenScopes.includes(option.scope),
  );
  // The advanced OAuth section is collapsed by default: it is a troubleshooting
  // surface, not the list a user came for.
  const [showOAuthTokens, setShowOAuthTokens] = useState(false);
  // Within the expanded section, revoked/expired rows are hidden by default so a
  // long token history does not bury the live rows; the user opts in to see them.
  const [showInactiveOAuthTokens, setShowInactiveOAuthTokens] = useState(false);
  // A slowly ticking clock: the relative ages and the expiry filter are derived
  // from it, so they stay honest as time passes without reading `Date.now()` mid-render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleOAuthTokens = oauthTokens.filter((token) =>
    showInactiveOAuthTokens
      || (token.revokedAt === null && new Date(token.expiresAt).getTime() > now));

  /** Opens the create form with a dated default name, unless the user already typed one. */
  const openNewTokenForm = () => {
    if (!newTokenName.trim()) {
      onNewTokenNameChange(t('accessTokens.form.defaultName', { date: isoToday(new Date()) }));
    }
    onShowNewTokenFormChange(true);
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          <h3 className="text-lg font-semibold">{t('accessTokens.title')}</h3>
        </div>
        <Button size="sm" onClick={openNewTokenForm}>
          <Plus className="mr-1 h-4 w-4" />
          {t('accessTokens.newButton')}
        </Button>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('accessTokens.description')}</p>

      {showNewTokenForm && (
        <div className="mb-4 rounded-lg border bg-card p-4">
          <Input
            placeholder={t('accessTokens.form.namePlaceholder')}
            value={newTokenName}
            onChange={(event) => onNewTokenNameChange(event.target.value)}
            className="mb-2"
          />
          <label className="mb-2 block text-sm text-muted-foreground">
            {t('accessTokens.form.expiryLabel')}
            <select
              data-testid="access-token-expiry"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              value={newTokenExpiryDays}
              onChange={(event) => onNewTokenExpiryChange(Number(event.target.value))}
            >
              {EXPIRY_DAY_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  {t('accessTokens.form.expiryOption', { days })}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="mb-3">
            <legend className="mb-1 block text-sm text-muted-foreground">
              {t('accessTokens.form.scopesLabel')}
            </legend>
            <div className="space-y-1">
              {ACCESS_TOKEN_SCOPE_OPTIONS.map((option) => (
                <label key={option.scope} className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    data-testid="access-token-scope"
                    data-scope={option.scope}
                    data-writable={option.writable}
                    className="h-4 w-4 rounded border-input"
                    checked={newTokenScopes.includes(option.scope)}
                    // The read baseline is required: every token carries it, so it cannot be unchecked.
                    disabled={!option.writable}
                    onChange={(event) => onToggleNewTokenScope(option.scope, event.target.checked)}
                  />
                  <span>{t(`accessTokens.scopes.${option.labelKey}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {hasWriteScope && (
            <p data-testid="access-token-scope-risk" className="mb-3 text-sm text-amber-500">
              {t('accessTokens.form.writeScopeRisk')}
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={onCreateAccessToken}>{t('accessTokens.form.createButton')}</Button>
            <Button variant="outline" onClick={onCancelCreateAccessToken}>
              {t('accessTokens.form.cancelButton')}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {accessTokens.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">{t('accessTokens.list.empty')}</p>
        ) : (
          accessTokens.map((token) => {
            const isRevoked = token.revokedAt !== null;
            return (
              <div
                key={token.id}
                data-testid="access-token-row"
                data-token-id={token.id}
                data-token-prefix={token.tokenPrefix}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{token.name || t('accessTokens.list.unnamed')}</div>
                  <code className="text-xs text-muted-foreground">{token.tokenPrefix}</code>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t('accessTokens.list.expires')} {new Date(token.expiresAt).toLocaleDateString()}
                    {` - ${t('accessTokens.list.lastUsed')} `}
                    {token.lastUsed
                      ? <span title={absoluteTime(token.lastUsed)}>{relativeTime(token.lastUsed, now)}</span>
                      : t('accessTokens.list.never')}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {isRevoked ? t('accessTokens.list.revoked') : t('accessTokens.list.active')}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isRevoked}
                    aria-label={t('accessTokens.list.revokeButton')}
                    onClick={() => onRevokeAccessToken(token.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('accessTokens.list.revokeButton')}
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <Collapsible className="mt-6" open={showOAuthTokens} onOpenChange={setShowOAuthTokens}>
        <CollapsibleTrigger
          data-testid="oauth-tokens-toggle"
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground"
        >
          <ChevronRight className={`h-4 w-4 transition-transform ${showOAuthTokens ? 'rotate-90' : ''}`} />
          {t('accessTokens.oauthTokens.title')}
        </CollapsibleTrigger>
        <CollapsibleContent data-testid="oauth-tokens-content">
          <div data-testid="oauth-tokens-panel" className="mt-3">
            <p className="mb-3 text-sm text-muted-foreground">
              {t('accessTokens.oauthTokens.description')}
            </p>
            <label className="mb-3 flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                data-testid="oauth-tokens-show-inactive"
                className="h-4 w-4 rounded border-input"
                checked={showInactiveOAuthTokens}
                onChange={(event) => setShowInactiveOAuthTokens(event.target.checked)}
              />
              <span>{t('accessTokens.oauthTokens.showInactive')}</span>
            </label>
            <div className="space-y-2">
              {visibleOAuthTokens.length === 0 ? (
                <p data-testid="oauth-tokens-empty" className="text-sm italic text-muted-foreground">
                  {t('accessTokens.oauthTokens.empty')}
                </p>
              ) : (
                visibleOAuthTokens.map((token) => {
                  const isRevoked = token.revokedAt !== null;
                  const isExpired = !isRevoked && new Date(token.expiresAt).getTime() <= now;
                  return (
                    <div
                      key={token.id}
                      data-testid="oauth-token-row"
                      data-token-id={token.id}
                      data-kind={token.kind}
                      data-client-name={token.clientName ?? ''}
                      className="flex items-center justify-between rounded-lg border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {token.clientName || t('accessTokens.oauthTokens.unknownClient')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('accessTokens.oauthTokens.kind')}{' '}
                          {token.kind === 'oauth_refresh'
                            ? t('accessTokens.oauthTokens.kindRefresh')
                            : t('accessTokens.oauthTokens.kindAccess')}
                          {' · '}
                          <code>{token.tokenPrefix}</code>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('accessTokens.oauthTokens.scopes')} {token.scopes.join(', ')}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {t('accessTokens.list.created')}{' '}
                          <span title={absoluteTime(token.createdAt ?? token.expiresAt)}>
                            {relativeTime(token.createdAt ?? token.expiresAt, now)}
                          </span>
                          {` - ${t('accessTokens.list.lastUsed')} `}
                          {token.lastUsed
                            ? <span title={absoluteTime(token.lastUsed)}>{relativeTime(token.lastUsed, now)}</span>
                            : t('accessTokens.list.never')}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {isRevoked
                          ? t('accessTokens.list.revoked')
                          : isExpired
                            ? t('accessTokens.list.expired')
                            : t('accessTokens.list.active')}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
