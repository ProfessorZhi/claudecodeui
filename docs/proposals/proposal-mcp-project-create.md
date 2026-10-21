# MCP project creation

## Problem Statement
CloudCLI v1.39.0 (300e5fa93a269661132a4992f707e1197d608844) exposes project creation only through JWT REST while Fleet uses PAT/OAuth MCP. The commander cannot create a project through its existing transport.

## Goals
Expose `project_create` through the existing audited/authenticated MCP transport. Accept `projectPath` and optional `customName`; return real `projectId`, canonical `path`, `displayName`, `isArchived`, and service `outcome`. Reuse `cloudcli:session:create` from the actual `ACCESS_TOKEN_SCOPES` vocabulary. Require an explicitly configured absolute `WORKSPACES_ROOT`, reject traversal outside it and all symlinks below it including deep missing descendants, and use the existing projects repository.

## Non-Goals
No model invocation, shell operation, new persistence store, UI credential reuse, production deployment, global REST validation change, or Fleet Python edits. No idempotent success promise: repeated active paths remain `PROJECT_ALREADY_EXISTS`; archived reuse retains its original projectId, returns existing `reactivated_archived` outcome and actual database isArchived=false after reactivation. Host-side approval policies are owned by the client.

## Design
`server/modules/projects/services/project-management.service.ts` already exports `createProject`, using `validateWorkspacePath`, mkdir and `projectsDb.createProjectPath`. Add `createProjectWithinWorkspaceRoot` in this same service and export through `server/modules/projects/index.ts`. The new entry takes configured root separately from caller input, resolves root, rejects equal-root/outside/relative paths, walks existing descendants with lstat (including a symlink followed by multiple missing segments), and uses nonrecursive mkdir plus revalidation before persistence. It calls the existing createProject with overridden validation/directory dependencies, preserving its database and conflict behavior. The existing REST createProject default path is unchanged. Root symlinks supplied by the device owner may resolve to their real root; caller symlinks below root are rejected. The check does not claim race-proof sandboxing against an already privileged local actor swapping directories during a call.

Add `server/modules/mcp-gateway/mcp-project-create.ts` (new) with the schema and registration, add optional `projectCreate` deps to `mcp-gateway.write-tools.ts`, register alongside the historically pinned five session-write tools, and wire the production root to `createProjectWithinWorkspaceRoot(input, process.env.WORKSPACES_ROOT)` in `server/index.ts`. The caller cannot pass or override root. Absent service deps return named MCP_TOOL_NOT_IMPLEMENTED; configured root absence returns a named service refusal. Include the tool in annotations (write, non-destructive, non-idempotent, closed world) and declared error metadata. AppError service codes/details must be converted to McpToolError so duplicate/invalid paths survive the existing envelope rather than INTERNAL_ERROR. Audit, PAT/OAuth, scope enforcement and write notifications remain on existing seams.

## Alternatives
REST/UI JWT reuse violates the existing authentication split. A separate project database or shell mkdir duplicates ownership. Widening shared validateWorkspacePath would alter unrelated REST/worktree behavior. Adding to the historic stage-4 table breaks its exact-name contract.

## Open Questions
None for implementation. The deployment operator must configure WORKSPACES_ROOT per node. Fleet owns mapping a friendly project slug to that configured root and grants.

## Fresh-directory amendment
Fleet requires optional `requireFresh` (default false) in the native schema and always sends true for friendly project creation. In strict mode the local service refuses any existing final directory or registered project (including archived/missing-directory rows). It creates the final component with exclusive nonrecursive mkdir and returns `freshDirectoryCreated:true` only after both that succeeds and a genuinely new DB identity is persisted. Default mode preserves existing-directory and archive behavior and returns false for this proof flag. Existing parents are still validated at the target node. The existing `projectsDb.createProjectPath` receives an optional requireFresh flag that selects INSERT ON CONFLICT DO NOTHING, avoiding a cross-process archived-row race; no new store is introduced. A failed persistence after an exclusive mkdir may leave the newly created directory for reconciliation; it must never be silently deleted or reported as an accepted project.
