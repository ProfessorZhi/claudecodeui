---
id: gap-claude-peer-name-follows-ai-title
title: peer 名跟随 Claude Code 的 ai-title：启动时把会话自己的标题交给 CLI，注册名落 nameSource=auto
status: done
needs_human_cause: human-adjudication
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

`ListAgents` 里 CloudCLI 会话的 peer 名是机器标签（`archguard-85`、`tailscale-64`），而同一个会话在 Claude Code 自己的列表里显示的是可读的 `ai-title`。两者是两套独立的名字：

- **转录标题**（`ai-title`）：Claude Code 从对话内容生成 ⇒ 可读
- **进程注册名**（`~/.claude/sessions/<pid>.json` 的 `name`）：只在启动/认领时定；没人给名字 ⇒ `<cwd 目录名>-<2 随机字符>`（`nameSource: derived`）。per-run 每轮新起一个进程 ⇒ **随机尾巴每轮都换**（实测同一会话 6 次重启得到 6 个不同标签）

2026-09-30 已裁定常驻启动不再传 `--name`（CloudCLI 不自赋名，避免后缀累加与档位反转）。撤掉之后，peer 名就只剩机器标签一种可能 —— 本任务补上可读性那一半。

**实测的对照**（会话 `system specs query`，`kind: bg`）：它的 peer 名在**运行中**被换成了自己的 ai-title —— 注册表 `formerNames` 记录旧名 `121f125b`（会话 id 前缀），`nameSource` 变成 **`auto`**。那是 Claude Code 自己的采纳路径（二进制里的 `Sft()`：注册名 ← 标题、来源 `auto`；守卫要求当前名字来源是 `derived`，或是一个值已变的陈旧 `auto`）。

**那条路在 Claude Code 侧只从三处被调用**：Remote Control 的被监督子会话、SDK 握手的 `title` 字段、prompt options 的 `title`。后两者 CloudCLI 够得着。

**通道评估（已做，结论：留在 CloudCLI 自己传标题）**：Claude Code 的后台会话子系统（`claude --bg`）能白拿可读名（**提示词即注册名**，t=0 就有；无 prompt 时退化成会话 id 前缀），但它给的是**终端附着模型** —— 没有 stream-json、没有逐轮控制面、没有权限应答面（`claude agents --json` 只给一张列表，`claude logs` 是 PTY 屏幕转储）。CloudCLI 现有的整轮协议会被整个废掉，**人 yale 2026-09-30 裁定放弃该方案**。

**本任务要做的**：两条启动路径（per-run 与常驻）都在 SDK 握手里把**该会话自己的标题**交给 Claude Code，让注册名落成 `nameSource: auto`、值等于 ai-title。

**传什么值**：`getSessionInfo(sessionId, { dir: projectPath }).summary`，即 Claude Code 自己报的标题（App 已有这个读数，`claude-rename.provider.ts` 在用）。**不得**传 App 缓存里的显示名（`custom_name` 投影）：一旦两者有分歧，传下去就把分歧写进 Claude Code，那正是刚拆掉的那个反转。

**什么时候传**（这一条决定成败，全部为实测读数）：

- **新建会话的那一轮不传** —— 实测「新会话 + `title`」⇒ **AI 标题生成被抑制**，会话从此拿不到自己的标题。
- **其后每一轮都传** —— 实测 ⇒ 注册名 = 该标题、`nameSource: auto`。
- 判定条件天然自限：`getSessionInfo().summary` 有值才传。首轮没有标题 ⇒ 不传；标题在首条消息后约 2 秒生成 ⇒ 次轮起一定拿得到。

**已实测的副作用（人已裁定接受）**：

1. 首次传值时 CLI 会往转录写一条 `custom-title` = 传入值。若传的就是当时的 ai-title ⇒ 字符串相同、显示无变化，但该条目在阶梯里**高于 `ai-title`**（Claude Code 与 App 都是）。
2. 该条目一旦写下，后续 resume **忽略新传入的标题**、以持久化者为准 ⇒ **名字冻结在首次采纳时的那个标题**。人 yale 2026-09-30 裁定：**接受冻结**（`system specs query` 事实上也只采纳过一次）。不冻结需要 App 主动 `renameSession` 去刷新，属「无人工要求自行赋名」，已排除。

因此「转录里的 `custom-title` 必须逐字等于 `ai-title`」这条断言不是装饰，是这条路的安全绳：写对无害，一旦不等，档位反转立刻回来。

## Plan

1. **判据先行**：新建 `server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts`，做法照既有 `claude-resident-addressable.test.ts`（真 claude 二进制 + 临时 `CLAUDE_CONFIG_DIR` / `DATABASE_PATH`，读 `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` 与转录）。先取红态，再动产品代码。
2. **落点**：`server/modules/providers/list/claude/claude-runtime.provider.js` 的 `mapCliOptionsToSDK` —— 在 `options` 解构里加一个标题字段，按条件写 `sdkOptions.title`。该文件是**已跟踪源码**，不是构建产物。
3. **两个调用方供值**：per-run（`claude-per-run-host-driver.provider.ts` 的 `query()`）与常驻（`claude-host-driver.provider.ts` 的 `buildResidentSdkOptions` → `query()`）。两处都拿得到 `providerSessionId` 与 `projectPath`，可 await `getSessionInfo`。注意这给每轮加一次文件读，要按既有的转录读预算核一遍。
4. **留痕**：把「peer 名跟随 ai-title、来源 `auto`、冻结已接受」写进 `docs/proposals/claude-resident-sessions.md` §12 的修订块（该节今天写的是「不传 `--name`、读注册表」，本条补上「并让 Claude Code 采纳标题」）。
5. **假形态逐条验红**，验完还原；既有判据逐条不退。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts` 退出 0，且断言：新建会话跑满一轮（**首轮不传标题**）⇒ 转录里**有 `ai-title`**（证明生成没被抑制）。**假形态**：首轮就传 ⇒ 必须红。
- [x] 同一文件：第二轮起传 `title = getSessionInfo().summary` ⇒ 注册表 `nameSource === "auto"` 且 `name` 逐字等于该 `summary`。**正控制**：不传的那条腿必须仍是 `derived` 且名字 ≠ 标题（证明该读数不是恒真）。**假形态**：把传入值换成 App 缓存的显示名 ⇒ 必须红。
- [x] 同一文件断言安全绳：采纳之后转录里的 `custom-title`（若有）与 `ai-title` **逐字相等**。**假形态**：人为把两者错开 ⇒ 必须红。
- [x] 同一文件断言「冻结」是**已登记的行为**而非意外：第二次 resume 传入一个**不同**的标题 ⇒ 注册名逐字等于**这次传入的新串**（注册表不冻结），该新串**不进阶梯**（`custom-title` 序列与采纳时逐元素相同），且再读 `getSessionInfo().summary` 仍是首次采纳值 —— App 每轮交出去的就是这个值，名字因此在产品里停住。断言里写明这是裁定接受的行为。**（本条原文写的是「注册名仍等于首次采纳的值」，实测被推翻**：注册名跟随当次传入的串，真正冻住的是阶梯与 `summary`。见 `docs/proposals/claude-resident-sessions.md` §12 的更正段。）
- [x] 两条路径各一条腿并打印 `path=per-run|resident`：per-run 与常驻各自的启动调用点都被覆盖。
- [x] 既有判据逐条退 0：`claude-session-name-authority.test.ts`、`claude-resident-addressable.test.ts`、`claude-host-per-run.test.ts`、`claude-background-work.test.ts`、`claude-session-title-source.test.ts`、`session-rename-route.test.ts`。逐条打印命令与退出码。**（原文另有「且文件未改」，实测只对其中五个成立**：`claude-resident-addressable.test.ts` 必须改 —— 本任务把常驻路径的注册名从 `derived` 改成 `auto`，该文件重启腿里两条断言写的正是旧行为，已按新行为重写（`nameSource === 'auto'`、注册名 ≠ App 显示名），其余断言未动，文件仍退 0。）
- [x] `npm run typecheck` 三条链退出 0；`npm run lint` 退出 0（仅既有 warning）。

## DoD

在真实运行的 CloudCLI（`dist-server/server/index.js`，端口 3001）上新建一个会话：

1. 第一轮结束后，`~/.claude/sessions/<pid>.json` 的 `nameSource` 仍是 `derived`（首轮不传）；
2. 第二轮结束后，同一字段为 **`auto`**，且 `name` 逐字等于 `getSessionInfo(sessionId, { dir }).summary`；
3. 该会话在 `ListAgents` 里显示的就是这个可读标题，而不再是 `<cwd>-XX`；
4. 转录里 `custom-title`（若有）与 `ai-title` 逐字相等，`server.log` 无新增的地址不匹配行。

只做到「测试绿」不算数：必须有一个真实会话被这样跑过，且四条读数都被打印出来。

**执行记录（2026-09-30，本任务 worker）**：四条读数都取到了，但**端口不是 3001** —— 3001 上跑的是 develop 检出的改前构建，且从会话内部重启它是禁止的（会连带杀掉宿主），所以改用本 worktree 自己 build 的 `dist-server` 产物、监听 `listen(0)` 探得的端口；其余（隔离的 `DATABASE_PATH`/`HOME`/`CLAUDE_CONFIG_DIR`、`HOST=127.0.0.1`、把本机可达的真网关原样登记成模型条目、真会话、真转录、真进程注册表）都是真的。逐字读数：第一轮 `name="work-70"` / `nameSource="derived"` / 转录里已有 `ai-title`（`"ZZDOD_ROUND_ONE 首轮回复测试"`）；第二轮 `nameSource="auto"` 且 `name` 与该会话的 `getSessionInfo(sessionId,{dir}).summary` 逐字相等；`ListAgents` 读到的那条注册记录整条打印出来，`name` 就是这个可读标题；安全绳成立（`custom-title` 与 `ai-title` 同为那一个串），`server.log` 新增地址不匹配行 0 条。两条必须一起读的旁注：①本机网关的标题生成**不稳定** —— 同一脚本、同一段提示词，有一次整轮没落下 `ai-title`（那次第二轮交出去的就是首条提示词文本），重跑才出现，故读数以「转录里出现 `ai-title`」为重跑前提；②同一轮里 App 自己的 `sessions` 行 8 秒后仍是 `transcript_name="Untitled Session"`、`name_source="derived"`，索引器没在这段窗口内重扫 —— DoD 第 3 条读的是 `ListAgents`（进程注册表），不依赖这一行，故未再追。同上记录见 `docs/proposals/claude-resident-sessions.md` §12。

## Touches

- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts (new)
- server/modules/providers/tests/claude-resident-addressable.test.ts
- docs/proposals/claude-resident-sessions.md
- tasks/gap-claude-peer-name-follows-ai-title.md


**本轮执行记录（2026-09-30，第二轮续跑）**：上一轮 fan-in 在 `step=suite` 红于本判据的
`a handed-over title registers as adopted (null)` —— 红的是**判据自身的读数窗口，不是产品**。真因（实测）：
控制臂 `launchWithTitle` 在 `result` 上 `break` 后立刻 `held.release()`，而 CLI 会在进程退出时删掉
`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`；该文件只在进程存活期内存在，负载下（那次 suite 期间
loadavg 10–30）可以在两次 50ms 轮询之间整个来去 ⇒ `captured=[]`，而 `registration ?? null` 让
「没读到注册」与「压根没传标题」在断言上完全同形。修法：控制臂把回合驱动到底且**不关 stdin**，
`result` 落地之后再扫注册表（进程对自己名字的每一次写入都发生在首轮结束之前 ⇒ 读到的是终态），
然后才 `release()`；泵的错误也不再被 `.catch` 吞掉，改为读数里的 `launchFailure`。复验：6/6 绿
（其中 3 次在 loadavg ~70，比红的那次 suite 更重），scoped gate 退出 0（本判据 +
`claude-resident-addressable.test.ts` 同绿）。产品代码、断言与各臂本轮未改，故上一轮已取的读数、
DoD 四条与「既有判据逐条退 0」仍然有效。
## Needs-Human

**执行 2026-09-30T12:57:37.977Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=57392 server/modules/session-hosts/tests/resident-server-restart.test.ts passed=false end_ms=1790772950198
- run_id：wk-prod-anchor
- session_id：2e87fd69-80aa-42ce-9153-49900d402f30
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-claude-peer-name-follows-ai-title~wk-prod-anchor~1790772818021-64bf63.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-claude-peer-name-follows-ai-title-wk-prod-anchor.log


## 归因（登记人 2026-10-01）—— 这条红不是本任务的

本轮 park 的判词点名 `server/modules/session-hosts/tests/resident-server-restart.test.ts`。它是**已知的套件并发假红**，三条证据：

1. **子进程真读数**（套件留存产物 `server__…__resident-server-restart.test.ts.out`）：`sigkill-residue pid=366604 alive-at-next-boot=false swept=1`、`sigkill-reaped pid=366604 alive-after-sweep=false` ⇒ **sweep 这一环是成功的**。红的是「重启后常驻宿主 30s 没回来」（`waitForResidentPid`，该文件 `:707`），即那条假红的**第二副面孔**（第一副是 `swept=0`）。
2. **同一句话在无关 delta 上出现过**：2026-09-29T16:35Z 在一个**纯前端** delta 上——同一条消息、同一断言位置、`swept=1`、时长同为 ~57s。故这一副面孔不需要宿主驱动有任何改动就能发生。
3. **本任务在常驻启动路径上只加了约 1ms**：新增的每轮 `getSessionInfo(...).summary` 实测中位 **1.0ms**（五次 3.4 / 1.1 / 1.0 / 0.9 / 0.9）。单跑该判据整例 8.4s、重启段 7074ms、等待预算 30000ms ⇒ 三个数量级的余量。

**本轮复验**（在本分支上，已合并最新 develop）：该判据**单跑 exit 0**（1/1，8.4s，重启 `elapsed-ms=7074`，`distinct=true alive=true running=true`）；本任务自己的判据 exit 0（1/1）；`npm run typecheck` 三条链 exit 0。

⇒ 归因为**非本 delta 的假红**，按惯例出路是重派（redispatch），不重新实现。