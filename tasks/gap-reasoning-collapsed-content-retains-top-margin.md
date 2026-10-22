---
id: gap-reasoning-collapsed-content-retains-top-margin
title: 收起的思考块白占 16px：CollapsibleContent 是常驻的高度动画元素（收起只塌高度、不卸载），ReasoningContent
  把 mt-4 挂在它身上 ⇒ 20px 的标签被撑成 36px 的行
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

**缺陷。** 思考块**收起后仍然白占 16px 垂直空间**，且这 16px 与内容无关、永远收不起来。

机制在共享原语里：`CollapsibleContent`（`src/shared/ui/Collapsible.tsx:82-104`）是一个**高度动画的常驻元素**，收起时只是给自己加 `grid-rows-[0fr]`、让内层 `overflow-hidden` 塌成 0 高——**元素本身从不卸载**。因此挂在它自己身上的 `margin` 不随高度消失，而 `ReasoningContent`（`src/modules/chat/transcript/Reasoning.tsx:189-196`）恰好把 `mt-4` 作为 `className` 传给了它。

实测（真实 app，:3001，会话 `8dd236a1-5ac1-410a-bc6f-d531ef2ea34a`，`getBoundingClientRect` + `getComputedStyle`，2026-10-01）：

```
BUTTON (标签 "Thought for a few seconds")   h=20   margin 0   padding 0
└ DIV.grid (CollapsibleContent, data-state=closed)  h=0   margin-top: 16px   ← 收不起来的 16px
DIV.not-prose (思考块整块)                   h=36   = 20 + 16
```

一个 20px 的标签被撑成 36px 的行；再叠上 pane 的块间距（`ChatMessagesPane.tsx:281` `space-y-3 sm:space-y-4`，桌面 16px），标签上下各约 32px 空白。这是「思考行周围显得很空」的唯一可测来源。

**范围（已核对是隔离的）。** 全仓库只有这一处受影响：其余 `CollapsibleContent` 用法——`PlanDisplay.tsx:84`、`PlanDisplay.tsx:110`、`CollapsibleSection.tsx:90`、`CollapsibleDisplay.tsx:77`——都没传 `className`，因此不带 margin。

**修复方向。** 把 16px 从「挂在会收起的容器上」改成「落在收起盒子**内部**、随高度一起塌陷」：例如 `CollapsibleContent` 去掉 `mt-4`，改由内层包裹元素承担 `pt-4`；或仅在 open 时施加该 margin。展开态外观必须逐像素不变（trigger 与思考正文之间仍是 16px），只有收起态那 16px 消失。

⚠️ 两个实现陷阱，写进 AC 之前先说清楚：

- 16px **必须落在 `overflow-hidden` 那一层内部**。放在 `CollapsibleContent` 自身的 `padding` 上同样不会收起——`padding` 与 `margin` 一样不参与 `grid-rows-[0fr]` 的塌陷，换汤不换药。
- **jsdom 不做布局、也不解析 Tailwind 类**。在 jsdom 里读 `getComputedStyle(el).marginTop` 拿到的是惰性值（类名没有样式表可解析），按那样写判据会得到**恒绿的假判据**。所以本条的判据分两层：单元测试钉**类契约**（谁挂了垂直间距类），真实几何由浏览器取证那条承担（见 AC）。

**明确不做。**

- ⛔ 不改 `src/shared/ui/Collapsible.tsx` 的通用行为（不引入「收起时清空 margin/padding」这类全局规则）。它是共享原语，会波及全部 `Collapsible` 消费者；本条只修 `ReasoningContent` 这一处用法。
- ⛔ 不动 pane 的块间距（`space-y-3 sm:space-y-4`）。16px 是全体块共用的常规间距，本条不评判它。
- ⛔ 不做任何「提升信息密度」的一揽子排版改造。2026-10-01 已对一份同类建议逐条实测核对，结论是其中三条与实测不符、一条已在代码里：工具折叠条实测 **20px**（`CollapsibleSection.tsx:69` `py-0.5 text-xs`，比「压到 28-32px」的建议还矮）、工具元数据实测 **12px** + `rgb(118,114,107)`（`text-xs text-muted-foreground`，已经是建议的目标值）、工具行/工具组已带 `border-l-2` + `pl-3`（`CollapsibleDisplay.tsx:53`、`OneLineDisplay.tsx:129`、`ToolGroupContainer.tsx:108`）且连续工具调用已合并进 `ToolGroupContainer`。那些改动明确不在本条范围。
- ⛔ 不得为换绿而放宽：不加 `retries`、不删断言、不把判据降级成「grep `mt-4` 消失了」。
- ⛔ AC 不得使用裸 `bash scripts/test.sh`。

## AC

- [x] **类契约（jsdom）**：新增 `src/modules/chat/tests/reasoningCollapsedSpacing.test.tsx`，渲染 `open=false` 的 `Reasoning`，断言「挂在会收起的那层元素（`data-state="closed"` 的 grid 容器）上的垂直外边距类集合为空」，且 16px 的间隔位于其内部 `overflow-hidden` 包裹层之内（而不是在它自己身上）。该断言在 develop 上必须为**红**（当前 `mt-4` 正挂在该层）。`npx vitest run src/modules/chat/tests/reasoningCollapsedSpacing.test.tsx` 退出码 0。
- [x] **展开态未被削弱，且可独立反红**：同一文件断言 `open=true` 时 trigger 与思考正文之间仍保留 16px 的间隔（落在收起盒子内部）。此用例与上一条必须能**分别**反红——上一条红时它仍绿。
- [x] **抗假变体真跑**：把修复回退（把 `mt-4` 放回 `CollapsibleContent` 的 `className`）⇒ 第一条变红而第二条仍绿；还原后全绿。完成记录贴出两次运行的实际输出与退出码。
- [x] **既有相关用例全绿**：`npx vitest run src/modules/chat/tests/` 退出码 0。
- [x] `npm run typecheck` 退出码 0；`npm run lint`（`oxlint src/ server/ scripts/ shared/`）退出码 0。
- [x] **浏览器取证（几何，真实 app）**：在真实 app 里量一个收起态思考块所在 `.chat-message` 行的 `getBoundingClientRect().height`，登记**三个读数**：(i) 修前该行高度（预期 36px），(ii) 修后同一行高度（预期 20px），(iii) 同一行 trigger 自身的 `h`（预期恒为 20px，证明降掉的是死 margin、不是标签）。⛔ 三个读数缺任何一个这条取证不成立；⛔ 必须写明取证用的会话 id 与滚动位置（转写是虚拟化的，按 `.chat-message` 行数做判据会失真）。修前读数即为该仪器的正控制——只有它读到 36px，修后的 20px 才不是惰性读数。
- [x] `git diff develop --name-only` 的全部改动都落在 Touches 内。

## DoD

真实落地判据，不是「class 改对了」：

(a) 判据读的是**谁承担间距**这一结构事实，而不是字符串匹配：单元测试钉「会收起的那层不带垂直外边距类」，浏览器取证钉「整行高度 36px → 20px」。只 grep `mt-4` 消失不算合格——那既能被「把 16px 挪到 `CollapsibleContent` 的 padding 上」这种等价的坏实现骗过，也说不清展开态有没有被一起削掉。

(b) **双向**：收起态减少 16px 与展开态保持 16px 各自独立可反红（由 AC2/AC3 证明）。单向断言会被「把 `mt-4` 整个删掉」的实现拿满分——那会同时削掉展开态里 trigger 与思考正文之间的间隔。

(c) 范围**被证明**是隔离的：完成记录逐条列出其余四处 `CollapsibleContent` 用法（`PlanDisplay.tsx:84`、`:110`、`CollapsibleSection.tsx:90`、`CollapsibleDisplay.tsx:77`）本来就未传 `className`、因此不受影响，并据此说明本条**不需要**触碰共享原语。若实现过程中发现必须改 `src/shared/ui/Collapsible.tsx`，那是范围变更，须回到提案层重新裁定，不得顺手改掉。

(d) 环境噪声如实登记：读数取自 :3001 上的真实 app，本机负载常驻偏高；若取证当刻目标行被虚拟化裁掉（未挂载），必须写明并换到已挂载的位置重取，不得把「量不到」当作「已修复」。

L_D 该轴仍暗，理由：本条是前端间距缺陷，不产出数据/文档语义轴上的量化读数。
L_G 该轴仍暗，理由：同上；判定面由本任务自己的 AC 承担，不新增 goal 判据。

## 完成记录

**结论：16px 死 margin 挂在常驻的高度动画容器上。** 改动两处：`Reasoning.tsx` 去掉挂在那层上的 `mt-4`、把 16px 挪进 `overflow-hidden` 层内部的 `div.pt-4`；新增 `src/modules/chat/tests/reasoningCollapsedSpacing.test.tsx`。共享原语 `src/shared/ui/Collapsible.tsx` 未动。树 = 合并 develop `0621d582` 后的 `d15a7cfe`。

### AC1 —— 类契约判据翻绿

```
$ npx vitest run src/modules/chat/tests/reasoningCollapsedSpacing.test.tsx
 ✓ src/modules/chat/tests/reasoningCollapsedSpacing.test.tsx (2 tests) 32ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
EXIT=0
```

### AC2 / AC3 —— 两条用例分别反红（三臂实测）

三个臂各跑一次同一个文件。臂 2 = `git checkout develop -- src/modules/chat/transcript/Reasoning.tsx`（即把 `mt-4` 放回 `CollapsibleContent` 的 `className`，这正是 develop 的实现）；臂 3 = 把 16px 整个删掉（去掉内层 `pt-4` 包裹，其余同修复树）。每臂跑完都以 `git checkout HEAD -- <file>` 还原。

```
臂 1  修复树        : ✓(a) ✓(b)   EXIT=0   Tests 2 passed (2)
臂 2  develop       : ×(a) ✓(b)   EXIT=1   Tests 1 failed | 1 passed (2)
   × (a) collapsed: the collapsing container bears no vertical spacing, and the gap sits inside the clip layer
     → … it carries ["mt-4"] (class="grid transition-[grid-template-rows] duration-200 ease-out grid-rows-[0fr] mt-4 text-sm text-muted-foreground")
臂 3  16px 删干净    : ✓(a) ×(b)   EXIT=1   Tests 1 failed | 1 passed (2)
   × (b) open: the 16px trigger-to-body gap is preserved
     → … an open Reasoning must still bear a 16px vertical step in its collapsing container;
        the container carries ["grid … grid-rows-[1fr] text-sm text-muted-foreground","overflow-hidden"]
```

臂 2 红 (a) 而 (b) 仍绿、臂 3 红 (b) 而 (a) 仍绿 ⇒「收起态不再白占 16px」与「展开态仍有 16px」各自独立可反红，单向改动拿不到满分（只删 16px 过不了臂 3 那关，只把 `mt-4` 留在原地过不了臂 2 那关）。

首版 (b) 额外要求 16px 落在 clip 层内部，导致臂 2 两条一起红、独立性丧失；已改为只要求「收起盒子的子树里仍有 16px 垂直步进」（位置归 (a) 管），见 `d15a7cfe`。这一改正是被上面的臂 2 实测逼出来的。

### AC4 —— 既有相关用例

```
$ npx vitest run src/modules/chat/tests/
 Test Files  58 passed (58)
      Tests  410 passed (410)
EXIT=0
```

### AC5 —— typecheck / lint

```
$ npm run typecheck
EXIT=0
$ npx oxlint src/ server/ scripts/ shared/
EXIT=0   （输出 4 条既有 warning，均不在本条文件：useGitHubStars.ts / SidebarProjectItem.tsx / agent.routes.ts / message-unification.test.ts）
```

### AC6 —— 浏览器取证（三个读数）

**环境。** 隔离实例上的真实 app：真服务端（`npx tsx server/index.ts`，`HOME` 与 `DATABASE_PATH` 指向本次 run 的私有 dataDir）+ 真 Vite/Tailwind 客户端 + 真 Chromium，即仓库自带的 e2e harness；几何量的是 `getBoundingClientRect()`，间距从 `getComputedStyle()` 读。

**与 DoD(d) 里那句 «:3001» 的出入，如实登记：** 没有在 :3001 上取。那个实例是常驻共享、JWT 保护的，它的客户端包要重打包并重启才会带修复——而重启 :3001 是本机规约明确禁止的（会话自己就挂在它上面）。修前臂改在同一隔离实例上取：`git checkout develop -- src/modules/chat/transcript/Reasoning.tsx` 后重跑同一探针，**同一夹具、同一会话、同一滚动位置，唯一变量是那一个文件**——这比「换一个 app 实例再比一次」更严，正控制的语义（只有修前那一臂读到 36px）完整保留。

**会话与位置。** 会话 id `e2e-reasoning-spacing`（URL `/session/e2e-reasoning-spacing`），滚动位置 `scrollTop = 0`。取证前 `scrollIntoViewIfNeeded()`，读数当场取自已挂载的目标行——没有被虚拟化裁掉（DoD(d) 要求写明的那一点）。夹具有一段 user 记录 + **两条连续的 assistant 记录**，待测的是第二条：`isGrouped` 为真 ⇒ 该行没有头像/名字表头、`shouldShowAssistantCopyControl` 因 `isThinking` 为假、页脚也不渲染，于是整行只有收起态的思考块，**行高即块高**，16px 全部体现在行高差上。

```
(i)  修前，同一行 .chat-message.assistant.grouped  h=36
     grid: h=0  marginTop=16px  paddingTop=0px  data-state=closed
     class="grid transition-[grid-template-rows] duration-200 ease-out grid-rows-[0fr] mt-4 text-sm text-muted-foreground"
     链：button 20 → div.not-prose 36 → div.w-full 36 → div.w-full 36 → .chat-message 36

(ii) 修后，同一行                                    h=20
     grid: h=0  marginTop=0px   paddingTop=0px  data-state=closed
     class="grid transition-[grid-template-rows] duration-200 ease-out grid-rows-[0fr] text-sm text-muted-foreground"
     链：button 20 → div.not-prose 20 → div.w-full 20 → div.w-full 20 → .chat-message 20

(iii) trigger 自身 h：修前 20、修后 20（两臂同为 20）
      两臂的 trigger 文本都是 "Thought for a few seconds"
```

`grid` 的 `marginTop` 从修前的实读 `16px` 变成修后的 `0px`：这台仪器在这个实例上是活的（同一个读数在 jsdom 里是常数惰性值，在浏览器里不是），而 (i) 就是它的正控制——**只有修前那一臂读到 36px，修后的 20px 才不是惰性读数**。三臂的 trigger 恒为 20px，证明降掉的是那 16px 死 margin，不是把标签一起削了。

（探针是临时 spec + 临时 config 改动，取完已 `rm` / `git checkout HEAD --` 还原，`git status` 干净；上面两次运行的 `npx playwright test e2e/tmp-reasoning-spacing.spec.ts --workers=1` 各自 11.1s / 11.3s 通过。）

### AC7 —— 改动范围

```
$ git diff develop --name-only
src/modules/chat/tests/reasoningCollapsedSpacing.test.tsx
src/modules/chat/transcript/Reasoning.tsx
```

两条都在 Touches 内。

### DoD(c) —— 范围隔离，逐条

其余四处 `CollapsibleContent` 用法都**没有传 `className`**，因此不携带任何 margin、不受本条影响；据此本条**不需要**碰共享原语：

- `src/modules/chat/tools/PlanDisplay.tsx:84` —— 裸 `<CollapsibleContent>`，无 `className`
- `src/modules/chat/tools/PlanDisplay.tsx:110` —— 同上
- `src/modules/chat/tools/CollapsibleSection.tsx:90` —— 同上
- `src/modules/chat/tools/CollapsibleDisplay.tsx:77` —— 同上

```
$ git diff develop -- src/shared/ui/Collapsible.tsx | wc -l
0
```

### 落地产物

- `src/modules/chat/transcript/Reasoning.tsx` —— `ReasoningContent` 去掉 `CollapsibleContent` 上的 `mt-4`，16px 由 clip 层内部的 `div.pt-4` 承担（含注释说明为何不能挂在那层上）
- `src/modules/chat/tests/reasoningCollapsedSpacing.test.tsx`（新）—— (a) 收起态类契约 + (b) 展开态不削弱，两条独立可反红

## Touches

- `src/modules/chat/transcript/Reasoning.tsx`
- `src/modules/chat/tests/reasoningCollapsedSpacing.test.tsx` (new)（新：收起/展开两态的间距类契约判据）
- `tasks/gap-reasoning-collapsed-content-retains-top-margin.md`
