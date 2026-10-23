---
id: gap-debug-agent-display-identity
title: 调试 Agent 的 UI 显示身份：侧栏提供商文字位非 Claude、LLMProviderLogo 不落穿（AC-136 的 checker）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-136
---
## Proposal

**交付物：调试 Agent 在 UI 上的显式显示身份，以及承载它的目标级判据 `goals/AC-136` 的 checker。** 据 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md` 的**裁决 A**（"调试 Agent 必须有自己的显示身份"）与决策 2，改动两处落点，并新建 `src/shared/tests/debug-agent-display-identity.test.ts`——该文件即 AC-136 的 criterion，**今天不存在**。

### 为什么需要它

`LLMProviderLogo`（`src/shared/ui/LLMProviderLogo.tsx`）是一条 `cursor` / `codex` / `opencode` 之外的**落穿链**，末尾 `return <ClaudeLogo className={className} />`；`PROVIDER_LABELS`（`src/modules/sidebar/utils/sidebarProjectFormatting.ts` 第 218 行）的声明类型是 `Record<LLMProvider, string>`，运行期 id 无键 ⇒ `undefined`。

实测（ADR-003 验证记录 c）在真实浏览器里：侧栏会话行的**提供商文字位为空**，但头像与无障碍名读出的是 **"Claude"**；打开会话后每条消息也带 Claude 头像与 "Claude" 标签。

**这不是"缺标"，是"错标"。** 缺标只是看不见；错标是**主动断言了一个错误的来源**。决策 2 的立论是"运行期 id 刻意不进 `LLMProvider` 联合 ⇒ UI 侧没有编译期强制点，只能靠显式显示身份"；一个自称 Claude 的调试面把这个立论**反过来了**——它不是无从区分，是冒名。一个用途是产生可信证据的调试面，其产物自称另一个 provider，会污染读证据时的第一判断。

### 两条落点（裁决 A 逐字给的实现要求）

1. `PROVIDER_LABELS` **放宽并加一键**——声明类型从 `Record<LLMProvider, string>` 放宽到接受任意 string 键（不放宽则加键就是编译错误，`npm run typecheck` 会红）。
2. `LLMProviderLogo` 在**落穿链之前**插入该 id 的判断，渲染一个与 claude 分支**可区分**的形态。

**不得**把该 id 加进 `LLMProvider` 联合（`server/shared/types.ts`）——裁决 A 逐字写了"决策 2 反对的是加进联合，不是给它显示身份"。两处落点的 props / 索引本就接受 `string`。

### 判据的形状（AC-136 逐字要求）

AC-136 的 criterion 是 `npx vitest run src/shared/tests/debug-agent-display-identity.test.ts`，命令逐字含文件路径、不得用 glob。该用例对一处**构造出的侧栏会话视图**取两个读数并打印：

1. 提供商文字位**非空**、且**逐字不等于 `"Claude"`**；
2. `LLMProviderLogo` 对该 id **不落穿**到 claude 分支（形态与 claude 分支可区分）。

取假形态：**不给它显示身份（保持落穿）**时该判据必须红——该失败是**静默的**，这正是本条存在的理由。

### 运行期 provider id 在前端是一个字面量（如实登记）

`DEBUG_AGENT_PROVIDER_ID = 'debug'` 定义在 `server/modules/debug-agent/debug-agent.gate.ts`。前端**不得**从 server 导入（boundaries 规则），故本判据在测试里用同值字面量并注释指向该常量。若 server 侧改名，本判据不会自己发现——该耦合由 registry 那一侧的判据承担。这是如实登记的边界，不是遗漏。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：逐条核对 `tasks/*.md` 的顶层 `goal_ac`，**无任何任务**声明 `goal_ac: AC-136`，故本任务是该 AC 的第一个占位者。相邻但判据不同的是 `gap-debug-agent-engine-and-scenario-ops`（`goal_ac: AC-124`）：它的任务级 AC4 落在同一处 UI 面，Touches 里也已有 `src/shared/ui/LLMProviderLogo.tsx` 与 `src/modules/sidebar/utils/sidebarProjectFormatting.ts`。区别在判据：那一条是**任务级**断言，本任务交付的是**目标级**判据 `goals/AC-136` 的 checker（`src/shared/tests/debug-agent-display-identity.test.ts`）及其正对照与反假变体。两条判据的命令与文件各不相同，各自独立判定；谁 merge 在前都只是让对方少改一处文件，两条之间没有条件关系。

## Plan

1. **两处落点最小改动**：`PROVIDER_LABELS` 放宽类型并加该 id 一键；`LLMProviderLogo` 在末尾 `return <ClaudeLogo />` **之前**加该 id 的分支，渲染新的 `src/shared/ui/DebugAgentLogo.tsx`（带自己的 `role="img"` 与 **`aria-label`**，使"可区分"是**可读**的而不是"长得不一样"）；`src/shared/ui/index.ts` 导出该组件（`LLMProviderLogo` 就在那里导出）。一处改动即覆盖所有消费面：`LLMProviderLogo` 的九个调用点（侧栏行、消息、工作区标题等）全部走同一个函数。
2. **判据读的是出货的表达式**：测试从 `@/shared/ui` 取 `LLMProviderLogo`，从 `@/modules/sidebar/utils/sidebarProjectFormatting` 取 `PROVIDER_LABELS`，对构造出的会话视图读**侧栏行自己那一条表达式** `PROVIDER_LABELS[session.__provider]`（`SidebarSessionItem.tsx` 第 66 行的同一条读法）。已在立案前实测：该深导入在 `npm run lint` 下 exit 0（baseline 与加探针各一次都为 0），**不需要**为它改 sidebar barrel。切勿让测试自建一份 label 表或 logo 替身——那样 AC2 的假形态就红不了，判据会变成自证。
3. **渲染读形态**：用 `react-dom/server` 的 `renderToStaticMarkup` + `React.createElement`（本文件被 criterion 钉死为 `.ts`，故不写 JSX）分别以该 id 与 `'claude'` 渲染 `LLMProviderLogo`，比较 markup。
4. **正对照（防"零 X 恒真"）**：判据必须同时断言 `PROVIDER_LABELS['claude']` 逐字为 `"Claude"`，且以 `'claude'` 渲染出的 markup **含** `aria-label="Claude"`。没有这两条，"不等于 Claude"是一个惰性实现也能拿满分的断言；再把 `'codex'` / `'cursor'` / `'opencode'` 三条渲染纳入互异性读数，使"比较不是对所有输入恒真"也被读到。
5. **提交之后再取假形态**：AC2 的还原靠 `git checkout --`，所以两处落点必须**先提交**，假形态才可还原。
6. **收尾**：`npm run typecheck`、`npm run lint`、`npx vitest run src/shared/tests/debug-agent-display-identity.test.ts` 三条各自 exit 0。

## AC

- [x] AC1 判据落地并绿：`npx vitest run src/shared/tests/debug-agent-display-identity.test.ts`（逐字含文件路径，不用 glob）退出码 0。该用例对构造出的侧栏会话视图打印**五项**实际读数：(a) `PROVIDER_LABELS[session.__provider]`（构造对象的 `__provider` = 运行期 id）——非空且逐字不等于 `"Claude"`；(b) `PROVIDER_LABELS['claude']`——逐字 `"Claude"`（正对照）；(c) 以该 id 渲染 `LLMProviderLogo` 的 markup **不含** `aria-label="Claude"`；(d) 以 `'claude'` 渲染的 markup **含** `aria-label="Claude"`（正对照）；(e) 该 id 与 `'codex'` / `'cursor'` / `'opencode'` 三条渲染的 markup 互不相同（比较不是恒真）。五项缺一即不满足。
- [x] AC2 抗假变体（**真跑并留输出，两个独立假形态各自跑**）：(L) 只撤 `PROVIDER_LABELS` 的键（`LLMProviderLogo` 分支保留）——`AC1` 的命令必须退出码非 0，红因是 (a) 的文字位为空，**不是**"文件不存在"或编译错误；(G) 只撤 `LLMProviderLogo` 的分支（**保持落穿**，这正是 AC-136 点名的假形态）——`AC1` 的命令必须退出码非 0，红因是 (c)：该 id 的渲染里出现 `aria-label="Claude"`。两次跑完各用 `git checkout --` 还原对应落点，`git status --short` 只剩既有未跟踪项，并**贴两次输出**（红那次 + 还原后绿那次）。
- [x] AC3 「不进联合」这半边：`git diff "$(git merge-base develop HEAD)"...HEAD -- server/shared/types.ts` 输出为空（该 id 未进 `LLMProvider` 联合；打印该命令输出）；且 `grep -n "export const PROVIDER_LABELS" src/modules/sidebar/utils/sidebarProjectFormatting.ts` 打印的声明行**不再是** `Record<LLMProvider, string>`；`npm run typecheck` 退出码 0。
- [x] AC4 本任务未触及 Touches 之外的文件。命令：`git diff --name-only "$(git merge-base develop HEAD)"` 与 `git ls-files --others --exclude-standard` 两个输出逐行核对，每一行都必须能对应到本任务 Touches 内的一条；命中 Touches 之外时逐行打印并以非 0 退出。用 merge-base 而非裸 develop——develop 会随他人 fan-in 前进。

**落地登记（实跑读数）**：两处落点在本任务开工时**已在 develop 上**，由 AC-124 的派工任务随产出引擎一并落地（`c05f4fd4`）——`PROVIDER_LABELS` 已放宽为 `ProviderLabels` 且带 `debug: 'Debug Agent'` 一键，`LLMProviderLogo` 已在 `return <ClaudeLogo />` 之前分支到自带 `aria-label="Debug Agent"` 的调试标记。故本任务的增量是**判据本身**（AC-136 的 checker 及其正对照与反假变体），两处落点未再改动；AC2 的两个假形态正是在这两处既有落点上取的，因此"撤掉出货模块的显示身份后判据变红"这一承重性证明读的仍是出货路径。AC1 实测五项读数：`(a) "Debug Agent"`、`(b) "Claude"`、`(c) false`（该 id 渲染 475 字符，不携带 `aria-label="Claude"`）、`(d) true`（claude 渲染 2381 字符）、`(e) debug:475, codex:2634, cursor:552, opencode:387，无一对相同`。AC2 实测：变体 (L) 退出码 1，红因 `(a) ... is empty ... (rendered undefined)`；变体 (G) 退出码 1，红因 `(c) LLMProviderLogo rendered "debug" as Claude`（该 id 渲染 2381 字符、携带 `aria-label="Claude"`，与 claude 分支逐字相同），且 (a)(b) 在该变体下仍绿——两条读数轴独立。两次还原后 `git status --short` 空（本 worktree 无既有未跟踪项），AC1 命令回到退出码 0。AC3 实测：`server/shared/types.ts` 的 merge-base diff 为空；声明行为 `export const PROVIDER_LABELS: ProviderLabels = {`（不再是 `Record<LLMProvider, string>`）；`npm run typecheck` 退出码 0。AC4 实测：merge-base diff 仅 `src/shared/tests/debug-agent-display-identity.test.ts` 一行，未跟踪文件为空，两行都对应 Touches 内的一条。

## DoD

真实落地判据（不是"改了两个字面量"）：**判据的两个读数取自出货的模块，不是测试本地的替身；且撤掉出货模块的显示身份后判据确实变红。**

承重性由三件事正面证明：

(a) **读的是出货路径**——`LLMProviderLogo` 经 `@/shared/ui` barrel 取、`PROVIDER_LABELS` 取侧栏行自己那一条表达式；AC2 的两个假形态只改出货代码、不改测试，它们各自变红即证明判据没有自证。

(b) **"不等于 Claude" 不是恒真命题**——AC1 的 (b)(d) 正对照与 (e) 的互异读数，使一个惰性实现（对任何输入都返回同一形态）无法通过。

(c) **"可区分"是可读的**——新形态带自己的 `aria-label`，故 (c) 的读法是"该 id 的渲染不携带 claude 的身份"（无 `aria-label="Claude"`），而不是"字节不相同"；而 (e) 同时挡住"改成冒充另一个 provider"。

另需如实登记两处边界：（i）本任务**不**让 `goals/AC-136` 转绿——AC 状态由 driver 机械判定，本任务只交付它引用的 checker 与两处落点；（ii）本判据针对的是**构造出的**侧栏会话视图，真实调试 Agent 的会话行要等产出引擎落地后才存在，本任务不去声称在真实会话上读到过，也不依赖产出引擎。

L_D 该轴仍暗，理由：本任务只让 UI 对一个构造出的会话视图给出正确读数；真实调试 Agent 的会话行今天还不存在（产出引擎由 AC-124 的派工任务交付），故没有可读出的产品领域读数。判定面由 AC1 的五项机械读数与 AC2 的两个假形态承担。
L_G 本目标的判据是 `goals/AC-136`（调试 Agent 在 UI 上有明确显示身份、不落穿为 Claude），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体，AC3 断言"不进 `LLMProvider` 联合"这半边。

## Touches

- src/shared/tests/debug-agent-display-identity.test.ts (new)
- src/shared/ui/DebugAgentLogo.tsx (new)
- src/shared/ui/LLMProviderLogo.tsx
- src/shared/ui/index.ts
- src/modules/sidebar/utils/sidebarProjectFormatting.ts
- tasks/gap-debug-agent-display-identity.md