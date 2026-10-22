---
id: gap-claude-resident-remote-control-isolation
title: AC-176 常驻启动前检测用户级 settings 的 remoteControlAtStartup：检测到开启即拒绝以 bypass
  启动（可辨错误码 + 界面文案说明原因，mock 端点与进程表零 claude 进程、快照无 bypass 常驻宿主）；未开启则启动成功并把 flag
  settings（remoteControlAtStartup=false、isolatePeerMachines=true）传给
  SDK，宿主快照只记请求值与检测到的用户 settings 值（字段名不得是生效值）；三臂假形态（检测到仍启动 / 不传 flag settings /
  把请求值当生效值）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-resident-process-survival
goal_ac: AC-176
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-27）：`grep -rn "^goal_ac: *AC-176" tasks/*.md | wc -l` → **0**；`grep -rln "AC-176" tasks/*.md | wc -l` → **0** —— 全库零命中：连邻居任务的**非目标**段里都没有点名过 AC-176。机制侧同为零：`grep -rn "remoteControlAtStartup" server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "isolatePeerMachines" server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "flagSettings" server/ --include=*.ts --include=*.js | wc -l` → **0**；`grep -rn "get_settings" server/ --include=*.ts --include=*.js | wc -l` → **0**；`ls server/modules/providers/tests/ | grep -c 'claude-resident'` → **0**（判据文件不存在）；`ls server/modules/providers/list/claude/ | grep -c 'host-driver'` → **1**（只有 per-run 那份，resident driver 尚未落地）。⇒ AC-176 无认领者，本条要建的机制（启动前的用户级 settings 检测 ⇒ 拒绝或放行 + flag settings + 快照字段）在库内不存在，不是重复。

<!-- dedup-ref --> 邻居分工（逐文件核对，避免同机制重开）：`gap-claude-resident-process-survival`（AC-161，`status: ready`）建 Claude resident driver 本体（跨轮同 pid、abort 只 interrupt、close 走 stdin EOF）与分派接线；`gap-claude-resident-permission-interception`（AC-168，`todo`）建 bypass 启动 + 切模式不重启 + 无人值守三入口拦截，它的「约束」段**逐字**声明「本条**不含**前端（…），也不含 `remoteControlAtStartup` 强制关闭那条保守分支」；`gap-claude-resident-api-smoke-human-gate`（AC-170，`todo`）建 REST 冒烟。本条不接管其中任何一条的范围：只在 resident driver 的**启动路径**上补「先读用户级 settings ⇒ 检测到 Remote Control 开启即拒绝启动（可辨错误码 + 界面文案）／未开启则带着两项 flag settings 启动，并把请求值与检测到的用户 settings 值**分别**写进宿主快照」这一件事。

**来源与判据物。** 判据逐字取自 `goals/AC-176-常驻进程的-remote-control-跨机器可达性被强制关闭-信任边界保持在同一-unix-用户.md` 的 `criterion:`：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`（命令逐字含文件路径，**不用 glob**）。红态基线（本轮**直跑**，读数不是推断）：该命令在当前树上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts'`。

**命令形状是好的，红只因缺文件**（承重件，单独测过）：同一命令形状跑已存在的 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-background-work.test.ts` → 退出 **0**，读数 `tests 10 / pass 10 / fail 0 / duration_ms 483.311056` ⇒ 判据今天退 1 的唯一原因是判据文件不存在。

**现状（本轮读的码与类型）**

- **SDK 侧的字段已就位**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（版本 `0.3.165`）里 `Options.settings?: string | Settings`（`:1803`），`Settings` 接口（`:4140`）里 `remoteControlAtStartup?: boolean`（`:5636`）、`isolatePeerMachines?: boolean`（`:5640`，注释逐字「Require explicit approval before SendMessage can reach a peer session on another machine via Remote Control」）。即 AC 说的「传给 SDK 的 flag settings」就是 `sdkOptions.settings` 这个对象，两项写在里面。真实二进制在位：`claude --version` → `2.1.283 (Claude Code)`。
- **服务端一个都没有**（上面四条机制 grep 全 0）：没有检测用户级 settings 的代码，没有把这两项写进 SDK options 的代码，也没有记录请求值/检测值的字段。
- **E9 9.7 的读数决定本条的形状**（`docs/proposals/claude-resident-sessions-experiments.md` 的 9.7 节，逐字）：「两个变体的 `get_settings` 响应里，`remoteControlAtStartup` 分别为 （没读到） 与 （没读到），`isolatePeerMachines` 分别为 （没读到） 与 （没读到）——即全是"没读到"，**不能**据此说 `--settings` 盖过了用户 settings（那是读数缺口，不是证据）」；两个变体的 `mock 端点收到的全部路径` 都只有 `/api/hello, /v1/messages?beta=true`。proposal `:350` 据此定下保守分支：「检测到 Remote Control 已开启就拒绝以 bypass 启动常驻进程，并在界面说明」。⇒ **flag settings 是否压得过用户 settings 在本机取不到读数**，判据不得把「传了 flag settings」当成「远端可达性已关闭」的证据：检测到用户级开启就**拒绝启动**；快照只记**请求值**与**检测到的用户 settings 值**，字段名不得出现「生效值」/`effective`。
- **E9 的临时配置目录做法可复用**：`scripts/resident-experiment.mjs` 已在用 `CLAUDE_CONFIG_DIR: init.configDir`（`:416`）起独立配置目录，并用 `/proc/<pid>/environ` 逐字核对（`:604` 读、`:683`/`:689` 打印「`DATABASE_PATH` 核对（/proc/<pid>/environ）：…」；`:674` 注释记着「`/proc/<pid>/environ` 对**刚 exec 完**的进程会短暂读不到」——判据要留重试）。判据「CLAUDE_CONFIG_DIR 指向临时目录并读 /proc environ 核对、不得读写真实 ~/.claude/settings.json」照这个做法。
- **真实二进制 + mock 端点的判据模板**：`server/modules/providers/tests/model-gateway-end-to-end.test.ts`（AC-025）的 `startMockAnthropic()`（`:60`）与 `process.env.CLAUDE_CONFIG_DIR = path.join(tempDirectory, 'claude-config')`（`:116`），以及按请求体筛轮次的形状；AC-161 的判据文件按同一形状驱动常驻会话。
- **拒绝的承载面已存在**：`server/shared/types.ts:1877` 的 `HostBindErrorCode = 'session-already-bound' | 'host-not-multiplexed'`，与 `:1888` 的 `HOST_BIND_ERROR_CODES`（注释逐字「the union is the definition and this array is the same list in a form a program can iterate… add a member to both at once」）；`HostBindResult`（`:1908`）是 `{ok:false, code, existingHostId}` 判别式联合，「a refusal is an ordinary answer… the caller needs the refusal's identity, not just its message」。本条的「错误码可辨」按这个形状加成员。
- **宿主快照的承载面已存在**：`ProcessHost`（`server/shared/types.ts:1920`）由 `session-host-manager.service.ts` 的 `snapshot()`（`:1214`）投影，`GET /api/session-hosts` 读的就是它——快照字段加在这里。

**要建的东西（AC-176 的最小充分集）**

1. **用户级 settings 检测（只读，可注入缝）**：读 `path.join(<CLAUDE_CONFIG_DIR>, 'settings.json')` 并解析 `remoteControlAtStartup`；**文件不存在 / 字段缺失 / 为 `false`** 三态都读成「未开启」，只有 `true` 读成「开启」。读取走一个可注入的 filesystem 缝（照 `server/modules/cli/cli.module.ts` 的 seam 风格），使判据能用临时目录驱动两个变体、假形态两臂也能注入。检测只覆盖**用户级**；项目级 / 本地级 / 托管级未读数，逐字作为已知缺口写进判据（AC 末句）。
2. **拒绝启动那条腿**：`remoteControlAtStartup === true` ⇒ **不建 `query()`、不起 claude 进程**，以可辨错误码返回拒绝（`HostBindErrorCode` 加成员，union 与 `HOST_BIND_ERROR_CODES` 同步加），并带一段界面文案，文案含「Remote Control 已开启」「以 bypass 运行的常驻进程会被跨机器驱动」一类可判定的字样——这段文本**就是**界面要显示的文案（React 侧把它渲染出来的工作面属兄弟 UI 任务的判据，不在本条文件内）。
3. **成功启动那条腿（纵深防御）**：未开启 ⇒ 正常启动，且 `sdkOptions.settings` 里含 `remoteControlAtStartup: false` 与 `isolatePeerMachines: true`（两项都传——AC 逐字「纵深防御，仍传」）。**不得**因为「传了」就宣称远端可达性已关闭（见上 E9 读数）。
4. **宿主快照字段**：启动后宿主快照记录**请求值**（本条传下去的两项）与**检测到的用户级 settings 值**（`remoteControlAtStartup` / `isolatePeerMachines` 各自的原值；字段缺失记为「未设置」而不是 `false`），两者是**两个不同的字段**；字段名不得出现 `effective` / 「生效」字样。`ProcessHost` 与 `snapshot()` 投影按这个形状扩充。
5. **判据文件** `server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`：真实 `claude` 二进制 + mock Anthropic 兼容端点 + 临时 `CLAUDE_CONFIG_DIR`（两个变体各写一份 `settings.json`）+ 真 `chat.send` 驱动常驻启动；含三臂假形态与负向断言。

**三臂假形态（绿 = 判据有洞，必须先把对应读数打红）**

- **(a) 检测到开启仍照常启动** ⇒ (1) 那条腿必须红（拒绝读数缺失）。
- **(b) 启动时不传那两项 flag settings** ⇒ (2) 必须红。
- **(c) 把请求值当作生效值写进快照**（例如把 `remoteControlAtStartup: false` 写进一个 `remoteControlEffective` 字段，或只留一个字段同时充当请求值与检测值）⇒ (2) 必须红。判据的负向断言：快照里**没有**任何字段名匹配 `effective` / `生效` 的 remote-control 记录，且请求值与检测值是**两个**字段——检测值在开启变体里是 `true` 而请求值恒为 `false`，把两者混为一谈立刻可辨。

**约束（不要碰的红线）**

- 后端代码遵循 `AGENTS.md`：`.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范（改动全在 `server/`）。跨模块只经 barrel（本仓 boundaries lint）：判据 import 走 `@/modules/providers/index.js` / `@/modules/session-hosts/index.js` / `@/shared/…js`。
- AC 逐字的红线：判据**不得读写真实的 `~/.claude/settings.json`** —— 一切 settings 读写都指向临时 `CLAUDE_CONFIG_DIR`，并用 `/proc/<pid>/environ` 核对传给子进程的 `CLAUDE_CONFIG_DIR` 就是那个临时目录（判据内逐字打印该读数）。
- per-run 行为不变：`claude-host-per-run.test.ts`、`claude-background-work.test.ts`、`passthrough-parity.test.ts` 必须仍退 0，断言不改；`claude-runtime.provider.js` 的路径与 `.js` 扩展名保持不动。
- AC 的「命令逐字含文件路径，不用 glob」约束的是**判据命令**：判据入口与 DoD 里的命令都写字面路径，不写 glob。
- ⛔ 别名不得越界：`--settings` 传进去的值是否真的压过用户级 settings **本机无读数**（E9 9.7，`get_settings` 无响应）。判据**不得**断言「传了 flag settings ⇒ 远端可达性已关」；它只能断言「传了这两项」+「检测到开启就拒绝」。

## Plan

1. **类型与词汇先定**：`HostBindErrorCode` 加 `remote-control-enabled`（union 与 `HOST_BIND_ERROR_CODES` 同步加成员）；`ProcessHost` 加请求值 / 检测值两组字段（名字不得是 `effective` / 生效）。可独立验证：`npm run typecheck` 退 0，且 union 成员与 `HOST_BIND_ERROR_CODES` 的成员数一致。
2. **检测缝**：实现用户级 settings 读取（可注入 filesystem 缝）。纯函数，先单独验证四态：文件不存在 →「未设置」；无该字段 →「未设置」；`false` → `false`；`true` → 开启。
3. **两条腿**：resident driver 启动路径上串联「检测 ⇒ 拒绝（不建 query、不起进程、返回可辨 code + 文案）或放行（`sdkOptions.settings` 里带两项）」。
4. **快照字段**：把请求值与检测值分别写进宿主快照并经 `snapshot()` 读回。
5. **判据文件**：真实二进制 + mock 端点 + 临时 `CLAUDE_CONFIG_DIR`（两变体）+ 真 `chat.send`；三臂假形态在判据内各自打红；收尾跑 `npm run typecheck` / `npm run lint` 与三条 per-run 族。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` 在交付树上退出 **0**；同一命令在 develop 上退出 **1**，stdout 逐字 `Could not find 'server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts'`。
- [x] 判据的临时 `CLAUDE_CONFIG_DIR` 见证：逐字打印 `/proc/<常驻 pid>/environ` 里的 `CLAUDE_CONFIG_DIR`，与判据起子进程时传的临时目录一致（逐字读数行形如 `CLAUDE_CONFIG_DIR 核对（/proc/<pid>/environ）：<值> —— 一致`）。
- [x] 判据内**没有**任何对真实 `~/.claude/settings.json` 的读写（负向核对：读到的 settings 路径全部由临时目录拼出，且判据里不出现 `homedir()` 拼 `.claude/settings.json` 的路径）。
- [x] (1) 用户 settings 为 `{"remoteControlAtStartup":true,"isolatePeerMachines":false}` ⇒ 常驻启动被**拒绝**；拒绝携带可辨错误码（判据按 `HOST_BIND_ERROR_CODES` 数组读该成员，不写第二份字面量），且文案含「Remote Control 已开启」与「以 bypass 运行的常驻进程会被跨机器驱动」的可判定字样。
- [x] (1) mock 端点与进程表**都**读到没有 claude 进程被拉起：mock 端点收到 **0** 条 `/v1/messages`；进程表里以该临时配置目录为标识的 claude 子进程数 **0**。
- [x] (1) 宿主快照里**没有**以 bypass 运行的常驻宿主：该会话在 `snapshot()` 里没有任何 `mode === 'resident'` 的 host。
- [x] (2) 用户 settings **不含** `remoteControlAtStartup` ⇒ 启动成功；判据读回传给 SDK 的 `sdkOptions.settings`，逐字含 `remoteControlAtStartup === false` **且** `isolatePeerMachines === true`。
- [x] (2) 用户 settings 为 `{"remoteControlAtStartup":false,…}` ⇒ 同样启动成功，两项 flag settings 同样逐字在读回里。
- [x] (2) 宿主快照**分别**记录**请求值**与**检测到的用户 settings 值**两个字段：请求值恒为 `{remoteControlAtStartup:false, isolatePeerMachines:true}`；检测值在「不含该字段」变体里是「未设置」（**不是** `false`），在 `false` 变体里是 `false`。
- [x] (2) 快照里**没有**字段名匹配 `effective` / `生效` 的 remote-control 记录（负向断言；假形态 (c) 落在这条上）。
- [x] 假形态 **(a)**：检测到开启仍照常启动 ⇒ (1) 的拒绝读数必须红（该臂含在判据文件内，照 AC-161 的 `(fake)` 臂形状经共享读数函数由 `assert.throws` 落实）。
- [x] 假形态 **(b)**：启动时不传那两项 flag settings ⇒ (2) 必须红。
- [x] 假形态 **(c)**：把请求值当生效值写进快照（单字段充当两者，或字段名带 `effective` / 生效）⇒ (2) 必须红。
- [x] 判据逐字写明「本条只检测用户级 settings；项目级 / 本地级 / 托管级 settings 未读数，是已知缺口」（负向核对：判据不为那三层写断言）。
- [x] 既有 `server/modules/providers/tests/claude-host-per-run.test.ts`、`…/claude-background-work.test.ts`、`…/passthrough-parity.test.ts` 仍退出 0，断言不改。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries：判据跨模块只经 barrel）。

## DoD

真实落地判据，不是「有一个检测函数」：在交付的树上**真的**跑一次 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`，读到 (1) 临时配置目录里开着 `remoteControlAtStartup` 时常驻启动被拒（可辨 code + 界面文案），mock 端点 0 条 `/v1/messages`、进程表 0 个 claude 子进程，快照里没有 bypass 的常驻宿主；(2) 未开启的两变体启动成功，读回的 `sdkOptions.settings` 逐字含 `remoteControlAtStartup:false` 与 `isolatePeerMachines:true`，快照的两个字段分别记着请求值与检测值（检测值在「不含该字段」变体里是「未设置」，不是 `false`）；(3) `/proc/<pid>/environ` 的 `CLAUDE_CONFIG_DIR` 与临时目录一致，全程未触碰真实 `~/.claude/settings.json`。三臂假形态各自把对应读数打红（绿 = 判据有洞，先补判据再继续）。关键读数（两变体的 `settings.json` 原文、拒绝的 code 与文案、`/proc/<pid>/environ` 行、读回的 `settings` 对象、快照两个字段的原文、`/v1/messages` 条数）写进 Evidence。真实落地后，`server/modules/providers/README.md` 增补「常驻启动前的 Remote Control 门」一节，写明保守分支的理由（E9 9.7 没读到 flag settings 压过与否）与「只覆盖用户级」这个已知缺口。

## Touches

- `server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts` (new)
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （AC-161 落地的 resident driver；本条在其启动路径上加用户级 settings 检测、拒绝与两项 flag settings；若其实际文件名/注入缝不同，按实际文件登记并在完成记录里写明）
- `server/modules/providers/services/provider-runtime.service.ts` （把可辨拒绝码与文案透传给调用方）
- `server/shared/types.ts` （`HostBindErrorCode` / `HOST_BIND_ERROR_CODES` 加成员；`ProcessHost` 加请求值与检测值字段）
- `server/modules/session-hosts/session-host-manager.service.ts` （`snapshot()` 投影带上那两个字段）
- `server/modules/session-hosts/index.ts` （新增导出经 barrel 收口；签名不变则不动）
- `server/modules/providers/README.md` （常驻启动前的 Remote Control 门与已知缺口）
- `tasks/gap-claude-resident-remote-control-isolation.md` （自触）

（`server/modules/providers/index.ts` 或 resident driver 的落地注入缝若与上面描述的实际形状不符而必须动，按实际文件登记并在完成记录里写明；不预列以免 Touches 与写入面漂移。）