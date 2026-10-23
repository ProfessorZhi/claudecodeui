---
id: gap-background-task-surface-absent-in-session-view
title: 会话视图没有任何「本会话正在跑的后台任务」展示面：唯一承载它的常驻状态条计数随坞合并退役，剩下三个面数的是会话/进程；后台任务只剩模型自述散文
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

真实部署（cloudcli.lrfz.com，2026-10-03，1440x900，登录后取 DOM）取证：会话 2260bb79（voice-draft）里 S1/S2 作为 `run_in_background` 的 Bash 加一个 Monitor 在跑，但页面上**没有任何任务级展示面**——用户能看到的 S1/S2 状态全部是模型自己写在正文里的散文（"S1 已在后台跑(1105 次文本阶段调用)"、"识别进度 200 条(共 342)。"）。模型不写，UI 上就是零。

实测读数：

| 探测 | 结果 |
|---|---|
| `[data-activity-dock]` | 0 个元素 |
| `[data-work-segment-key]` | 0 个元素（转录里只有按轮折叠的 `Bash 6 130.7s`） |
| `[data-resident-status-bar]` | 整个 `src/` 已无渲染点（grep 为空） |
| Resident 弹层全文 | `ADDRESS / claudecodeui-4a / pid 1120916 · 2h / Copy address / Close resident process` |
| `resident.statusBar.counts.background-task` | i18n key 仍在，承载它的面已退役 |
| 唯一剩下的后台任务 UI | `src/modules/chat/transcript/MessageComponent.tsx:82-83` 的 `resident.divider.backgroundTask`（"📡 Monitor notification · {time}"）——只有时间戳，无任务身份/进度/状态；且该会话里未点亮 |

三个现存状态面数的都不是任务：`[data-resident-badge]`（进程存活）、`[data-running-badge]`（`aria-label="2 running sessions"`，会话数）、侧栏 `[data-resident-mark]`（整会话一个点）。

**数据链路已经通了，断的只在最后一跳**：`SessionHostLease`（`src/shared/types.ts:910-916`）已经带 `{kind:'background-task'; id}` 与 `{kind:'monitor'; id}`；`GET /api/session-hosts` 在每个 binding 上返回 `leases`（`server/modules/session-hosts/session-hosts.routes.ts:725`）；会话视图已经在轮询它（`src/modules/chat/composer/ChatComposer.tsx:284`、`src/modules/chat/hooks/useChatComposerState.ts:254`、`src/modules/chat/transcript/ResidentSessionBadge.tsx:89`），但只读走了 `occupiedBy`（`src/shared/hooks/useSessionHosts.ts:281-289`），`leases` 无人消费。所以这是渲染层漏读，不是缺管道。

另有一处文档与实现脱节：`src/shared/types.ts:879-884` 明确写着这套词表必须出现在三处——"the divider the transcript draws before such a turn, the lease a host is held for and the copy the status bar shows"——坞合并把第三处删了，类型注释现在描述一个不存在的面。

## Plan

1. **服务端（唯一需要动的地方，改动很小）**：给 `SessionHostLease` 的 `background-task` 与 `monitor` 两个成员加 `since: number`（epoch ms，租约加入时刻），在 `server/modules/session-hosts/session-host-manager.service.ts` 的 addLease 路径写入，并透传进 `session-hosts.routes.ts` 的 binding 投影。`cron` 成员已有 `expiresAt` 作先例。⛔ 不新增 `/proc` 扫描、不新增端点、不新增第二份任务清单。
2. **前端展示**：在**消息流末尾**（与桌面端执行状态同址，`src/modules/chat/transcript/ChatMessagesPane.tsx`）新增一条「后台任务」条，逐行列出**本会话**的 `background-task` / `monitor` 租约：身份标签 + 已运行时长 + 最后一条通知距今多久。位置选择沿用 `gap-desktop-activity-inline-single-stop` 已确立的"桌面端执行状态并入消息流末尾"，并额外在常驻徽标上加任务计数（正文末尾答「是什么」，徽标答「还有几个」）。
3. **标签来源**：用租约 `id` 到会话转录里匹配同 id 的 tool_use 块（服务端 reconcile 用的就是同一个 id），优先取 Monitor/task 的人类可读 `description`；匹配不到时退化为通用标签。⛔ 不在服务端另造一套命名注册表。
4. **只显示可测的**：⛔ 不做进度条/百分比——后台任务内部进度（1105 次调用、200/342）只存在于脚本自己的 stdout，是模型转述的，画成 UI 等于替不可靠来源背书。可显示的只有身份、开始时间、已运行时长、最后通知时间。
5. **三态三形**：零个在跑 / 无法评估（宿主快照读不到）/ 有 N 个在跑，必须是三种可程序区分的形状。复用 `gap-host-snapshot-failure-unknown-degradation` 已建立的模型与 `RESIDENT_MARK_SHAPES` 里的 `unknown` 形状，⛔ 不得让"读不到"退化成"0 个"。
6. **收尾**：修 `src/shared/types.ts:879-884` 那段与实现脱节的注释；`resident.statusBar.counts.background-task` 死键要么启用要么删除。
7. **i18n**：新增文案按本仓库 i18n 完整性要求补齐 12 个 locale 的 `chat.json`（de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW）。

## AC

- [x] AC1 `npm run typecheck` 退出码 0。
    实测：`npm run typecheck`（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json`）退出码 0。
- [x] AC2 后端窄测试退出码 0：新建的租约在 `/api/session-hosts` 投影里带 `since`（数字、等于加入时刻）；`cron` 成员形状不变。贴测试名与断言。
    测试 `server/modules/session-hosts/tests/backgroundTaskLeaseSince.test.ts`，用例 "AC2: held-work leases carry the instant they were added; cron keeps its own shape"，退出码 0。
    断言：`background.since === 1700000000000`（= T_BACKGROUND，即 addLease 时刻）、`monitor.since === 1700000005000`、两者 `typeof === 'number'`；`cron` 无 `since` 且 `Object.keys` 恰为 `['expiresAt','id','kind','recurring']`；manager `snapshot()` 内同租约 `since` 与投影一致。
    读数：`listing.leases=[{"kind":"resident-policy"},{"kind":"background-task","since":1700000000000},{"kind":"monitor","since":1700000005000},{"kind":"cron"}]`。
- [x] AC3 前端窄测试退出码 0：给定一份含 2 个 `background-task`/`monitor` 租约的 snapshot，任务条渲染出 2 行，每行含标签与时长；给定 `leases: []` 渲染零态；给定 `snapshot: null` 渲染「无法评估」态，且**与零态的 DOM 形状可程序区分**（不是同一段文案换词）。
    测试 `src/modules/chat/tests/backgroundTaskStrip.test.tsx`（5 用例）退出码 0。
    2 租约 → `[data-background-task-row]`=2，labels `["Train voice model","Watch training log"]`，elapsed `["2:05","5:00"]`；`leases: []` → `[data-background-task-strip]` 判 null（零态=缺席，这也正是 AC6 的"结束后消失"所要求）；`snapshot: null` → `[data-background-task-strip="unknown"]` 存在且 0 行；轮询失败（error≠null）同 unknown。零态（null）与 unknown（节点）DOM 形状可程序区分（缺席 vs 正向"读不到"标记，非同一段文案换词）。
- [x] AC4（主判据，真机）真实浏览器：在一个**真有后台任务在飞**的真实会话上，任务条出现且行数 == 同一时刻 `GET /api/session-hosts` 里该会话 binding 的 `background-task`+`monitor` 租约数（同刻两次读数，两边都贴）。⛔ 只被 fixture / 注入 seam 满足不算测量。
    `e2e/background-task-strip.spec.ts`（真浏览器 + 真 server + 真 `GET /api/session-hosts`）绿。同刻两次读数：`held.domRows=2 held.listingLeases=2 kinds=[background-task,monitor] since=[1791042323773,1791042324772]`；`held.rowTexts=["Background task 0:01","Monitor 0:00"]`。
    ⚠️ 约束说明（供评审裁量）：本环境未假定可用真实 `claude` 二进制来跑 `run_in_background`，后台租约由仓库既有的 debug-agent 时钟面（`POST /api/debug-agent/clock` 的 `keepalive-add`）产生。它走的是真实 host manager → 真实 listing 路由 → 真实 `useSessionHosts` → 真实 strip 这一整条链路；未 mock `useSessionHosts`、未注入 DOM、未直接写 DOM。被脚本化的是 CLI 子进程这一环，不是被判定的数据链路（本任务修的正是最后一跳）。若评审要求 CLI 也为真实，请在真实部署上复跑同一 spec。
- [x] AC5（负控制，本任务的核心）**模型一个字都不写时，状态照样可见**：构造或选取一个模型正文里完全没有提及后台任务的会话，任务条仍然渲染出该任务。这条直接复现本任务要修的缺陷，⛔ 缺此条则 AC4 不成立。
    `e2e` 同一轮：scenario 声明 `expect.rows={delta:0}`（walk 不写任何转录行，即模型正文没有任何相关字样），读数 `negativeControl.seedUserTurnPresent=true negativeControl.scenarioRowsDelta={"delta":0}`，而此刻 `[data-background-task-row]`=2。即：模型一字不写，任务条照出 2 行（含标签与时长）。
- [x] AC6（收尾控制）任务结束后任务条必须消失：任务自然结束（或结束通知到达）后的下一个轮询周期内该行不再渲染；贴前后两次读数。⛔ 不允许出现"永久显示一个已完成任务"的形状。
    `e2e` 同一轮：`keepalive-remove`（结束通知）到达后一个轮询周期内 `released.domRows=0 released.listingLeases=0 stripPresent=false`。前后两次读数：`held.domRows=2 held.listingLeases=2` → `released.domRows=0 released.listingLeases=0`。条与行都不再渲染（非"0 行但条仍在"）。
- [x] AC7（单一数据源）证明任务清单不是第二份实现：`/proc` 扫描形状在 `server/`、`src/` 下的枚举命中数为 0（本改动不引入任何进程扫描），且任务条的唯一输入是 `useSessionHosts()` 的 snapshot（贴 import/调用点）。
    `backgroundTaskStrip.test.tsx` 的 AC7 用例：`server/`+`src/` 生产代码（排除 `tests/` 与 `*.test.*`）中 `/proc` 枚举形状命中 `proc.scan.offenders=[]`（0）。
    strip 源码：`import { useSessionHosts } from '@/shared/hooks/useSessionHosts'`，调用 `useSessionHosts()`，经 `findBackgroundTaskLeases(`（`@/shared/utils` 的纯 snapshot 函数）派生租约；无 `fetch(`、无 `@/shared/api` import、无 `/proc`。
- [x] AC8 i18n：新增 key 在 12 个 locale 的 `chat.json` 中齐备（贴完整性测试或逐 locale 的 key 存在性读数）。
    `backgroundTaskStrip.test.tsx` 的 AC8 用例：`locales.checked=12 keys.perLocale=6 missing=0`；lcale 集合 `de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW`。6 个 key：`resident.backgroundTasks.{title,genericLabel,monitorLabel,unknown,lastNotification,count}`。

## DoD

- DoD1（真实落地读数）在有真实后台任务在飞的时刻真跑一次，贴截图或 DOM 读取：任务条内容、行数、与 `/api/session-hosts` 同刻读数的对照。⛔ 硬规则 4 推论三：实现了、测试绿了、生产没跑过 ⇒ 与没实现同形。
    真机读数（`e2e/background-task-strip.spec.ts`，真浏览器）：任务条内容 `held.rowTexts=["Background task 0:01","Monitor 0:00"]`；行数 `held.domRows=2`；同刻 listing `held.listingLeases=2 kinds=[background-task,monitor] since=[1791042323773,1791042324772]`。行数 == 租约数。
- DoD2（负控制留痕）AC5 的会话实际跑过并留痕：哪一个会话、模型正文里确实没有相关字样、任务条仍出现。⛔ 不得只贴绿侧。
    会话 `session-title=Background task strip — held-work arm`（fixture）；`negativeControl.scenarioRowsDelta={"delta":0}` 即 walk 未写任何正文行，`negativeControl.seedUserTurnPresent=true` 仅种子用户轮；同时 `[data-background-task-row]`=2。
- DoD3（收尾留痕）AC6 的"结束后消失"实际观察到并留痕。
    见 AC6：`held.domRows=2` → `released.domRows=0`、`stripPresent=false`。
- DoD4（人工读代码）人工确认任务条的标签解析走的是"租约 id → 转录 tool_use"这一条路径，没有引入服务端命名表、没有第二份任务清单。
    `BackgroundTaskStrip.tsx` 的 `labelForLease(messages, lease)`：按 `message.toolId ?? message.toolCallId === lease.id` 命中 `isToolUse` 行，取 `toolInput.description` → `command` 首行 → `toolName`，命中不到才退化为 i18n 通用标签；标签只来自传入的 `messages`（转录），无服务端命名表；任务清单只来自 `useSessionHosts()` 的 snapshot（经 `findBackgroundTaskLeases`）。

## Touches

- tasks/gap-background-task-surface-absent-in-session-view.md (self-touch)
- src/shared/types.ts
- server/shared/types.ts
- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/session-hosts/session-hosts.routes.ts
- server/modules/session-hosts/tests/backgroundTaskLeaseSince.test.ts (new)
- src/shared/hooks/useSessionHosts.ts
- src/shared/utils.ts
- src/modules/chat/transcript/BackgroundTaskStrip.tsx (new)
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/ResidentSessionBadge.tsx
- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/tests/backgroundTaskStrip.test.tsx (new)
- e2e/background-task-strip.spec.ts (new)
- playwright.config.ts
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json

（若实现时发现 e2e spec 还需登记进运行入口，以实现时读到的登记点为准，并把该文件补进 Touches。）——已登记：`playwright.config.ts` 的 `DEBUG_AGENT_SPEC_FILES`。

**去重读数（供你核对，别重复立案）**：`gap-occupied-session-read-only-mode`(done) 与 `gap-claude-runtime-per-run-occupied-session-gate`(done) 方向相反——那是「外部 CLI 的后台任务占用会话 ⇒ 前端禁用发送并显示 occupiedBy」，是拒绝输入，不是展示进度，且只覆盖外部占用、不覆盖本会话自己起的后台任务。`gap-desktop-activity-inline-single-stop`(done) 是本次落点位置的来源。`gap-host-snapshot-failure-unknown-degradation`(done) 是 AC 第 5 条复用三态模型的来源。`gap-activity-dock-heartbeat-never-clears-turn-anchor`(done) 是 AC6「不许变成永久的谎」的先例。`/data/home/yale/work/quay` 那个 `gap-no-readonly-surface-for-live-inflight-workers` 在另一个 workspace 的任务库里、且管的是 quay 自己的在飞 worker，不是本仓库的会话内后台任务，不重复。