---
id: gap-launch-profiles-gateway-end-to-end-test
title: launch-profiles：gateway profile 的 chat.send 真实落到 mock Anthropic 服务器且
  Authorization 来自环境变量（AC-002）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-passthrough-env-parity-test
goal_ac: AC-002
---
## Proposal

GOAL-001 的 AC-002 要求：以 gateway profile 跑一轮真实 `chat.send`，测试内 mock 的 Anthropic 兼容服务器确实收到该请求，且 `Authorization` 头取自 profile 所引用的环境变量；取假形态：profile 未生效时请求打到默认端点，mock 收不到即红。目前 `server/modules/launch-profiles/` 不存在，`tasks/` 中没有任何任务以 `goal_ac: AC-002` 推进该判据，这是结构性缺口（判据测试 `gateway-end-to-end.test.ts` 因模块缺失而红）。依据 `docs/proposals/launch-profiles.md`（commit 7da6f45c）「编译层」与 ADR-001。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-passthrough-env-parity-test（AC-001）负责 resolveLaunchSpec 骨架与 passthrough 路径；本任务只覆盖 gateway 形态的编译与端到端落地，profile 持久化/白名单/密钥不入库分别归 AC-003/AC-004 的任务。

方案（最小切片）：
1. 在 `server/modules/launch-profiles/` 的 `resolveLaunchSpec` 中实现 gateway 编译：`baseUrl` → `ANTHROPIC_BASE_URL`；`authMode='envVar'` 时按 `authEnvVarName` 读取宿主 `process.env[authEnvVarName]` 的值，写入 `authEnvVarTarget`（默认 `ANTHROPIC_AUTH_TOKEN`）；`modelAliases` → `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`。只存变量名，值不进入 profile 存储。
2. 保证 SDK 路径 `server/modules/providers/list/claude/claude-runtime.provider.js` 的 `sdkOptions.env` 经 `spec.env` 覆盖到子进程，使 chat.send 真正以该端点启动 Claude Code。
3. 新增 `server/modules/launch-profiles/tests/gateway-end-to-end.test.ts`：测试内起本机 `http.createServer` 作为 mock Anthropic 兼容服务（响应最小合法 `/v1/messages` 流或 JSON），设置受控环境变量（如 `FJDAC_API_KEY=test-secret-…`），建立 gateway profile（baseUrl 指向 mock、authEnvVarName 指向该变量），经真实 chat.send 入口（参照 `server/modules/websocket/tests/chat-edit-send.test.ts` 的驱动方式）跑一轮；断言 mock 收到至少一个请求，且其 `Authorization`（或 `x-api-key`，按 target）头值等于该环境变量的值。
4. 取假用例：同一测试内再跑一轮不带 profile（或 profile 未生效）的 chat.send，断言 mock 收到 0 个请求（请求打向默认端点），证明该测试在 profile 未生效时会变红；并对 Authorization 头断言值来自环境变量而非字面量硬编码（改变环境变量值后头随之变化）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/gateway-end-to-end.test.ts` 退出码 0（AC-002 的判据命令）。
- [x] 测试断言 mock 服务器至少收到 1 个请求，且请求的认证头值严格等于被引用环境变量的值；改变环境变量值后重跑，头值随之改变（`assert.strictEqual`）。
- [x] 取假用例通过：无 profile / profile 未生效时 mock 收到请求数为 0，测试内以断言证明此时判据会变红。
- [x] `grep -n "resolveLaunchSpec" server/modules/providers/list/claude/claude-runtime.provider.js` 有命中；`npm run typecheck` 与 `npm test` 退出码 0（既有 server 测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求测试经由真实 chat.send 入口驱动真实的 `claude-runtime.provider.js` 启动路径（Agent SDK 子进程真实发出 HTTP 请求），由测试内 mock Anthropic 兼容服务器实际接收并记录请求与认证头；AC-002 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-002` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/index.ts
- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/tests/gateway-end-to-end.test.ts
- server/shared/types.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/index.ts
- server/modules/websocket/index.ts
- tasks/gap-launch-profiles-gateway-end-to-end-test.md
