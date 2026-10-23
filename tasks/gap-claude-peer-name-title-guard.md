---
id: gap-claude-peer-name-title-guard
title: peer 名只在会话真有标题时才交给 CLI：阶梯兜底值不得被冻进 manual 档
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

上一条任务（`gap-claude-peer-name-follows-ai-title`，已 done）让 per-run 与常驻两条路在第二轮起把会话标题交给 Claude Code，注册名因此能落成 `nameSource: auto`、可读。**机制本身是对的**（2026-10-01 在真服务器上实测：第一轮 `derived`、第二轮抓到活动进程 `nameSource: 'auto'`）。

**但它传的值取自 `getSessionInfo().summary`，而 `summary` 是 Claude Code 那条阶梯的结果，不是「有没有标题」的判据。** 文档逐字：summary = custom title / auto-generated summary / **first prompt**。当会话没有 `ai-title` 时，它返回的是**首条消息原文**。

于是实测出现这个后果（2026-10-01，:3001，新代码）：

| 会话 | 跑了几轮 | 注册表（进程存活时读） | App 侧档位 | 转录 |
|---|---|---|---|---|
| `fe72ad3a` | 2 | `nameSource: **auto**`，name = 首条消息原文 | **`manual`**（rank 3） | **没有 `ai-title`**，有 1 条 `custom-title` = 同串 |
| `a0cde8d3` | 1 | （未抓到） | `derived`（rank 0） | 同样没有 `ai-title` |

档位表（`server/modules/database/repositories/sessions.db.ts`）：`agent 4 / manual 3 / ai 2 / self-assigned 1 / else 0`。

⇒ **在没有 `ai-title` 的会话上，这一步把「可自愈的 `derived` 占位名」提升成了「冻结在 `manual` 档的首条消息」——而 `manual` 高于 `ai`。** 一旦 Claude Code 之后补上标题，它再也压不上来。这是本系列任务一直在防的那种反转，只是值从「App 自造地址」换成了「阶梯兜底值」。

**这不罕见**：最近 48 小时 CloudCLI 新建 522 个会话，**只有 18 个（3%）有 `ai-title`**（504 个没有；其中 490 个是 quay 的短 worker，名字来源 `agent`）。有标题的转录行数中位 188，没有的 92。今天自建的两个探针会话是 **0/2**。

**人 yale 2026-09-30 裁定接受的是「冻结 AI 标题」；这里冻结的是兜底值，不是一回事。**

**本任务做的**：给 `resolveClaudeSessionTitle` 加一条守卫 —— **只有在会话确实有一个真正的标题时才交出去**；`summary` 只是阶梯兜底值时一律返回 `null`（等于不传），让注册名留在 `derived` 占位、将来标题出现时仍能被采纳。

**怎么判「真正的标题」**（实现者选一条并在代码里写明理由）：
- 读转录里的 `ai-title`（App 已有读取器：`session-ai-title.service.ts` 的 `readAiTitleEntry` 与带窗口的 readers），把它当交付值 —— 值即证据，没有就是没有；
- 或：把 `summary` 与该会话的首条消息比对，相等即判为兜底值。
⚠️ 不要用 App 自己那列 `transcript_name_source` 直接当判据：它可能已被覆盖档位（`manual` / `self-assigned`）改写，且它描述的是**本 App 的读数**，不是「Claude Code 侧有没有标题」。
⚠️ 人工 `/rename` 出来的 `custom-title` 属于**真标题**，不在本条要挡的范围内（人的名字本来就该最高）。

**实现者补记（2026-10-01）——上面两条建议之外，实际选的是第三条读法：`getSessionInfo(...).customTitle`。** 理由有两条，都是判据逼出来的：

1. **读转录 `ai-title` 那条路满足不了 AC 第 3 条。** 人工 `/rename` 落的是 `custom-title`，**不产生 `ai-title`**；只认 `ai-title` 就等于把人的名字也一起挡掉，与 AC 第 3 条「`/rename` 的值仍被交出去」直接冲突。`customTitle` 在 SDK 里编译成 `customTitle || aiTitle`，生成标题与人工改名**两条都覆盖**，一个读法同时满足 AC 2 与 AC 3。
2. **比对 `summary` 与首条消息那条路是不完备判据。** 阶梯不只 `lastPrompt` 一档兜底，还有 `summaryHint`；「与首条消息不等」并不等于「有标题」，只是把没抓到的那几档漏过去。而 `customTitle` 是**值即证据**：没有标题时它就是 `undefined`，返回 `null` 即不传，不需要任何启发式。

它同时也是**唯一**一个能同时满足三条 AC 的读法，且与 Claude Code 自己「这个会话是否已有名字」的判据同源。

## Plan

1. **判据先行**：新建 `server/modules/providers/tests/claude-peer-name-title-guard.test.ts`，做法照同目录既有的 `claude-peer-name-follows-ai-title.test.ts`（真 claude 二进制 + mock 端点决定标题，临时 `CLAUDE_CONFIG_DIR` / `DATABASE_PATH`）。先取红态。
2. **守卫**：`server/modules/providers/list/claude/claude-runtime.provider.js` 的 `resolveClaudeSessionTitle`（该文件是已跟踪源码）。三个调用方（`claude-per-run-host-driver.provider.ts`、`claude-runtime.provider.js` 内部、`claude-host-driver.provider.ts`）都走这一个函数，**不需要改**。
3. **留痕**：在 `docs/proposals/claude-resident-sessions.md` §12 的修订块补一句：交出去的必须是**真标题**，阶梯兜底值不交。
4. **假形态逐条验红**，验完还原；既有判据不退。
5. **既有判据的连带修正（计划外，见 AC 第 4 条）**：`claude-resident-addressable.test.ts` 里那条 `second.registryNameSource === 'auto'` 的断言，是上一条任务在「交出去的是会话自己的标题」这一信念下改的；该 fixture 里既不可能有 `ai-title`（mock 对非 agent 请求一律回 `aux ok`）也不可能有 `custom-title`（leg-3 的改名因该 harness 从没填过 `jsonl_path` 而被 provider 拒绝，日志逐字 `had nothing to write to the "claude" store (no-transcript)`），所以那个 `auto` 只能是阶梯兜底值被交出去的结果——正是本任务要拿掉的那个读数。该文件因此**不能**满足 AC 第 4 条的「文件未改」。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-peer-name-title-guard.test.ts` 退出 0，且断言：会话**没有** `ai-title` 时，跑满两轮之后注册表 `nameSource` **仍是 `derived`**、App 侧也仍是 `derived`，且转录里**不出现**本 App 写入的 `custom-title`。**假形态**：把阶梯兜底值（首条消息）也交出去 ⇒ 必须红。
- [x] 同一文件**正控制**：会话**有** `ai-title` 时，第二轮之后注册表 `nameSource === "auto"` 且 `name` 逐字等于该 `ai-title`（证明守卫没有把整条路堵死）。
- [x] 同一文件断言人工名不受影响：会话的标题来自 `/rename`（`custom-title`）时，该值仍被交出去（它是真标题）。
- [x] 既有判据逐条退 0。`claude-peer-name-follows-ai-title.test.ts`、`claude-session-name-authority.test.ts` **文件未改**；`claude-resident-addressable.test.ts` 退 0 但**文件改了**——它那条 `auto` 臂断言的正是本任务要移除的兜底值交付（见 Plan 第 5 条），改回 `derived` 并写明理由，该文件已登记进 `## Touches`。「文件未改」这一半对它不成立，是本任务唯一一处偏离，不隐藏。逐条打印命令与退出码。
- [x] `npm run typecheck` 三条链退出 0；`npm run lint` 退出 0（仅既有 warning）。

## DoD

在真实运行的 CloudCLI（`dist-server/server/index.js`，端口 3001）上取两条腿：

1. **无标题腿**：新建一个会话（其转录里**没有 `ai-title`**），跑满两轮 ⇒ `~/.claude/sessions/<pid>.json` 的 `nameSource` 仍是 `derived`；App 行的 `transcript_name_source` 仍是 `derived`；转录里没有本 App 写入的 `custom-title`。
2. **有标题腿**：新建一个会话、等它的转录出现 `ai-title`，再跑第二轮 ⇒ `nameSource === "auto"` 且 `name` 逐字等于该 `ai-title`。

⚠️ 第二条腿依赖标题生成，而它**会 flake**（同 prompt 同 env 有时整轮没有 `ai-title`；2026-10-01 实测最近 48 小时只有 3% 的 CloudCLI 会话拿到标题）。**没出现 `ai-title` 是重跑的理由，不是改代码的理由**；判据里对 `ai-title` 的等待要做成**轮询那个行**，不是睡固定秒数。

只做到「测试绿」不算数：两条腿都要有真实会话跑过、且读数被打印出来。

## Touches

- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/services/session-ai-title.service.ts
- server/modules/providers/tests/claude-peer-name-title-guard.test.ts (new)
- server/modules/providers/tests/claude-resident-addressable.test.ts
- docs/proposals/claude-resident-sessions.md
- tasks/gap-claude-peer-name-title-guard.md

## 验证留痕（2026-10-01）

判据逐条跑过，命令与退出码：

| 命令 | 退出码 |
|---|---|
| `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-peer-name-title-guard.test.ts` | 0 |
| 同上 `claude-peer-name-follows-ai-title.test.ts` | 0 |
| 同上 `claude-session-name-authority.test.ts`（16 tests） | 0 |
| 同上 `claude-resident-addressable.test.ts` | 0 |
| `npm run typecheck`（`tsconfig.json` / `server/tsconfig.json` / `scripts/tsconfig.json` 三条链） | 0 |
| `npm run lint` | 0（仅既有 warning） |

新判据的关键读数（运行日志原文）：有标题腿 round 2 `registration={"name":"AC Generated 449c861e","nameSource":"auto"}`；无标题腿 round 2 `aiTitles=[] customTitles=[] registration={"name":"claude-peer-title-guard-…-0f","nameSource":"derived"}`，App 行 `transcript_name_source="derived"`；`/rename` 腿 `customTitles=["AC Renamed 449c861e"] registration={"name":"AC Renamed 449c861e","nameSource":"auto"}`。

**假形态验红**：守卫未加时该判据红在第一条断言 —— `AssertionError: a session with no title must keep the CLI's derived name … 'auto' !== 'derived'`，同一日志里 `registration` 的 `name` 是首条消息原文、`nameSource: "auto"`、`customTitles=["AC-UNTITLED-…"]`，即本任务要移除的那个形态本身。

**DoD 两条腿**（真服务器、真会话，读数取自本 worktree 自己 build 的 `dist-server/server/index.js`，`HOST=127.0.0.1`、`listen(0)` 探得的端口；会话经 App 自己的 HTTP + WebSocket 面建立与驱动，模型走本机真网关）：

- **无标题腿**：`aiTitles=[] customTitles=[] registryName="workspace-3f" nameSource="derived"`，App 行 `transcript_name_source="derived"` 且 `jsonl_path` 已写（这一行不是空读）。该会话首轮消息是 `hi`。
- **有标题腿**：`aiTitle="DOD-TITLED-… titled-r1-a1"`，`registryName` 与它逐字节相等，`nameSource="auto"`，App 行 `transcript_name_source="ai"`。

两条腿能分开，靠的是先量出一条本机性质：**这台网关的标题生成看内容** —— 首条消息 `hi` 不落 `ai-title`，而普通提示词、长提示词、代码块三种都给（实测 3/4 有标题）。所以「一个没有 `ai-title` 的会话」在真服务上可造，但必须先探。**两处偏离照旧**：端口不是 3001（3001 是本会话自己的宿主，从会话内部重启它是禁止的）；隔离靠 `HOME` 而非 `CLAUDE_CONFIG_DIR`——服务的会话索引器按**进程 home** 解析 `~/.claude`，只隔离 `CLAUDE_CONFIG_DIR` 会让服务继续盯着真的 `~/.claude`（实测：那样配置时服务日志同步的是本会话自己的转录），App 行那条读数就永远等不到本次运行的转录、变成空读。
