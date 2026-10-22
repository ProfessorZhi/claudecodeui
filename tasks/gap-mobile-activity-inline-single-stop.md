---
id: gap-mobile-activity-inline-single-stop
title: 移动端执行状态进入消息流末尾（无 Stop、不覆盖消息），只保留右下角主 Stop 一个入口；桌面仍用 composer 上沿 tab 状态
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-mobile-voice-clip-row-below-textarea
---
## Proposal

来源方案：`docs/proposals/mobile-workspace-and-composer-layout.md` 第 4 节（本任务自包含）。仅前端，范围 `src/modules/chat/`。

现状：执行中，`ChatComposer.tsx` 在输入框上沿渲染 tab 形 `ActivityIndicator`（含 Stop 与 Esc 提示），同时右下角 `PromptInputSubmit` 也变成 Stop——移动端出现**两个**可访问名为 Stop 的入口；`ChatMessagesPane` 在 `hasActivityIndicator` 时给消息区底部预留 `pb-12 sm:pb-14` 以避让这块浮层。`ChatInterface.tsx` 已持有 `sessionActivity`（来自 `useChatSessionState`），并把 `hasActivityIndicator` 传给 pane。

目标：

- `<768px`：在 `ChatMessagesPane` 的**消息内容末尾**渲染紧凑状态行（脉冲点、活动文本、elapsed time）。状态行参与正常文档流，**不使用覆盖消息内容的绝对/固定定位**；**不带 Stop**；右下角 `PromptInputSubmit` 是唯一停止入口。composer 上沿的 tab 形 `ActivityIndicator` 在移动端不渲染。
- `>=768px`：继续使用 composer 上沿 tab 形 `ActivityIndicator`，保留现有 Stop 与 Esc 提示；桌面布局与行为不变。
- `ActivityIndicator.tsx` 增加 inline / tab 两种展示 variant；inline variant 不渲染 Stop；**计时与退出动画逻辑只保留一份**，两种 variant 共用，不得复制一份。
- `hasActivityIndicator` 对消息 pane 底部 padding 要区分断点：移动端已有流内状态，不再为浮层预留 48px；桌面端继续预留。
- 权限请求出现时继续隐藏普通活动状态，维持当前优先级（移动与桌面一致）。
- 状态跟随：inline 状态行进入消息流后必须继续触发现有 follow-to-bottom 逻辑；**用户主动向上滚动时不能强行拉回底部**。
- `ChatInterface.tsx` 把现有 `sessionActivity` 传给 `ChatMessagesPane`；**不新增可由它派生的状态**。移动/桌面边界用 `md`（768px），与 `useDeviceSettings().isMobile` 一致，不用 `sm`。

不做：不改中止/排队/发送的业务行为，不改 `sessionActivity` 的产生方式，不改 WebSocket 协议；不碰 header、录音回放与 footer 的其它布局（前序任务负责）。

实施规范：按 `.agents/skills/frontend-module-standards/SKILL.md`（导出组件消费者注释、新增 state 须注释用途、新测试跨模块只经 barrel 导入）。若实现发现跟随逻辑在 `ChatMessagesPane.tsx` 之外的文件里（如滚动 hook），先用 task_write 把该文件补进 Touches 再改。

## AC

- [x] `npx vitest run src/modules/chat/tests/activityIndicatorResponsive.test.tsx` 退出码 0，用例各自独立、失败信息打印实际读数：(a) inline variant 渲染活动文本与 elapsed time，且其子树内**无** Stop 按钮（无可访问名含 Stop 的元素）；(b) tab variant 渲染活动文本与 Stop，且 Esc 提示仍在（桌面不变的正向对照）；(c) elapsed time 随（假）时钟前进，且 inline 与 tab 两种 variant 读到同一份计时来源（同一 `activity.startedAt` 下读数一致）；(d) `activity` 由非空变为 `null` 时按现有退出动画行为收起，inline variant 与 tab variant 行为一致；(e) 移动档 `ChatMessagesPane` 在消息列表**末尾**渲染 inline 状态行（DOM 上位于最后一条消息之后、且位于滚动容器内部），其类名不含 `absolute` 与 `fixed`；(f) 桌面档 pane 不渲染 inline 状态行。
- [x] `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` 退出码 0，新增用例：`activity.canInterrupt=true` 时，把 composer 与 pane 一并渲染的移动档可访问性视图里，可访问名含 Stop 的按钮**恰好 1 个**（且为 `PromptInputSubmit`）；桌面档保持现状（tab 状态 Stop + 主 Stop 的既有读数原样，不得因本任务变化）；存在 pending 权限请求时，两档均**不**渲染普通活动状态（inline 与 tab 都没有）。
- [x] 底部 padding 按断点区分：移动档 `hasActivityIndicator=true` 时 pane 内容底部间距**不含**为浮层预留的 `pb-12`，桌面档仍预留（用例读出两档实际的类名或计算值并打印）。
- [x] 跟随行为不回归：`npx vitest run src/modules/chat/tests/transcriptScrollOwnership.test.tsx src/modules/chat/tests/messageStreamEnd.test.tsx` 退出码 0；并在 `activityIndicatorResponsive.test.tsx` 新增用例——inline 状态行挂载/更新（elapsed 文本变化）时，用户处于底部则继续贴底；用户已主动上滚离底则**零次**程序化写 `scrollTop`（对照：与不带 inline 状态行的同一场景读数一致）。
- [x] 断点边界：`grep -nE '(^|[^a-zA-Z-])sm:' src/modules/chat/composer/ActivityIndicator.tsx` 无命中（退出码 1）；`grep -n 'pb-12' src/modules/chat/transcript/ChatMessagesPane.tsx` 的命中行都带 `md:` 前缀或在桌面分支内（逐行核对）。这是机制层辅助闸，不变量由 DoD 的真浏览器读数证明。
- [x] `npx vitest run src/modules/chat` 退出码 0（既有 chat 测试不回归）；`npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 是 `oxlint src/ server/`；裸 `npx oxlint` 预先非 0，不作判据）。

## DoD

真实落地判据：不是「测试存在」。要求对一个**真实执行中的会话**（或经既有 e2e 约定的 in-page WebSocket 替身喂入的真实 realtime 帧——伪造传输层、绝不伪造消费者，见 `e2e/transcript-follow.spec.ts`）在真浏览器里读出并写进 Evidence：

| 视口 | 可见且可访问的 Stop 个数 | 状态行相对最后一条消息的位置 | 消息正文是否被状态行覆盖 | 状态行是否随消息滚动 |
|---|---|---|---|---|
| 390×844 执行中 | 必须恰 1 | 紧随最后一条消息之后（文档流内） | 必须否（状态行与最后一条消息的边界框不相交） | 必须是（滚动后其 `getBoundingClientRect().top` 随之变化） |
| 320×700 执行中 | 必须恰 1 | 同上 | 必须否 | 必须是 |
| 767×900 执行中 | 必须恰 1 | 同上 | 必须否 | 必须是 |
| 768×900 执行中 | 主 Stop + tab 状态 Stop 与改动前读数一致 | composer 上沿 tab | — | — |
| 1280×720 执行中 | 同上 | 同上 | — | — |

另读：390 下发起一个权限请求时，普通活动状态消失（inline 状态行不在 DOM 里），权限提示可见；向上滚离底部后再来一段流式输出，页面**不被拉回底部**；活动结束后 inline 状态行按退出动画收起、pane 底部间距回落。「可见且可访问的 Stop」必须用可访问性树（`getByRole('button', { name: /stop/i })` 且可见）计数，不得用类名或 `querySelectorAll` 估算。

读数如实标注边界：一次性探针不入库；永久回归矩阵由同一方案的 e2e 矩阵任务承担，本任务不宣称已覆盖；若执行态由传输层替身喂入，须在 Evidence 里写明喂了哪些帧、没伪造什么。

L_D 该轴仍暗，理由：本任务改的是活动状态的呈现位置与一个 variant，不产出领域数据或文档语义读数。

L_G 该轴仍暗，理由：同上；验证读数就是 DoD 里真浏览器的 Stop 计数与状态行边界框读数。

## Touches

- src/modules/chat/composer/ActivityIndicator.tsx
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/activityIndicatorResponsive.test.tsx (new)
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- tasks/gap-mobile-activity-inline-single-stop.md

## Evidence

真实浏览器读数（一次性探针，**不入库**）。执行态由既有 e2e 约定的 in-page WebSocket 替身喂入：
`addInitScript` 包裹 `window.WebSocket`，记录 `window.__wireSockets`，经 `__injectFrame` 投递
**真实 realtime 帧**给消费者本身。喂入的帧只有两类，均为服务端会真实下发的形状：

- `chat_subscribed`（`isProcessing: true` / `pendingPermissions: []`，再投一次带 `pendingPermissions:
  [{requestId, toolName}]`）——即服务端对 `chat.subscribe` 的真实 ack；
- `complete`——统一终局事件，`onSessionIdle` 据此删掉 processing 条目。

**没有伪造消费者**：界面、`useSessionProtection` 的 processing map、`ActivityIndicator`、滚动跟随
全部是应用自己的代码。另用 `page.route` 把 `GET /api/providers/sessions/running` 应答成服务端的真实信封
`{success:true,data:{sessions:[{sessionId,provider,lastSeq}]}}`，让 5s 轮询维持运行态；未伪造 `startedAt`
（由上面的 `chat_subscribed` 帧提供，故计时来源仍是运行自己的时钟，而不是探针编的）。该路由在本轮被命中
3 次（`runningPollHits=3`）。会话为 e2e 既有种子 `e2e-transcript-follow`，经 `/session/<id>` 门进入。

Stop 计数一律走**可访问性树**：`page.getByRole('button', { name: /stop/i })` 且逐个 `isVisible()`，
**未用类名或 `querySelectorAll` 估算**。状态行定位读 `getBoundingClientRect()` 与
`compareDocumentPosition`。每个视口读数前把 pane 底部对齐（`scrollTop = scrollHeight`），使读数描述
读者到达时的布局，而不是上一格滚动遗留的位置。

### DoD 矩阵（真实执行中的会话）

| 视口 | 可见且可访问的 Stop | 状态行位置（相对最后一条消息） | 覆盖消息正文 | 随消息滚动 |
|---|---|---|---|---|
| 390×844 | 1（`["Stop"]`，即 `PromptInputSubmit`） | 文档流内、`inlineTop=673.0` > `lastRowBottom=661.0`、`messageRowsAfterInline=0`、`inPane=true`、定位类 `[]` | 否（`overlap=false`） | 是（`673.0 → 913.0`，滚动 −240 后） |
| 320×700 | 1（`["Stop"]`） | `inlineTop=529.0` > `lastRowBottom=517.0`、`rowsAfter=0`、`inPane=true`、`[]` | 否 | 是（`529.0 → 769.0`） |
| 767×900 | 1（`["Stop"]`） | `inlineTop=717.0` > `lastRowBottom=701.0`、`rowsAfter=0`、`inPane=true`、`[]` | 否 | 是（`717.0 → 957.0`） |
| 768×900 | 2（`["Stop","Stop"]`，主 Stop + tab 状态 Stop） | composer 上沿 tab（`tabPresent=true`，pane 无 inline） | — | — |
| 1280×720 | 2（`["Stop","Stop"]`） | 同上 | — | — |

pane 底部 padding：390/320/767 读作 `[pb-3]`（无 `pb-12`）；768/1280 读作 `[pb-12]`。`innerWidth` 读数
390/320/767 → 移动档，768/1280 → 桌面档，边界落在 `md`(768)。

### 另读

- **权限优先（390）**：投递带 `pendingPermissions` 的 `chat_subscribed` 后，inline 状态行在 DOM 中 0 个
  （`inlineRowsInDom=0`），权限提示可见（`"Permission required"` 节点 1 个）；主 Stop 仍 1 个。
- **上滚后不被拉回（390）**：向上滚离底部后追加流式输出，`scrollTop 4279 → 4279`（**未变**），
  `gap 2056 → 2536`（内容在视口下方生长），期间程序化写 `scrollTop` **0 次**。
- **结束收起（390）**：`complete` 帧后状态行立即带 `chat-activity-exit` 类（读到
  `... text-muted-foreground chat-activity-exit`），随后从 DOM 消失（`inlinePresentAfterExit=false`）；
  pane 底部 padding 前后均 `[pb-3]`（移动端本就不为浮层预留）；`scrollHeight 7483 → 7443`（状态行高度离开
  文档流）。对照：同一场景下流内没有状态行时，内容生长引起的程序化 `scrollTop` 写同样为 0 次。

边界如实标注：**一次性探针不入库**（脚本与 config 副本已在读数后删除，工作树 `git status` 干净）；
**永久回归矩阵由同一方案的 e2e 矩阵任务承担，本任务不宣称已覆盖**。上表的三条移动档读数即 DoD 要求的
「可见且可访问的 Stop 计数 + 状态行边界框读数」。

### 单元/静态闸读数

- `npx vitest run src/modules/chat/tests/activityIndicatorResponsive.test.tsx` → 9/9 通过（(a) inline 无 Stop、
  (b) tab 有 Stop 与 Esc、(c) 两 variant 同一 `startedAt` 计时、(d) 同一退出动画、(e) 移动档末尾流内状态行
  与 767/768 边界、(f) 桌面档 pane 无 inline、`the pane reserves the floating tab's space only from md up`、
  `growth from the status line reads exactly as growth from any other row`）。
- `npx vitest run src/modules/chat/tests/chatComposerResponsive.test.tsx` → 12/12 通过。
- `npx vitest run src/modules/chat/tests/transcriptScrollOwnership.test.tsx src/modules/chat/tests/messageStreamEnd.test.tsx`
  → 20/20 通过。
- `npx vitest run src/modules/chat` → 47 文件 / 359 用例通过。
- `npm run typecheck` → 退出码 0；`npm run lint` → 退出码 0（仅既有 warning）。
- `grep -nE '(^|[^a-zA-Z-])sm:' src/modules/chat/composer/ActivityIndicator.tsx` → 无命中，退出码 1。
- `grep -n 'pb-12' src/modules/chat/transcript/ChatMessagesPane.tsx` → 唯一命中
  `193:  const paneBottomPadding = hasActivityIndicator && !isMobile ? 'pb-12 md:pb-14' : 'pb-3 sm:pb-4';`，
  桌面分支且带 `md:`。

## 完成记录

- 在既有工作树 `gap-mobile-activity-inline-single-stop`（分支 `task/gap-mobile-activity-inline-single-stop`）上继续：
  复用前一轮的 2 个提交（`ActivityIndicator` 的 inline/tab variant、pane/interface 接线与测试），未重做。
- 前一轮 `ChatComposer.tsx` 里遗留的一行未提交改动（把 tab 的 `!hasPendingPermissions` 守卫去掉）已还原 ——
  它与 AC-2 的「存在 pending 权限请求时两档都不渲染普通活动状态」直接冲突，且 develop 侧
  `docs/operations/process-isolation-and-memory-caps.md` + `tasks/gap-vitest-worker-heap-limit.md` 记载该改动
  正是 2026-09-25 `chatComposerResponsive.test.tsx` 跑到 218G 触发 OOM 的复现输入。
- 6 条 AC 逐条以命令读数核对通过，读数写入 `## Evidence`。
- `L_D` / `L_G` 两轴仍暗，理由见 DoD。
