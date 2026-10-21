# Plan 02: durable provider Run readback

## Overview
Branch from 639ded6, preserving project creation. All fixtures, databases, dependency/build products and logs use RUN-0050/cloudcli-run-readback-20261022. Do not finalize an artifact directory containing historical finalize evidence.

## Phases

### Phase 1: Red evidence
Add tests for exact-run terminal text despite newer session history, immediate completed read, failed/aborted states, unknown IDs and session mismatch, original terminal state after five-minute memory eviction, real SQLite cross-process terminal reconstruction and unfinished-old-boot UNKNOWN, immutable receipt identity and no transcript body storage. Add concurrent writer-scoped queue UUID probes, exact-run eviction and standard handlerBound true/false discovery. Tests use real SQLite and local provider history parsers, loopback MCP and fixture runtime frames; no model calls.
Acceptance: capture actual red failures before implementation. Review schema/API against actual source.

### Phase 2: Existing owner persistence and queue mapping
Implement the receipt schema/repository/migration in the existing database, registry write/readback/critical updates and strict pre-effect registration persistence, per-run eviction and finalization, writer-scoped queued UUID selection across existing gateway/provider seams. Reuse getConnection and native history interfaces.
Acceptance: receipt identity/terminal monotonicity/queue mapping and cross-process tests pass; no full message body stored and no alternate scheduler/database. If post-effect SQLite writing fails, actual terminal stays readable in memory with explicit degraded durability.

### Phase 3: MCP readback and discovery
Implement typed readback/unknown reasons and exact result reference reading, mismatch refusal and no latest-answer attribution. Preserve explicit old bounded wait compatibility but add no polling paths. Add optional handlerBound registration metadata and mark all existing placeholder branches false/real overrides true.
Acceptance: real MCP read-only scope and initialization/list/call paths pass; result and metadata report exact proof scope. Unknown/restarted never encourages replay.

### Phase 4: Validation and reviewable delivery
Run bounded relevant tests (new receipt/registry/control/provider gateway/MCP and previous project regressions), server noEmit/build and changed-file lint. Use actual separate processes with the same SQLite/history files to verify terminal readback; do not use a fake clock flip as restart proof. Compile exact revision and run loopback MCP SDK probe. Commit explicit files, provide base-pinned format-patch plus guarded apply/rollback package and hashes, retain worktrees and evidence; no deployment or model calls.
Acceptance: all scoped tests and build pass, parent independent review can inspect exact SHA and limitations. No existing finalize evidence overwritten.

## Bounded final-result amendment
Add actual Codex parser tests showing live itemId is not a stable history id, and a real cross-process Codex writer snapshot readback after a later SDK assistant under the same reused item_0. Add 64KiB UTF-8 boundary/full-prefix hash checks, no older transcript text storage, immutable terminal snapshot and failed/aborted partial-result probes. Implement bounded snapshot only on the sole owner's first actual terminal event, return explicit terminal_result_snapshot attribution and metadata, and preserve native-reference precedence. No raw result/database/token enters source packages.

## MCP queue receipt fence
Use real loopback requests to prove per-run busy rejection creates no receipt/provider call, and direct real-control/MCP-adapter execution to prove an unconfirmed own queue UUID produces a non-retryable unknown error with its registered ticket. No automatic replay or fallback channel.

## Attribution review corrections
Capture RED for cross-session/provider lifecycle reuse, cached late binding, terminal old-writer retarget, superseded mapping and native-reference context mismatch. Limit registry matching to emitter session/provider, guard terminal mapping and newer current identity, freeze terminal native ID in SQLite, and verify native history context before lookup. Preserve running initialization and same-session/provider cross-round positives. Run the focused readback suite and existing registry tests; freeze a separate reviewable fix commit.

## Explicit Session model correction
Add isolated real SQLite focused tests for both provider families: no-message persistence, initial-send options after verified persistence, omitted model unchanged, missing owner/no row, echo without persistence, write failure and blank model refusal. Capture RED on the frozen source. Extend only lifecycle models contract and its production wiring to optional same-owner model setter/resolver; persist and verify before send, never use a requestedModel fallback as proof. Run lifecycle/wiring focused tests and server typecheck; deliver a separate commit.

## Unstarted Session restart correction
First reproduce the real MCP projects_list error in the parent's original artifact root without model calls; record the typed error and factory/production clock difference. Add zero-model real MCP project0/session1/session2 list assertions; fix only the missing artifact clock. For the independently evidenced migration issue, add actual separate-process SQLite initialization tests proving both provider families' unstarted mappings stay NULL while bound and disk-discovered identities stay intact. Add genuine absent-column legacy backfill plus repeat-migration positive/negative coverage. Capture RED before guarding the migration to run backfill only on first column addition. Run narrow database/mapping/migration tests and typecheck; freeze a separate source commit for independent review. Do not alter the parent's original fixture mapping without its explicit authorization.

## Typed provider-turn completion
Reproduce the actual SDK typed-event production pipeline using the real Codex runtime, real normalizer, RunRegistry/SQLite and a controlled SDK event iterator (0 new models). Add completed-without-exit-code, missing-signal EOF, turn.failed, failure-before-completion and abort controls. Capture RED before changing normalization and runtime fallback. Add terminal completion provenance to shared/receipt/MCP schema and permit final snapshots only for proven process success or typed provider success. Extend actual cross-process durable result reconstruction with the provider signal; never mutate the prior real UNKNOWN receipt. Run relevant provider/runtime/Run/SQLite focused tests, server typecheck/build and independent delta review. Give a new source-specific compiled factory and full patch package. Native read-only checks are confined to the two explicit provider-owned conversation files and exact project/process identity.
