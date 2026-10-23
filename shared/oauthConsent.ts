/**
 * The one route name the two halves of the OAuth consent hand-off agree on.
 *
 * The server's authorization endpoint (`GET /oauth/authorize`) validates a
 * request and then answers `302` to this client-side route; the consent SPA
 * renders there and drives the decision API. It lives in the repository-root
 * `shared/` tree because BOTH compiler configurations compile that tree
 * (ADR-004 decision 2): the backend reaches it as `../../../shared/oauthConsent.js`
 * and the frontend as `@shared/oauthConsent`.
 *
 * Consumers: `server/modules/oauth/oauth-consent.routes.ts` (the redirect target,
 * and the path its document-header middleware is mounted at by `server/index.ts`)
 * and the consent SPA route in `src/` (`gap-oauth-consent-spa-ui`).
 */
export const OAUTH_CONSENT_SPA_PATH = '/oauth/consent';
