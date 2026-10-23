---
id: gap-composer-touch-hint-retired
title: 触摸设备不再显示发送键提示行：还原 `hidden lg:block`（手机省 20px），并把已达成 AC 的判据迁移到新的不变量
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

触摸设备的发送键提示行（`Tap ➤ to send • Return adds a line`）以 `basis-full` 独占 footer 一整行，常驻高度 = `leading-4`(16px) + footer `gap-y-1`(4px) = **20px**，且该行在任何宽度都渲染（`ChatComposer.tsx:612` 的 `touchOnly ? '' : 'hidden lg:block'`）。本任务：触摸设备回到"完全不显示这一行"。

形态沿革（已用 git 核实，不是推测）：

- 2025-07-11 `fc2a94a2` → 2025-11-06 `1e50cfda`：移动端有一个 `absolute bottom-1 left-12 right-14 … sm:hidden` 浮层，**0 高度**、仅在输入框聚焦且为空时显示，且文案是**键盘措辞**（在触摸设备上念 Shift/Ctrl）。
- 2025-11-06 `1e50cfda` 删除了该浮层 → 2026-09-22 `7d842d4c` 之前，移动端**完全不显示** hint（`hidden lg:block`，390px 与 780px 实测 `display:none`）。
- 2026-09-22 `7d842d4c`（`gap-composer-send-key-touch-scoped` 的落地）把触摸 hint 加了回来，形态变成 footer 独占一行 = 20px。**20px 这个形态只存在了 1 天。**

本任务要回退的正是最后这一步。做出该产品决定的理由（写在这里是为了让后来者不必重新论证）：

1. `Tap ➤ to send` 与紧邻的 ➤ 发送按钮完全重复，零信息——点箭头发送是通用约定。
2. `Return adds a line` 只在"行为**违背**预期"时才有价值。`gap-composer-send-key-touch-scoped`（done）的修复恰恰让行为**回到**平台惯例（软回车换行、由按钮发送；同类产品无一例外）。所以它在告诉用户他们本来就默认的事。
3. 唯一受益人群是"已养成回车=发送习惯的存量移动用户"，而那个习惯本身就是被修掉的缺陷；他们的困惑一次按键即自纠正。
4. 代价是**每一台触摸设备、每一次会话** 20px，而移动端是最缺纵向空间的一档。

**关键实现决定（不要做纯 revert）**：若只把类名改回 `hidden lg:block`，`submitHint` 就只剩 `enter`/`ctrlEnter` 两个分支，于是 **≥1024px 的触摸平板（iPad 横屏、Surface）会显示 `Enter to send • Shift+Enter for new line • Tab to change modes`**——软键盘没有 Shift，这正是 `gap-composer-send-key-touch-scoped` 要修的那一类缺陷。而现有 e2e 触摸 leg 只跑 390px，**测不到这个宽度，会静默通过**。因此类名必须是 `touchOnly ? 'hidden' : 'hidden lg:block'`：触摸设备任何宽度都不可见；键盘设备 <1024px 不可见、≥1024px 可见（维持桌面现状）。

行为**不变**：`src/modules/chat/hooks/useSendOnEnter.ts` 与 `src/modules/chat/hooks/useChatComposerState.ts` 的 keydown（约 :1108-1124，触摸设备 Enter 换行、Tab 切模式）**一行不动**。变的只是"要不要把这件事说出来"。

i18n 死键：改动后 `input.hintText.touch` / `touchQueue` / `touchUpdateQueued` 永不渲染（触摸设备整行不可见，键盘设备只走 enter/ctrlEnter 分支），12 个 locale 全删。留着会让"某 key 必须非空"这类判据变成空洞的真。

已达成 AC 的迁移（必须显式记录，不能静默重写）：done 任务 `gap-composer-send-key-touch-scoped` 的 AC-70 与 AC-71 随本次改动失去主体，但**失效方式不同**，处理也不同：

- AC-70（`touchOnly` 真时提示文案不含 Shift/Ctrl，且容器类名不含 `hidden`/`lg:block`）的验证命令是 `npx vitest run src/modules/chat/tests/sendOnEnter.test.tsx`。删掉两条 touch 用例后该文件**仍然退出 0**（键盘四条用例还在）——即命令绿、而其描述的内容已不存在。这是判据空洞，必须换成下面的 AC-1/AC-2，不能拿"文件还是绿的"当证据。
- AC-71（一条未入库的 `node -e` 脚本，校验 12 个 locale 的 `input.hintText.touch` 非空）会**真的变红**。它必须由下面的 AC-4 显式取代。
- AC-72（e2e 触摸 leg 的三条 Enter 行为断言）与 AC-74（抗假变体）**一字不动**：它们证的是行为，与文案无关。这正是本次改动安全的根据——删掉的是行为的**描述**，不是行为的**守卫**。

顺带记录但**不在本任务范围内**（避免范围蔓延）：`input.queue.*`（`QueuedMessageCard` 的文案）在 12 个 locale 里有 7 个整块缺失（de、fr、it、ja、ru、tr、zh-TW），卡片在那 7 种语言下渲染英文 fallback。另外，触摸 hint 删掉后 queue 态仍有两条独立信号（按钮变为 ↑、上方 QueuedMessageCard 显示内容与"会自动发送"），并非无提示。

落位按 `.agents/skills/frontend-module-standards/SKILL.md`。本任务**不新增、不移动任何测试文件**（改写已达成 AC 所钉的文件路径会连带把那些 AC 判红）。

## AC

每条须独立可反红，并在失败信息里打印**实际读数**。

- [x] AC-1 提示分支收敛且键盘四条不回归：`npx vitest run src/modules/chat/tests/sendOnEnter.test.tsx` 退出码 0，键盘四条提示断言（`enter` / `ctrlEnter` / `queue` / `updateQueued`）逐字符等于 `src/modules/i18n/locales/en/chat.json` 的取值；且该文件对 `input.hintText.touch` 的引用数为 **0**（`grep -c` 读数打印）。失败信息须打印实际取到的提示文案与期望的 locale 取值。
- [x] AC-2 触摸设备提示行不可见，且带阳性对照：`npx playwright test e2e/mobile-composer-send-key.spec.ts` 退出码 0，同一次运行内断言三格并分别可反红——(a) 390×844 + touch emulation 下 `div.basis-full` 的 `display === 'none'`；(b) **阳性对照** ≥1024px + touch emulation 下**仍为** `'none'`；(c) **阳性对照** ≥1024px 键盘设备下为 `'block'`。没有 (b)(c)，(a) 对"把 `hidden` 删光"这种惰性实现同样成立（惰性实现也得 0）。失败信息打印三格的 `{viewportWidth, touchOnly, display}` 实际读数。
- [x] AC-3 抗假变体：把类名里的 `hidden` 去掉（`touchOnly ? '' : 'lg:block'`）后重跑该 spec，AC-2(a) 必须变红；还原后全绿，且 `git diff` 只剩本任务声明的写点。
- [x] AC-4 i18n 死键清零，且带阳性对照：一条脚本校验 12 个 `src/modules/i18n/locales/*/chat.json` 均**不含** `input.hintText.touch` / `touchQueue` / `touchUpdateQueued`（任一存在即非 0 退出并打印哪个文件哪个 key），且 12 个文件仍是可解析 JSON；同一脚本对 `input.hintText.enter` 必须报"存在"——证明该检查不是在把一个恒假条件当通过。
- [x] AC-5 行为不回归且前提断言仍在：同一 spec 的触摸 leg 三条 Enter 行为断言（空输入 Enter → 值 `"\n"`；输入文本后 Enter → 值恰好多一个 `\n` 且 `location.pathname` 不变；点 `button[aria-label="Send"]` → `pathname` 变为 `/session/<id>`）与桌面 leg 全绿，且该 spec 的 PREMISE 断言（页内 `matchMedia('(pointer: coarse) and (hover: none)').matches` 为 true、账号偏好为关）**未被删除**。
- [x] AC-6 空间读数（本次改动的目的，现有测试全都测不到）：390×844 下 composer 的 `offsetHeight` 比改动前小 **20px**（±1），与 AC-2(a) 同一次运行内取得。失败信息打印改动前/后两个高度读数。
- [x] AC-7 `npm run typecheck` 与 `npm run lint` 退出码均为 0（`npm run lint` 即 `oxlint src/ server/`；裸 `npx oxlint` 在本仓库预先就有诊断且非 0，不作为判据）。
- [x] AC-8 迁移记录：本任务 Evidence 里逐条写明 `gap-composer-send-key-touch-scoped` 的 AC-70/AC-71 被取代的方式与取代后的判据（即 AC-1/AC-2/AC-4），并且**不改写**那个 done 任务文件里的原始 AC 文本（保留历史真值），只在新任务里记"已取代"。

## DoD

真实落地判据：不是"测试存在"，而是真实浏览器里的三格读数。在**同一次** Playwright 运行内，对 390×844 触摸、≥1024px 触摸、≥1024px 键盘三格各记录 `{viewportWidth, touchOnly, hintDisplay, composerHeight}`，原样贴进 Evidence。

- composer 高度必须**跨改动前后各测一次**（对 `develop` 的一次对照运行，或改动前先取一次基线），证明那 20px 是真的少了，而不是自说自话。
- ≥1024px 触摸那格是本任务的核心风险读数：必须在真 Chromium 下读到 `display:none`，且同一次运行内键盘同宽度读到 `block`。宽度与 touch emulation 必须由同一处配置一起下发（CDP 的 `setDeviceMetricsOverride` 在会话断开后失效而 `setTouchEmulationEnabled` 会留下——`gap-composer-send-key-touch-scoped` 的原型曾因此一度在 1280px 视口下测"触摸设备"）。
- 边界如实标注：触摸来自 Chromium 的 touch emulation，**不是真机软键盘**。"存量用户习惯"这一条是产品判断、无实测数据，必须标注为判断而非读数。
- 既有 e2e 已知坑沿用而非新增：新库首次启动走 onboarding，`beforeAll` 等 `#username` 在负载下约 1/7 概率红在 ~184s（安静时约 11s），按墙钟归因、不要加重试。
- L_D 该轴仍暗，理由：本任务改的是 UI 空间与提示可见性，不产出领域数据或文档语义读数；12 个 locale 的键位完整性由 AC-4 单独机械钉住，除此之外该轴没有可分离的度量。
- L_G 该轴仍暗，理由：同上；本任务的验证读数就是 DoD 里三格 `{viewportWidth, touchOnly, hintDisplay, composerHeight}` 与跨改动前后的高度对照。

## Touches

- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/tests/sendOnEnter.test.tsx
- e2e/mobile-composer-send-key.spec.ts
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
- tasks/gap-composer-touch-hint-retired.md

（若实施中确需改 `playwright.config.ts` 或新增其他文件，必须回到 AC 里补一条对应的判据，否则 Touches 与写入面不符。）

## Evidence

实现 commit：`c954770e`（实现）→ `90f696d9`（e2e 的跨改动对照读数与 AC-1 失败信息）。工作区干净，未提交文件 0 个。

### AC-1 提示分支收敛且键盘四条不回归

```
$ npx vitest run src/modules/chat/tests/sendOnEnter.test.tsx
 Test Files  1 passed (1)
      Tests  8 passed (8)
$ echo $?
0
$ grep -c "input.hintText.touch" src/modules/chat/tests/sendOnEnter.test.tsx
0
$ echo $?
1
```

键盘四条（`enter` / `ctrlEnter` / `queue` / `updateQueued`）逐字符等于 `src/modules/i18n/locales/en/chat.json` 的取值——断言里 `expected` 就是 `enChat.input.hintText.*` 本身，不是重述的字符串；失败信息同时打印 `hint.text` 与 `expected` 两个实际读数。

触摸那条用例（`a touch-only device is shown no hint at any width, and no touch wording survives to be shown`）读四格（idle×偏好关/开、mid-turn 未排队、mid-turn 已排队），每格三项断言：类名含 `hidden`、类名**不含** `lg:block`、文案落在四条键盘措辞集合内（正向陈述：触摸分支已不存在，所以触摸设备解析出来的必须是一条键盘措辞；任何复活触摸分支的写法——包括 `defaultValue` 兜底——都会打印一条不在任何 locale 文件里的字符串）。

### AC-2 / AC-6 同一次运行的三格读数

```
$ npx playwright test e2e/mobile-composer-send-key.spec.ts --reporter=list
CELL touch@390     {"viewportWidth":390, "touchOnly":true,  "hintDisplay":"none",  "hintWidth":0,   "composerHeight":131}
CELL touch@1280    {"viewportWidth":1280,"touchOnly":true,  "hintDisplay":"none",  "hintWidth":0,   "composerHeight":147}
CELL keyboard@1280 {"viewportWidth":1280,"touchOnly":false, "hintDisplay":"block", "hintWidth":842, "composerHeight":167}
  3 passed (22.4s)
```

（同一行还打印了 `hintText`；三格的文案分别是 `Ctrl+Enter to send • …`、`Ctrl+Enter to send • …`、`Enter to send • …`。两格触摸的文案仍在 DOM 里，但 `hintWidth: 0` 是 `display:none` 的第二位独立证人——一个被排版的元素有宽度，被隐藏的没有。）

- (a) 390×844 + touch emulation：`display === 'none'`（改动本身）。
- (b) ≥1024px + touch emulation：**仍为** `'none'`。这是本任务的核心风险读数——纯 revert 在这里会读到 `'block'`。
- (c) ≥1024px 键盘设备：`'block'`，阳性对照——没有它，把 `hidden` 从所有地方删光的惰性实现也能在 (a)(b) 得 0 分。

三格合起来三个方向可反红（见 AC-3 的实测）。

### AC-3 抗假变体

把 `touchOnly ? 'hidden' : 'hidden lg:block'` 改成 `touchOnly ? '' : 'lg:block'`（不是纯 revert，是"惰性实现"那一支）后重跑触摸 leg：

```
$ npx playwright test e2e/mobile-composer-send-key.spec.ts --grep "touch-only device"
CELL touch@390 {"viewportWidth":390,"touchOnly":true,"hintDisplay":"block","hintWidth":348,"composerHeight":167}
Error: a touch-only phone must be shown no hint row at all; the touch@390 cell read
  {viewportWidth:390, touchOnly:true, hintDisplay:"block", hintWidth:348, composerHeight:167}
1 failed
```

(a) 变红，失败信息带着三格读数。还原（`git checkout HEAD -- src/modules/chat/composer/ChatComposer.tsx`，与变异前 `diff` 逐字节相同）后重跑：

```
$ npx playwright test e2e/mobile-composer-send-key.spec.ts --reporter=list
THREE CELLS {…"touch@390":{…"hintDisplay":"none"…"composerHeight":131}…}
  3 passed (22.4s)
```

`git status --short` 只剩本任务声明的写点（`e2e/mobile-composer-send-key.spec.ts`、`src/modules/chat/tests/sendOnEnter.test.tsx`；后者在对齐 AC-1 失败信息后已 commit）。

### AC-4 i18n 死键清零（含阳性对照）

一条未入库的一次性脚本（`/tmp/quay-qcthr-ac4/check-i18n-dead-keys.cjs`——放临时目录是为了让 `## Touches` 与真实写入面一致，不为一条一次性检查新增仓库文件）：

```
$ node /tmp/quay-qcthr-ac4/check-i18n-dead-keys.cjs
locales=12 deadKeys=0 unparseable=0 missingEnter=0
POSITIVE CONTROL input.hintText.enter present in 12/12: de:90 en:85 es:93 fr:108 id:102 it:90 ja:52 ko:55 ru:87 tr:102 zh-CN:45 zh-TW:45
$ echo $?
0
```

反向对照（同一脚本对 `develop` 的改动前树）：

```
locales=12 deadKeys=36 unparseable=0 missingEnter=0
$ echo $?
1
```

12 个文件仍是可解析 JSON（`unparseable=0`），且 `input.hintText.enter` 在 12/12 里都报"存在"——证明这个检查不是在把一个恒假条件当通过。删 key 时 `de`/`fr`/`it`/`ja`/`ru`/`tr`/`zh-TW` 七个文件的三条死键是 `input.hintText` 的**末位**，删行会留下前一行的悬挂逗号，已一并修掉（这也是第一次脚本抛 `SyntaxError: Expected double-quoted property name` 的原因）。

### AC-5 行为不回归

同一次运行内，触摸 leg 的三条 Enter 行为断言（空输入 Enter → 值 `"\n"`；输入文本后 Enter → 值恰好多一个 `\n` 且 `location.pathname` 不变；点 `button[aria-label="Send"]` → `pathname` 匹配 `/session/<id>`）与桌面 leg 全绿。PREMISE 断言仍在其位且未被削弱：页内 `matchMedia('(pointer: coarse) and (hover: none)').matches` 必须为 `true`、`both halves` 必须同时成立、账号偏好必须为关（`PREFERENCE before {"enabled":false}`），另有"本页发出的每个 `GET /api/user/preferences` 都不得报告偏好为开"。这三个前提是"把 1280px 视口测成手机"那类错误会红而不是过的原因。

### AC-7 typecheck / lint

```
$ npm run typecheck   # tsc --noEmit × tsconfig.json / server / scripts
exit 0
$ npm run lint        # oxlint src/ server/ scripts/
exit 0
```

### AC-6 跨改动前后的高度对照

改动前读数**不是**从改动后的树推出来的（渲染它的那串文案已被删除），所以是一次真正的前后各测一次。方法：在本 worktree 里把两个文件退回 `develop` 的版本，用一条一次性探针 spec（`e2e/__baseline-probe.spec.ts`，跑完即删、不入库）以**同一套 `test.use({hasTouch, isMobile, viewport})` 通道**在 390×844 下读实时排版，再 `git checkout HEAD --` 还原：

```
$ git checkout develop -- src/modules/chat/composer/ChatComposer.tsx src/modules/i18n/locales/en/chat.json
$ npx playwright test e2e/__baseline-probe.spec.ts
BASELINE touch@390 {"touchOnly":true,"innerWidth":390,"hintDisplay":"block",
                    "hintText":"Tap ➤ to send • Return adds a line","hintHeight":16,"composerHeight":151}
  1 passed (15.6s)
$ git checkout HEAD -- <同上两文件>     # → 0 paths dirty
```

| | 改动前 | 改动后 | 差 |
|---|---|---|---|
| 提示行 `display` | `block` | `none` | — |
| 提示行高度 | 16px | 0（未排版） | 16px |
| footer `gap-y-1`（行在时才有） | 4px | 0 | 4px |
| **composer `offsetHeight` @390×844 触摸** | **151px** | **131px** | **20px** |

20px 就是"提示行自己的一行 16px + footer 里只在该行存在时才有意义的 4px 间距"，与 Proposal 里预估的 `leading-4`(16) + `gap-y-1`(4) 一致，是实测而非推算。这条读数写进了 spec 的 `COMPOSER_HEIGHT_BEFORE_PX`，断言写成 `|saved - 20| <= 1` 并同时打印改动前/后两个高度，所以常量一旦过时会自己说出来。

**走过的弯路（如实记，供后来者省一次）**：最初想用"对 `develop` 的一次对照运行"来取这个读数，把整份 spec 拷进一个 detached 的 develop worktree 里跑——两次都红在 `openComposer`，因为没有项目。原因不是环境坏了，而是 `playwright.config.ts` 的播种被 `if (isDataDirOwner)` 把着，而 `isDataDirOwner = !process.env.QUAY_E2E_DATA_DIR`：**外部设了 `QUAY_E2E_DATA_DIR` 就等于声明"这个目录我已经播过种了"，播种会被整段跳过**。正确做法是让 config 自己 `mkdtemp`（用 `TMPDIR` 指定落点即可）。另一条弯路是那份 spec 的触摸 leg 要**先断言新行为**才走到高度读数，在改动前的树上行为断言先红、读数一格都印不出来——这也正是最终改用独立探针的原因。

### AC-8 迁移记录：`gap-composer-send-key-touch-scoped`（done）的 AC-70/AC-71

那个 done 任务文件的原始 AC 文本**一字未改**（保留历史真值），此处只记取代关系：

| 原 AC | 失效方式 | 取代判据 |
|---|---|---|
| AC-70（`touchOnly` 真时提示文案不含 Shift/Ctrl，且容器类名不含 `hidden`/`lg:block`） | **命令仍绿、内容已不存在**——验证命令是 `npx vitest run …/sendOnEnter.test.tsx`，删掉两条 touch 用例后该文件照样退出 0。这是判据空洞，最危险的一类。 | **AC-1**：同一文件里改为钉"键盘四条逐字符不回归"+"该文件对 `input.hintText.touch` 的引用数为 0"；**AC-2**：把"触摸设备显示什么"整个搬到真浏览器的三格读数上（类名不再作数，读 computed style）。 |
| AC-71（未入库的 `node -e` 脚本，校验 12 个 locale 的 `input.hintText.touch` 非空） | **真的会变红**（key 被删光），必须显式取代而非静默丢弃。 | **AC-4**：同一条机械检查反向——12 个 locale 均不含三条死键、仍是可解析 JSON，且带 `input.hintText.enter` 阳性对照证明检查不是恒假。 |
| AC-72（e2e 触摸 leg 的三条 Enter 行为断言）、AC-74（抗假变体） | 不受影响 | **一字不动**。它们证的是行为，与文案无关——这正是本次改动安全的根据：删掉的是行为的**描述**，不是行为的**守卫**（AC-5 原样复述了它们）。 |

### 边界如实标注

- **触摸来自 Chromium 的 touch emulation，不是真机软键盘。** 三格读数（含 `(pointer: coarse) and (hover: none)` 为真）都出自 `test.use({hasTouch, isMobile, viewport})` 下发的浏览器上下文，不是一部手机。真机上软键盘弹起还会压缩可用高度，本任务没有实测那一项。
- **"存量用户习惯"是产品判断，不是读数。** Proposal 里"回车=发送的习惯是被修掉的缺陷、一次按键即自纠正"这句没有任何实测数据支撑，按判断标注；本任务实测到的只有空间读数（20px）与三格可见性。
- **本 worktree 额外出现过两个随后即删的文件**：`e2e/__baseline-probe.spec.ts`（改动前基线探针）与 `/tmp/quay-qcthr-ac4/check-i18n-dead-keys.cjs`（AC-4 检查器）。两者都不入库，`## Touches` 与实际写入面一致；提交后的 `git status --short` 为空可核。
- **L_D 该轴仍暗**，理由：本任务改的是 UI 空间与提示可见性，不产出领域数据或文档语义读数；12 个 locale 的键位完整性由 AC-4 单独机械钉住，除此之外该轴没有可分离的度量。
- **L_G 该轴仍暗**，理由：同上；本任务的验证读数就是上面三格 `{viewportWidth, touchOnly, hintDisplay, composerHeight}` 与跨改动前后的高度对照（151 → 131）。
