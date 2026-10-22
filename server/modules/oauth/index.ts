// createAccessTokensService: the OAuth module's public entry point for personal
// access tokens — issuance, verification and revocation. Consumers: this
// module's own criteria, the settings module's /access-tokens routes, and the
// server entrypoint, which builds one instance to back the token-info route.
export { createAccessTokensService } from '@/modules/oauth/access-tokens.service.js';
// ACCESS_TOKEN_SCOPES / normalizeAccessTokenScopes: the single scope vocabulary
// and its deduplicating validator. Consumers: the settings module's
// createAccessToken and this module's scope criterion, both through this barrel.
export {
  ACCESS_TOKEN_SCOPES,
  normalizeAccessTokenScopes,
} from '@/modules/oauth/access-tokens.service.js';
export type {
  AccessTokenRejectionReason,
  AccessTokensService,
  AccessTokensServiceOptions,
  IssueAccessTokenInput,
  IssueAccessTokenResult,
  IssuedAccessToken,
  VerifyAccessTokenResult,
} from '@/modules/oauth/access-tokens.service.js';
// createTokenInfoRouter: used by the server entrypoint to mount
// GET /api/oauth/token-info, and by this module's criterion to mount the
// production route factory on a real express server.
export { createTokenInfoRouter } from '@/modules/oauth/token-info.routes.js';
// createOAuthStore: the OAuth storage layer (clients, grants, authorization
// codes, OAuth access/refresh tokens, revocation cascades, hash-only writes).
// Consumers: this module's oauth-store criterion, and the AC-259+ endpoint
// tasks that build the authorization-code flow on top of it.
export { createOAuthStore } from '@/modules/oauth/oauth-store.service.js';
export type {
  CreateGrantInput,
  CreateGrantResult,
  DisableClientResult,
  IssueAuthorizationCodeInput,
  IssueAuthorizationCodeResult,
  IssueOAuthTokenInput,
  IssueOAuthTokenResult,
  OAuthStore,
  OAuthStoreOptions,
  OAuthTokenKind,
  OAuthTokenRejectionReason,
  RegisterClientInput,
  RegisterClientResult,
  RevokeGrantResult,
  VerifyOAuthTokenResult,
} from '@/modules/oauth/oauth-store.service.js';
// createOAuthConsentRouter / createOAuthAuthorizeApiRouter /
// createOAuthConsentDocumentHeadersMiddleware: the SPA consent transport
// (gap-oauth-consent-spa-backend-contract) — the validating `GET /oauth/authorize`
// that 302s to the SPA route, the JWT-authenticated JSON API the SPA drives
// (`/context`, `/decision`), and the route-level middleware carrying the
// anti-framing / no-store headers onto the SPA document. Consumers: this module's
// `oauth-server.mount.ts` and the server entrypoint, both through this barrel,
// plus this module's oauth-consent-page criterion and the OAuth flow e2e.
export {
  createOAuthAuthorizeApiRouter,
  createOAuthConsentDocumentHeadersMiddleware,
  createOAuthConsentRouter,
} from '@/modules/oauth/oauth-consent.routes.js';
export type {
  OAuthAuthorizeApiOptions,
  OAuthConsentRouterOptions,
} from '@/modules/oauth/oauth-consent.routes.js';
// createOAuthProvider: the OAuth authorization-server SEMANTICS (PKCE S256,
// single-use 60-second codes with replay revocation, refresh rotation/reuse
// revocation, audience binding, exact redirect-uri matching, confidential-client
// secrets, configurable lifetimes). Consumers: this module's
// oauth-provider criterion, and the later endpoint tasks (AC-262+) that expose
// the authorization-server HTTP surface on top of it.
export { createOAuthProvider } from '@/modules/oauth/oauth-provider.service.js';
export type {
  AuthorizeInput,
  AuthorizeResult,
  ExchangeAuthorizationCodeInput,
  ExchangeRefreshTokenInput,
  ExchangeResult,
  OAuthErrorCode,
  OAuthProvider,
  OAuthProviderOptions,
  OAuthTokenPair,
  VerifyAccessTokenReason,
  VerifyOAuthAccessTokenResult,
} from '@/modules/oauth/oauth-provider.service.js';
// readMcpAllowedRedirectHosts / validateRedirectUris: the DCR policy (AC-264) —
// the allowlist reader and the pure redirect-uri validator. Consumers: the server
// entrypoint (reads the allowlist and injects it into the register mount) and this
// module's oauth-dcr criterion (which pins the policy branches directly).
export { readMcpAllowedRedirectHosts, validateRedirectUris } from '@/modules/oauth/oauth-dcr.policy.js';
export type {
  OAuthDcrMode,
  RedirectUriErrorCode,
  RedirectUriValidation,
  RedirectUriValidationInput,
} from '@/modules/oauth/oauth-dcr.policy.js';
// createOAuthRegisteredClientsStore / createOAuthClientsService: the DCR store
// adapter and the manual-client service (AC-264). Consumers: this module's
// oauth-clients routes and its oauth-dcr criterion.
export {
  createOAuthClientsService,
  createOAuthRegisteredClientsStore,
} from '@/modules/oauth/oauth-clients.service.js';
export type {
  CreateManualClientInput,
  CreateManualClientResult,
  OAuthClientsService,
  OAuthRegisteredClientsStoreDeps,
} from '@/modules/oauth/oauth-clients.service.js';
// mountOAuthRegister / createOAuthClientsRouter: the SDK registration mount
// (gated by MCP_DCR) and the manual-client route factory (AC-264). Consumers: the
// server entrypoint (mounts both) and this module's oauth-dcr criterion.
export { createOAuthClientsRouter, mountOAuthRegister } from '@/modules/oauth/oauth-clients.routes.js';
export type { MountOAuthRegisterDeps, OAuthRegisterMountReading } from '@/modules/oauth/oauth-clients.routes.js';
// createOAuthSettingsService: the settings-page read/revoke/disable surface over
// the OAuth store (AC-265) — the caller's own grants, a 404 for a foreign grant,
// and the client list/disable. Consumers: the server entrypoint (which builds one
// instance for the router) and this module's oauth-settings criterion.
export { createOAuthSettingsService } from '@/modules/oauth/oauth-settings.service.js';
export type {
  OAuthClientSummary,
  OAuthGrantSummary,
  OAuthSettingsService,
} from '@/modules/oauth/oauth-settings.service.js';
// createOAuthSettingsRouter: the thin router factory mounting
// /api/settings/oauth-grants and /api/settings/oauth-clients (AC-265). Consumers:
// the server entrypoint (mounts it behind authenticateToken) and this module's
// oauth-settings criterion.
export { createOAuthSettingsRouter } from '@/modules/oauth/oauth-settings.routes.js';
// mountOAuthServer: the production mount of the authorization-server HTTP surface
// (AC-268; SPA consent, gap-oauth-consent-spa-backend-contract) — /oauth/authorize
// (the validating redirect router), the JWT-guarded /api/oauth/authorize JSON API,
// /oauth/token and /oauth/revoke. Consumers: the server entrypoint (mounts it,
// before the static layer, sharing the ONE provider that also backs /mcp's
// verification seam, and injects authenticateToken) and this module's
// end-to-end oauth-flow criterion.
export { mountOAuthServer } from '@/modules/oauth/oauth-server.mount.js';
export type { MountOAuthServerDeps, OAuthServerMountReading } from '@/modules/oauth/oauth-server.mount.js';

// createOAuthRequestLogger: used by the server entrypoint, which mounts it ahead of the
// OAuth and MCP routers so every request to them leaves one secret-free log line.
export { createOAuthRequestLogger } from '@/modules/oauth/oauth-request-log.service.js';
