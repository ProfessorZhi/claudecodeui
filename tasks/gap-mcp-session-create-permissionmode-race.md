---
id: gap-mcp-session-create-permissionmode-race
title: "MCP session_create: accept optional permissionMode, apply before first
  run starts"
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: proposal
---
## Proposal

Current `session_create` MCP tool (server/modules/mcp-gateway/mcp-session-lifecycle.ts) accepts project/message/provider/model/lifecycleMode but NOT permissionMode. permissionMode can only be set after creation via `session_reconfigure` (server/modules/mcp-gateway/mcp-session-reconfigure.ts). When `session_create` is called WITH an initial `message`, the first run starts immediately: `buildSessionCreate` (mcp-session-lifecycle.ts:225-259) calls `deps.control.send(caller, { sessionId, content: message })` with NO `options` object at all (mcp-session-lifecycle.ts:248-258) — unlike `session_send` (mcp-session-send.ts:293-298) which does build and pass `options`. For the default `lifecycleMode` ('per-run'), the per-turn child process reads `options.permissionMode` once at spawn time via `mapCliOptionsToSDK` (server/modules/providers/list/claude/claude-runtime.provider.ts:471-530); since session_create's send never includes `options`, the very first run spawns under the SDK/CLI's default permission mode. The `canUseTool` callback installed at spawn (claude-runtime.provider.ts:1653-1709) then surfaces an unattended "Permission required" pause on the first Bash/tool call — before any `session_reconfigure` call issued by the client can possibly land, because there is no way for the client to win that race (the session row / run already exists and the first tool call can fire before the reconfigure request round-trips). `session_reconfigure`'s existing validate-then-write pattern (mcp-session-reconfigure.ts:198-284: capability check against `providerCapabilitiesService.getProviderCapabilities(provider)?.permissionModes` BEFORE any write, lines 217-226) is the precedent to mirror for session_create's own validation.

Dedup note: this workspace already has an exhaustive MCP-gateway AC series (GOAL-020/GOAL-022; e.g. `gap-ac250-session-create-interrupt-lifecycle` for session_create/session_interrupt, `gap-ac272-mcp-session-reconfigure` for session_reconfigure's model/effort/permissionMode semantics, `gap-ac278-mcp-production-session-wiring` for the `mcp-session-write-deps.ts` production wiring). None of them covers session_create accepting permissionMode at creation time or closing this specific first-run race — `gap-ac250-...`'s landed implementation confirms the current `session_create` input shape has no `permissionMode` field, and `gap-ac272-...` only adds reconfigure-after-the-fact semantics, which is the very race this task exists to close. This task is net-new, not a duplicate.

EXPLICITLY OUT OF SCOPE for this task — do not file, touch, or fold in any of the following (tracked as a separate, deliberately untouched concern per the task author's instruction):
- Any change to resident-lifecycle permission handling, `RESIDENT_PERMISSION_MODE`/`buildResidentSdkOptions`'s unconditional override (server/modules/providers/list/claude/claude-host-driver.provider.ts), or any resident-vs-per-run default-permission-mode asymmetry. That is a distinct, already-identified issue that must NOT be investigated or modified as part of this task.

## AC

- [x] AC1: `SESSION_CREATE_INPUT_SCHEMA` / `McpSessionCreateInput` / `readSessionCreateInput` in mcp-session-lifecycle.ts accept an optional `permissionMode: string` field. A regression test proves that omitting it leaves `control.send`'s call shape and DB writes byte-identical to pre-change behavior (zero behavior change for existing callers).
- [x] AC2: When `permissionMode` is supplied and is unsupported for the resolved provider's capabilities (same check `session_reconfigure` already performs via `providerCapabilitiesService`), `session_create` refuses BEFORE creating any session row — a test asserts `sessions.create` is never called and no DB write occurs (no partial/orphaned session).
- [x] AC3: When `permissionMode` is supplied and valid, it is persisted onto the session row immediately after creation (via the same mechanism `provider-models.service.ts`'s `setSessionPermissionMode` uses) — verifiable by reading the session back even when no initial `message` was given (no run started at all).
- [x] AC4: When both `message` and a valid `permissionMode` are supplied (the default per-run lifecycle case — the scenario in the bug report), the `control.send` call issued by `session_create` carries `options.permissionMode` equal to the requested value, so the FIRST spawned child process's SDK options (via `mapCliOptionsToSDK`) already have the mode applied — no subsequent `session_reconfigure` call is required for the first run to honor it. A test must assert this end-to-end against a real/temp DB and dispatch path, showing the first run does NOT hit an unattended "Permission required" pause when `permissionMode` is supplied, with a negative-control test proving the same harness DOES observe the pause when `permissionMode` is omitted (so the positive assertion isn't vacuous).
- [x] AC5: Backward-compat regression: existing session_create tests plus `mcp-production-session-wiring.test.ts` (AC-278, the AST-scanning + real-DB production wiring check in server/index.ts) stay green after adding the new `capabilities`/`models` deps to `buildSessionCreateDeps` (server/modules/mcp-gateway/mcp-session-write-deps.ts) and to the composition root call in server/index.ts (~625-642).

## DoD

All ACs above pass under the project's scoped test runner (per docs/operations/process-isolation-and-memory-caps.md rules — never a full/unbounded fan-out from inside a session). Resident-lifecycle permission override behavior must be verified UNCHANGED (not modified, not newly tested) by this task — out of scope per above.

## Touches

- server/modules/mcp-gateway/mcp-session-lifecycle.ts
- server/modules/mcp-gateway/mcp-session-write-deps.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts (updated criterion test for this AC)
- tasks/gap-mcp-session-create-permissionmode-race.md
