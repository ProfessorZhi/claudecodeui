---
id: gap-debug-agent-message-header-falls-through-to-claude
title: 调试 agent 的消息头 provider 名落穿为 Claude（头像已是 Debug Agent，名字不是）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**缺陷（实测）。** 调试 agent 会话里，每条 assistant 消息的头部：头像已经是 Debug Agent 的烧瓶标（`LLMProviderLogo`），但紧挨着的 provider 名字显示为 **"Claude"**。

实测读数：在真实浏览器里打开一个调试 agent 会话，assistant 行的无障碍快照为 `img "Debug Agent"` 紧跟 `generic: "Claude"`；行文本读作 `Claude 来自调试 provider 的脚本化回复。`。

**机制（代码归属）。** `src/modules/chat/transcript/MessageComponent.tsx:326-337` 是一条三元落穿链：

```
message.type === 'error' ? t('messageTypes.error')
  : message.type === 'tool' ? t('messageTypes.tool')
    : (provider === 'cursor' ? t('messageTypes.cursor')
        : provider === 'codex' ? t('messageTypes.codex')
          : provider === 'opencode' ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : t('messageTypes.claude'))
```

`provider === 'debug'` 没有任何分支，落到最后的 `t('messageTypes.claude')`，于是显示 "Claude"。

**这是同一个缺陷的第二次出现。** AC-136（`goals/AC-136-调试-agent-在-ui-上有明确显示身份-不落穿为-claude.md`，已 achieved）修的是**同一类**落穿：它给 `src/shared/ui/LLMProviderLogo.tsx:33` 加了 `aria-label="Debug Agent"`（头像），并给 `src/modules/sidebar/utils/sidebarProjectFormatting.ts:260` 的 `PROVIDER_LABELS` 加了 `debug: 'Debug Agent'`（侧栏）。**消息头这条链不在 AC-136 的判据面内，所以漏了。**

**为什么这条比"看不见"更糟。** 「静默缺席」只是不显示；**错标是主动断言了一个错误的来源**，而 ADR-003 决策 1 立论所依赖的恰恰是"调试 agent 与真 provider 在 UI 上无从区分（因为它走同一条链路）"——一个把合成产出标成 Claude 的名字，会让读屏用户和任何读这一行的人相信这是 Claude 的真实产物。

## AC

- [x] 新增（或扩展）判据，且**对当前实现必红**：渲染一条 `provider: 'debug'` 的 assistant 消息，断言消息头的 provider 名文本为 "Debug Agent"（而非 "Claude"）。命令：`npx vitest run <该测试文件路径>`（client 侧测试；命令必须逐字含文件路径）。失败时打印实际读到的文本。
- [x] 正控制：同一个判据断言 `provider: 'unknown-provider-xyz'` 仍回退到 Claude。**这条是承重的**——它保证修复不是"把 fallback 删掉"或"把三元链改成恒真"，即修的是 `debug` 这一个已知身份，而不是取消未知 provider 的回退语义。取假变体：把 `debug` 分支实现成"删掉最后那个 `t('messageTypes.claude')` 回退"，必须让正控制红。
- [x] 头像与名字一致：同一条消息上，`LLMProviderLogo` 的无障碍名与 provider 名文本指向同一个身份（读两个值并比较，不靠人工看）。
- [x] i18n：若新增 key，必须与既有 `messageTypes.*` 同形，且在 `src/modules/i18n/locales` 下的**全部** locale 都存在（逐目录枚举，不写死语言列表）。

## DoD

真实落地：在一个**真实跑起来的调试 agent 会话**里，消息头的 provider 名读作 "Debug Agent"，且读屏读到的名字与头像一致；同时未知 provider 仍回退到 Claude。承重性：
(a) 判据先红后绿，红要先于修复被观察到；
(b) 正控制（unknown → Claude）在修复后仍绿，且删除 fallback 的取假变体会让它红；
(c) 用实机读数（浏览器里读出的文本）登记，而不是只登记单测结果。

## Touches

- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/i18n/locales/*/chat.json
- src/shared/ui/LLMProviderLogo.tsx
- src/modules/sidebar/utils/sidebarProjectFormatting.ts
- src/modules/chat/tests/debug-agent-message-header-identity.test.tsx (new)
- tasks/gap-debug-agent-message-header-falls-through-to-claude.md

## Evidence

**判据（AC1–AC4）**：`src/modules/chat/tests/debug-agent-message-header-identity.test.tsx`，命令
`npx vitest run src/modules/chat/tests/debug-agent-message-header-identity.test.tsx`。

- **先红（修复前观测）**：`Tests 2 failed | 1 passed (3)`。红的两条是：debug 消息头实际读到
  `"Claude"`（断言消息印出实际文本：`Expected "Debug Agent" / Received "Claude"`），以及 12 个
  locale 的 `messageTypes.debug` 读到 `undefined`。第三条（正控制 unknown→Claude）此时**已绿**——
  落穿本来就没被动过，这正是它的作用。
- **后绿（修复后）**：`Test Files 1 passed (1)` / `Tests 3 passed (3)`。
- **取假变体（AC2 的承重腿）**：把 `debug` 分支实现成删掉末尾 `t('messageTypes.claude')` 回退
  （`': ''`），重跑得 `Tests 1 failed | 2 passed (3)`——唯一红的是正控制，读数为
  `an unrecognised provider must still be named Claude, but the header read ""`，debug 臂仍绿。
  按原实现还原后复绿。即：该假形态只能被正控制看见，AC2 的预言成立。
- **改动面**：`MessageComponent.tsx` 的落穿链加 `provider === 'debug'` 分支（末尾回退保留，注释说明
  为什么保留）；12 个 locale 的 `chat.json` 各加 `"debug": "Debug Agent"`——它与
  Claude/Codex/Cursor/OpenCode 同为专名，故各语言同值，且与 `LLMProviderLogo` 的
  `aria-label="Debug Agent"` 逐字相同，这正是 AC3 逐语言比较要求的不变量。
- **其它门**：`npm run typecheck` exit 0；`npm run lint` exit 0（本任务改动的文件零 finding）；
  `bash scripts/test.sh --for-task gap-debug-agent-message-header-falls-through-to-claude --allow-thin` 绿
  （`__PERFILE__ … debug-agent-message-header-identity.test.tsx passed=true`，`# tests 1 / # pass 1 / # fail 0`，
  exit 0；这份门只跑 Touches 里的 `*.test.*`，typecheck/lint 不在其中，故上面两条另行跑过）。
- **DoD 的实机腿：已尝试，未取得该读数，据实登记（不声称做过）。** 在本 worktree 里跑了真实
  浏览器 + 真实 server 的调试 agent e2e：`npx playwright test e2e/resident-status-bar.spec.ts`
  （4 passed），另用一份临时探针 spec（跑完即删）驱动 `resident-busy-send` 的两个调试会话并逐行
  dump `.chat-message`。读数：这些 fixture 的调试会话只有三种行——种子 **user** 行、divider 行、
  **unattended** 行，**没有任何 assistant 行**（`assistantRowsOnLastSession=0`）；而
  `MessageComponent.tsx:250-267` 的 unattended 分支**按设计不画消息头**（"the absence of the
  avatar" 就是它与回复的区别）。所以「真实浏览器里读一条调试 agent **回复**的消息头 provider 名」
  用仓库现有 fixture 制造不出来：`DebugAgentScenarioSeed` 只有 `title`/`userText`，要造 assistant
  行得改 debug-agent 的服务端 seam，超出本任务的 Touches 与 AC 面。同一次真实运行确实读到了同一批
  调试会话的**身份面**：侧栏行 `img "Debug Agent"` 紧跟 `Debug Agent Resident session`
  （AC-136 的修复，活的）。**消息头没有实机读数，故此处不登记实机读数。**
- **注意到但未改（范围之外）**：`src/modules/chat/ChatInterface.tsx:481-488` 有一条同形的落穿链
  （`selectedProviderLabel`，用于"选择一个项目"空态）。它同样会被 `useChatProviderState` 在打开
  会话时写入的 `selectedSession.__provider`（调试会话即 `'debug'`）喂到，但只在 `!selectedProject`
  时渲染——而调试会话总归属于某个 fixture 项目——且不在本任务 Touches/AC 面内，故按范围留给后续。
- **Touches 补登（ABI）**：`src/modules/i18n/locales/*/chat.json` 是 AC4 强制的新增写入面（12 个
  locale 各一行 key），首版 Touches 只声明了四个文件，会让 fan-in 的 anti-drift 把 12 个 locale
  文件判成 `out-of-declared`（HARD FAIL）。故经 ABI 补一条 glob（`*` 匹配单层路径，覆盖 12 个目录）。
