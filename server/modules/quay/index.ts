// quayRoutes: mounted by the server entrypoint behind auth (read-only display endpoints).
// quayService: consumed by the projects module to attach Tier-1 `.quay/config.yml` detection
// to its listing without starting a subprocess. Its `getCachedSnapshot(projectId)` is
// consumed by the MCP gateway's `overview` tool (AC-247): the read-only path that returns a
// TTL-cached snapshot or `null` WITHOUT loading, so `overview` over N projects spawns zero
// `quay` CLI processes. `getQuaySnapshot(projectId, { forceRefresh: true })` remains the
// load-on-demand path the `quay_snapshot` tool's explicit refresh uses.
export { quayRoutes, quayService } from './quay.module.js';
export { isReadOnlyQuayCommand } from './quay.service.js';
export type {
  QuayCommandResult,
  QuayCommandRunner,
  QuayDriverState,
  QuayDriverSummary,
  /** Consumed by the MCP gateway's `quay_snapshot` tool: one task the worker driver reports in flight. */
  QuayInFlightTask,
  QuayProjectStatus,
  QuaySnapshot,
} from './quay.service.js';
