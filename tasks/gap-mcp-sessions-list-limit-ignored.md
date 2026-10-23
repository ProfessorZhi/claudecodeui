---
id: gap-mcp-sessions-list-limit-ignored
title: sessions_list 的输入 schema 没有 limit，调用方传 limit 被静默丢弃并返回最多 200 条：声明并执行
  limit，超界给 INVALID_ARGUMENT
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**Finding（2026-10-07，对运行中的服务做真实调用）：** 调 `sessions_list { project, state: "any", limit: 6 }`，返回了约 200 条会话，`limit` 完全没生效。`mcp-gateway-SPEC.md` 的工具清单里 `sessions_list` 的输入就是 `{ project?, provider?, state?, limit? = 10, cursor? }`，而且 SPEC 的通用约定要求手机屏幕友好的小输出；实际返回 200 条对手机客户端与模型上下文都是浪费。

**现状（已读代码核实）：**

- `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 里 `sessions_list` 的 `inputSchema` 只有 `project` 与 `state` 两个字段，没有 `limit`（也没有 `provider`、`cursor`）。未声明的参数被 zod 默认丢弃，所以调用方传了也没有任何报错。
- 处理函数里页大小是常量 `SESSION_LIST_PAGE_SIZE = 200`，`readRecentSessionRows` 与 `readProjectSessionRows` 都用它取数；输出带 `total`，所以调用方知道总数。
- AC-288 已把参数校验失败统一成 `INVALID_ARGUMENT` 信封，本任务的越界处理要沿用，不另造错误码。
- 同文件的 `session_read` 已有 `limit: z.number().int().min(1).max(MCP_SESSION_READ_MAX_LIMIT).optional()`，是现成的写法参照。

**要交付：**

1. 给 `sessions_list` 的 `inputSchema` 加 `limit: z.number().int().min(1).max(200).optional()`；传了就只返回前 `limit` 条（排序仍是现有的最近活动在前），`total` 仍是过滤后的总数，使调用方知道被截断。
2. **默认值不改**：未传 `limit` 时行为与现在完全一致（最多 200 条），避免打破现有调用方与现有测试；是否把默认值降到 SPEC 里的 10，作为单独的决定，不在本任务内。
3. `limit` 为 0、负数、非整数或超过 200 时返回 `INVALID_ARGUMENT`（沿用现有信封），不静默截断。
4. 工具描述里写明 `limit` 的含义与上限。
5. 不新增 `server/**/*.test.ts` 文件：断言写进已有的 `server/modules/mcp-gateway/tests/mcp-read-tools.test.ts`（该文件本来就在测 `sessions_list`）；不新增工具，所以该文件里钉住的读工具数量不变。

## AC

- [x] `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-read-tools.test.ts` 退出码 0，且新增断言：传 `limit: 3` 时返回恰好 3 条且是按最近活动排序的前 3 条，`total` 仍是过滤后的总数；未传 `limit` 时返回条数与改动前一致。
- [x] 同一测试文件断言：`limit` 为 0、-1、1.5、201 时返回 `INVALID_ARGUMENT`，信封里点名 `limit`；`project` 与 `state` 过滤与 `limit` 组合时先过滤再截断。
- [x] `grep -n "limit" server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 能在 `sessions_list` 的 `inputSchema` 里看到 `limit`，且 `mcp-english-only.test.ts`、`mcp-error-envelope.test.ts`、`mcp-invalid-argument.test.ts`、`mcp-tool-annotations.test.ts` 逐文件运行退出码 0（工具描述与错误文案仍是英文）。
- [x] `npm run typecheck` 退出码 0。

## DoD

在真实运行的服务上实际操作一次：用 PAT 经 `/mcp` 调 `sessions_list { project: <某项目 id>, limit: 5 }`，返回恰好 5 条，`total` 大于 5；再传 `limit: 0`，返回 `INVALID_ARGUMENT`，信封里点名 `limit`。仅有测试夹具通过不算完成。

**已执行（真实服务实例，非夹具）：** `scripts/mcp-smoke.mjs` 的 `bootServer` 从本 worktree 起真 `server/index.ts`（临时 `DATABASE_PATH`、`listen(0)` 端口），播种真 PAT 并建 6 个真会话于一个临时项目。经 `/mcp` 调 `sessions_list { project: <该临时项目 id>, limit: 5 }` → 恰好 5 条、`total: 6`；再调 `limit: 0` → `INVALID_ARGUMENT`，`details.fields = [{ path: "limit", problem: "must be >= 1" }]`。

## Touches

- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts
- tasks/gap-mcp-sessions-list-limit-ignored.md
