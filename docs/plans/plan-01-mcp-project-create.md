# Plan 01: MCP project creation

## Overview
Apply the approved proposal to v1.39.0 without modifying the live installation. Source canonical is read-only; code lives in this Item worktree; dependencies, caches, SQLite fixtures and build outputs live under RUN-0048 artifacts.

## Phases

### Phase 1 — Red acceptance tests
Objectives: prove failures before implementation. Add `server/modules/mcp-gateway/tests/mcp-project-create.test.ts` with a real loopback express MCP mount, actual authentication service, SDK initialize/tool discovery and temporary SQLite. Configure DATABASE_PATH/TMPDIR/WORKSPACES_ROOT in the launching process; do not replace HOME. Tests cover absent bearer HTTP 401, missing create scope refusal before side effects, unknown/configured root, actual project identity in DB, duplicate active path error, archived reuse result, traversal/equal-root, deep ancestor symlink escaping and in-root symlink refusal. Use isolated fixture paths; no model calls.
Acceptance: new test is red because project_create is absent. Capture exact command/exit under evidence root.
Dependencies: install exact lockfile dependencies in artifacts with lifecycle scripts off, rebuild only isolated better-sqlite3 if necessary or reuse compatible existing native binding bytes read-only. Link worktree node_modules to artifact target, no dependency product under workspace.

### Phase 2 — Implement service and MCP registration
Objectives: add dedicated rooted entry to existing project-management service; preserve createProject default behavior and reuse its persistence. Add MCP schema/handler and optional deps, annotation/error metadata, production index wiring. Explicit output schema covers real service projection. Convert recognized AppError only, preserve existing error vocabulary for other errors.
Acceptance: Phase 1 tests green; no files under Fleet Python/runtime changed; no new DB/shell/UI JWT code. Mandatory gateway scope remains enforced through audit seam.
Dependencies: Phase 1 red evidence and completed two-round proposal/plan gates.

### Phase 3 — Validate and deliver
Objectives: run narrow new and existing project/service/MCP discovery/annotation/error/production-wiring tests with bounded concurrency and memory. Run server TypeScript noEmit/build to artifact outDir (do not run npm prebuild/postbuild scripts that stage into workspace), scoped lint. Run broader project build/typecheck/lint if environment permits; record concrete limitations.
Acceptance: changed tests, relevant regressions and server build pass. Source diff contains no credentials, test state or generated output. Commit exact files; attempt Draft PR when authorized Git access exists, otherwise deliver git-format-patch with baseline-pinned apply/check/rollback scripts that do not touch a live installation. Record revision, hashes and test exits in RUN-0048. No deploy/restart.
Dependencies: Phase 2 acceptance.

## Fresh-directory amendment
Before implementing the strict branch, add red real-MCP tests for existing unregistered directory, archived row, registered row with missing directory, concurrent same-name calls, a directory created between preflight and final exclusive mkdir, and a DB archived row inserted between directory creation and persistence. Verify no refusal registers a new row or reactivates the archived row. Implement final-component exclusive mkdir in the existing rooted service, atomic no-reuse branch in the existing projects repository, optional requireFresh input and mandatory freshDirectoryCreated boolean result. Keep default tests intact. Repeat affected tests, typecheck/build and lint; update mocks in the existing tool registry coverage fixtures only to cover the new advertised field.
