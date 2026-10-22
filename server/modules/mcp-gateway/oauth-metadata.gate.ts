/**
 * OAuth discovery-document gate (AC-262, GOAL-021 exit condition 4).
 *
 * Decides whether the two `/.well-known/*` discovery documents are published and
 * what they advertise. The switch that turns OAuth on is read through
 * `readMcpOauthEnabled` (this module never touches that env var itself: AC-242's
 * criterion pins the literal to exactly one reader, and a second read site would
 * red it across files).
 *
 * Three decisions, kept apart because each moves independently:
 *
 *  - **published or not** — off means nothing is mounted (AC-262 leg (d));
 *  - **the base URL** — on REQUIRES an https origin, with `localhost` and
 *    `127.0.0.1` allowed over http for development. A missing, unparseable, or
 *    otherwise non-conforming value is a CONFIGURATION failure that names the
 *    offending variable, so a misconfigured deploy dies at startup instead of
 *    silently advertising a wrong issuer;
 *  - **dynamic client registration** — `registration_endpoint` is advertised
 *    only when the DCR switch is not `off`.
 *
 * Nothing here is cached: the criterion reads several differently-valued env
 * objects in one process, and a process-lifetime cache would collapse them.
 */

import { readMcpOauthEnabled } from './mcp-gateway.loopback.js';

/**
 * The three dynamic-client-registration modes. `off` (the fail-closed default)
 * omits `registration_endpoint` from the advertised metadata; `allowlist` and
 * `open` include it. AC-264 owns the actual registration policy and will reuse
 * this reader rather than define a second one.
 */
export type McpDcrMode = 'off' | 'allowlist' | 'open';

/**
 * The gate's decision. A discriminated union so a disabled reading carries no
 * (meaningless) base URL and the mount path cannot accidentally use one.
 *
 * Consumers: `mountOAuthMetadata` (this module's sibling), `server/index.ts`
 * (via the barrel, to log the decision), and the AC-262 criterion.
 */
export type OAuthMetadataGateReading =
  | { enabled: false; reason: string }
  | { enabled: true; baseUrl: string; resourceUrl: string; dcrMode: McpDcrMode; reason: string };

/**
 * The advertised authorization-server metadata document. Named apart from the
 * SDK's own `OAuthMetadata` because this object is built by hand (endpoint
 * paths are SPEC §150's `/oauth/*`), not by the SDK's `createOAuthMetadata`,
 * which roots the endpoints and ties `registration_endpoint` to a provider.
 *
 * Consumers: `mountOAuthMetadata` (hands it to the SDK metadata router) and the
 * AC-262 criterion (reads it directly for the DCR three-state).
 */
export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  registration_endpoint?: string;
};

/**
 * The error text every invalid-base-URL branch throws. The variable NAME is
 * spelled out because the point of the failure is to tell an operator which
 * setting to fix; `checkIssuerUrl` inside the SDK router enforces the same
 * https/localhost rule but never names the variable, so this gate must throw
 * first.
 */
const BASE_URL_ERROR_PREFIX =
  'PUBLIC_BASE_URL must be an https origin (http://localhost and http://127.0.0.1 are allowed)';

/**
 * Reads the DCR switch. FAIL-CLOSED: unset, empty, or any unrecognised value
 * answers `off`. Consumers: `readOAuthMetadataGate` (below), the AC-262
 * criterion, and later AC-264 through the barrel.
 */
export function readMcpDcrMode(env: NodeJS.ProcessEnv = process.env): McpDcrMode {
  const raw = env.MCP_DCR;
  if (raw === undefined) {
    return 'off';
  }

  const value = raw.trim().toLowerCase();
  if (value === 'allowlist' || value === 'open') {
    return value;
  }

  return 'off';
}

/**
 * Validates and normalises the public base URL, or throws an `Error` whose
 * message names the variable.
 *
 * The accepted shapes are exactly `https://…` and `http://localhost` /
 * `http://127.0.0.1` (any port): the SDK's own issuer check allows the same
 * development exemption, and a bare-http public origin would let discovery hand
 * out a token endpoint a browser would refuse. Trailing slashes are stripped so
 * endpoint paths never double up.
 */
function readPublicBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.PUBLIC_BASE_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${BASE_URL_ERROR_PREFIX}: it is not set`);
  }

  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${BASE_URL_ERROR_PREFIX}: ${trimmed} is not a valid URL`);
  }

  const isHttps = url.protocol === 'https:';
  const isLocalHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (!isHttps && !isLocalHttp) {
    throw new Error(`${BASE_URL_ERROR_PREFIX}: ${trimmed} is not https`);
  }

  return trimmed.replace(/\/+$/, '');
}

/**
 * The gate. When the switch is off the base URL is NOT validated — a disabled
 * server publishes nothing, so an unrelated missing value must not stop it.
 * When it is on, an invalid base URL throws (the caller lets it bubble, so the
 * entrypoint fails to start). Consumers: `mountOAuthMetadata` and the AC-262
 * criterion.
 */
export function readOAuthMetadataGate(env: NodeJS.ProcessEnv = process.env): OAuthMetadataGateReading {
  if (!readMcpOauthEnabled(env)) {
    return { enabled: false, reason: 'MCP OAuth is disabled' };
  }

  const baseUrl = readPublicBaseUrl(env);

  return {
    enabled: true,
    baseUrl,
    resourceUrl: `${baseUrl}/mcp`,
    dcrMode: readMcpDcrMode(env),
    reason: `base URL ${baseUrl}`,
  };
}

/**
 * Builds the authorization-server metadata document from a validated base URL
 * and DCR mode. Pure: same inputs, same object, no env and no URL parsing — so
 * the criterion can pin every advertised field directly.
 *
 * `code_challenge_methods_supported` is EXACTLY `['S256']`: advertising `plain`
 * would let a client downgrade PKCE to a value that offers no protection.
 * Consumers: `mountOAuthMetadata` and the AC-262 criterion.
 */
export function buildAuthorizationServerMetadata(options: {
  baseUrl: string;
  dcrMode: McpDcrMode;
}): AuthorizationServerMetadata {
  const { baseUrl, dcrMode } = options;
  const metadata: AuthorizationServerMetadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  };

  if (dcrMode !== 'off') {
    metadata.registration_endpoint = `${baseUrl}/oauth/register`;
  }

  return metadata;
}
