---
id: gap-claude-resident-peer-name-projection-stale
title: 常驻宿主的 peerName 投影是启动时的一次性快照：进程改名后 GET /api/session-hosts（状态条 popover 的「复制
  SendMessage 地址」）仍长期发布 derived 机器名 —— 改名路径要触发重读
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

**症状（实测，2026-10-03，真服务 :3001 `GET /api/session-hosts` × `~/.claude/sessions/*.json`）**：14 个活宿主里 **7 个**的 `binding.peerName`（= 状态条 popover 的「复制 SendMessage 地址」、AC-172 判据里的 `popover.address`）与 CLI 注册表里该 pid 的**真实名字**不一致：

| pid | 宿主启动 | 投影 `peerName` | CLI 注册名（nameSource） | |
|---|---|---|---|---|
| 1120916 | 16:44:19 | `claudecodeui-4a` | Voice draft workspace for Claude Code (`user`) | STALE |
| 1205810 | 16:46:58 | `claudecodeui-5e` | 输入/草稿串台问题进展确认 (`user`) | STALE |
| 3486481 | 17:26:32 | `archguard-5e` | A4 分层方向检查 proposal 评审 (`user`) | STALE |
| 1289364 | 17:43:00 | `claudecodeui-16` | S1/S2 任务状态在 UI 中不可见 (`user`) | STALE |
| 2471201 | 18:04:23 | `archguard-dd` | New Session 的 Working... 气泡闪烁 (`user`) | STALE |
| 1978011 | 18:33:14 | `archguard-ca` | ABI Task 视图模型缺失 depends_on (`user`) | STALE |
| 4120147 | 19:33:05 | `archguard-25` | claudecodeui-4a 会话地址命名 (`user`) | STALE |

余下 7 个对得上：6 个 `nameSource: auto`（标题在启动时就交付、注册名 start+0.0~1.8s 就位）与 1 个 `derived`（该会话确实没有标题）。**规律是逐条可读的：凡注册名在启动之后才变成标题的（`user` 档，实测 nameSince = start+2.1~4.0s），投影一律停在启动时的 derived 机器名。**

**机制（代码逐行可查，非推断）**

1. 冷启动的新会话没有标题 ⇒ `resolveClaudeSessionTitle` 返回 null ⇒ `launchedTitle = null`（`server/modules/providers/list/claude/claude-host-driver.provider.ts:2895`、`:2937`；这条守卫是 `gap-claude-peer-name-title-guard` 定的，属正确行为）。
2. `startIdentityReadback`（`:3187`）在拿到 provider session id 的那一刻起用 5s 预算 / 50ms 间隔轮询（`:852-853`），但判定式是 `settled = Boolean(registration?.name) && !(state.launchedTitle && registration?.nameSource === 'derived')`（`:3216`）。`launchedTitle` 为 null 时，**第一次轮询就把 derived 机器名判为「已定稿」**，`sink.identity()` 上报，`identityReadbackStarted` 置位 —— 注释逐字写着 *"Called once per host … and once per host only"*。
3. 约 2~4s 后 `mirrorResidentTitle`（`:3380`）写 `rename_session` 控制帧，CLI 注册名变成会话自己的标题（`nameSource: user`）——这一步是好的，也确实是 `gap-claude-resident-name-live-mirror` / `gap-claude-resident-name-mirror-window-opens-too-late` 落下的成果。
4. **没有任何路径在改名后重读**：`binding.peerName` 的唯一写入者是 `server/modules/session-hosts/session-host-manager.service.ts:754 recordIdentity`；`readCliSessionRegistration` 全仓唯一调用点就是第 2 步那个一次性 poll（`:3207`）。于是投影把机器名冻进这个进程的整个生命周期。

**不是「跑在旧构建上」**：`dist-server` 构建于 10-03 14:30，服务 pid 2209686 起于 10-03 14:30:37，镜像代码在位（`grep -c "mirrorResidentTitle\|rename_session" dist-server/.../claude-host-driver.provider.js` → 5）。源码文件均早于该构建。

<!-- dedup-ref --> **与既有 done 任务的关系**：`gap-claude-resident-addressable`（AC-164）落了 `peerName` 字段与读回；`gap-claude-peer-name-follows-ai-title` / `gap-claude-resident-name-live-mirror` / `gap-claude-resident-name-mirror-window-opens-too-late` 修的都是 **CLI 注册名那一侧**（今天已修好：注册表里就是可读标题）。本条修的是**它们的下游投影**：同一个快照字段，在改名之后没人再读。AC-172 的判据用 debug agent 驱动、`peerName` 是场景给定的常量，所以这条永远绿。全库扫过 `peerName` 只出现在 3 个任务里（上述 addressable / status-bar / self-assigned-names），无一覆盖「改名后刷新投影」。

**后果**：popover 的「复制地址」给出的可能是**孤儿名**——这些 `user` 档条目在注册表里连 `formerNames` 都没有（对比 pid 2055194 的 `auto` 采纳留有 `formerNames`），照它发消息大概率是 `No agent named … is reachable`，与 `gap-claude-resident-name-mirror-window-opens-too-late` 记录过的失败同形，只是从另一个面冒出来。**可达性未实发消息验证**（本条只做了注册表侧静态判断），实现者若要用它当 DoD 的一部分，先补一条实发读数。

**非目标**：CLI 侧的改名/镜像路径（已 done，不得回改）；§12 的名字生成规则；前端——前端只读投影，前端另算一份名字是禁忌（AC-172 已把它写成「第二份实现」）；debug-agent driver（它自己在 `debug-agent.host-driver.ts:725` 上报 identity）。

## Plan

1. **把「身份读数」从事务性一次性动作改成「注册名变化后可重读」**。两个候选形状，实现者择一并在代码里写明理由：(a) 已知改名动作成功后触发一次重读——`mirrorResidentTitle` 的 `rename_session` 发帧之后，以及 CloudCLI 自己的改名写回路径（`gap-session-rename-writeback` 那条）之后；(b) 把读回做成有界订阅/轮询：沿用已有 50ms poll 的形状，但把窗口覆盖到「命令帧发出之后」而不是随 `identityReadbackStarted` 关死。无论哪个形状，**`recordIdentity` 仍是唯一写入者**，上报的值仍必须**从 `~/.claude/sessions/<pid>.json` 读回**（`readCliSessionRegistration` 已按 pid + provider sessionId 校验，不得退化成「拿我们知道的那个标题去填」——那就是预测，不是读数）。
2. **重读不得把 derived 变成新的冻结值**：保留 `settled` 的语义 —— `launchedTitle` 非 null 时 derived 仍读作「未定稿」；冷启动时 derived 仍是第一时刻的**诚实读数**，只是不再**永久**。要防的是「重读把刚上报的值又写回 null/derived」这类抖动：写之前先判值是否变化。
3. **判据文件** `server/modules/providers/tests/claude-resident-peer-name-refresh.test.ts`：照 AC-025 的形状（真 `claude` 二进制 + mock Anthropic 兼容端点、临时 `DATABASE_PATH` + 临时 `CLAUDE_CONFIG_DIR`、按请求体体量识别真轮）。先取红态（修前：投影 = derived、注册表 = 标题，断言 `equal=false`），并让假形态（把重读摘掉）红在同一条承重断言上。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-peer-name-refresh.test.ts` 退出 0
- [x] **承重读数（先于实现，红态实测）**：修前树上该命令退出非 0，且红在「投影 `peerName` 逐字等于注册表 `name`」那条断言上；判据打印 `projection.peerName=<v> registry.name=<v> equal=false` 与 `registry.nameSource=<v>`。
- [x] **冷启动完整链**：冷启动宿主（无标题 ⇒ `launchedTitle=null`）⇒ 投影曾为 derived（打印 `t0.peerName=<v>` 与 `t0.registry.nameSource=derived`）⇒ 转录出现定稿 ai-title ⇒ 注册表 `name` 逐字等于该 ai-title 且 `nameSource != 'derived'` ⇒ **投影随后逐字等于它**（打印 `after.peerName=<v> after.registry.name=<v> equal=true` 与墙钟）。
- [x] **正控制（防恒真）**：同一次运行里，一个启动时就有标题的宿主（`launchedTitle` 非 null）投影从一开始就等于标题 —— 打印两行并断言相等。
- [x] **只读不造**：投影的值逐字来自 `~/.claude/sessions/<pid>.json`（判据自己再读一次该文件并打印 pid / name / nameSource，断言三者与投影一致）；不得来自前端或 App 缓存列。
- [x] **假形态必红**：把重读路径摘掉（恢复成一次性读回）⇒ 本判据红在承重断言上；登记变异 diff 或等价的可复现说明。
- [x] **既有判据不退**：`claude-resident-addressable.test.ts`、`claude-resident-name-live-mirror.test.ts`、`claude-resident-name-mirror-latency.test.ts`、`claude-session-name-authority.test.ts` 逐个独立进程退 0，逐条打印命令与退出码。
- [x] `npm run typecheck` 三条链退出 0；`npm run lint` 退出 0（仅既有 warning）。
- [x] `git diff --stat develop...HEAD` 只出现在 `## Touches` 列出的文件里。

## DoD

- 真服务（临时 `DATABASE_PATH` + 临时 `CLAUDE_CONFIG_DIR`）+ **真 `claude` 二进制**跑出一条冷启动会话：其 `GET /api/session-hosts` 的 `peerName` 在标题定稿后逐字等于 `~/.claude/sessions/<pid>.json` 的 `name`（不是 mock 常量、不是前端另算、不是「我们知道的那个标题」）。
- 状态条 popover 的「复制地址」读同一投影 ⇒ 同一次运行里复制出的串就是注册名（判据打印 `clipboard=<v> registry.name=<v> equal=true`）。
- 全过程不重启宿主进程：`pid` 与 `startedAt` 前后不变（打印 before/after）。
- 落地后新起的冷启动宿主不再产生新的陈旧条目（旧进程不追溯）；以一次真服务读数（`GET /api/session-hosts` 与注册表逐条对照）作为收尾证据。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts`
- `server/modules/session-hosts/session-host-manager.service.ts`
- `server/modules/providers/tests/claude-resident-peer-name-refresh.test.ts` (new)
- `tasks/gap-claude-resident-peer-name-projection-stale.md`
