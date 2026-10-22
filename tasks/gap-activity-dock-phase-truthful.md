---
id: gap-activity-dock-phase-truthful
title: AC-187 真实浏览器：坞文案来自真实阶段（thinking→tool(Bash)→writing→idle）、同一阶段 6 秒不轮换、回合末收起
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-activity-dock-unreachable-degradation
  - gap-activity-send-unreachable-draft-retry
  - gap-claude-turn-phase-real-signals
goal_ac: AC-187
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，读任务库与代码）。`grep -rn "^goal_ac: *AC-187" tasks/*.md` → **0 命中**。`grep -rln "AC-187" tasks/` 只命中三条**不同机制**的旁述，且三条都白纸黑字把这一格让了出来：`gap-claude-turn-phase-real-signals`（`goal_ac: AC-186`）明写「本任务只做这个归约器与它的判据，不接 UI、不改转写、不做真实浏览器验证（那是 AC-187）」；`gap-activity-dock-unreachable-degradation`（`goal_ac: AC-184`）明写「同族不同机制的 AC-187（文案对应真实阶段且不按时间轮换）与 AC-188…目前没有任务认领，本条不替它们申领…AC-187 管的是回合中状态下文案的**来源**」；`gap-activity-send-unreachable-draft-retry`（`goal_ac: AC-185`）明写「AC-187 管的是回合中状态下文案的来源」。机制侧读数：`grep -rn "ACTION_KEYS\|Math.floor(elapsedSeconds / 4)" src/ --include=*.tsx` 命中 `src/modules/chat/composer/ActivityIndicator.tsx`（今天坞仍按已用秒数每 4 秒轮换六个词）；`grep -rn "data-activity-phase\|turnPhase" src/ e2e/ --include=*.ts --include=*.tsx` → 0；`test -f e2e/activity-dock-truthful.spec.ts` → **ABSENT**（该文件由 AC-184 建立）。⇒「真实浏览器里坞文案=真实阶段且阶段内不轮换」这一机制无人认领，不是重复。本条的三条真前置由 frontmatter 的 `depends_on` 显式声明（**唯一**的 gating 面），本段只作可追溯性说明：`gap-activity-dock-unreachable-degradation`（建立判据文件、`[data-activity-dock]` 构件与 `DEBUG_AGENT_SPEC_FILES` 登记）、`gap-claude-turn-phase-real-signals`（本条的 phase/toolName 就来自它的 `createClaudeTurnTracker()` 与 `TurnPhase`/`TurnState`）、`gap-activity-send-unreachable-draft-retry`（与本条写同一批文件——同一 spec、同一条坞，并发没有意义）。

**现状读数（2026-10-01，读代码）。** `src/modules/chat/composer/ActivityIndicator.tsx:92` 的 `label` 是 `renderedActivity.statusText || actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length]`——没有服务端阶段时按**已用秒数每 4 秒轮换**六个词（`ACTION_KEYS`：thinking/processing/analyzing/working/computing/reasoning）。`elapsedSeconds` 由本地 `setInterval(() => Date.now() - startedAt)` 自增（`:78-82`），`startedAt` 是客户端时钟（`src/shared/types.ts:196` 注释逐字写 client clock）。也就是说：同一阶段内每 4 秒文案就变一次——这正是 AC 的稳定性读数要打红的形态；而 `tool` 阶段要读到的工具名（`Bash`）今天根本没有任何来源：服务端从未把 `tool_use.name` 作为阶段推给客户端，坞也没有渲染它的位置。AC-186 交付的是**纯归约器**（`server/modules/providers/services/claude-turn-phase.service.ts`，导出 `createClaudeTurnTracker()` → `TurnPhase`/`TurnState`），它的 Touches 只有该服务、providers barrel 与它的判据——**既没有把它接到 run loop，也没有接到调试 agent 的帧路径**。调试 agent 今天也发不出阶段帧：`DEBUG_AGENT_ROLES = ['assistant','user']`、`buildMessageRow` 只写 `content: [{ type: 'text' }]`（`debug-agent.scenario.ts:132`、`debug-agent.runtime.ts:68-82`），没有任何 op 能写出带 `tool_use` 块的 assistant 行或 `stream_event` 行。⇒「信号→服务端阶段→活动帧→坞」这条链上，把阶段送到坞这一段无人认领，是本条的实现面。

**要做的事。** 在**真实浏览器、真实服务端、真实调试 agent 回合**上，把坞做成「阶段是真的」：服务端把 AC-186 归约出的 `phase`/`toolName` 随既有活动帧推给客户端；坞按阶段显示**对应阶段的本地化文案**（`tool` 阶段带上工具名 `Bash`），同一阶段内 6 秒每秒读数恒等（不轮换），回合结束（`result` ⇒ idle）坞收起。调试 agent 需要扩展出能依次发出 `thinking`/`tool`/`writing`/`idle` 四个阶段的场景操作（现有 op 不足即扩展），**且不得改变其它既有场景的行为**。判据是 AC 的 `criterion:` 逐字命令 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-187"`。

**开放的设计风险（留给实现，不写进 AC）。** AC-186 的归约器消费的是 run loop 手上的**原始 SDK 消息**；调试 agent 走的是它自己的 engine（`forwardFrames({ transformedMessage: row, normalizeMessage, … })`）。实现时必须先确认调试 agent 的帧确实经过同一个接缝；若不覆盖，就把归约器接到**两条路径共用的 forwarder**（`server/modules/providers/provider.registry.ts` 里 `forwardFrames: forwardNormalizedFrames` 那一处），不新增第二条消息通路、也不在调试 agent 里自建帧——ADR-003 decision 7 由 `server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts` 静态守卫：调试 agent 只准写方言行，帧一律由产品的 normalizer 产出。

## Plan

1. **红态先行。** 在 `e2e/activity-dock-truthful.spec.ts`（AC-184 已建）里追加一个标题含 `AC-187` 的用例，照 `e2e/resident-busy-send.spec.ts` 的形状起：`request.newContext()` 打 `POST /api/debug-agent/scenarios` 播种、`POST /api/debug-agent/clock` 走一个能依次发出 thinking → tool(Bash) → writing → idle 的场景；读数在 `clock` 响应**在飞时**取得（该响应等到整段走完才返回，别让它成为失败时的第一错误；收尾把未决 promise 归约成 settled 值）。实现前该选择红（`-g "AC-187"` 无匹配）。
2. **调试 agent 出阶段帧（server）。** 扩展场景 op 与方言行，使一个场景能写出：带 `id`/`name: 'Bash'` 的 `tool_use` 块的 assistant 行、配对的 `user` `tool_result` 行、`stream_event`/`content_block_delta` 行（writing）、回合开始但尚无文本/工具的 thinking 段、以及 `result` 结束段。改动面：`debug-agent.scenario.ts`（新 op/类型/校验）、`debug-agent.runtime.ts`（新的方言行构造器）、`debug-agent.engine.ts`（应用新 op）。**只写方言行，不构造帧**（守卫测试必须保持绿）；`DEBUG_AGENT_ROLES` 既有取值与既有 op 的语义不得改变。
3. **服务端接线。** 把 AC-186 的 tracker 接到能同时覆盖真实 run loop 与调试 agent 的 forwarder 上，把 `phase`/`toolName` 合并进该会话的 `SessionActivity`，随既有活动帧（AC-182 的 `activity.snapshot`/`activity.patch`/心跳）推给客户端。**复用 AC-182/184 已有的活动帧与坞构件，不新建第二条管道。** 接线落点以实现时的真实接缝为准；若需要动 `server/modules/websocket/` 下的活动帧服务或其它文件，先把该文件加进 `## Touches` 再写。
4. **客户端渲染（只读服务端推来的阶段）。** 在 `src/modules/chat/utils/activityDockView.ts`（AC-184 已建）里加「阶段 → 本地化文案」的选择器：`phase ∈ {thinking, writing, tool, …}` 映射到对应 locale 键，`tool` 阶段文案含 `toolName`（有 `toolName` 才显示工具名，没有就退回阶段词）。`ActivityIndicator.tsx` 的 `label` 改成读该选择器，**删掉 `Math.floor(elapsedSeconds / 4) % actionWords.length` 这条按时间轮换的分支**；坞挂一个可供判据稳健读取的阶段属性（如 `data-activity-phase`，与文案同源）。回合结束（phase=idle 且无活动）坞收起，沿用 `ActivityIndicator` 现有的退出动画路径。
5. **文案。** 阶段的本地化键（至少 thinking / writing / tool，`tool` 带 `{{tool}}` 占位）加进 `src/modules/i18n/locales/*/chat.json` **全部 12 个**文件；缺一个则 i18n 完整性判据红。既有 `claudeStatus.actions.*` 六词**保留但不再被坞轮换使用**（其它消费者不受影响）。
6. **组件级单元判据（快速反馈）。** 新增/扩展 `src/modules/chat/tests/` 下的坞用例：喂 `phase: 'tool', toolName: 'Bash'` ⇒ 文案含本地化的 tool 词与 `Bash`；喂 `phase: 'thinking'` ⇒ 文案是对应 locale 的 thinking 词（**正控制**，证明文案不是恒空）；用假定时器在同一 phase 下推进 ≥6 秒逐秒读文案，断言逐次相等（稳定性读数的快速反馈层）；喂 idle ⇒ 不渲染坞。
7. **假形态（承重；先提交再变异，`git checkout -- <file>` 恢复，逐字登记变异 diff / 失败行 / 恢复命令）。** (i) 把坞的 `label` 改回 `actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length]`（即 AC 原文的「改回按已用时间轮换的词表」）⇒ **6 秒稳定性读数必须红**（单元层与 e2e 层都要记，至少一层红且记下另一层为什么看不到）；(ii) 把阶段来源改回本地 `statusText`/本地时钟 ⇒ `tool` 阶段的 `Bash` 读数必须红。任一条没红按「判据有洞」处理，先补判据（例如把稳定性窗口内两次读数的间隔加宽到必跨过 4 秒边界）再加回。
8. **墙钟与登记。** 用例自己记起止并断言**用例体** ≤ `20_000`ms、整次调用在 `SINGLE_SPEC_CEILING_MS = 55_000`（`playwright.config.ts:317`）与 60 秒闸之内；`'activity-dock-truthful.spec.ts'` 已在 `DEBUG_AGENT_SPEC_FILES`（AC-184 登记），本条不重复登记。
9. **静态门与对齐。** `npm run typecheck`、`npm run lint`、`npx tsc --noEmit -p server/tsconfig.json` 均退出 0；跨模块 import 走 barrel，并遵守 `.agents/skills/backend-module-standards/SKILL.md`（server/：`type` 优先、导出就地声明、私有细节不导出、跨模块只经 `index.ts`）与 `.agents/skills/frontend-module-standards/SKILL.md`（src/：`@/...`、`export type`/`import type`、共享类型放 `src/shared/types.ts`）；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-187"` 退出 0，`--list` 列出该用例。红态基线：实现前该选择红（用例不存在）。
- [x] AC2 阶段序（真实浏览器读数）：调试 agent 场景推进中，`[data-activity-dock]` 依次读到 thinking、tool、writing、idle 四个阶段。逐步打印 `dock.phase` 与 `dock.text` 原始读数。
- [x] AC3 文案=阶段（承重）：`thinking`/`writing` 阶段读到的坞文案等于该阶段在 `en` locale 文件里的对应键值；`tool` 阶段文案含工具名 `Bash`。打印读到的文案与期望的 locale 键值逐条对照。
- [x] AC4 同一阶段内 6 秒不轮换（承重）：在稳定阶段（取 `tool` 阶段）内**连续 6 秒每秒读一次**（≥6 个读数，跨度 ≥5000ms），逐字相等。打印 `dock.stable.samples=[…]`。**变异**：把 `label` 改回按已用时间轮换 ⇒ 本 AC 必须红。
- [x] AC5 回合结束坞收起：场景走到 `result`/idle 后，`[data-activity-dock]` 不再渲染（或 `data-activity-state` 为 idle 且坞不可见）。打印 `dock.afterTurn=…`。
- [x] AC6 其它场景不被改变（边界）：新增的调试 agent op 不改变既有 op 语义 —— `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-frames.test.ts` 退出 0；`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts` 退出 0（调试 agent 仍只写方言行）。打印两次调用的结论。
- [x] AC7 墙钟：用例体实测 ≤ `20_000`ms（打印 `dock.wall=…ms`），整次调用在 55s/60s 闸内退出 0。
- [x] AC8 取假形态必须红（承重）：(i) `label` 改回按已用时间轮换 ⇒ AC4 红；(ii) 阶段来源改回本地 `statusText`/本地时钟 ⇒ AC3 的 `Bash` 读数红。逐条记录变异 diff、逐字失败行与恢复命令；任一条没红按「判据有洞」处理，先补判据。
- [x] AC9 静态门与登记：`npm run typecheck`、`npm run lint`、`npx tsc --noEmit -p server/tsconfig.json`、`npx vitest run src/modules/chat/tests/`（坞用例）均退出 0；`'activity-dock-truthful.spec.ts'` 在 `DEBUG_AGENT_SPEC_FILES` 内（AC-184 登记，本处只读确认）；`git diff --stat` 只落在 `## Touches` 列出的文件上（新增文件用 ASCII `(new)`）。

## DoD

- 判据驱动的是**真实服务端、真实应用、真实调试 agent 回合**：坞的阶段读数来自 `npx playwright test` 起的真实 webServer + Vite 客户端 + 调试 agent 场景，不接受 in-page 替身、不接受 stub 掉 socket、不接受由 spec 自己往 DOM 写 `data-activity-state`/阶段文案、不接受把坞读数换成读某个内部 React state。
- **文案来自服务端推来的真实阶段**，不是本地对已用时间的函数：实现里坞的 `label` 不再出现 `Math.floor(elapsedSeconds / 4)` 或任何按时间取词的表达式（用 grep 证明）。
- **工具名来自 `tool_use.name`**，经归约器 → 活动帧 → 坞，一路上没有查找表、没有时间推算。
- **同一阶段内不轮换**：6 秒逐秒读数逐字相等，且该读数在假形态（改回按时间轮换）下会红。
- 调试 agent 的扩展**只写方言行**（ADR-003 decision 7）；`debug-agent-vocabulary-guard.test.ts` 保持绿，产品侧的帧形状仍由产品自己的 normalizer 产出。
- **不得改变其它场景的行为**：既有 op 语义与 `DEBUG_AGENT_ROLES` 既有取值不变；既有调试 agent 判据仍绿。
- 遵守 `.agents/skills/backend-module-standards/SKILL.md`（server/）与 `.agents/skills/frontend-module-standards/SKILL.md`（src/）。
- 只动 `## Touches` 列出的文件；若实现确实需要动别的文件，先把该文件加进 `## Touches` 再写。

## Evidence — 本轮 suite 红的真因（已在本分支修复）

上一轮 fan-in 的 suite 以单文件红收场：`server/modules/session-hosts/tests/session-host-per-run-parity.test.ts` 的 AC4（与 `fixtures/per-run-frame-baseline.json` 逐字节比帧）。真因是本条把 `phase`/`toolName` 合进 `activityAnnouncement`（`server/modules/websocket/services/activity-heartbeat.service.ts`），该公告经 `chat-websocket.service.ts` 展开到 `chat_subscribed` hello 帧；而 AC-155 的基线录制于 host wrapper 之前、provenance 禁重录，不可能持有这两个键。保留日志（`.quay/suite-logs/20261002T180717-1886218/…per-run-parity.test.ts.out`）逐字失败行：`claude/replay: frame differs at #0: baseline {…"pendingPermissions":[]} live {…"pendingPermissions":[],"phase":"idle","toolName":null}`。

修法沿用同族任务 `gap-activity-heartbeat-server-frames` 处理 `bootId`/`rev`/`heartbeatIntervalMs`/`unreachableAfterMs` 的同一处：把这组 activity 公告字段加进 `server/modules/session-hosts/tests/per-run-frame-scenarios.ts` 的 `UNSTABLE_FRAME_FIELDS`。读数：修前该文件 4/5（AC4 红，`EXIT=1`），修后 5/5 绿、`EXIT=0`。

## Touches

- e2e/activity-dock-truthful.spec.ts
- server/modules/debug-agent/debug-agent.scenario.ts
- server/modules/debug-agent/debug-agent.runtime.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/tests/debug-agent-frames.test.ts
- server/modules/providers/provider.registry.ts
- server/modules/providers/index.ts
- server/modules/providers/list/claude/claude-runtime.provider.ts
- server/modules/websocket/services/activity-heartbeat.service.ts
- server/shared/types.ts
- src/modules/chat/utils/activityDockView.ts
- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/hooks/useActivityFreshness.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/shared/types.ts
- src/modules/chat/tests/activityDockPhaseTruthful.test.tsx (new)
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- server/modules/session-hosts/tests/per-run-frame-scenarios.ts
- tasks/gap-activity-dock-phase-truthful.md（自触）
## Needs-Human

**执行 2026-10-02T10:27:05.762Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-audio.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: this run changed the worktree's git status: (empty)
- run_id：wk-prod-anchor
- session_id：fa87fa92-7730-437d-bc86-d50af910a8e3
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-activity-dock-phase-truthful~wk-prod-anchor~1790936635200-beb2a8.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-activity-dock-phase-truthful-wk-prod-anchor.log
