---
id: gap-mcp-session-search
title: MCP 只读工具 session_search：暴露 session-conversations-search.service.ts 的跨
  session 全文检索，返回 sessionId/messageId/snippet/timestamp，并与
  session_read(mode=around) 衔接
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景（2026-10-07 只读调查，针对真实使用场景：用户记得某个历史会话讨论过一个概念但忘了措辞，想跨 2837+ 个历史 session 一次查询定位）。

现状（已读代码核实）：
- MCP 侧 `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` 的 `MCP_STAGE3_READ_TOOLS` 目前是 `overview`/`projects_list`/`sessions_list`/`session_get`/`session_read`/`run_get`/`quay_snapshot`/`ui_last_opened_session`/`ui_visible_context`/`ui_clients_list`，没有任何跨 session 内容检索工具；`session_read` 一次只能读一个指定 session 的 `latest`/`outline`/`around` 窗口。
- 跨 session 全文检索引擎已经存在且在用：`server/modules/providers/services/session-conversations-search.service.ts` 的 `searchConversations()`（经 `sessionConversationsSearchService.search()` 包装）。它对 `sessionsDb.getAllSessions()` 里每条 session 的 `jsonl_path` 用 `@vscode/ripgrep` 做大小写不敏感、fixed-strings 的文件级并发搜索（`findMatchedFileKeys`，40 文件/批、6 路并发），只有被 ripgrep 命中的文件才逐行解析取 snippet（`parseClaudeSessionMatches`/`parseCodexSessionMatches`）；同时对 session 标题做子串匹配（`findSessionTitleResults`）。每条正文命中产出 `{ role, snippet, highlights, timestamp, provider, messageUuid }`。只支持 `claude`/`codex` 两种 provider；已归档项目排除；每 session 最多 2 条命中；总数上限 200；无持久化索引，是精确全文检索，不是语义检索。
- 它唯一的出口是 `GET /api/providers/search/sessions`（REST SSE，`server/modules/providers/provider.routes.ts`），被前端两处消费：侧边栏搜索（`src/modules/sidebar/hooks/useSidebarController.ts`）与命令面板消息搜索（`src/modules/command-palette/hooks/useSessionMessageSearch.ts`），都经 `src/shared/api.ts` 的 `searchConversationsUrl()`。从未通过 MCP 暴露。
- 两边 id 语义天然对齐：搜索结果的 `messageUuid` 就是 Claude JSONL 条目的 `entry.uuid`；`server/modules/providers/services/sessions.service.ts` 的 `fetchWindowAround`（`session_read(mode:'around')` 的实现）按「provider 自己的 anchor id，否则合成 id」解析 `aroundId`——也就是说搜索结果的 `messageUuid` 可以直接喂给 `session_read(mode:'around', aroundId)` 精确展开上下文。Codex 的命中目前没有这个字段（引擎本身的限制，见下）。

要交付：

1. 新文件 `server/modules/mcp-gateway/mcp-session-search.ts`（遵守 `$backend-module-standards`），镜像既有 `mcp-run-get.ts`/`mcp-overview-tools.ts` 的「可选依赖 + `isXxxWired` 判断 + 未接线时占位」写法：
   - 导出 `McpSessionSearchDeps`（对 `sessionConversationsSearchService.search` 的最小切片——只注入这次调用需要的方法，不整个服务搬进来）。
   - 输入 `{ query: string, project?: string, provider?: 'claude'|'codex', speaker?: 'user'|'assistant'|'any', limit?: number, cursor?: string }`（`project` 现阶段只接受 project id；一旦本任务之外的 `resolveDeps` 生产接线落地，`project` 自动也能接受名称片段，不需要本工具改代码）。
   - 输出 `{ query, totalMatches, moreAvailable, results: [{ sessionId, provider, projectId, projectDisplayName, sessionTitle, lastActivity, score, matches: [{ messageId, role, timestamp, snippet, highlights }] }], cursor? }`。`messageId` 取自引擎的 `messageUuid`（Codex 命中该字段为 `null`）。`score` 第一版是确定性加权（命中数 + 短语精确命中 + 新近度），不是概率；输出文档需要诚实声明这一点。
   - `project` 过滤在 `searchConversations` 返回的 `ProjectConversationResult[]` 之上按 `projectId` 过滤（改动面最小，不改引擎本身）。
   - `cursor` 分页：现有引擎一次性跑完所有匹配 session（受 limit 截断），本工具的 cursor 语义是「跳过已返回的前 N 个 session，对结果重新扫描后 slice」——不保证跨调用绝对稳定，工具 description 需要诚实声明这一点，不假装是稳定分页。
   - 工具 description 必须声明局限：这是全文/精确匹配，不是语义检索；原话措辞差异大时可能搜不到，建议尝试多组关键词。
2. 在 `mcp-gateway.read-tools.ts` 的 `MCP_STAGE3_READ_TOOLS` 加入 `session_search` 一行（scope `cloudcli:read`）+ `TOOL_BODIES` 里的 `notImplemented` 占位（跟 `overview`/`run_get` 同样的「先占位再路由」节奏），`registerMcpReadTools` 加对应的 `isSessionSearchWired` 分支，路由到第 1 条的真实 handler。
3. 同步更新 `mcp-tool-annotations.ts`（`readOnlyHint:true`、`destructiveHint:false`、`idempotentHint:true`、`openWorldHint:false`——效果完全在 CloudCLI 自己的磁盘/存储内）与 `mcp-tool-error-codes.ts`——这是本模块既有的「三处同步」契约，漏一处会在既有 registry 驱动的覆盖表判据（`mcp-english-only.test.ts`/`mcp-error-envelope.test.ts`）里判红。
4. 如果 providers 模块 barrel（`server/modules/providers/index.ts`）还没导出 `sessionConversationsSearchService`，补上导出（`$backend-module-standards` 要求跨模块只经 barrel，不深度 import service 文件）。
5. `server/index.ts` 的 `createMcpGatewayModule({ readTools: {...} })` 里加 `sessionSearch: { search: (input) => sessionConversationsSearchService.search(input) }`。

<!-- dedup-ref -->机制上去重已核对：`task_list search="session_search"` 与 `search="transcript search"` 均为空（本仓库此前无同名/同机制任务）；现有 `gap-mcp-ui-last-opened-session`/`gap-mcp-ui-visible-context`/`gap-mcp-ui-clients-list`/`gap-mcp-ui-open-session` 四个已完成任务都是「新增一个 MCP 工具」的同类先例，可直接抄形态（表+annotations+error-codes+barrel+server/index.ts 五处同步），但它们解决的是设备/导航/UI 状态问题，不是跨 session 内容检索，机制不同，不是重复。本任务与同批另一个任务（修 MCP project/session 名称解析生产接线）只是「本工具的 `project` 过滤一旦那边落地会自动升级」的非阻塞关系，两个任务可独立并行推进，不互为前置。

## AC

- [x] `grep -n "session_search" server/modules/mcp-gateway/mcp-gateway.read-tools.ts server/modules/mcp-gateway/mcp-tool-annotations.ts server/modules/mcp-gateway/mcp-tool-error-codes.ts` 三个文件均有命中。
- [x] 新判据文件 `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --test server/modules/mcp-gateway/tests/mcp-session-search.test.ts` 退出码 0，且覆盖以下断言：(a) 真实 jsonl 夹具里包含目标短语的消息被命中，返回的 `messageId` 能直接喂 `session_read(mode:'around', aroundId)` 拿到同一条消息（两边逐字比对消息内容）；(b) 传 `project`（project id）后只返回该 project 的命中；(c) 无命中时返回 `results: []` 而不是报错；(d) 命中数超过 `limit` 时返回 `cursor`，带 `cursor` 重新调用能看到后续结果；(e) 未接 `sessionSearch` deps 时调用 `session_search` 得到 `MCP_TOOL_NOT_IMPLEMENTED`（占位负控制）。
- [x] `grep -n "session_search" server/modules/mcp-gateway/tests/mcp-read-tools.test.ts server/modules/mcp-gateway/tests/mcp-english-only.test.ts server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts` 三个既有「registry 驱动覆盖表」判据文件均已同步，且三文件各自单独运行退出码 0。
- [x] `grep -n "sessionConversationsSearchService" server/modules/providers/index.ts server/modules/mcp-gateway/mcp-session-search.ts server/index.ts` 命中，且 `grep -rn "from '.*session-conversations-search.service" server/modules/mcp-gateway` 为空（只经 providers 模块 barrel 导入，没有深度 import）。
- [x] `npm run typecheck` 退出码 0；`npm run lint` 的 `: error ` 计数为 0。

## DoD

在真实运行的服务上实际操作一次：用真实的 claudecodeui 项目历史会话（存量 session），经 `/mcp` 用 PAT 调用 `session_search`，查一个你知道出现在某条历史消息里的关键词，确认返回的 `sessionId`/`messageId`/`snippet`/`timestamp` 指向正确的会话与消息，并用返回的 `messageId` 调 `session_read(mode:'around', aroundId)` 确认能展开到同一条消息周围的上下文。仅有测试夹具通过不算完成。

## Touches

- server/modules/mcp-gateway/mcp-session-search.ts
- server/modules/mcp-gateway/mcp-gateway.read-tools.ts
- server/modules/mcp-gateway/mcp-tool-annotations.ts
- server/modules/mcp-gateway/mcp-tool-error-codes.ts
- server/modules/mcp-gateway/index.ts
- server/modules/providers/index.ts
- server/index.ts
- server/modules/mcp-gateway/tests/mcp-session-search.test.ts
- server/modules/mcp-gateway/tests/mcp-read-tools.test.ts
- server/modules/mcp-gateway/tests/mcp-english-only.test.ts
- server/modules/mcp-gateway/tests/mcp-error-envelope.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-mcp-session-search.md

## Notes

本任务不新增全文索引、不实现语义检索；`mode` 字段预留但只接受 `'fulltext'`，语义检索是否要做、怎么做留给后续独立任务评估（不在本任务范围）。`since`/`until` 等逐条消息时间过滤、provider 扩展到 cursor/opencode 也不在本任务范围。