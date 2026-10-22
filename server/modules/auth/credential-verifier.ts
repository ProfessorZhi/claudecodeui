/**
 * Credential-verification narrow port (mcp-gateway-SPEC stage 5, AC-260).
 *
 * The OAuth consent page must authenticate the browser user with their local
 * username and password before it will issue an authorization code. It has no
 * business knowing about sessions, JWTs or `AppError`s: all it needs is a
 * boolean-shaped answer. This factory wraps the auth service's `login` — the
 * existing, tested credential check — and collapses every failure mode
 * (wrong password, unknown user, malformed input) into `{ ok: false }`, so a
 * thrown `AUTH_INVALID_CREDENTIALS` can never leak out of the route as a 500.
 *
 * Consumers: the OAuth module's `oauth-consent.routes.ts` (wired at the AC-262
 * mount) and this module's `tests/oauth-consent-page.test.ts` contract leg,
 * both through the auth module barrel.
 */

/** Outcome of a credential check: the resolved numeric user id, or a single opaque failure. */
export type CredentialVerificationResult = { ok: true; userId: number } | { ok: false };

/**
 * The narrow port the consent page depends on. Deliberately not `AuthService`:
 * only `verifyCredentials` is part of the contract, so a caller can inject the
 * real verifier, a fake, or a wrapper without pulling in the auth service's
 * session surface.
 */
export type CredentialVerifier = (
  username: string,
  password: string
) => Promise<CredentialVerificationResult>;

/**
 * The only slice of the auth service this port consumes: `login`, whose success
 * carries the user row and whose failure is a throw. Typed structurally so the
 * factory does not bind to the concrete service class.
 */
export type CredentialVerifierAuthService = {
  login(username: unknown, password: unknown): Promise<{ user: { id: number | bigint } }>;
};

/**
 * Wraps `authService.login` as a non-throwing credential check. A resolved login
 * becomes `{ ok: true, userId }` (the store keys users by `number`, while sqlite
 * may hand back a `bigint`, so the id is normalized); a thrown error — the
 * expected `AUTH_INVALID_CREDENTIALS` path — becomes `{ ok: false }`.
 */
export function createCredentialVerifier(
  authService: CredentialVerifierAuthService
): CredentialVerifier {
  return async (username: string, password: string): Promise<CredentialVerificationResult> => {
    try {
      const result = await authService.login(username, password);
      return { ok: true, userId: Number(result.user.id) };
    } catch {
      // Authentication failures are the normal path here, not an exception: the
      // consent page renders a 401 error page, so nothing may propagate.
      return { ok: false };
    }
  };
}
