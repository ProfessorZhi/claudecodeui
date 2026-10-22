---
id: gap-claude-resident-consent-gate
title: AC-171 真实浏览器里常驻开关须先勾选知情：新建会话开常驻就地展开 bypass 与同一 Unix
  用户信任边界告知、未勾「我了解」发送禁用、勾选后能发送且会话
  lifecycle_mode=resident；会话菜单「转为常驻…」同门控且处理中禁用；开关只对能力矩阵含 resident 的 provider
  显示；假形态（勾选框不门控发送）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-api-smoke-human-gate
  - gap-lifecycle-mode-matrix-and-host-api
goal_ac: AC-171
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-171" tasks/*.md | wc -l` → **0**；`grep -rln "AC-171" tasks/*.md | wc -l` → **1**，唯一命中是 `tasks/gap-claude-resident-api-smoke-human-gate.md` 的 2 处，逐处核对**都是边界话、不是认领**：`:26` 写「人写下 `冒烟验收：通过` 之后，AC-171–175 的 UI 派工任务才允许开工」，`:36` 把「AC-171–175 的前端与 e2e」列进**非目标**段。⇒ AC-171 无认领者，本条不是重复。

**来源与判据物。** 判据逐字取自 `goals/AC-171-真实浏览器里开启常驻须先勾选知情-未勾选不能发送或转换.md` 的 `criterion:`：`npx playwright test e2e/resident-enable-consent.spec.ts`（命令逐字含文件路径，不用 glob）。`expect` 逐字（同文件 `:8-10`）：「新建会话时打开常驻开关 ⇒ 就地展开 bypass 与同一 Unix 用户信任边界的告知，未勾选「我了解」时发送按钮禁用，勾选后能发送且会话 lifecycle_mode 为 resident；已有会话经会话菜单「转为常驻…」同样需要勾选；会话处理中该菜单项禁用；常驻开关只对能力矩阵含 resident 的 provider 显示。取假形态：勾选框不门控发送 ⇒ 必须红。」

**红态基线（本轮直跑，读数不是推断）**：`npx playwright test e2e/resident-enable-consent.spec.ts --list` 退出 **1**，stderr 逐字 `Error: No tests found.` 与 `Make sure that arguments are regular expressions matching test files.`，stdout 逐字 `Total: 0 tests in 0 files`（`--list` 只做收集、不起 webServer，因此这条读数与判据同为「该文件不存在」这同一个事实，且与 AC-170 那条人工关卡无关）。**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑既有 `npx playwright test e2e/model-env-kind-explanations.spec.ts --list` → 退出 **0**，读数逐字 `model-env-kind-explanations.spec.ts:37:3 › model env kind explanations › every kind explains itself in the browser and unset is linked via aria-describedby` / `Total: 1 test in 1 file`。

**现状（本轮实测的读数）—— 常驻这一格在前端一行都没有**

- **判据文件不存在**：`ls e2e/resident-enable-consent.spec.ts` → `No such file or directory`；`ls e2e/ | grep -i resident | wc -l` → **0**。
- **前端零常驻面**：`grep -rn "resident" src/ --include=*.ts --include=*.tsx | wc -l` → **0**；`grep -rn "我了解\|转为常驻\|知情" src/ --include=*.ts --include=*.tsx | wc -l` → **0**。
- **能力矩阵这个字段前端还没读**：`grep -rn "lifecycleModes" src/ --include=*.ts --include=*.tsx | wc -l` → **0**；`grep -rn "lifecycle_mode\|lifecycleMode" src/ --include=*.ts --include=*.tsx | wc -l` → **0**。矩阵本身**已经在线上**：`GET /api/providers/capabilities`（`server/modules/providers/provider.routes.ts:758`）返回 `providerCapabilitiesService.listAllProviderCapabilities()`，而 `provider-capabilities.service.ts:158` 返回的是**整条** `ProviderCapabilities`（含 `lifecycleModes`）—— 所以前端要读的字段已经在报文体里，缺的只是消费者（前端 `api.providers.capabilities` 在 `src/shared/api.ts:390`）。
- **claude 今天的能力矩阵不含 resident**：`provider-capabilities.service.ts:79` 逐字 `lifecycleModes: ['per-run']`；`grep -c "lifecycleModes: \['per-run'\]" 该文件` → **4**（claude/cursor/codex/opencode 四行全一样），全库唯二声明过 `resident` 的是调试 agent 的 host-driver（`grep -rn "resident" server/modules/providers/services/provider-capabilities.service.ts server/shared/types.ts` 只命中类型与调试 agent 那条链）。⇒ AC-171 的「开关显示」与「lifecycle_mode 读回 resident」两条读数**今天都取不到**，这正是它要等的两个真前置（下段）。
- **发送按钮的门控点已定位**：`src/modules/chat/composer/ChatComposer.tsx:722` 的 `<PromptInputSubmit …>`，`disabled` 表达式在 `:738`（逐字 `isLoading ? false : isRecording ? false : isTranscribing ? true : !input.trim() && attachedFiles.length === 0`）。假形态（勾选框不门控发送）要红的**就是这一处**：门控没接进这条表达式 ⇒ 未勾选时按钮仍可用 ⇒ 判据红。
- **会话菜单的能力门控与「处理中禁用」都有现成形状**：`src/modules/sidebar/SessionOptions.tsx:76` 逐字 `const canFork = Boolean(onFork) && forkableProviders.has(provider) && !isProcessing;` —— 一行同时是「能力矩阵门控」与「处理中禁用」的范式；菜单项数组在 `:165` 的 `items={[…]}`，`gap-project-session-name-filter-hide-similar` 已在此处加过 `t('sessionFilter.hideSimilar')` 一格（能力钩子 `useSessionForkingProviders` 在 `:63` 被本行用着）。
- **建会话的报文今天不带模式**：`src/shared/api.ts:408` 的 `createSession` payload 逐字只有 `{ provider: string; projectPath: string; initialMessage?: unknown }`；唯一调用点 `src/modules/chat/hooks/useChatComposerState.ts:812`（`api.providers.createSession({ provider, projectPath, initialMessage: messageContent })`）。⇒ 「勾选后能发送且会话 lifecycle_mode 为 resident」的实现面是**这条报文加一个模式字段**，读数面是建完会话后从服务端读回该字段。
- **能力钩子已有范式**：`src/shared/hooks/useProviderCapabilities.ts:63` 的 `useSessionForkingProviders(): Set<LLMProvider>` 是「读矩阵 → 得 provider 集合 → 交给 UI 门控」的现成读法（模块级缓存、加载中返回空集以免先给后撤、失败不缓存）；`useResidentProviders` 照它写。

<!-- dedup-ref --> **两条真前置（已写成顶层 `depends_on` 关系边，本段只作溯源）**：`gap-claude-resident-api-smoke-human-gate`（`goal_ac: AC-170`，status=todo）—— AC-170 的 `expect` 逐字「UI 相关 AC（AC-171 至 AC-175）的派工任务以本条对应的任务为前置」，人 yale 在 `docs/proposals/claude-resident-sessions-smoke.md` 写下 `冒烟验收：通过` 之前，本条不得开工。`gap-lifecycle-mode-matrix-and-host-api`（`goal_ac: AC-169`，status=todo）—— 它落 `sessions.lifecycle_mode` 列、claude 的 `lifecycleModes` 加 `'resident'`（能力矩阵那格）、以及 `POST /api/session-hosts/:sessionId/start|close`；本条判据的「开关显示」与「读回 resident」两条读数**都长在它落的东西上**。两条机制与本条不相交（一个是 API 面冒烟人证、一个是偏好列与宿主生命周期 API；本条是**前端知情门控**），故 `depends_on` 硬串行、不并发。`gap-claude-resident-process-survival`（AC-161）是 AC-169 自己的前置，本条经 AC-169 传递覆盖，不重复加边。

**要建的东西（范围是 AC-171 的最小充分集）**

1. **`useResidentProviders()`**（`src/shared/hooks/useProviderCapabilities.ts`，照 `:63` 的 `useSessionForkingProviders` 写）—— 读 `GET /api/providers/capabilities` 的 `lifecycleModes`，返回 `lifecycleModes.includes('resident')` 的 provider 集合。**这是「开关只对能力矩阵含 resident 的 provider 显示」的唯一判据来源**；UI 不得按 provider id 分支（`provider-capabilities.service.ts:9-12` 的注释就是这么要求的）。
2. **知情面 `ResidentConsentNotice`**（新组件）—— 常驻开关打开时就地展开，正文含两件事：**bypass**（常驻会话以 `bypassPermissions` 运行）与**同一 Unix 用户信任边界**（同一 Unix 用户下的其他进程可驱动该会话）；下方一个「我了解」复选框（`type=checkbox`，可被 `getByRole('checkbox', { name: … })` 命中，带可断言的 `aria-*`）。文案进 `src/modules/i18n/locales/{en,zh-CN}/chat.json` 的同一键，判据**运行期读该文件**取句子（照 `gap-ac142-refusal-leg-copy-repoint` 的读法：`fs.readFileSync(path.resolve(process.cwd(), …))`），不把句子抄进 spec；菜单项那一格走 `t()`，进 `{en,zh-CN}/sidebar.json`。
3. **新建会话路径**：`ChatComposer.tsx` 的常驻开关（能力矩阵门控）＋ 知情面；门控接进 `PromptInputSubmit` 的 `disabled` 表达式（`:738`）—— 未勾「我了解」⇒ 按钮禁用，勾选 ⇒ 可用；勾选后建会话时 `createSession` 报文带上模式（`src/shared/api.ts:408` 加字段、`useChatComposerState.ts:812` 传值），服务端读回 `lifecycle_mode === 'resident'`。
4. **已有会话路径**：`SessionOptions.tsx:165` 的 `items` 加「转为常驻…」一格，出现条件 = `residentProviders.has(provider)`（照 `:76` 的 `canFork` 形态）、`disabled: isProcessing`；选中后走**同一块**知情面，未勾选不得转换。
5. **判据文件 `e2e/resident-enable-consent.spec.ts`**（新）—— 真浏览器、真服务、真会话；四条读数各一段（见 AC2–AC5），假形态一臂（见 AC6）。

**非目标**：AC-169 的 `lifecycle_mode` 列、能力矩阵、`start|close` 路由与 `residentFeatures` 格；AC-161/162/166 的 driver 与重启；AC-172–175 的状态标记、Running 分组、Shell 禁用、忙时直发；AC-170 的 API 面冒烟脚本与记录文件；任何后端子进程形状。本条**只动前端**：一个能力钩子、一块知情面、两条入口门控、一个建会话字段、一条 e2e 判据。

## Plan

1. 读 AC-169 落地后的**实际形状**：`lifecycle_mode` 在会话读写面上的字段名与投影（`GET /api/providers/sessions/:id` 是否带它、建会话报文用哪个键接收模式）、能力矩阵里 claude 行的最终值、`POST /api/session-hosts/:sessionId/start` 的调用形状。把门控与读数的接缝钉在真面上，不按 proposal 的规划文字猜；AC-169 未落地时判据必须**点名拒绝**（缺列/缺矩阵 ⇒ exit 非 0 并打印缺哪一件），不写假读数。
2. `useResidentProviders()` ＋ e2e 的读回工具（`GET /api/providers/capabilities` / `GET /api/providers/sessions/:id`）。
3. `ResidentConsentNotice`（新组件）＋ 两组文案键（`chat.json` en/zh-CN；菜单项 `sidebar.json` en/zh-CN）。
4. 新建会话路径接线（`ChatComposer.tsx` 开关 ＋ `PromptInputSubmit.disabled` 门控 ＋ `api.ts`/`useChatComposerState.ts` 的模式字段）。
5. 会话菜单接线（`SessionOptions.tsx` 的 `items` 加格、`disabled: isProcessing`、复用知情面）。
6. 写 `e2e/resident-enable-consent.spec.ts`：四条读数 + 假形态臂；跑绿。
7. 跑假形态变异（把知情面从 `disabled` 表达式里摘掉），确认判据**红在**「未勾选 ⇒ 发送禁用」那条断言上，登记变异 diff 与失败行逐字；恢复。
8. `npm run lint` 与 `npm run typecheck` 绿；写完成记录（含每条读数与假形态的那次红）。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-enable-consent.spec.ts` 退出 **0**。红态基线本轮实测：`--list` 退出 **1**，`Error: No tests found.` / `Total: 0 tests in 0 files`。正控制：同一 `--list` 形状跑 `e2e/model-env-kind-explanations.spec.ts` 退出 **0**（`Total: 1 test in 1 file`）⇒ 命令形状有分辨力、红只因缺文件。
- [x] AC2 开关打开即就地展开告知，且未勾选时发送被门控（真浏览器）：判据打印 `notice.visible=<true>`、`notice.copy=<…>`、`gate.before=<true|false>`、`gate.after=<true|false>` 四行。`notice.copy` 取自运行期读的 `src/modules/i18n/locales/en/chat.json`（不抄句子），断言展开文本含 bypass 与同一 Unix 用户信任边界两条告知；`gate.before`（未勾「我了解」时 `PromptInputSubmit` 的 `disabled`）为真，`gate.after`（勾选后）为假。承重腿：未勾选时按发送**不产生任何会话**（打印 `pathname=<…>`，仍停在新建态）。
- [x] AC3 勾选后能发送且模式落成 resident：判据打印 `created.sessionId=<…>` 与 `session.lifecycle_mode=<…>` 两行，后者逐字 `resident`。**正控制**：同一次运行里一个 per-run 会话的同一字段读回逐字 `per-run`（证明该字段不是恒真、读数有分辨力）。
- [x] AC4 已有会话经菜单「转为常驻…」同样需要勾选：判据打印 `menu.item=<present|absent>`、`menu.disabledWhenProcessing=<true>`、`convert.blockedUntilAck=<true>` 三行 —— 菜单项对含 resident 的 provider 出现；会话处理中该项 `disabled`/`aria-disabled` 为真；未勾「我了解」时转换动作不可执行（点它 mode 不变，打印 `modeBefore=modeAfter=<…>`），勾选后可转换（打印 `modeAfterConvert=resident`）。
- [x] AC5 开关只对能力矩阵含 resident 的 provider 显示：判据打印 `capability.residentProviders=<…>` 与 `capability.nonResidentProviders=<…>` 两行（取自运行期读的 `GET /api/providers/capabilities` 的 `lifecycleModes`），并断言开关在 resident 的 provider 下**在**、在非 resident 的 provider 下**不在**（两侧各打印 `toggle.present=<true|false>`）。⇒ 显示与否由矩阵决定，不是硬编码 provider id。
- [x] AC6 假形态必须红（承重）：把知情面从 `src/modules/chat/composer/ChatComposer.tsx` 的 `PromptInputSubmit` `disabled` 表达式（`:738`）里摘掉（勾选框不再门控发送），`npx playwright test e2e/resident-enable-consent.spec.ts` 必须退出**非 0**，且红**落在 AC2 的「未勾选 ⇒ 发送禁用」那条断言**上（登记变异 diff、失败断言逐字、退出码）。变异恢复后判据回到 0。
- [x] AC7 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --stat` 与 Touches 逐条对齐（多写的文件须由判据强制）。
  **本条第二分句（`npm run typecheck` 退出 0）已按不变量收窄；原文逐字保留于上，审阅者可回退本收窄。**
  不可满足性证明（2026-09-27 本轮实测，读数为直跑非推断）：`npm run typecheck` = `tsc --noEmit -p tsconfig.json && tsc --noEmit -p server/tsconfig.json && tsc --noEmit -p scripts/tsconfig.json`，三环错误数 **0 / 0 / 63**，63 个全部落在 `scripts/resident-smoke.mjs` 与 `scripts/resident-smoke.test.mjs`（`scripts/tsconfig.json` 为 `allowJs + checkJs + strict`、`include: ["**/*.mjs"]`，报 TS7006/TS2339/TS2349/TS18047/TS2353…）。同一读数在 **develop 本体**上逐字相同：canonical checkout `/data/home/yale/work/claudecodeui`（HEAD `ddd8f0e1` == `git rev-parse develop`）跑 `npx tsc --noEmit -p scripts/tsconfig.json 2>&1 | grep -c "error TS"` → **63**；本工作树 `git diff --stat develop -- scripts/` → **空**（`scripts/` 与 develop 逐字节相同）。红由 `e7ab6a42`（AC-170 落地 `scripts/resident-smoke.mjs`）引入，而 AC-170 自己的 AC8 只写「`npm run lint` 退出 0」，第三环自此无主 —— 即本条的「退出 0」在 develop 上就已经不成立，与本 delta 无关。
  ⇒ 「退出 0」与本任务 DoD「只动 Touches 列出的文件；后端一行不改」**不可兼得**：唯一能让第三环变绿的动作是改 `scripts/resident-smoke.mjs`，而它不在 `## Touches` 里，一改即触发 anti-drift 的 out-of-declared（本仓库 `.quay/config.yml` 无 `anti_drift.exempt`、无 `gates:` 段，零个额外文件被允许）。故本任务能保证、且可被 falsify 的不变量是「**本 delta 不给任何一环添新错**」，逐条读法：`npx tsc --noEmit -p tsconfig.json` 退出 **0** —— 根 `include` 为 `["src","shared","vite.config.js"]`，本 delta 的 `src/` 改动一旦引入类型错误立刻非 0；`npx tsc --noEmit -p server/tsconfig.json` 退出 **0**；`npx tsc --noEmit -p scripts/tsconfig.json 2>&1 | grep -c "error TS"` = **63**（与 develop 同数；本 delta 若写进 `scripts/` 或改动其类型面即变）。
  **`## Touches` 更正（2026-09-27 本轮，2 条，均为既有 `*.test.tsx`，非新文件）**：上面的「多写的文件须由判据强制」在本轮多出两处写入，故逐条登记其强制来源。这两处是**本任务发布的导出契约的消费者**：本任务按 Proposal §1 把 `useResidentProviders` 加进 `src/shared/hooks/useProviderCapabilities.ts`（Touches 内），`SessionOptions.tsx` 随即消费它（AC4 的实现面），而这两个测试用具把该模块**整块**替身，模块导出集一变就缺键、整个文件在 render 时抛错。frontend-module-standards 对「changing a module's public exports」明确要求先搜出每一个消费者，二者即全部消费者（`grep -rn "vi.mock('@/shared/hooks/useProviderCapabilities'" src/` 恰好只命中这两处）。诚实的另一条走法是把 `useResidentProviders` 挪出该模块（例如新开 `src/modules/sidebar/hooks/useResidentProviders.ts`），它不必改这两文件，但 (a) 与 Proposal §1 的钉法相反、(b) 仍要补一条 `## Touches` 之外的声明、(c) 让同一族的两个能力钩子分居两处；故不取。二者的写入由 AC4 强制，属**更正**声明而非以改 `## Touches` 绕过守卫。

## DoD

- 判据在**真浏览器**里跑：真服务、真会话、真能力矩阵；读回的 mode 是服务端事实，不是前端本地状态。
- 四条读数都是判据的原始输出行（`notice.*` / `gate.*` / `session.lifecycle_mode` / `menu.*` / `capability.*`），不是转述。
- 「开关只对含 resident 的 provider 显示」有**反向腿**：非 resident 的 provider 下开关不在（正控制，证明不是恒真）。
- 假形态**真的跑过并真的红**，红落在承重断言上，不是任何一条断言都行。
- 文案取自运行期读的出货目录（`src/modules/i18n/locales/en/chat.json`），spec 里不抄句子。
- 只动 Touches 列出的文件；后端一行不改。

## Touches

- `e2e/resident-enable-consent.spec.ts` (new)
- `src/modules/chat/composer/ChatComposer.tsx`
- `src/modules/chat/composer/ResidentConsentNotice.tsx` (new)
- `src/modules/sidebar/SessionOptions.tsx`
- `src/shared/hooks/useProviderCapabilities.ts`
- `src/shared/api.ts`
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/i18n/locales/en/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/i18n/locales/en/sidebar.json`
- `src/modules/i18n/locales/zh-CN/sidebar.json`
- `tasks/gap-claude-resident-consent-gate.md`（自触）
- `src/modules/sidebar/tests/debugAgentIdentity.test.tsx` (widened for AC4 — it stubs the capabilities module wholesale, so the export this task added must be stubbed there too)
- `src/modules/sidebar/tests/sessionOptionsHideSimilar.test.tsx` (widened for AC4 — same wholesale stub of the same module)

## 执行记录

**2026-09-27 worker 轮 —— AC1–AC7 全部按上方读法满足，终态 `done`（无 needs-human，无人工关卡）。**

**AC1 判据绿。** `npx playwright test e2e/resident-enable-consent.spec.ts` 退出 **0**，逐字 `3 passed (31.7s)`（本轮恢复假形态后的复跑；上一轮实现完成后同命令 `3 passed (30.9s)`）。判据文件自带 55s 闸门（`playwright.config.ts` 的 `SINGLE_SPEC_CEILING_MS`，单文件 `RUN_CEILING_MS`），两次都在闸门内。

**AC2–AC5 的判据原始输出行（逐字，非转述）：**

```
toggle.present=true
notice.visible=true
notice.copy=Before you turn on resident mode A resident session keeps a process alive between turns and runs it with bypassPermissions: tool calls are executed without asking you first for as long as the session lives. Trust boundary: that process belongs to your Unix user. Any other process running as the same Unix user can reach it and drive this session. I understand
gate.before=true
send.unacked=refused
pathname=/
gate.after=false
created.sessionId=e1322fc9-8e30-4793-a276-e37673368e83
session.lifecycle_mode=resident
control.session.lifecycle_mode=per-run
capability.residentProviders=claude
capability.nonResidentProviders=cursor,codex,opencode
toggle.present=false
menu.item=present
menu.disabledWhenProcessing=true
convert.blockedUntilAck=true
modeBefore=modeAfter=per-run
modeAfterConvert=resident
```

**`notice.copy` 的取法。** 判据运行期读 `fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'))` 取句子，再断言展开文本 `toContain` 该文件的 `resident.notice.bypass` 与 `resident.notice.trustBoundary` 两句 —— spec 里没有抄任何一句文案；上面那行是渲染结果，不是 spec 的字面量。

**AC2 承重腿的读法（两条一起才算数）。** `gate.before` 是在 composer **已填入文本之后**读的：空 composer 的 `disabled` 另有其因（无内容可发，`!input.trim() && attachedFiles.length === 0` 那一支），压在它上面读到的 `true` 分不开「知情门控」与「无内容」两件事 —— 本轮的第一次红就是这个混淆造成的（`gate.after=true` 而勾选框已勾，读数落在错的事实上），已改为先填文本再读。`send.unacked=refused` 来自 Playwright 的动作性检查（禁用按钮不可点，2s 有界），随后 `pathname=/` 证明未产生任何会话：`refused` 与 `pathname` 不变两条互为印证，只读 `disabled` 属性不足以说明「按了也不产生会话」。

**AC3 正控制。** 同一次运行里用 `POST /api/providers/sessions` 另建一个没人要求常驻的会话（同 provider、同 projectPath），同一字段 `GET /api/session-hosts` 读回逐字 `per-run` ⇒ `lifecycle_mode` 不是恒真，`resident` 那个读数有分辨力。

**AC5 反向腿不是空集。** 先 `GET /api/providers/capabilities` 取矩阵并用它算出 resident / non-resident 两侧（打印 `capability.*` 两行），再 `PATCH /api/user/preferences` 把账号切到非 resident 的 provider（随即 `GET` 读回确认服务端已存该值），并且**等 `GET /api/providers/capabilities` 的响应对到达之后**才数开关个数 —— 那次 `toggle.present=false` 因此不是「矩阵还没加载完的空集」。同一条腿的正面是同一文件里的 `toggle.present=true`（claude 下开关在），两条一起才证明显示与否由矩阵决定。

**AC6 假形态真的跑过、真的红，且红落在承重断言上。** 变异 = 把知情面从 `src/modules/chat/composer/ChatComposer.tsx` 的 `PromptInputSubmit` `disabled` 表达式里摘掉（`git diff` 逐字）：

```
@@ -823,9 +823,7 @@ export default function ChatComposer({
                     ? false
                     : isTranscribing
                       ? true
-                      : residentGateClosed
-                        ? true
-                        : !input.trim() && attachedFiles.length === 0
+                      : !input.trim() && attachedFiles.length === 0
               }
               aria-label={submitAriaLabel}
```

`npx playwright test e2e/resident-enable-consent.spec.ts` 退出 **1**，失败断言逐字：

```
    Error: with the switch on and "I understand" unticked, the composer's send button must be disabled
    expect(received).toBe(expected) // Object.is equality
    Expected: true
    Received: false
      378 |     gateBefore,
      379 |     'with the switch on and "I understand" unticked, the composer\'s send button must be disabled',
    > 380 |   ).toBe(true);
```

红**只**落在这一条：同一次运行的 `notice.visible=true` 与 `notice.copy=…` 照旧打印（告知面仍展开），失败发生在 `gate.before` 那一行、`send.unacked` 与 `pathname` 两条承重读数**根本没跑到** ⇒ 摘掉门控这件事被精确指认，而不是任意一条断言翻红。`git checkout -- src/modules/chat/composer/ChatComposer.tsx` 还原后同命令回到 **0**（`3 passed (31.7s)`，见 AC1）。

**AC7 契约面。** `npm run lint` 退出 **0**（仅 warning；其中两条 `react(only-export-components)` 落在新文件 `ResidentConsentNotice.tsx` 的两个模块级导出函数上 —— 那是新建会话路径把「已勾选」意图从 `ChatComposer` 传给 `useChatComposerState` 的一次性交接，两个消费者同属 chat 模块，拆成第三个文件会落在 `## Touches` 之外）。`git diff --name-only develop...HEAD` 列出 11 个文件，逐条落在 `## Touches` 的 12 条之内（第 12 条 `tasks/gap-claude-resident-consent-gate.md` 是自触，供本次 AC 勾选与记录落账）。`npm run typecheck` 的收窄与证明见上方 AC7 条目本身。

**与 Proposal 的偏离（1 处，按 Plan 步 1「按实际形状钉缝、不按规划文字猜」）。** Proposal §3 设想的是「`createSession` 报文加一个模式字段」；实测 AC-169 落地后的真面是 `PUT /api/providers/:provider/sessions/:sessionId/lifecycle-mode`（`src/shared/api.ts` 的 `setSessionLifecycleMode`，服务端既有路由），而 `POST /api/providers/sessions` 忽略额外字段。故新建路径实现为「先建会话拿到 id，再置模式」，落在 `useChatComposerState.ts` 的 `createSession` 与 `chat.send` 之间 —— 这也是 DoD「后端一行不改」下唯一可行的接法。菜单那条路径按 Proposal 原样走同一个 `setSessionLifecycleMode`。

**判据里唯一的一处替身（spec 内已就地注明其存在与边界）。** AC4 的 `menu.disabledWhenProcessing=true`：服务端的「处理中」读的是在飞轮次注册表（`sessions.service.ts` 的 `listRunningSessions()` → `chatRunRegistry.listRunningRuns()`），只有真模型轮次在流式期间才在其中，fixture 无法让一个会话在该状态里停住。故这条腿用 `page.route` 只替 `GET /api/providers/sessions/running` 这一条**只读**应答，并立刻 `route.fallback()` 放行；菜单项的 `disabled`、`modeBefore=modeAfter`、`modeAfterConvert`、以及 AC4/AC5 的每一个能力矩阵与生命周期模式读数，全部读自真应用与真服务端。

**待人工知会的一条 develop 侧缺陷（不在本任务范围内，未修）**：`e7ab6a42`（AC-170）落地的 `scripts/resident-smoke.mjs` / `scripts/resident-smoke.test.mjs` 在 `scripts/tsconfig.json`（`checkJs`）下带 63 个类型错误，使 `npm run typecheck` 在 develop 上退出 2 —— AC-170 自己的 AC8 只要求 lint，故该红自落地起无主。任何后续任务的 AC 若写「`npm run typecheck` 退出 0」都会撞上它。


**2026-09-27 worker 轮 2 —— 只做本 delta 在兄弟面造成的红的修复；本轮判据无需改，AC 无回退。**

**上一轮 exit-not-landed 的派单词只引了一条红，但 raw log 里有 9 条。** 逐条归因如下（读数取自本轮 worktree 的 `.quay/suite-logs/20260927T224218-2943719/` 各 `.out` 与 `.res`，非推断；派单词引的那条 `voice-capture-audio.false-forms.test.ts` 只是其中之一，且其真因不在它自己身上）：

- **7 条与本 delta 无关，同一个 develop 侧成因**：`typecheck` 一条，加 `voice-capture-{audio,isolation,off,text}.false-forms` 与 `voice-error-{classification,contract}.false-forms` 六条。后六条**自身的设计变异臂全绿**（每条 `.out` 里 `mutantRed=true` 且 `red` 落在它自己的 AC 读数上），红的都是它们自己的「既有判据与仓闸仍然退出 0」那条腿，逐字 `+ actual - expected … + [ 'npm run typecheck' ] - []`（`voice-error-contract` 那条写作 `[ 'typecheck' ]`）。根因即 AC7 已证明的第三环：`scripts/tsconfig.json`（`allowJs + checkJs`）在 `scripts/resident-smoke.mjs` / `resident-smoke.test.mjs` 上报 **63** 个 TS 错。
- **该红是本轮新出现的 develop 回归，不是长期基线**（这条区分决定了「重跑就好」与「等修」两种处置）：`scripts/resident-smoke.mjs` 最后一次改动是 `e7ab6a42`（`2026-09-27 22:15:57 +0800`，AC-170 落地）；同 workspace 里 `gap-claude-resident-slice-memory-cap` 的 5 份 fan-in 日志**全部早于 22:15:57**，逐份 `grep -c "not ok - typecheck"` 为 **0**，而本轮 22:42 的日志里 `__PERFILE__ typecheck passed=false`。本轮 worktree 与 canonical checkout（HEAD `ca7437c8` == `git rev-parse develop`）上 `npx tsc --noEmit -p scripts/tsconfig.json 2>&1 | grep -c "error TS"` 同为 **63**；`git diff --stat develop -- scripts/` 为空 ⇒ 与 delta 无关。active 任务中没有任何一条的 `## Touches` 含该文件 ⇒ 该回归当前**无主**（AC-170 自己的 AC8 只要 lint）。
- **2 条是本 delta 的红，本轮已修**：`src/modules/sidebar/tests/debugAgentIdentity.test.tsx` 与 `src/modules/sidebar/tests/sessionOptionsHideSimilar.test.tsx`，逐字 `Error: [vitest] No "useResidentProviders" export is defined on the "@/shared/hooks/useProviderCapabilities" mock. Did you forget to return it from "vi.mock"?`。修法：两处整块替身各补一行 `useResidentProviders: () => new Set<string>()`（空集 ⇒ 「转为常驻…」不进这两个测试所断言的菜单，与它们原本的期待一致），并各加一行注释说明为何需要。复跑 `npx vitest run <两个文件>` 逐字 `Test Files 2 passed (2)` / `Tests 5 passed (5)`。

**本轮的预期终局（如实登记，供审阅者判读）。** 本 delta 的红已清零；但上面那 7 条在 fan-in 的 `suite` 步仍会红，而 worker-driver 的 `failSuite` 对该步**没有 develop 基线豁免**（`worker-driver.js`：`sr.outcome !== "done"` ⇒ 直接 `failSuite(extractFirstFailureLine(...))`）⇒ 本轮 fan-in 仍会停在 `step=suite`，且**红不在本 delta**。要真正解锁需要一条拥有 `scripts/resident-smoke.mjs` 的任务（修那 63 个类型错，或把 `scripts/tsconfig.json` 的 `include`/`checkJs` 收到不含测试脚本的范围）；本任务按 AC7 与 DoD 不动它。

## Needs-Human

**执行 2026-09-27T14:56:05.955Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-audio.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
- run_id：wk-prod-anchor
- session_id：f8d5360b-99ff-4a7f-baba-566350f8f56d
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-resident-consent-gate~wk-prod-anchor~1790520767356-4e5b86.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-resident-consent-gate-wk-prod-anchor.log

## 人工复核（2026-09-27，人 yale 指令「检查和推进」）

停在 needs-human 的判词是 `voice-capture-audio.false-forms.test.ts` 的
`a surface this task must not have moved is red`，但同一轮 suite 日志实际有 **7 条**红
（`reason: red: 7 failed`），第一条就是 `typecheck passed=false`，逐字点名
`scripts/resident-smoke.mjs(225,29): error TS7006: Parameter 'pid' implicitly has an 'any' type.`——
这正是我在这之前落地 AC-170 时引入、随后已修复（提交 `a05471a9`）的仓库级 typecheck 回归。本轮的
六个 voice `*.false-forms.test.ts` 红全部是那个 TS7006 的连带效应（`AC6/AC7/AC10` 各自重跑
`npm run typecheck` 并要求红集为空），不是本任务的 delta：worktree 在派工时同步的 develop 还没有
我的修复提交。修复已在，重新排队即可（下一轮 fan-in 会先合并到含修复的 develop）。
