/**
 * OAuth discovery-document mounting (AC-262).
 *
 * Serves the two `/.well-known/*` documents MCP clients use to discover this
 * server's authorization server:
 *
 *  - `/.well-known/oauth-authorization-server` (RFC 8414) — the AS metadata;
 *  - `/.well-known/oauth-protected-resource/mcp` (RFC 9728) — the protected
 *    resource metadata, pointing back at the AS issuer.
 *
 * The SDK's `mcpAuthMetadataRouter` installs both as `res.json` handlers (so the
 * content type is `application/json`) and derives the PRM path from the resource
 * server URL's pathname — passing `<baseUrl>/mcp` is what puts the document at
 * `/.well-known/oauth-protected-resource/mcp`.
 *
 * Mount ORDER is load-bearing, exactly as `/mcp` is: behind the static-assets
 * middleware the SPA catch-all answers both paths with `200 text/html`, so the
 * criterion reads them as JSON against the real static layer behind this mount.
 *
 * A gate that throws is NOT caught here: an invalid base URL is a startup
 * configuration failure, and the entrypoint's top-level call must abort the
 * process rather than serve half-configured discovery documents.
 */

import type { Express } from 'express';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';

import { buildAuthorizationServerMetadata, readOAuthMetadataGate } from './oauth-metadata.gate.js';

/**
 * Whether anything was attached, and the gate's reason. Consumers: the AC-262
 * criterion and `server/index.ts`, which logs it.
 */
export type OAuthMetadataMountReading = {
  mounted: boolean;
  reason: string;
};

/**
 * Mounts the two discovery documents onto `app`, or attaches nothing at all.
 *
 * `deps.env` is injectable so the criterion can read several switch states in
 * one process (the gate is deliberately uncached). When the gate is closed the
 * mount is SKIPPED — no layer is added — so the paths fall through to whatever
 * is mounted behind this call (the static layer, or Express's own 404).
 */
export function mountOAuthMetadata(app: Express, deps: { env?: NodeJS.ProcessEnv } = {}): OAuthMetadataMountReading {
  const gate = readOAuthMetadataGate(deps.env);
  if (!gate.enabled) {
    return { mounted: false, reason: gate.reason };
  }

  const router = mcpAuthMetadataRouter({
    oauthMetadata: buildAuthorizationServerMetadata({ baseUrl: gate.baseUrl, dcrMode: gate.dcrMode }),
    resourceServerUrl: new URL(gate.resourceUrl),
  });
  app.use(router);

  return { mounted: true, reason: gate.reason };
}
