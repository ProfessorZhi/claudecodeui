---
id: gap-ac223-search-jump-reuses-id-window
title: AC-223 搜索跳转复用并取代「全量拉取再放宽窗口」：走与轨道点击同一条 id 寻址窗口读（?around=），判据落
  e2e/transcript-jump-to-turn.spec.ts -g "AC-223"
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-223
---
## Proposal

AC-223 承载 GOAL-017 范围第 4 条「跳转路径复用并取代搜索跳转里『全量拉取再放宽窗口』的做法」，来自 gap-goal-017-exit-clause-nonregression-ac 的 Resolution (ii) 欠账②。AC 记录判据（goal 文件 frontmatter `criterion`）为：文件 `e2e/transcript-jump-to-turn.spec.ts` 存在，且 `npx playwright test e2e/transcript-jump-to-turn.spec.ts -g "AC-223"` 退出 0。当前必红：该用例不存在（`grep -c "AC-223" e2e/transcript-jump-to-turn.spec.ts` → 0，`-g "AC-223"` 报 No tests found）。

现状：

- 实现侧已存在共用入口 `jumpToMessage(anchorId)`（`src/modules/chat/hooks/useChatSessionState.ts:1752`），走 `sessionStore.loadWindowAround(sessionId, anchorId, {before, after})` → `?around=<id>&before&after` 窗口读；轨道点击（`useTurnNavigation.ts:154`）与搜索 effect（`useChatSessionState.ts:1853-1890`）都调它。搜索 effect 把命中的 snippet+timestamp 先经 `resolveSearchTargetAnchorId` 解析成 anchor id，再调 `jumpToMessage`。
- 但没有任何判据断言：搜索跳转确实走了这条路径、且没有第二条「拉全量 → 按 timestamp 放宽窗口 → scrollIntoView」的实现（AC 记录逐字指出：注释在、判据不在）。`grep -c "AC-223"` 为 0。
- 疑似真缺陷（须由判据证实或证伪）：`resolveSearchTargetAnchorId`（`useChatSessionState.ts:171-211`）在 outline 分支里**先按 timestamp 取最近轮次**（184-200 行，`distance < nearestDistance` 严格小于 ⇒ 同毫秒时先出现的那一轮先赢），snippet 分支在其后（202-208 行）。对夹具里同毫秒的第 600/601 两轮，搜索命中第 601 轮（snippet「Turn 601.」唯一、timestamp 与 600 相同）时，outline 的 timestamp 分支会先返回第 600 轮的 id ⇒ 跳转落在孪生第 600 轮。这正是 AC-223 取假形态 (ii)「用 timestamp 而非消息 id 定位」要对红的形态，所以判据必须能在现状上红/绿分明。

要做的事：

1. 在 `e2e/transcript-jump-to-turn.spec.ts` 新增标题含 `AC-223` 的用例，复用该 spec 既有夹具与共用种子 `e2e-transcript-jump`（`seedTranscriptJumpTranscript`：1200 轮、第 600/601 轮同毫秒）与既有读数 helper（`installFetchLog`/`readFetches`、`readTarget` 的「整行可见」读数、`pointAtPane` 等），通过**真实侧边栏搜索 UI** 触发一次跳转（进入会话内容搜索、输入能唯一命中某轮的查询、点击该会话结果按钮 → `onConversationResultClick` 带 timestamp+snippet → 会话对象挂上 `__searchTargetSnippet`/`__searchTargetTimestamp` → 搜索 effect 解析并 `jumpToMessage`）。读三条：(a) 跳转后 fetch 日志里形如 `/messages` 且不带 `around` 的整段读（无 `limit` / `limit=null` / offset 0 形态）0 次，且新增取页请求均带 `around=`；(b) 被跳转那条消息整行落在视口内（沿用 AC-213 的 `readTarget.fully` 与轮次号判别），在 600/601 同毫秒对照上必须落在被寻址的那一轮（判据须含该对照）；(c) 该次跳转的取页请求与轨道点击的取页请求是同一种 `?around=<id>` 窗口读形状（同一入口），且不存在第二份实现——可用 spec 内 node 侧读源文件断言：搜索 effect 经 `jumpToMessage`、跳转链路无 `scrollIntoView` 全量拉取分支；或动态断言两次跳转的请求形状一致且都走 around 窗口读。执行者择一，须机械可判。

2. 让判据绿：若 (b) 的同毫秒对照在当前 `resolveSearchTargetAnchorId` 下红，修解析顺序使 **id 忠实**——snippet/已加载消息命中的具体轮次 id 优先于 timestamp 的最近轮次（timestamp 仅作无 snippet 命中时的回退），保持搜索 effect 仍只调 `jumpToMessage`。若判据本就绿，记录现状即为正确、不做无谓改动。

3. 取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 把搜索跳转改回整段拉取再放宽窗口（如把 `jumpToMessage` 前的窗口读换成裸 `/messages` 全量读）⇒ (a) 红；(ii) 用 timestamp 而非消息 id 定位（如把 `resolveSearchTargetAnchorId` 的 snippet 分支去掉、只留 timestamp）⇒ (b) 在 600/601 对照上红。

4. 守卫不回退：AC-213 v2 既有用例、搜索跳转既有客户端测试（`searchTargetLocator.test.ts`、`transcriptScrollOwnership.test.tsx`）保持绿。

不在本任务内：AC-213/214/…/222 其它判据的改动；不新增种子（除非判据证实需要可搜索的唯一 token——若需，先用 task_write 把 `playwright.config.ts` 加进 Touches）；不改服务端 around 路由。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/transcript-jump-to-turn.spec.ts -g "AC-223"` 退出 0；用例标题含 `AC-223`，真实 Chromium 对真实后端+Vite，夹具与共用种子同 AC-213 v2（`e2e-transcript-jump`）。红态基线：改动前 `grep -c "AC-223" e2e/transcript-jump-to-turn.spec.ts` → 0、`-g "AC-223"` 报 No tests found（逐字记下）。读数：实现后 `-g "AC-223"` EXIT=0，`1 passed (12.0s)`，用例标题 `AC-223 a sidebar search jump reads one around window and lands on the addressed turn`（transcript-jump-to-turn.spec.ts:778:3），全 spec（AC-213 v2 + AC-223）`2 passed (29.9s)`；红态基线逐字：`grep -c "AC-223"` → `0`；对 develop 版 spec 跑 `-g "AC-223"` → `Error: No tests found.` EXIT=1。
- [x] AC2 (a) 不再整段拉取：搜索跳转后 fetch 日志中「`/messages` 且不带 `around` 且无 `limit`（limit=null / offset 0 形态）」的条数为 0；跳转触发的取页请求均带 `around=`（写下请求 URL 清单）。读数：搜索跳转触发的 `/messages` 清单 = `["/api/providers/sessions/e2e-transcript-jump/messages?around=e2e-transcript-jump-1800&before=40&after=40"]`；不带 `around=` 的 `/messages` 条数 = 0（`bareReads=[]`），裸 `/messages`（无 query，即 limit=null/offset=0 形态）0 条。
- [x] AC3 (b) 目标落位：被跳转消息整行落在视口内（沿用 AC-213 的 `fully` 读数与轮次号判别），并在同毫秒 600/601 对照上落在被寻址的那一轮（记下落定的轮次号与高亮所在行）。读数：`readTarget(turn601.id)` 得 `fully=true`、`turnNumber=601`、`highlighted=true`；孪生 600 `highlighted=false`；跳转寻址 id = `e2e-transcript-jump-1800`（第 601 轮 user prompt 的 uuid；第 600 轮为 …-1797）。
- [x] AC4 (c) 同一条路径：断言搜索跳转与轨道点击走同一 `?around=<id>` 窗口读入口，且不存在第二份「全量拉取 → 按 timestamp 放宽窗口 → scrollIntoView」实现（写下所用的机械判据与其读数）。读数：动态——搜索跳转 URL `…?around=e2e-transcript-jump-1800&before=40&after=40` 与随后轨道 tick 跳转 URL 同为该形状（`path` / `hasAround` / `before=40` / `after=40` 逐字段相等）；结构——spec 内 node 读源断言通过：`useChatSessionState.ts` 含 `jumpToMessage(anchorId)`、含 `loadWindowAround(sessionId, anchorId`、不含 `.scrollIntoView(` 调用，`useTurnNavigation.ts` 含 `jumpToMessage(`。
- [x] AC5 取假形态必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 搜索跳转改回整段拉取 ⇒ AC2 红；(ii) 用 timestamp 而非消息 id 定位 ⇒ AC3 的 600/601 对照红。读数：(i) 变异 diff（`useChatSessionState.ts` 搜索 effect 内、`void jumpToMessage(anchorId);` 之前插入）`+        // MUTATION AC-223 (i): the old "pull the whole transcript" read.` / `+        await api.providers.sessionMessages(sessionId, { limit: null, offset: 0 });` → 逐字失败行 `Error: the search jump must not read /messages without an around id; it made ["/api/providers/sessions/e2e-transcript-jump/messages"]`（AC2 断言，EXIT=1）；(ii) 变异 diff `-  if (target.snippet) {` → `+  if (false && target.snippet) {`（只留 timestamp 分支）→ 逐字失败行 `Error: the search jump must highlight turn 601's own row ({"targetPresent":true,"flashTurn":"600"})`（AC3 的 600/601 对照，EXIT=1）。恢复命令（两条同一）：`git -C <worktree> checkout HEAD -- src/modules/chat/hooks/useChatSessionState.ts`，恢复后重跑 `-g "AC-223"` 绿。
- [x] AC6 既有守卫不回退（逐字写读数）：AC-213 v2 用例绿；`npx vitest run src/modules/chat/tests/searchTargetLocator.test.ts src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 绿；`npm run typecheck` 与 `npm run lint` 退出 0。读数：AC-213 v2 绿（全 spec `2 passed`，含 AC-213 v2 16.6s）；vitest `Test Files 2 passed, Tests 34 passed`；`npm run typecheck` EXIT=0；`npm run lint` EXIT=0 —— 上回合 fan-in 时 develop 上该门因既存、且不在本 diff 的 `scripts/activity-dock-human-gate.test.mjs:234:9 eslint(no-unused-vars): Variable 'backTask' is declared but never used` 而 EXIT=1（该文件与 develop 逐字相同、单独 `npx oxlint` 复现同一 error；该 lint 红会连带红掉 7 个 voice `*.false-forms.test.ts` 跨任务守卫，因其 AC 断言 `npm run lint` 退出 0，上回合正因此 exited-not-landed）；本回合合并 develop（`4c0f4fe2` 删除该 dead binding）后 `npx oxlint src/ server/ scripts/ shared/` 0 error、`npm run lint` EXIT=0，7 个 voice `*.false-forms.test.ts` 全部复跑转绿。
- [x] AC7 `git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若实现被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写。读数：`git diff --stat develop...HEAD` = `e2e/transcript-jump-to-turn.spec.ts`、`src/modules/chat/hooks/useChatSessionState.ts`、`src/modules/chat/tests/searchTargetLocator.test.ts`、`src/modules/chat/utils/searchTargetLocator.ts` 四文件，均在本任务 Touches 内；无新增文件、无 Touches 外改动；`tasks/gap-ac223-search-jump-reuses-id-window.md` 由 task_write 自身提交。

## DoD

- 判据在真实浏览器里用真实侧边栏搜索 UI 对真实服务运行；读数来自页内 fetch 日志与目标行几何，不用墙钟、不放宽阈值。
- 搜索跳转真的复用 `jumpToMessage` 这一 id 寻址入口：取页只以 `?around=<id>` 窗口读发生，整段拉取 0 次；同一路径在 600/601 同毫秒对照上落在被寻址的 id（不是孪生）。
- 两条取假形态均实测先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 既有 AC-213 v2 与搜索跳转既有客户端测试保持绿；遵守 `frontend-module-standards`；新增测试文件对其他模块只经 barrel 导入。

## Touches

- e2e/transcript-jump-to-turn.spec.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/utils/searchTargetLocator.ts
- src/modules/chat/tests/searchTargetLocator.test.ts
- tasks/gap-ac223-search-jump-reuses-id-window.md
