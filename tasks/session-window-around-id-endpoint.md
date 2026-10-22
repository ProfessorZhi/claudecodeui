---
id: session-window-around-id-endpoint
title: AC-210 按消息 id 取前后窗口：返回窗口、startIndex、total 与双向 hasMore，追加后稳定
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - session-turn-outline-endpoint
goal_ac: AC-210
---
## Proposal

现状：取页只有「自最新端往前数」的 limit/offset（`sliceTailPage`，`server/shared/utils.ts:454`），要读一个靠前轮次附近的内容只能先读完它之后的全部页。偏移还会随追加整体平移，客户端必须靠 total 差值对齐。

要做的事：在既有 messages 接口上增加「围绕 id」的读法（新增查询参数，例如 `around=<id>&before=B&after=A`），不改 limit/offset 的任何既有行为。服务端在缓存的完整数组里按 id 定位下标 X，返回 `[max(0, X-B), min(total, X+A+1))` 的切片，附带 `startIndex`（窗口首条的绝对序号）、`total`、`hasMoreBefore`、`hasMoreAfter`。id 不存在时返回明确的「未找到」，不得回落到最新页。id 的取值面是 AC-209 大纲给出的 id（transcriptAnchorId 或消息 id），也要能定位任意非用户消息 id，因为客户端向后加载续接时用窗口边缘消息的 id。切片逻辑放在 server/shared/utils.ts 紧邻 sliceTailPage，纯函数，便于单测。

## Plan

1. 先写判据文件 `server/modules/providers/tests/session-window-around.test.ts`（≥1200 条夹具，覆盖 AC-210 的全部断言，含追加后的稳定性与未知 id、以及既有 limit/offset 读数不变）。先看它红。
2. 在 utils.ts 增加 `sliceAroundIndex`；在 sessions.service.ts 增加 `fetchWindowAround`；在 provider.routes.ts 的 messages 路由上解析新参数，参数缺省时走旧路径。
3. 在 src/shared/types.ts 增加窗口响应类型（带注释）。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-window-around.test.ts` 退出 0。红态基线：测试文件不存在。（实测 7/7 pass，exit 0）
- [x] AC2 取假形态必须红（先提交再变异，逐条记录 diff、逐字失败行与恢复命令）：(a) 用 total-offset 的尾部偏移实现且追加后不重算 startIndex ⇒ 稳定性断言红；(b) 未知 id 静默回落最新页 ⇒ 未找到断言红。（两条变异均在绿提交 b8e01877 上施加、运行、`git checkout --` 还原；diff、失败行与恢复命令逐字记在判据文件头 `## Recorded mutation probes (AC2)`）
- [x] AC3 既有 limit/offset 行为不变：同一夹具上改造前后各取三个页（offset 0、中段、最老），逐条深度相等，并写下比较方式。（判据对 offset 0 / 中段 / 最老 / 越界 + 缺省读各取一页，与未改动的 `sliceTailPage(full.messages, limit, offset)` 逐条 `assert.deepEqual`；比较方式写在判据头 `## How the untouched-path claim is compared (AC3)`；`sliceTailPage` 本体未被本任务改动）
- [x] AC4 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。（typecheck exit 0；lint exit 0，仅剩 194 条既有 warning；diff 恰为 Touches 的 4 个改动文件 + 新增判据文件）

## DoD

- 窗口来自与分页同一份缓存数组，startIndex 是绝对序号。
- 参数缺省时行为逐字等同改造前。
- 遵守 `backend-module-standards`；类型在 src/shared/types.ts 带注释；只动 `## Touches` 列出的文件。

## Touches

- server/shared/utils.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/provider.routes.ts
- src/shared/types.ts
- server/modules/providers/tests/session-window-around.test.ts (new)
- tasks/session-window-around-id-endpoint.md
