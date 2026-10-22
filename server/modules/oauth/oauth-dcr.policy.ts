/**
 * Dynamic client registration (DCR) policy (AC-264, GOAL-021 exit condition 5).
 *
 * Decides whether a client may register and which redirect URIs it may declare.
 * Two independent switches feed the decision — the `MCP_DCR` mode (read once by
 * AC-262's `readMcpDcrMode`, injected here rather than read a second time, so the
 * env var keeps its single production reader) and the `MCP_ALLOWED_REDIRECT_HOSTS`
 * allowlist — but every rule this file applies is a pure function of its
 * arguments, so the criterion can pin each branch without an env object.
 *
 * Nothing here is cached: the criterion reads several differently-valued env
 * objects in one process, and a process-lifetime cache would collapse them.
 *
 * The `dcrMode` union is declared locally, not imported from the mcp-gateway
 * module, even though `McpDcrMode` there is structurally identical: the gateway
 * already depends on this module (`createMcpAuthMiddleware` narrows to the OAuth
 * `AccessTokensService`), so importing it back would close a barrel cycle. The
 * composition root reads `readMcpDcrMode()` and injects its result, which this
 * union accepts structurally.
 */

/**
 * The three DCR modes. `off` refuses every registration (and `server/index.ts`
 * mounts no registration endpoint at all); `allowlist` additionally requires
 * every redirect host to be named in `MCP_ALLOWED_REDIRECT_HOSTS`; `open`
 * applies only the scheme-safety rule below.
 *
 * Structurally identical to the mcp-gateway's `McpDcrMode`; kept separate here
 * to avoid a barrel cycle (see the file header). Consumers: the clients service,
 * the register mount, and this module's DCR criterion.
 */
export type OAuthDcrMode = 'off' | 'allowlist' | 'open';

/** The RFC 7591 error code every redirect-uri rejection carries. */
export type RedirectUriErrorCode = 'invalid_redirect_uri';

/**
 * Result of {@link validateRedirectUris}. On rejection the `reason` names the
 * offending URI and why it failed, so a caller (and the criterion) can record
 * exactly which URI was refused.
 */
export type RedirectUriValidation =
  | { ok: true }
  | { ok: false; error: RedirectUriErrorCode; reason: string };

/** Arguments to {@link validateRedirectUris}; the mode and allowlist are injected. */
export type RedirectUriValidationInput = {
  dcrMode: OAuthDcrMode;
  allowedHosts: string[];
  redirectUris: string[];
};

/**
 * Reads the redirect-host allowlist. `MCP_ALLOWED_REDIRECT_HOSTS` is a
 * comma-separated list; each entry is trimmed, lowercased, emptied-filtered and
 * deduplicated. Unset or empty answers `[]` (so an `allowlist` deployment with no
 * configured hosts refuses everything, which is the fail-closed reading).
 *
 * Consumers: `server/index.ts` (injects the result into the register mount) and
 * this module's DCR criterion.
 */
export function readMcpAllowedRedirectHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MCP_ALLOWED_REDIRECT_HOSTS;
  if (raw === undefined) {
    return [];
  }

  const hosts = new Set<string>();
  for (const entry of raw.split(',')) {
    const host = entry.trim().toLowerCase();
    if (host !== '') {
      hosts.add(host);
    }
  }
  return [...hosts];
}

/**
 * Validates the redirect URIs a registration declares. Pure: no env, no cache.
 *
 * The rules, in order:
 *  1. every URI must parse as an absolute URL;
 *  2. scheme safety, for EVERY mode — `https:`, or `http:` whose hostname is
 *     exactly `localhost` or `127.0.0.1` (a bare-http public callback would let a
 *     token leak over the wire);
 *  3. in `allowlist` mode, EVERY URI's hostname (lowercased) must be in
 *     `allowedHosts` — not merely the first one;
 *  4. `off` refuses outright (fail-closed; the endpoint is not mounted anyway).
 *
 * Consumers: the registered-clients store and the manual-client service (both in
 * `oauth-clients.service.ts`), and this module's DCR criterion.
 */
export function validateRedirectUris(input: RedirectUriValidationInput): RedirectUriValidation {
  const { dcrMode, allowedHosts, redirectUris } = input;

  if (redirectUris.length === 0) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      reason: 'at least one redirect_uri is required',
    };
  }

  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        reason: `${uri} is not an absolute URL`,
      };
    }

    const isLocalHttp =
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    if (parsed.protocol !== 'https:' && !isLocalHttp) {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        reason: `${uri} must use https, or http on localhost or 127.0.0.1`,
      };
    }

    if (dcrMode === 'allowlist' && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        reason: `${uri} host ${parsed.hostname} is not in MCP_ALLOWED_REDIRECT_HOSTS`,
      };
    }
  }

  if (dcrMode === 'off') {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      reason: 'dynamic client registration is off',
    };
  }

  return { ok: true };
}
