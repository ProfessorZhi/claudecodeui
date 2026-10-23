---
id: session-history-incremental-cache
title: AC-211 服务端历史缓存增量化：转录追加只解析新增尾部，结果与全量解析相等
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on: []
goal_ac: AC-211
---
## Proposal

现状（2026-10-04 读代码）：`server/modules/providers/services/session-history-cache.service.ts` 每次请求只做一次 stat，比较 path、mtime、size；任何不同即整体失效，下一次取页走 `claude-sessions.provider.ts` 的全量路径——逐行 JSON.parse 整份 JSONL、丢弃被取代的提示分支、读每个子 agent 转录、按时间戳排序、归一化、再跑 `prepareTranscriptMessages`。活跃会话每个新回合都会使缓存失效，所以拖动滚动条或向上翻页时每次取页都可能重解析整份文件（1 万条以上的会话是秒级）。

要做的事：让缓存条目记住「已解析到的字节偏移」与解析所需的尾部状态；当文件只是在末尾追加（path 相同、size 增大、旧前缀不变）时，只解析新增字节，把新增行并入已有的原始行集合，再重新归一化受影响的尾部。关键约束：工具结果会折叠回更早的 tool_use 行、checklist 快照会折叠、被取代的提示分支会改变更早的行——这些跨缓存边界的折叠必须与全量解析等价。最稳妥的做法是缓存「原始行集合 + 偏移」，增量只省掉 JSON.parse 与文件读取，归一化与折叠对完整行集合重做（或只对受影响的尾部区间重做并有等价对照守住）。选型由实现者裁定，但判据是结果与全量解析深度相等。回落规则：文件变小、前缀被改写（用已缓存尾部若干字节的校验和比对）、mtime 倒退时回落全量解析；并发读取共享一次解析（现有 pending promise 保留）。

不在本任务内：大纲与按 id 取窗口的接口（AC-209、AC-210），它们依赖本任务的缓存形状。

## Plan

1. 先写判据文件 `server/modules/providers/tests/session-history-incremental-cache.test.ts`，覆盖 AC-211 的 (a)(b)(c)(d)(e)，并包含对照臂：同一输入的全量解析函数。先看它红。
2. 给缓存条目增加解析偏移与前缀校验信息；追加场景走增量解析，其余回落。在解析函数上加一个可观测的「本次解析读取的字节数」计数（测试可读，生产无副作用），不得靠 mock 文件系统来计数。
3. 保证 sessions.service.ts 的取页逻辑不感知增量与否（切片语义逐字不变）。
4. 跑现有 server 测试里与 session history 相关的全部用例，确认输出不变。

## AC

- [x] AC1 判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-history-incremental-cache.test.ts` 退出 0。红态基线：测试文件不存在。
- [x] AC2 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(a) 追加后仍整文件解析 ⇒ 字节计数断言红；(b) 增量并入但不重做跨边界的工具结果折叠 ⇒ 深度相等红；(c) 前缀被改写后仍返回旧缓存 ⇒ 回落断言红。
- [x] AC3 既有行为不变：`npx tsx --tsconfig server/tsconfig.json --test "server/modules/providers/tests/*.test.ts"` 中与 session history、sessions.service、provider.routes 相关的既有用例全部保持绿，写下运行的文件清单。
- [x] AC4 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐。

## DoD

- 判据跑的是真实缓存服务与真实 Claude 转录夹具，不 mock 文件系统读取；字节计数来自解析函数自己的读数。
- 增量路径的结果与全量解析深度相等，对照臂在同一测试里同时运行。
- 追加、截断、前缀改写、mtime 倒退、并发读取五种输入都有用例。
- 遵守 `backend-module-standards`（`.agents/skills/backend-module-standards/SKILL.md`），只动 `## Touches` 列出的文件。

## Touches

- server/modules/providers/services/session-history-cache.service.ts
- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/providers/tests/session-history-incremental-cache.test.ts (new)
- tasks/session-history-incremental-cache.md

## Evidence

worker 实测 2026-10-04（实现提交 8f7a2642）：

- AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-history-incremental-cache.test.ts` 退出 0（tests 5 / pass 5 / fail 0）。
- AC2 假形态（先提交实现再变异，逐条 `git checkout -- server/modules/providers/list/claude/claude-sessions.provider.ts` 恢复；恢复后复跑判据 5 pass）：
  - (a) 追加后仍整文件解析：变异 `readClaudeTranscriptRows` 的 resume 守卫为 `false && context?.previous && …`。失败行逐字：`AssertionError [ERR_ASSERTION]: expected <= 518 bytes parsed, got 919`（追加 454 字节，实读 919 = 整文件）。
  - (b) 增量并入但不重做跨边界折叠：变异为 resumed 读取时跳过 `fetchHistory` 的 toolResult 折叠。失败行逐字：`AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal`（增量结果 vs 全量对照臂）。
  - (c) 前缀被改写后仍返回旧缓存：变异为跳过 `resumeClaudeTranscript` 的前缀 digest 比对。失败行逐字：`AssertionError [ERR_ASSERTION]: a prefix rewrite must re-parse the whole file`（actual 211，expected 644）。
- AC3 既有行为不变，运行的文件清单：session-history-cache.service.test.ts、sessions.service.test.ts、sessions-details.test.ts、provider.routes.test.ts、provider-attachment-history.test.ts、claude-sessions.test.ts、codex-sessions.test.ts（70 pass / 0 fail）；opencode-sessions.test.ts、claude-compaction.test.ts、claude-background-work.test.ts、claude-subagent-echo.test.ts、session-fork.test.ts、provider-runtime.service.test.ts、provider-token-usage.service.test.ts、session-synchronizer-coalescing.test.ts（52 pass / 0 fail）。
- AC4：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0；`git diff --stat develop...HEAD` 仅列 Touches 三文件（claude-sessions.provider.ts、session-history-cache.service.ts、session-history-incremental-cache.test.ts）。
- scoped 门：`bash scripts/test.sh --for-task session-history-incremental-cache --allow-thin` 退出 0。