/**
 * The OAuth consent module's public surface.
 *
 * One thing is public: the page the server's `GET /oauth/authorize` hands the
 * browser to. Everything the page is built from — the `useOAuthConsent` state
 * machine, the scope/error key tables — is a module-private implementation
 * detail and stays out of this barrel.
 */

/** Rendered by App's `/oauth/consent` route; the authorization screen the server's 302 lands on. */
export { default as OAuthConsentRoute } from '@/modules/oauth-consent/OAuthConsentRoute';
