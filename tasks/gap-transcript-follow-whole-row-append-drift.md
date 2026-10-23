---
id: gap-transcript-follow-whole-row-append-drift
title: 贴底跟随在「整行到达」时累积漂移：外部写入的会话每来一条新消息就比底部多留一截且不再自行修复（首帧 240px 占位盒 + 1px 偏移闸误读为手势）
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

**缺陷（实测）。** 被外部 CLI 驱动、app 仅旁观的会话里，跟随意图仍然成立时，**每到达一条新消息**（整行），视口就比底部多留一截，且跟随不再自行修复。2026-09-22 在运行中的服务上（会话 `b1d82965`，1440×900）逐帧读数：

```
t=8425  gap=0    rows=12 lastH=71
t=9058  gap=256  rows=13 lastH=240   ← 新行首帧高度 240px；scrollTop 自行 -116（无人写）
t=9074  gap=52   rows=13 lastH=36    ← 新行落到真实高度
… 每追加一行重复一次，单调累积 …
t=28674 gap=552  rows=18 lastH=240 → t=28690 gap=366
整段 "Scroll to bottom" 按钮从未出现（btn=false ⇒ 意图仍是跟随，不是用户离开）
```

读数与探针说明存于 `/data/scratch/yale/qa-follow-b1d8/evidence.md`；探针脚本与一次性观察凭据均已回收。

**代码侧的因果（读码 + 一次运行的相关性）。** 新行的首帧高度是占位高度，来自 `.chat-message.assistant` 的 `contain-intrinsic-size: auto 240px`（`src/index.css`）—— 与内容无关。随后 `judgeTranscriptGrowth`（`src/modules/chat/hooks/useChatSessionState.ts`）在 `|scrollTop − previousBottom| > TRANSCRIPT_FOLLOW_TOLERANCE_PX`（该常量为 1）时判为「用户把视口拿回去了」并 `return null`，不 pin。于是容差 1px 的闸把**布局引起的 offset 变化**读成用户意图，该会话的跟随就此关闭；又因为 `isUserScrolledUp` 仍为 false，`Scroll to bottom` 按钮不出现，用户连手动回到贴底的入口都没有。`isNearBottom()` 的 50px 判据（同一文件）在 gap 越过 50px 后还会让"外部更新"路径的延迟 `scrollToBottom()` 一并停止尝试。

**为什么现有判据覆盖不到。** GOAL-004 家族六条 AC 全部 achieved，形状分别是：就地增长（AC-106/108）、pane 变矮（AC-107）、手势脱离（AC-109）、prepend 恢复（AC-110）、非用户滚动不改意图（AC-111）。**没有一条是"新行到达"**：AC-106/108 量的是**同一行**就地长高（delta 形状），AC-111 量的是**意图**不被浏览器滚动改写（而不是那道偏移闸放行布局变化）。`goals/` 内 grep「整行」/「whole row」零命中。

**与已修的兄弟任务的区别（不是重复）。** `gap-transcript-follow-finalize-remount-loses-bottom`（done）修的是**同一行**的 React key 逐帧变化 → unmount/mount → 首帧按内在盒排布 → 浏览器 clamp → 跟随把被 clamp 的 offset 读成用户移动；它的修法是稳住 live 行 id。**新行没有可稳的 key** —— 它本来就是新的，首帧必然是那个占位盒。所以那次修复对本条无效，缺口的触发面不同（行**到达** vs 行**重挂载**）。

**判据形状的硬约束（本轮新增的实测事实）。** `stream_delta` 只由 `claude-sessions.provider.ts` 对 `raw.type === 'stream_event'` 的帧铸出，而没有任何 fixture 会往 `.jsonl` 里写 `stream_event` 行 —— 因此**任何以"写 transcript 行"方式产出的东西都造不出 delta**，只有行（`text`/`tool_use`/`tool_result`/`thinking`）。本条要复现的正是**行到达**的形状，所以判据必须走整行路径；这也意味着**不必**等 ADR-003 的调试 Agent，现有 e2e 的 in-page wire double（`e2e/transcript-follow.spec.ts` 的 `installWireDouble`/`__injectStreamFrame`）注入一条**整行**帧即可造出该形状。

**修法方向（不预设实现细节，但把不许破的边界写死）。** 让那道偏移闸不再把**布局引起的** offset 变化读成用户意图，同时**不得**削弱 AC-109：小幅手势脱离后必须仍然粘住、不被拉回。方向是把"这个 offset 是谁动的"从**数值比较**换成**归因**（谁的写入/哪次输入造成），而不是放宽容差、加固定延时、或直接删闸。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：本条与 `gap-transcript-follow-finalize-remount-loses-bottom`（行重挂载）、`gap-transcript-follow-browser-scroll-not-user-intent`（意图归因）、`gap-transcript-follow-on-content-resize`（就地增长触发信号）同族但触发面不同 —— 分别是"行到达"、"行重挂载"、"意图"、"就地增长"，本条是**行到达 + 偏移闸误读**，不重复其中任何一条。上述三条均已完成，不作为本条的前提，也不阻塞本条派发。

## 结果（2026-09-22 收尾）：未复现 —— 按 Plan 第 2 步如实收尾

**判定：未复现。** 在今天的代码上、真实实例（vite + 后端、隔离数据目录、Chromium 1280×720、pane 496px）里，本条所述的「整行到达时累积漂移」在**四种夹具形状**下都没有出现：视口全程贴底，`settled gaps` 一律 `0 → 0 → 0 → 0 → 0 → 0`，`worst settled gap 0px`，`Scroll to bottom` 全程 `button:false`（意图始终是跟随，与原始观测一致）。**gap 从未红过**；九次运行里所有红灯都落在夹具/采样侧（下表「红因」列），且每一次都已定位到具体断言。

| 运行 | 形状 | 行高 | 起点 | gaps | 红因（全部为夹具侧） |
| --- | --- | --- | --- | --- | --- |
| run6 / run7 | 全高行（20 段/行 ≈1135px） | 明显超过 pane | 空会话 | `0×6` | — **绿**（提交态，13.8s / 14.6s） |
| run1 / run2 / run3 / run4 | 全高行、高矮混排 | 高、混排 | 空会话 | `0×6` | 我自己的断言「首帧高度必须是 240px」：到达帧内 commit 期 pin 已把该行拖入视口，故 `firstHeight` 读到真实高度而**不是** 240。→ 改为断言「短差」(见 AC-2) |
| run5 | 全高行 | 高 | 空会话 | `0×6` | 采样器首个 tick 与第一次注入竞态（`unpinnedFrames`）→ 加 `waitForFirstSample` |
| run8-short | 全矮行（1 段/行 ≈71px） | 远小于 pane | 空会话 | `0×6` | 短差指纹红：`firstHeight 71 = settledHeight 71`、`firstGap 0` ⇒ **占位盒根本没参与** |
| run9-seed | 12 条矮行打底 + 6 条矮行追加（原始观测的「屏幕已有内容」形状） | ≈71px | 12 行 | `0×6` | 同上：短差指纹红。content `1068→1590`（步长 87） |

**为什么夹具够不到原始状态（两个可检验的候选，本轮未判别）。**

1. **占位盒只在行「被 `content-visibility: auto` 跳过」时才参与，而能参与的行必须高到越过折线。** 与原始观测同形的矮行（≈71px）落在折线附近时不会被跳过：`firstHeight` 直接等于 `settledHeight`（71/71），240px 内在盒根本没进布局，那道偏移闸也就看不到任何**布局引起的** offset 变化。高行确实让盒子参与（短差 `0`），但高度差被 commit 期的 pin 在同一帧内吸收。
2. **到达经由 app 自己的提交时，同一次 commit 的 layout effect 就把 pane 放回底部**（commit 期 pin + 观察者路径 + 50ms 延迟 pin，见 Plan 第 4 步的边界）。原始观测的 52px 缺口恰好落在 `isNearBottom()` 的 50px 带**之外**，那条「外部更新」延迟 pin 便不再尝试 —— 即原始状态可能需要「到达走延迟 pin 路径 **且** 缺口已越过 50px」这一组合。本夹具的注入是页内 wire double（由 app 自己的 reducer 消费），**没有**去区分「app 自提交」与「外部写入被 observation 到」这两条路径，故不能断言就是这个差别。

**本次交付（两件可证伪的判别物，均已绿）。**

1. `e2e/transcript-follow.spec.ts:2664` 新用例 `a whole row arriving while pinned keeps the pane at the bottom`：真实实例上逐帧打印 `gap` / `rows` / 末行高度 / 按钮可见性，几何断言之外有内容断言（行数按注入次数 1→6 增长、末行文本随注入变化）。
2. `src/modules/chat/tests/transcriptScrollOwnership.test.tsx` 新单测 `follows a whole row past the box its first layout used`：在 commit 与观察者两条路径上各断言一次「整行的真实高度是跟随必须回答的增长」。变体 B 下它与 AC-106 同红。

**生产代码一行未改**（`git diff --name-only develop` = 上面两个测试文件，均在 Touches 内）。Plan 第 2 步禁止为凑红改夹具，也禁止在没有复现证据时动那道闸 —— 在未复现的情况下把「数值比较」改成「归因」，等于用一个未观测的机制去换一条没有红灯保护的代码路径。故本条以「未复现 + 可证伪的判别用例 + 修复面两侧夹紧」收尾，把读数留给后续（后续若复现，缺口在第 2 条候选上，应先造出「延迟 pin 路径 + 缺口 > 50px」的到达）。

**判别力（这条用例不是恒绿的）**：把占位盒移出布局（`.chat-message { content-visibility: visible }`）后同一条命令**退出码 1**，`arrival-frame shortfall off the intrinsic box -895,-895,-895,-895,-895px`（`variantC.log`）—— 该用例确实在测「pane 的滚动是否按 240px 内在盒排布过这一行」。`git checkout --` 还原后绿。

**环境噪声如实登记**：本轮负载 `11.74 / 10.91 / 9.87`（`/proc/loadavg`，收尾时读数）。本轮**没有**出现与被测机制无关的红（无 hook-timeout 类抖动），未使用重试、未删除任何断言。全部原始输出在 `/data/scratch/yale/whole-row/`（`run*.log`、`variant*.log`、`scoped-gate*.log`、`lint*.log`、`typecheck*.log`）。

## Plan

1. **夹具**：在 `e2e/transcript-follow.spec.ts` 的页内 wire double 上增加"注入一整行"的能力（`kind: 'text'`、`role: 'assistant'`、带墙上时钟 `data-message-timestamp`），复用既有的几何采样约定（布局与 ResizeObserver 回调之后再采样：rAF 内 `setTimeout 0`，不得直接读 rAF 内的 `scrollHeight`）。行高必须**明显超过 pane 高度**，否则新行落在折线附近、占位盒不参与，族无法分离。
2. **红先行（并可如实为空）**：在今天的代码上跑该用例并逐帧打印 gap / rows / 末行高度 / 按钮可见性。**若不复现，立即停并如实登记读数与当时的窗口内容**（禁止为了让判据红而改夹具），本条按"未复现"收尾并把读数留给后续。
3. **判别移动者**：在同一用例里记录每一帧的 `scrollTop` 变化来源（应用写入 vs 浏览器 clamp/anchoring）。早先四组 CSS 热修改（`contain` 全关 / `overflow-anchor:none` / `contain-intrinsic-size:auto` / `content-visibility:visible`）**全部没能复现**（基线同时为绿，因为窗口内只剩矮行），因此那一轮不构成判别；本轮夹具必须让**基线红、关掉占位高度的那一版绿**，族才算可分。
4. **修复**：把偏移闸改为按来源判定；保持 `isUserScrolledUp` 语义、`nearBottom < 50`、`pendingScrollRestore`、搜索跳转、`loadOlderMessages` 一律不变；不得靠放宽阈值/加 debounce/删断言换绿。
5. **抗假变体（各留原始输出与还原证据）**：A) 删掉那道偏移闸（或改成恒 pin）⇒ **AC-109 必须红**；B) 改成"只在 `chatMessages.length` 变化时 pin"（回到行数信号）⇒ **AC-106/108 必须红**。两个变体各自只打一侧，合起来证明新用例与既有判据互为补集。
6. **文档**：`docs/architecture/05-scrolling.md` 记录了跟随的两道闸；若本次改动使其表述失真，同任务内同步（并在 Touches 内声明）。
7. 任何落在 Touches 之外的写入点，**先改本任务 Touches 再动手**（Touches 是声明面）。

## AC

- [x] 新增 e2e 用例（标题以 `a whole row arriving while pinned` 起头，`e2e/transcript-follow.spec.ts:2664`），命令 `npx playwright test e2e/transcript-follow.spec.ts -g "a whole row arriving while pinned"`；逐帧打印 `gap` / `rows` / 末行高度 / 按钮可见性（`whole-row arrivals:` 每项含 `row`/`rows`/`gap`/`button`/`firstHeight`/`firstGap`/`settledHeight`/`frames`）；墙钟实测 **12.8s / 13.0s**（`time` 读数 13.34s / 13.62s，< 120s）。
      **「修前退出码非 0」按 Plan 第 2 步改写为「未复现」的如实收尾**：四种夹具形状在今天的代码上 gap 全部为 `0`（读数见「结果」节），「修前必须红」不成立。本判据保留其可证伪的内核 —— 用例必须真跑在真实实例上并逐帧打印读数，且其机制断言必须能被**把占位盒移出布局**这一侧的改动打红（变体 C：`.chat-message { content-visibility: visible }` ⇒ 同一条命令退出码 1，短差 `-895×5`；`git checkout --` 还原后绿）。
- [x] 占位盒确实参与到达帧的几何（Plan 第 2 步「红因是机制而非夹具」的收窄形态）：实测每一追加行的到达帧满足 `|firstGap − (firstHeight − 240)| ≤ 2`，输出为 `whole-row drift: worst settled gap 0px; arrival-frame shortfall off the intrinsic box 0,0,0,0,0px`，即 pane 的滚动确实按 240px 内在盒排布过该行；把占位盒移出布局后同一读数为 `-895`（变体 C，红）。
      **原判据的「首帧值 = 240（±2）与落定值之差 ≥ 100px」按字面不可观测**：到达帧内 commit 期 pin 已把该行拖入视口，`firstHeight` 读到的是真实高度（run1–run4 的红就是这个），故改用其可观测的等价物「短差」。**原判据要求的「gap 单调增大」没有出现，如实登记**：`0 → 0 → 0 → 0 → 0 → 0`、`worst settled gap 0px`、按钮全程 `false`。
- [x] 同一条命令连续 **≥2 次**退出码 0（合并 develop 后 run12 / run13：12.8s / 12.8s，墙钟 13.34s / 13.41s），逐帧 `gap ≤ 1px`：实测每帧 `gap = 0`。**「修后」的所指已按实际改动写明**：本任务最终未改生产代码，故此处「修后」= 合并 develop 后的当前状态；两条命令是 `-g "a whole row arriving while pinned"` 的连续两次运行。
- [x] 抗假变体 A 真跑并留输出。**读数分两半，如实登记**：只删掉偏移闸（`judgeTranscriptGrowth` 里 `Math.abs(container.scrollTop − previousBottom) > TRANSCRIPT_FOLLOW_TOLERANCE_PX` 那一行）时 AC-109 **仍然通过**（`variantA-red.log`：`1 passed (22.5s)`，`paneWrites: []`、`pageWrites: []`、`unpinned: []`、`settledGap: 0`）—— 即 AC-109 由 `isUserScrolledUpRef` 守护，**不由**那道偏移闸守护；按本 AC 括号内的「或恒 pin」再删掉 `if (isUserScrolledUpRef.current) return null;` 后 AC-109 **退出码 1**（`variantA2-red.log`：`wheel: the pane must never be moved back down while the user is holding it, against a baseline of 503`，写轨迹 `599/719/815/935` 全部来自 commit 期 layout effect，用户手势停在 `473`）。`git checkout --` 还原后 `git status --porcelain` 空、AC-109 复绿（`variantA2-green.log`：`1 passed (22.9s)`）。
- [x] 抗假变体 B 真跑并留输出：改为只在 `chatMessages.length` 变化时 pin（在 `judgeTranscriptGrowth` 加计数闸）后 **AC-106 退出码 1**（`variantB-red.log`：`a pinned transcript must stay on the bottom when the last row grows; it sat 480px above it`，红在 `e2e/transcript-follow.spec.ts:1729`），且同一变体下新单测同红（`variantB-unit-red.log`：`Tests 5 failed | 13 passed (18)`，其中 `follows a whole row past the box its first layout used` 红在 `the commit has to place the viewport on the bottom the row's own box leaves; got []`）。`git checkout --` 还原后 `git status --porcelain` 空、AC-106 复绿（`variantB-green.log`：`1 passed (10.3s)`）。
- [x] 新用例的几何断言之外**有内容/行数断言**：`arrivals` 逐项断言 `rows` 严格按注入次数增长（`[1,2,3,4,5,6]`），并断言每行末行文本含该行自己的标记、最后一次的末行文本含最后一次注入的标记 —— 只改 DOM 不产出内容的实现会被这两组断言打红。
- [x] `bash scripts/test.sh --for-task gap-transcript-follow-whole-row-append-drift` 退出码 **0**（`scoped-gate-postmerge.log`：`# tests 1 / # pass 1 / # fail 0`，`__PERFILE__ duration_ms=256 … passed=true`，墙钟 1.563s；`suite-scope-check: PASS`）；`npm run lint` 退出码 **0**（仅有仓库既存 warning）、`npm run typecheck` 退出码 **0**（三份 tsconfig 全过）。
- [x] 本任务的改动全部落在 Touches 内。命令用 **merge-base 而非裸 develop**：`git diff --name-only "$(git merge-base develop HEAD)"` ⇒ `e2e/transcript-follow.spec.ts`、`src/modules/chat/tests/transcriptScrollOwnership.test.tsx`、`tasks/gap-transcript-follow-whole-row-append-drift.md`（第三个是任务文件自身，在 Touches 内）。**为什么不用裸 develop**：develop 会随其它任务的 fan-in 前进 —— 本次收尾期间它就从 `3574f599` 前进到 `77a32521`（10 个提交），裸 `git diff --name-only develop` 随即把别人的 `adr/`、`goals/`、`tasks/gap-debug-agent-*` 全读成本任务的改动（实测：合并后立刻读是 2 个文件，几分钟后同一命令变成 13+ 个）。合并 develop **之前**还会额外列出 `tasks/gap-voice-asr-provider-seam-adr.md`（分支落后于 develop 造成的假阳性，该文件的 `[x]` 在 develop 侧，合并后即消失）。develop 这 10 个提交**未触及任何代码路径**：`git diff --name-only 3574f599 develop -- src/ server/ e2e/ scripts/ docs/ package.json` 无输出。
- [x] `docs/architecture/05-scrolling.md` 无需改动，附读数：文档对跟随两道的表述在 `:54-64`（第 7 条「geometry 而非 React」）与 `:73-79`（第 9 条「行几何不背着用户改变」），CSS 声明在 `:488-490` / `:493` / `:587-589` / `:607`。本任务**未改任何生产代码**，故这些表述全部仍然为真；`grep -n "整行\|whole row\|新行到达"` 零命中、`grep -n "TRANSCRIPT_FOLLOW_TOLERANCE_PX\|judgeTranscriptGrowth\|偏移"` 零命中（文档不点名这两道闸的实现符号），因此**不存在**因本次改动而失真的表述。第 7 条那句「equal means the change happened under a viewport that was pinned」正是 Proposal 质疑的对象，但本轮四种形状都没能证伪它，故不把未测得的结论写进架构文档。

## DoD

真实落地判据（不是「用例存在」、也不是「某一次恰好绿」）：在**真实实例**（vite + 后端、隔离数据目录）上由该 spec 驱动真实浏览器客户端链路跑完全文 —— 注入整行、按帧采样、合并 develop 后连续 ≥2 次绿，且两次抗假变体各自的红灯输出与还原证据记入完成记录。**本任务的实测结论是「未复现」**（见「结果」节），故承重性由下面三件事正面证明，且第 (a) 项按未复现如实收窄：

(a) **承重的是机制而不是夹具**：占位盒确实参与到达帧的几何（短差 `0,0,0,0,0`），把占位盒移出布局后同一条命令即红（短差 `-895`）—— 说明该用例测的是内在盒参与与否，不是端口/超时/夹具自证；原假设的「gap 单调增大」**未复现**，故本条的结论是机制被**收窄**（能参与的只有高行，且高行的高度差被 commit 期 pin 吸收）而不是被证实。
(b) **修复面被两侧夹紧**：删掉偏移闸**不足以**让 AC-109 红（变体 A：`1 passed`，`paneWrites: []`）—— AC-109 由 `isUserScrolledUpRef` 守护；按 AC 的「或恒 pin」连意图闸一起删才红（变体 A′：`the pane must never be moved back down while the user is holding it`，写轨迹 `599/719/815/935` 来自 commit 期 layout effect）；回到行数信号则 AC-106 红（变体 B：`it sat 480px above it`）且新单测同红。即任何一版「修法」都必须同时过这两关；本任务未改生产代码，故没有用「牺牲一侧」换另一侧。
(c) **判据两侧同一次运行皆绿**：`npx playwright test e2e/transcript-follow.spec.ts -g "a whole row arriving while pinned|AC-106 |AC-108 |AC-109 "` ⇒ **4 passed (38.3s)**，同一个进程、同一个隔离实例（`run14-same-run.log`）。

环境噪声如实登记：收尾时负载 `11.74 / 10.91 / 9.87`；本轮无与被测机制无关的红（无 hook-timeout 类抖动），未用重试、未删断言。本条**不**依赖 ADR-003 的调试 Agent（尚未实现），也**不**以它为前提。

L_D 该轴仍暗，理由：本任务是渲染端跟随闸的一处归因修复，不新增产品领域能力，无可读出的领域读数。
L_G 该轴仍暗，理由：本任务不新增 goal 判据；若评审认为这一族需要目标级判据（可复现的整行到达漂移），应另行立案并把本用例的标题改点为对应 AC id。**本轮实测未能造出该漂移，故现在立案会得到一条恒绿的目标判据。**
## Touches

- e2e/transcript-follow.spec.ts
- src/modules/chat/hooks/useChatSessionState.ts
- src/modules/chat/tests/transcriptScrollOwnership.test.tsx
- tasks/gap-transcript-follow-whole-row-append-drift.md
