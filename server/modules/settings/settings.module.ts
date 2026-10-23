import {
  accessTokensDb,
  credentialsDb,
  mcpAuditLogDb,
  notificationPreferencesDb,
  oauthClientsDb,
  oauthGrantsDb,
  pushSubscriptionsDb,
} from '@/modules/database/index.js';
import {
  createMcpAuditReader,
  MCP_GATEWAY_PATH,
  readMcpGatewayGate,
} from '@/modules/mcp-gateway/index.js';
import {
  createNotificationEvent,
  getPublicKey,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import { createAccessTokensService } from '@/modules/oauth/index.js';

import { createSettingsRouter } from './settings.routes.js';
import { createSettingsService } from './settings.service.js';

const accessTokensService = createAccessTokensService({ now: () => new Date() });

/**
 * The display name of the grant a token was issued under — the OAuth client's
 * name, or null when the row has no grant or its client has been removed. Used
 * only by the advanced OAuth-token list below, whose rows would otherwise render
 * the NULL `name` the OAuth store writes as a blank.
 */
function resolveGrantClientName(grantId: number | null): string | null {
  if (grantId === null) {
    return null;
  }
  const grant = oauthGrantsDb.findById(grantId);
  if (grant === undefined) {
    return null;
  }
  return oauthClientsDb.findById(grant.client_id)?.client_name ?? null;
}

const settingsService = createSettingsService({
  credentials: {
    list: (userId, type) => credentialsDb.getCredentials(userId, type),
    create: (userId, name, type, value, description) =>
      credentialsDb.createCredential(userId, name, type, value, description),
    remove: (userId, credentialId) => credentialsDb.deleteCredential(userId, credentialId),
    toggle: (userId, credentialId, isActive) =>
      credentialsDb.toggleCredential(userId, credentialId, isActive),
  },
  notifications: {
    getPreferences: (userId) => notificationPreferencesDb.getPreferences(userId),
    updatePreferences: (userId, preferences) =>
      notificationPreferencesDb.updatePreferences(userId, preferences),
    createEnabledEvent: () => createNotificationEvent({
      provider: 'system', kind: 'info', code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' }, severity: 'info',
    }),
    notifyUser: (userId, event) => notifyUserIfEnabled({ userId, event }),
  },
  pushSubscriptions: {
    save: (userId, endpoint, p256dh, auth) =>
      pushSubscriptionsDb.saveSubscription(userId, endpoint, p256dh, auth),
    remove: (endpoint) => pushSubscriptionsDb.removeSubscription(endpoint),
  },
  getVapidPublicKey: getPublicKey,
  // The gate is read through the mcp-gateway module's own reader and the path
  // comes from that module too, so settings never re-parses `MCP_ENABLED` and
  // the reported path cannot drift from the one the transport mounts at.
  mcpGateway: {
    readGate: () => readMcpGatewayGate(),
    path: MCP_GATEWAY_PATH,
    publicBaseUrl: () => process.env.PUBLIC_BASE_URL?.trim() || null,
  },
  accessTokens: {
    list: (userId, kind) => accessTokensDb.listByUser(userId, kind),
    findById: (tokenId) => accessTokensDb.findById(tokenId),
    issue: (input) => accessTokensService.issueToken(input),
    revoke: (tokenId) => accessTokensService.revokeToken(tokenId),
  },
  // The advanced read-only OAuth-token list: every non-PAT row for the user, each
  // joined to the client name of the grant that issued it. The rows are returned
  // in the token row's own storage shape (including `token_hash`), so the
  // service's projection is the single place that decides what leaves the wire.
  oauthTokens: {
    list: (userId) =>
      accessTokensDb
        .listByUser(userId)
        .filter((row) => row.kind !== 'pat')
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          token_hash: row.token_hash,
          token_prefix: row.token_prefix,
          scopes: row.scopes,
          expires_at: row.expires_at,
          created_at: row.created_at,
          last_used: row.last_used,
          revoked_at: row.revoked_at,
          client_name: resolveGrantClientName(row.grant_id),
        })),
  },
  // The MCP-audit readback (AC-304): the reader owns ownership + the write-only
  // default; these are the production seams it reads. A user's rows are the rows
  // of that user's token ids (the audit table has no user_id column), and a row's
  // client name comes from the OAuth client when it has one, else the PAT's own
  // name (a PAT has a null `client_id`).
  mcpAudit: createMcpAuditReader({
    listTokenIdsForUser: (userId) => accessTokensDb.listByUser(userId).map((token) => token.id),
    listRowsForTokens: (tokenIds, limit, excludeTools) =>
      mcpAuditLogDb.listForTokens(tokenIds, { limit, excludeTools }),
    resolveClientName: (row) =>
      row.client_id !== null
        ? (oauthClientsDb.findById(row.client_id)?.client_name ?? 'mcp client')
        : row.token_id !== null
          ? (accessTokensDb.findById(row.token_id)?.name ?? 'personal access token')
          : null,
  }),
});

/** Settings router assembled for the authenticated server mount. */
export const settingsRoutes = createSettingsRouter(settingsService);
