---
id: gap-launch-profiles-env-injection-closed-test
title: launch-profiles：env 白名单在写入路径与编译路径各自拒绝 PATH/NODE_OPTIONS/LD_PRELOAD 等键，且
  WebSocket 伪造的 options.env 被后端完全忽略（AC-004）
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-004
---
## Proposal

GOAL-001 的 AC-004 要求：env 键名白名单在写入路径与编译路径各自拒绝 `PATH`/`NODE_OPTIONS`/`LD_PRELOAD` 等键；且经 WebSocket 伪造的 `options.env` 被后端完全忽略；取假形态：任一路径漏判或客户端 env 被采纳即红。目前 `server/modules/launch-profiles/` 不存在，`tasks/` 中没有任何任务以 `goal_ac: AC-004` 推进该判据，这是结构性缺口（判据测试 `env-injection-closed.test.ts` 因模块缺失而红）。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）「安全设计 §3 客户端只传 profile id」「§4 环境变量键名白名单」与 ADR-001。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-passthrough-env-parity-test（AC-001）证明无 profile 时 env 与改动前一致，gap-launch-profiles-secret-never-persisted-test（AC-003）覆盖凭据不落库；本任务只覆盖键名白名单与客户端 env 忽略。

方案（最小切片）：
1. 在 `server/modules/launch-profiles/launch-spec.service.ts`（模块私有）定义白名单与校验函数：允许前缀 `ANTHROPIC_`、`CLAUDE_CODE_`、`CLAUDE_AUTOCOMPACT_`，允许精确键 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`ENABLE_TOOL_SEARCH`、`DISABLE_TELEMETRY`，显式拒绝 `PATH`、`NODE_OPTIONS`、`NODE_PATH`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`DYLD_*`、`BASH_ENV`、`ENV`、`SHELL`、`IFS`、`PYTHONPATH`、`CLAUDE_CLI_PATH`、`CLAUDE_CONFIG_DIR`（即使匹配前缀也拒绝）。
2. 写入路径：`launch-profiles.service.ts` 的新建/更新方法调用该校验并抛出可读错误；route 保持轻薄不自行校验。编译路径：`resolveLaunchSpec` 对读出的 `config.env` 再校验一次，违规键不得进入产出的 env（模拟绕过接口直接写库的历史脏数据）。持久化经 `server/modules/database` 的 `launch_profiles` 表与 `launchProfilesDb` 仓库（schema.ts / repositories/launch-profiles.db.ts / index.ts 导出），由 launch-profiles service 通过 database 模块 barrel 使用。
3. WebSocket 路径：`chat-websocket.service.ts` 的 `dispatchRun` 不再把客户端 `options.env` 带入 `runtimeOptions`，wire 协议只承载 `launchProfileId`，env 完全由服务端从 DB 解析。
4. 新增 `server/modules/launch-profiles/tests/env-injection-closed.test.ts`：对每一条显式拒绝规则逐一断言写入路径抛错、且绕过写入接口直接落库后编译路径产出的 env 不含该键；伪造 `options.env`（含 `NODE_OPTIONS`/`LD_PRELOAD`）经真实 `dispatchRun` 入口后，捕获到的 `runtimeOptions`/最终 spawn env 不含该值。取假用例：临时放宽任一路径（或让客户端 env 被采纳）时同一断言必须变红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/env-injection-closed.test.ts` 退出码 0（AC-004 的判据命令）。
- [x] 测试对 PATH、NODE_OPTIONS、NODE_PATH、LD_PRELOAD、LD_LIBRARY_PATH、DYLD_*、BASH_ENV、ENV、SHELL、IFS、PYTHONPATH、CLAUDE_CLI_PATH、CLAUDE_CONFIG_DIR 逐键断言：写入路径抛出校验错误，且直接落库后 `resolveLaunchSpec` 产出的 env 不含该键。
- [x] 测试经 `dispatchRun` 传入伪造的 `options.env`（含 `NODE_OPTIONS`、`LD_PRELOAD`），断言后端最终 `runtimeOptions`/spawn env 中不含这些值（`assert.ok(!('NODE_OPTIONS' in env))` 一类）。
- [x] 取假用例通过：分别仅放宽写入路径校验、仅放宽编译路径校验、让客户端 env 被采纳三种变体，同一断言函数均判红，证明任一路径漏判都会被捕获。
- [x] `npm run typecheck` 与 `npm test` 退出码 0（既有 server 测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求校验函数被真实的 launch-profiles service 写入方法与 `resolveLaunchSpec` 实际调用，且 `chat-websocket.service.ts` 的真实 `dispatchRun` 入口不再采纳客户端 `options.env`；测试通过真实入口而非直接调用校验函数来证明；取假变体证明两条路径与客户端 env 三处判据各自敏感。AC-004 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-004` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/launch-spec.service.ts (new)
- server/modules/launch-profiles/launch-profiles.service.ts (new)
- server/modules/launch-profiles/index.ts (new)
- server/modules/database/schema.ts
- server/modules/database/index.ts
- server/modules/database/repositories/launch-profiles.db.ts (new)
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/launch-profiles/tests/env-injection-closed.test.ts (new)
- server/modules/websocket/index.ts
- tasks/gap-launch-profiles-env-injection-closed-test.md

## Needs-Human

**执行 2026-09-20T03:59:03.240Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=7345 lint passed=false end_ms=1789876702999
- run_id：wk-prod-anchor
- session_id：54f7e36d-616a-4277-8e43-39726cb764c5
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-launch-profiles-env-injection-closed-test~wk-prod-anchor~1789876678964-5e36a8.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-env-injection-closed-test-wk-prod-anchor.log
