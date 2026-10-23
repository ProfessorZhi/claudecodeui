---
id: gap-ac179-criterion-anchor-retired-by-dock-consolidation
title: AC-179 判据读数锚 [data-resident-status-bar] 被活动坞合并退役，判据死在正信号等待 30s 超时；换锚到
  [data-activity-dock] 并把恒真的「状态条不在滚动盒内」腿改写成行级读数
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-179
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rln '^goal_ac: *AC-179' tasks/*.md` → 只命中 `tasks/gap-resident-status-bar-covers-transcript.md`，其 `status:` 逐字为 `done` —— 按规则 **done 不是重复，而是「上一次的修法没兜住」的证据**；在飞任务扫描（逐份读 `tasks/*.md` 的 `^status:` 与 `^goal_ac:`）→ 全库在飞且带 `goal_ac` 的只有 `gap-activity-dock-human-gate.md`（AC-190）与 `gap-ac175-criterion-anchor-retired-by-dock-consolidation.md`（AC-175），**无一为 AC-179** ⇒ 无在飞认领者，本条不是重复。

**机制相近但不相交的邻居（逐条读过，各自认领自己的 AC）**：`gap-ac172-…` / `gap-ac177-…` / `gap-ac178-criterion-anchor-retired-by-dock-consolidation.md`（三条皆 **done**，分别是 AC-172 / AC-177 / AC-178 的换锚收尾，读各自 `-g` 命中的 test；`gap-ac178-…` 的任务体逐字写着「**不**修 AC-177 / AC-179 / AC-175」，把这三条留给各自 AC 的范围）；`gap-ac175-criterion-anchor-retired-by-dock-consolidation.md`（**ready**，AC-175，读的是 `e2e/resident-busy-send.spec.ts:80` 的 `const BAR = '[data-resident-status-bar]'` 与会话内「忙」读数 —— **另一个文件、另一条 AC**，本条不碰）；`gap-activity-single-dock-global-consistency`（done，就是做这次坞合并的那条，范围是产品面的合并本身）。同机制扫描：`grep -rln 'data-activity-dock' tasks/*.md` 命中的都是别的读数面，没有一份是「把 AC-179 的读数锚回灌到 `e2e/resident-ui-layout.spec.ts` 的 `status bar does not cover the transcript` 用例」。

**判据物（逐字取自 `goals/AC-179-常驻状态条不压住对话文字.md`）。** `criterion:` = `npx playwright test e2e/resident-ui-layout.spec.ts -g "status bar does not cover the transcript"`（命令逐字含文件路径与 `-g` 过滤）。`expect` 逐字：「视口 780x493 下已常驻会话有一条助手消息时，状态条的边界框与该消息文字块的边界框不相交，且消息文字块在视口内可见。正控制：非常驻会话没有状态条，同一消息读数可见。取假形态：状态条改成绝对定位盖在消息上 ⇒ 必须红，且红落在边界框相交读数上。」`origin` 逐字：「人 yale 2026-09-29 指令「现在建」。来源：同日验证截图里 Resident Idle 状态条压在 Claude 消息行上。」

**红态基线（本轮直接重跑判据本身，读它自己的失败输出，不读台账 `reason` 的 stderr 尾巴）。** 命令同上 → **EXIT=1**，wall 36.6s，失败逐字：

```
Error: a resident session must draw the bar this reading is about
expect(locator).toBeVisible() failed
Locator: locator('[data-resident-status-bar]')
Expected: visible   Timeout: 30000ms   Error: element(s) not found
  > 620 |       .toBeVisible({ timeout: 30_000 });
     at /data/home/yale/work/claudecodeui/e2e/resident-ui-layout.spec.ts:620:8
```

即判据死在**正信号等待**处，一个几何读数都没取到。同一轮 stdout 证明这不是启动期那条老路：`resident.session=…` / `resident.session.lifecycle_mode=resident`（API 已读回常驻）、`[e2e] client startup: the transcript pane for session … landed after 2281ms (attempt 1)`（有界预热与探针工作正常）。

**因果括号（台账时间戳 vs 提交时间；`criterionHash` 三次相同 = 判据文本一字未动，动的是环境）。**

- `2026-10-02T08:25:53.661Z` — goal-sweep **pass**（`.quay/gate-events.jsonl` 里 AC-179 最后一次绿，`payload.criterionHash: edb17e89aa4dc2dd`）
- `2026-10-02 16:29:56 +0800` = `08:29:56Z` — `e3f86d82`：develop 上**第一个**含 `ad1bb63a` 的提交（`git rev-list --ancestry-path ad1bb63a..develop --reverse | head -1`），即坞合并进入 develop 的时刻
- `2026-10-02T11:51:15.845Z` goal-sweep **fail**（首个红）、`11:55:55.694Z` goal-cli **fail**，两次 `criterionHash` 仍是 `edb17e89aa4dc2dd`

⇒ 绿 → 落地 → 红，括号闭合。判据文本未改（hash 相同）⇒ 动的是它寻址的那个标记。

**机制。** `ad1bb63a`（`activity dock: one dock, one source, one answer`，作者时间 `2026-10-02 15:40:33 +0800`）把常驻状态条并进活动坞：`ResidentStatusBar` 的 `data-resident-status-bar="true"` 被整体删除。本轮实测：`grep -rn 'data-resident-status-bar' --include=*.tsx --include=*.ts src/ server/ shared/ | grep -v '/tests/'` → **0 命中**（排除 worktrees），全仓只剩 5 处，全部是**量具**而非产品：`e2e/resident-ui-layout.spec.ts:30`（本条）、`e2e/resident-busy-send.spec.ts:80`（AC-175 的 ready 任务）、`src/modules/chat/tests/residentStatusBarClearsTranscript.test.tsx:60` 与 `e2e/activity-dock-truthful.spec.ts:930`（两处都是**「这些标记必须匹配不到任何东西」的退役清单**，故意保留）、`src/modules/chat/tests/hostSnapshotFailure.test.ts:159`。

**为什么这不是产品回归，而是「量具跟着产品走」的收尾 —— 本轮探针实测（不是推断）。** 把 `e2e/resident-ui-layout.spec.ts:30` 的模块级 `const BAR` 指向合并后的坞（`'[data-activity-dock]'`），其余一字不动 →

- 第 1 次：判据 **EXIT=1**，红**不在**相交读数上，而在自加的那条机制腿上 —— 逐字 `Error: the status bar must not be drawn inside the transcript's scroll box; bar.box=305,313,459,32 pane.box=289,57,491,289`（spec `:664`，`Expected: false / Received: true`）；同一跑里 `resident.intersect=false` / `resident.msg.visible=true` / `resident.msg.in.pane=true`。
- 第 2 次（只把那条机制腿临时放宽，其余一字不动，为了让读数跑到控制臂）：判据 **EXIT=0**，`1 passed (13.5s)`，`elapsed=13467ms` < `SINGLE_SPEC_CEILING_MS = 55_000`。两臂读数一次取全（`printReading` 原始行）：resident 臂 `bar.exists=true` / `bar.box=305,314,459,32` / `msg.box=305,195,459,87` / `intersect=false` / `msg.visible=true` / `msg.in.pane=true` / `bar.over.pane=true` / `msg.count=1` / `pane.box=289,57,491,289` / `viewport=780x493`；per-run 臂 `bar.exists=false`（计数 0）/ `msg.box=305,207,459,87` / `msg.visible=true` / `msg.in.pane=true` / `bar.over.pane=false`。两次探针改动已用 `/tmp` 备份 + `sha256sum` 校验还原（`e2e/resident-ui-layout.spec.ts` = `c3aeba3b0db6e3d3b6b57e04288c3e43da4f73f801c664811784c7a141c68824`，`git status --porcelain` 该文件为空）。

⇒ **AC-179 的保证仍然成立**：坞的边界框与助手消息行不相交（`intersect=false`）、消息完整在视口内（`msg.visible=true`）、per-run 会话不画它（计数 0）。真正失效的只有两处**量具**：(1) 正信号锚 `[data-resident-status-bar]` 已退役；(2) 该用例自加的机制腿 `barOverPane`（`overlaps(barBox, paneBox)`）**对合并后的坞恒真**——坞由 `ChatComposer.tsx:538` 渲染在 `className="pointer-events-none absolute bottom-full left-1/2 z-10 …"` 的包装里，`absolute bottom-full` 的语义就是「悬在输入框上沿之上、盖住 transcript 的末尾」，这是合并时**有意**的设计（同处注释逐字：`it hangs over the top edge of the input and, being out of flow, over the last of the transcript`）。所以「状态条不得画在滚动盒内」这条腿在合并后的产品上**没有可满足的世界**：留着它，判据只能靠改产品（把坞从悬停位挪走）才绿，而那会推翻坞合并本身并打到别的坞判据。

**探针未覆盖、必须由本条实测补齐的一条。** `barOverPane` 当初是「通用伪造器」（上一轮完成记录逐字：修前的 `sticky` 浮层形态红在它上面 —— `bar.box=305,114,459,46 pane.box=289,86,491,224`，`intersect=false`，因为那个形态压住的是**别的行**）。换锚后这条腿必须被一条**在合并后世界里可满足、且仍能否证原形态**的读数替代，否则要么恒红、要么把伪造器一起丢掉。候选（本条要实现的那条）：把读数从「坞与 pane 盒」下移到**行级**——断言 pane 内**最外层**的每一条消息行的边界框都不与坞的边界框相交（不是只断最后一条助手行）。原 `sticky` 形态（条画在滚动盒里、悬在行上）会被它抓到；合并后的坞（悬在 pane 底边、行止于 pane 底部内边距之上）不会。这一点必须由**两个负控制真跑真红**来证明，不能靠推理。

**修法（最小充分，不发明新机制、不往生产里补死契约）**：把 AC-179 用例的读数锚换到合并后坞里等价的那个面（`[data-activity-dock]`，与 AC-177 / AC-178 换锚后读的是同一个根），并把那条恒真的机制腿改写成上面说的行级读数；AC 逐字要求的相交 / 可见 / 正控制三条断言**一字不改**。⛔ **不**为兼容旧标记往生产代码里补一个 `data-resident-status-bar`（`gap-ac178-…` 那条已完成任务已明文禁止，那会把一次换锚变成往生产里加回死契约）。⛔ 不修 AC-175（`e2e/resident-busy-send.spec.ts:80` 的同因红）与 AC-177 / AC-178 的用例。

## Plan

1. **量红态（已在本轮立案前完成，读数见 Proposal）。** 判据直接重跑 → EXIT=1 / 死在正信号等待；换锚探针 → EXIT=1 只剩 `barOverPane` 一条；放宽该腿 → EXIT=0 且两臂读数齐。执行前自己复跑一次确认红形态仍如上（工作树须干净）。
2. **换锚。** 把 `e2e/resident-ui-layout.spec.ts:30` 的模块级 `const BAR` 从退役的 `'[data-resident-status-bar]'` 改为 `'[data-activity-dock]'`，并把它上面那行注释（现在写的是「AC-172 的 DOM 契约」）改成如实描述：坞的根，合并后承载常驻会话事实的那个面。⚠️ 该常量被 AC-177 用例在 `:1067` 用局部 `const BAR` 遮蔽、被 AC-178 用例同样遮蔽 —— 改模块级常量**不会**动到那两条用例的读数；逐行核对确认本用例（`:575`–`:780`）内 `BAR` 的引用只有 `:619` 与 `:674` 两处。
3. **改写那条机制腿。** 把 `:660`–`:664` 的 `expect(residentReading.barOverPane, …).toBe(false)` 换成行级读数：在 `readGeometry` 里把「坞与 pane 盒相交」换成「坞与**任一最外层消息行**相交」的读数（例如 `barOverRows` / `rowsOverlapped`），并断言为空。读数仍由同一次 `getBoundingClientRect` 一次取全；`printReading` 同步印新读数（让红可直接归因）。**不得**顺手削弱别的断言：AC 的三条承重断言（`intersect=false` / `msgVisible=true` / `perRunBarCount=0`）文本逐字保留。
4. **负控制一（AC 逐字要求的假形态）**：把坞的包装改成绝对定位**盖在消息上**（等价于 origin 截图形态）⇒ 判据必须红，且**红落在 `intersect` 那条读数上**（不是行级腿、不是别的腿）；登记变异 diff、逐字失败行、退出码；还原后复绿。
5. **负控制二（证明新的行级腿不是恒真）**：把条放回 `.chat-messages-pane` 的滚动子树内（修前的 `sticky` 形态，或等价最小变异）⇒ 判据必须红，且这次红**落在新的行级读数上**（因为该形态压住的是别的行，`intersect` 可能仍为 false —— 这正是上一轮留下那条腿的原因）。登记变异 diff、逐字失败行、退出码；还原后复绿。
6. **两臂对照**：同一次运行里打印 resident 臂与 per-run 臂的坞计数（应 `1` / `0`），证明新锚有区分力，不是「两臂都空」的假绿。
7. `npm run lint` / `npm run typecheck` 绿；`git diff --stat` 与 Touches 逐条对齐；写完成记录。

## AC

- [x] AC1 判据翻绿：`npx playwright test e2e/resident-ui-layout.spec.ts -g "status bar does not cover the transcript"` 退出 **0**（命令逐字不改），且用例自报 `elapsed=NNNNms` < 55_000（不触发 `SINGLE_SPEC_CEILING_MS`）。验证：`echo $?` + stdout 的 `1 passed` 与 `elapsed=` 两行逐字登记（本轮探针读数：`elapsed=13467ms`）。
- [x] AC2 读数锚不再指向退役标记：AC-179 用例区间内 `[data-resident-status-bar]` 命中数 = **0**。验证：`awk 'NR>=575 && NR<=780' e2e/resident-ui-layout.spec.ts | grep -c 'data-resident-status-bar'` = 0，且 `sed -n '575,780p' e2e/resident-ui-layout.spec.ts | grep -c 'data-activity-dock'` ≥ 1（两条命令逐字输出登记）。
- [x] AC3 AC 逐字要求的三条承重断言一字未改：`intersect` / `msgVisible` / `perRunBarCount` 三条断言的文本（含各自的失败消息串）逐字保留。验证：`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^-.*the status bar must not overlap the message'` = **0**、`… | grep -c '^-.*the message must be entirely inside the viewport'` = **0**、`… | grep -c '^-.*an ordinary session must draw no status bar'` = **0**（三条命令的逐字输出 + 计数 0）。⚠️ 本条**不**要求整份 diff 的 `^-.*expect(` 计数为 0 —— 被替换的机制腿本身就是一行 `expect(`，这是本条明确授权的改动，须在完成记录里如实写明换掉的是哪一条、换成什么。
- [x] AC4 新机制腿有区分力（承重，防「新的腿恒真」的假绿）：行级读数在绿跑下的实测值出现在完成记录里；且负控制二（滚动盒内的形态）下该读数**翻红**。验证：一次绿跑的 `printReading` 原始行（pane 内最外层行集 + 坞盒 + 行级相交读数）+ 负控制二的逐字失败行。
- [x] AC5 负控制一（AC 逐字要求的假形态）红在相交读数上：把坞改成绝对定位盖在消息上 ⇒ 判据退出非 0，**红落在 `intersect` 那条断言上**（逐字含 `intersect=true` 与两盒读数）；控制腿（per-run）无坞仍绿，故红不落在控制腿。验证：变异 diff、逐字失败行、`echo $?`；还原后 AC1 复绿。
- [x] AC6 两臂对照 + 不碰邻居：同一次运行的 stdout 里 resident 臂坞计数 = **1**、per-run 臂 = **0**；`npx playwright test e2e/resident-ui-layout.spec.ts --list` 退出 **0** 且仍列出 **3** 个用例、三个标题逐字未变；生产代码里 `data-resident-status-bar` 命中数仍为 **0**（`grep -rn … src/ server/ shared/ | grep -v '/tests/'`）；`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**。

## DoD

- 真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿，并把 pass 写进 `.quay/gate-events.jsonl`（AC-179 的台账尾部不再是 CURRENTLY FALSE）。且这条绿不是「恰好那次没抖」—— AC1 的 `elapsed=` 与 AC6 的两臂计数（1 / 0）逐次写进完成记录。
- 判据在**真浏览器**里跑：真服务、真 `GET /api/session-hosts` 读回 `lifecycleMode=resident`、debug-agent scenario 驱动，**不拉起真 claude**。
- AC1 / AC4 的读数都是判据的**原始输出行**（`bar.box=` / `msg.box=` / `intersect=` / `msg.visible=` / 新的行级读数），不是转述；几何读数由 `getBoundingClientRect` 在同一时刻一次取全。
- 两个负控制**真跑过、真红**，且红落在各自的承重读数上（负控制一落 `intersect`，负控制二落新的行级腿）；恢复后判据复绿。变异施加 / 恢复用 `/tmp` 备份 + `sha256sum -c` 校验，⛔ 不用 `git checkout --`（会抹掉当时尚未提交的实现）。
- 完成记录必须如实写明这一次红的性质：**不是** AC-179 的产品保证失效 —— 本轮探针实测该保证仍成立（`intersect=false` / `msg.visible=true` / per-run 计数 0）—— 失效的是判据的**量具**：正信号锚 `[data-resident-status-bar]` 在 `ad1bb63a` 并进活动坞时退役（该合并随 `e3f86d82` 于 `2026-10-02 08:29:56Z` 进 develop），且该用例自加的 `barOverPane` 腿对合并后的坞恒真（坞按设计 `absolute bottom-full` 悬在 pane 底边上）。据此本条交付的是「量具跟着产品走」的收尾，不是产品修复。
- ⛔ 不得用改判据命令 / 改 AC 的三条承重断言 / `skip` / `retries` / 改 `SINGLE_SPEC_CEILING_MS` 换绿；⛔ 不得往生产代码里补回 `data-resident-status-bar`（死契约）。
- ⛔ 不修 AC-175（`e2e/resident-busy-send.spec.ts:80` —— 已有 ready 任务认领）、不修 AC-177 / AC-178 的用例与其 `-g` 标题。
- 单文件判据在 **55s** 内自己结束（打印墙钟），不是被看门狗或 60s 闸门外部击杀。
- 只动 Touches 列出的文件。

## Touches

- e2e/resident-ui-layout.spec.ts
- tasks/gap-ac179-criterion-anchor-retired-by-dock-consolidation.md（自触）


## 完成记录

**这一次红的性质（如实登记）：不是产品修复，是「量具跟着产品走」的收尾。** AC-179 的产品保证——常驻坞的边界框不与助手消息行相交、消息完整在视口内、per-run 会话不画它——本轮实测仍成立（下面每一次绿跑的 `intersect=false` / `msg.visible=true` / per-run 计数 0）。失效的是判据的**量具**，两处：

1. 正信号锚 `[data-resident-status-bar]` 在 `ad1bb63a`（`activity dock: one dock, one source, one answer`）把常驻状态条并进活动坞时被整体退役，该合并随 `e3f86d82` 于 `2026-10-02 08:29:56Z` 进 develop。本工作树净检出上直接重跑判据即复现：`EXIT=1`，wall 36.2s，死在**正信号等待**处，一个几何读数都没取到——逐字 `Error: a resident session must draw the bar this reading is about` / `expect(locator).toBeVisible() failed` / `Locator: locator('[data-resident-status-bar]')` / `Expected: visible   Timeout: 30000ms   Error: element(s) not found` / `at e2e/resident-ui-layout.spec.ts:620:8`。
2. 该用例自加的机制腿 `barOverPane`（`overlaps(barBox, paneBox)`）对合并后的坞**恒真**：坞由 `ChatComposer.tsx:537` 渲染在 `pointer-events-none absolute bottom-full left-1/2 z-10 …` 的包装里，`absolute bottom-full` 的语义就是「悬在输入框上沿之上、盖住 transcript 的末尾」，这是合并时**有意**的设计。本工作树实测 `resident.bar.over.pane=true`（坞 `305,314,459,32` vs pane `289,57,491,289`），留着这条腿判据没有可满足的世界。

**改了什么（最小充分，不发明新机制、不往生产里补死契约）。** 只动 `e2e/resident-ui-layout.spec.ts`：

- 模块级 `const BAR`（`:39`）由退役的 `'[data-resident-status-bar]'` 改为 `'[data-activity-dock]'`——与 AC-177（`:1098`）、AC-178（`:1340`）换锚后读的是同一个根；那两条用例各自用局部 `const BAR` 遮蔽模块级常量，本次改动**没有**碰到它们。
- 换掉的那一条 `expect(` 是 `:660`–`:664` 的 `expect(residentReading.barOverPane, 'the status bar must not be drawn inside the transcript's scroll box; …').toBe(false)`，换成行级读数 `expect(residentReading.barOverRows, 'the status bar must not be drawn over any row of the transcript; …').toEqual([])`（`:691`）。`barOverRows` 由**同一次** `page.evaluate` 里的 `getBoundingClientRect` 一次取全：`rows.filter((row) => overlaps(barBox, row.box))`，即 pane 内**每一条**最外层消息行（不止最后一条助手行）与坞盒相交的集合。`barOverPane` 读数本体保留（`:264`）并继续由 `printReading` 打印（`:288`），但**不再在 resident 臂上断言**——它现在是「坞按设计悬在 pane 底边上」的取证行；per-run 控制臂上那条 `expect(perRunReading.barOverPane, …).toBe(false)`（`:729`）一字未动。
- 该用例的两处文档注释同步改写；`barOverRows` 之上新增 `describeRows` 打印助手。
- 退役标记的**悼词**按角色改写、不再复现标识符字面量：文件里唯一提到它的散文（AC-177 常量块：「the bar's own trigger attribute and its dialog root are gone」）已去掉 `[data-resident-status-bar-trigger]` 字面量。这一步是必需的，不是顺手：AC2 的验证区间 `575..780` 与这条散文重叠，不改写则该 grep 会命中悼词本身。

AC 逐字要求的 `intersect`（`:676`）/ `msgVisible`（`:681`）/ `perRunBarCount`（`:708`）三条承重断言的文本与失败消息串**一字未改**；`--list` 三个用例标题一字未改。

**实测读数（逐次，全部为判据 stdout 的原始行，几何由 `getBoundingClientRect` 同一时刻一次取全）。**

绿跑 ×5（本工作树，`-g "status bar does not cover the transcript"`，命令逐字未改），每次 `EXIT=0` / `1 passed`：

| 次 | `elapsed=` | resident `bar.box` | resident `msg.box` | `intersect` | `msg.visible` | `msg.in.pane` | `bar.over.pane` | **`bar.over.rows`** | per-run 坞计数 | per-run `bar.over.rows` |
|---|---|---|---|---|---|---|---|---|---|---|
| 换锚后 1 | `13086ms` | `305,314,459,32` | `305,219,459,87` | false | true | true | true | `[]` | 0 (`bar.exists=false`) | `[]` |
| 换锚后 2 | `13094ms` | `305,314,459,32` | `305,219,459,87` | false | true | true | true | `[]` | 0 | `[]` |
| 换锚后 3 | `12826ms` | `305,316,459,32` | `305,195,459,87` | false | true | true | true | `[]` | 0 | `[]` |
| merge develop 后 | `12852ms` | `305,314,459,32` | `305,195,459,87` | false | true | true | true | `[]` | 0 | `[]` |
| tick 入树后（末次、提交态） | `12879ms` | `305,313,459,32` | `305,219,459,87` | false | true | true | true | `[]` | 0 (`bar.exists=false`) | `[]` |

五次 `elapsed` 全部 < `SINGLE_SPEC_CEILING_MS = 55_000`；末次的 `git status --porcelain` 为空，即跑在与 Touches 逐条对齐的**提交态**上。绿跑原始行（merge 后那一次，逐字）：

```
resident.bar.exists=true
resident.bar.box=305,314,459,32
resident.msg.box=305,195,459,87
resident.intersect=false
resident.msg.visible=true
resident.msg.in.pane=true
resident.bar.over.pane=true
resident.bar.over.rows=[]
resident.msg.count=1
resident.pane.box=289,57,491,289
resident.viewport=780x493
resident.rows=["user@305,113,459,66","assistant@305,195,459,87"]
per-run.bar.exists=false
per-run.bar.over.pane=false
per-run.bar.over.rows=[]
per-run.pane.box=289,57,491,253
elapsed=12852ms
  1 passed (12.8s)
```

**两臂对照（AC6 / AC4 的区分力证据）：** 同一次运行里 resident 臂坞计数 = **1**（`resident.bar.exists=true`、`[data-activity-dock]` 解析到 1 个元素），per-run 臂 = **0**（`per-run.bar.exists=false`，另有一行 `per-run.bar.exists=false` 来自 `per-run.bar.exists=${perRunBarCount > 0}`）。不是「两臂都空」的假绿。

**负控制一（AC 逐字要求的假形态：坞绝对定位盖在消息上）——真跑、真红，红落在 `intersect`。** 变异（`/tmp/ac179-negctl/ChatComposer.tsx.orig` 备份，原 `sha256=65886fb840a4bc286adc0b1374befd21742b9df64da7761dd5420a3222218a7e`）：

```diff
--- a/src/modules/chat/composer/ChatComposer.tsx
+++ b/src/modules/chat/composer/ChatComposer.tsx
@@ -536,7 +536,7 @@ export default function ChatComposer({
       {!hasPendingPermissions && !isMobile && (
-        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 translate-y-px bg-transparent sm:w-[calc(100%-2rem)]">
+        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 -translate-y-[100px] bg-transparent sm:w-[calc(100%-2rem)]">
```

`echo $?` = **1**。读数：`resident.bar.box=305,215,459,32` / `resident.msg.box=305,219,459,87` / **`resident.intersect=true`** / `resident.msg.visible=true` / `resident.msg.in.pane=true` / `resident.bar.over.rows=["assistant@305,219,459,87"]`。失败逐字（红落在相交读数上）：

```
    Error: the status bar must not overlap the message; intersect=true bar.box=305,215,459,32 msg.box=305,219,459,87
    Expected: false
    Received: true
    > 679 |     ).toBe(false);
        at …/e2e/resident-ui-layout.spec.ts:679:7
  1 failed
```

红**没有**落在控制腿（per-run 臂无坞，该断言在其之前根本不参与）。还原：`cp /tmp/ac179-negctl/ChatComposer.tsx.orig …` + `sha256sum -c` → `OK`，`git status --porcelain` 该文件为空；随后 AC1 复绿（上表第 2、3 次）。

**负控制二（证明新的行级腿不是恒真：把条放回 pane 的滚动子树内、悬在行上）——真跑、真红，红落在新的行级读数上，而 `intersect` 仍为 false。** 变异（`/tmp/ac179-negctl/ChatMessagesPane.tsx.orig` 备份，原 `sha256=6a94df431eefcc1ad753b824008b6d78b17d8d665319b944967ac4dcd7885831`）：把坞从 composer 的悬停位**移进** `.chat-messages-pane` 的滚动子树，`sticky top-14` 使其在滚动盒内悬在首行上；同时关掉 composer 那一份以免重合（同一次变异内的两处，`ChatComposer.tsx` 的 `!hasPendingPermissions` 前加 `false &&`）：

```diff
--- a/src/modules/chat/transcript/ChatMessagesPane.tsx
+++ b/src/modules/chat/transcript/ChatMessagesPane.tsx
@@ -361,6 +361,14 @@ function ChatMessagesPane({
         className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${paneBottomPadding}`}
       >
+        <div className="pointer-events-none sticky top-14 z-20">
+          <ActivityIndicator
+            activity={hasActivityIndicator ? activity : null}
+            sessionId={activeSessionId}
+            sendFailed={sendFailed}
+            persistWhenIdle={isResidentSession}
+          />
+        </div>
         {chatMessages.length > 0 && (
```

`echo $?` = **1**。读数（关键一对）：**`resident.intersect=false`**（坞 `289,128,491,32` vs 助手行 `305,227,459,87` 不相交）而 **`resident.bar.over.rows=["user@305,145,459,66"]`**——该形态压住的是**别的行**（首行 user），正是上一轮留下这条腿的原因。失败逐字（红落在新的行级读数上）：

```
    Error: the status bar must not be drawn over any row of the transcript; bar.box=289,128,491,32 overlapped=["user@305,145,459,66"] pane.box=289,57,491,289 rows=["user@305,145,459,66","assistant@305,227,459,87"]
    - Expected  -  1
    + Received  + 13
    > 695 |     ).toEqual([]);
        at …/e2e/resident-ui-layout.spec.ts:695:7
  1 failed
```

即：若只留 `intersect` 腿，这个「画在滚动盒里、悬在行上」的形态会**通过**；新的行级腿把它抓死。附带一条实测：该形态下 `resident.bar.over.pane=true`，故若沿用旧的 pane 盒腿，它也会红——但那条腿在合并后的产品上对**合法**的坞恒真（见上），所以它不能被留下；新的腿既能否证该形态、又对合法的坞恒真为空。还原：两次 `cp … .orig` + 两次 `sha256sum -c` 均 `OK`，`git status --porcelain` **整树为空**；随后 AC1 复绿（上表第 3、4 次）。两次变异施加/恢复全程用 `/tmp` 备份 + `sha256sum -c`，**未**使用 `git checkout --`。

**机械核查（逐条命令与输出）。**

- AC2：`awk 'NR>=575 && NR<=780' e2e/resident-ui-layout.spec.ts | grep -c 'data-resident-status-bar'` = **0**；`sed -n '575,780p' e2e/resident-ui-layout.spec.ts | grep -c 'data-activity-dock'` = **1**。
- AC3：`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^-.*the status bar must not overlap the message'` = **0**；`… '^-.*the message must be entirely inside the viewport'` = **0**；`… '^-.*an ordinary session must draw no status bar'` = **0**。
- AC6：`grep -rn 'data-resident-status-bar' --include=*.tsx --include=*.ts src/ server/ shared/ | grep -v '/tests/' | wc -l` = **0**（生产代码里没有补回死契约）；`npx playwright test e2e/resident-ui-layout.spec.ts --list` `EXIT=0`，`Total: 3 tests in 1 file`，三条标题逐字未变（`:602:1 › status bar does not cover the transcript`、`:1093:3 › resident ui layout › the popover close is reachable at a narrow viewport and closes the process`、`:1323:1 › resident session hides enable affordance`）；`npm run lint` `EXIT=0`；`npm run typecheck` `EXIT=0`（tsconfig + server + scripts 三份）。
- 范围：`git diff develop --name-only` = 只有 `e2e/resident-ui-layout.spec.ts`；与 Touches 逐条对齐。scoped 门 `bash scripts/test.sh --for-task gap-ac179-criterion-anchor-retired-by-dock-consolidation --allow-thin` `EXIT=0`（thin：scoped 门不覆盖 `e2e/*.spec.ts`，故本条的自测就是判据本身）。
- 未越界：AC-175（`e2e/resident-busy-send.spec.ts`）由 develop 上已 done 的 `gap-ac175-…` 认领，本条未碰；AC-177 / AC-178 的用例与其 `-g` 标题未碰；未改判据命令 / `SINGLE_SPEC_CEILING_MS` / `retries` / `skip`。

**DoD 的落地判定：** 单文件判据在 55s 内自己结束（四次实测 12.8–13.1s，打印墙钟，非被看门狗或 60s 闸门外部击杀）；判据跑在真浏览器 + 真服务上（真 `GET /api/session-hosts` 读回 `lifecycleMode=resident`、debug-agent scenario 驱动，未拉起真 claude）。台账侧的翻绿由 driver 的下一轮 goal-gate 完成。
