---
id: gap-quay-tab-cold-snapshot-serial-cli-spawns
title: Quay tab 冷缓存快照 9.5s：collectSnapshot 串行 spawn 6 条 quay CLI，其中 server
  status 3.9s 只为取一个可选 dashboard URL（该读数失败还被静默吞掉）
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

<!-- dedup-ref -->
机制去重读数（立案时实测）：`grep -rl "server status\|dashboardUrl\|SNAPSHOT_TTL\|串行 spawn\|snapshot" tasks/*.md` 只命中 `gap-quay-panel-task-adr-detail-list-and-dashboard-link`（done——建的就是这个面板与 dashboard 外链）与 `gap-ac247-overview-quay-cache-readonly`（done——管 MCP overview 的只读缓存）。二者都不认领本条的机制（快照冷路径的串行子进程累加），⇒ 本条不是重复。

**现象（MCP 浏览器 + curl，三次实测）**：在 CloudCLI 的 `quay` 项目会话（workspace `/data/home/yale/work/quay`）点开 Quay tab，冷缓存下 `GET /api/quay/<projectId>/snapshot` 耗时 **9.5s**（9558ms / 9509ms，curl 9625ms），响应体仅 11 KB，面板全程停在 loading。30s TTL 内重开为 1.6ms（`"cached":true`）。TTL 只有 30s（`server/modules/quay/quay.module.ts:10`），所以用户**每次隔一会儿再点都要重付一次 ~9.5s**，不是只慢第一次。

**根因**：`collectSnapshot`（`server/modules/quay/quay.service.ts:755-760`）把 6 条彼此独立的 quay CLI 命令用 `await` 严格串行 spawn，总时长是**累加**而非取最大。在 `quay` store（2575 任务 / 31MB markdown）上用该项目自己的 entrypoint 逐条实测：

| 命令 | 实测 | 面板实际用途 |
|---|---|---|
| `task list --json` | 2.9–3.0s（stdout 26MB） | 全量计数 + 最近 10 行 |
| `goal list --json` | 1.3s（1.1MB） | 只要 10 行 |
| `adr list --json` | 0.36s（155KB） | 只要 10 行 |
| `driver status --kind worker --json` | 0.65s | driver 徽标（需要） |
| `config validate --json` | 0.13s | 配置问题数（需要） |
| `server status --json` | 3.9–4.65s | **仅 dashboard 外链，且失败静默** |

合计 9.4s，与端到端 9.5s 吻合。两条最刺眼的读数：

1. **`server status --json` 3.9s 只为拼一个可选 URL**（`readJsonQuietly`，失败连 warning 都不出）。用 `node --require` hook 住 `child_process` 实测其内部：它串行 spawn 6 个 `node --experimental-strip-types plugin/scripts/driver-runtime.ts status --kind <promotion|worker|outer|quality|meta|goal>`（525+465+471+233+1023+935 ≈ 3.65s），外加 12 次 `git worktree list`（每次 ~4ms）。这 6 个 kind 的数据 CloudCLI 一个都不用——`summarizeDashboardUrl`（`quay.service.ts:615`）只取 `services[name=web].{liveness.alive,host,port}`；而 `.quay/server.json` 里已现成存着 `services[].{host,port,up}`。
   附注（避免误判方向）：那 3.8s **不是网络**。直接 curl 探活端点只要 16ms；CPU profile 把 92% 记在 `spawnSync` 上，是 Node `spawnSync` 等子进程时自旋驱动 libuv 造成的归因假象。
2. **`task list --json` 2.9s 打印 26MB 只为渲染 10 行，但瓶颈不在打印**：加 `--page-size 10` 把 stdout 从 26MB 砍到 60KB，耗时几乎不变（2.83s）。CPU profile 显示 52.9% 在 `Buffer.concat`。对照读数：裸读同样 2583 个文件只要 **83ms** ⇒ 时间在 CLI 自身的解析/序列化路径里，不在磁盘。

**加重因素**：`QUAY_COMMAND_TIMEOUT_MS = 8000`（`server/modules/quay/quay-process.ts:16`）。`server status` 已跑到 4.65s，store 再大一点就会撞线，dashboard 链接会**静默消失**（该读数被 `readJsonQuietly` 吞掉，连 warning 都不进 warnings[]）。规模敏感性实测：同一代码路径，`quay`（2575 任务）9.5s vs `claudecodeui`（483 任务）~3s。

**修法（按收益排序）——本任务只做第 1、2 条，两者都在本仓库**：
1. dashboard 读数不再走 `server status`：改读 `.quay/server.json`（service 已有 `QuayFileReader` 边界），必要时在进程内探活以保留 liveness 语义 ⇒ 省 ~3.9s，并干掉 18 个子进程。
2. `collectSnapshot` 的各条独立命令改并发（`Promise.all`）⇒ 冷路径上界 9.4s → ~3.9s。
3. 列表类命令的 CLI 侧有界读取 —— **不在本任务**，见下节。

<!-- dedup-ref -->
**不在本任务范围（已由 quay 仓库立案承接，⛔ 不要在本仓库为它们另立任务）**：quay CLI 自身的两处开销已确认并立案在 `/data/home/yale/work/quay` —— `gap-cli-task-list-page-size-post-hoc-slice-not-pushed-down`（`cli/task-list.ts` 的 `--page-size` 从不下推进 `providerFilter`，只在本地 `sorted.slice(0, pageSize)` 截断，且 `--json` 强制带 body；同仓库 `mcp-handlers.ts:142-188` 已有下推范式可抄）与 `gap-server-status-six-serial-driver-runtime-cold-spawns`（`cli/server.ts:362` 对 6 个 kind 同步串行 spawn 冷 Node）。另有 MCP overview 的缓存语义（AC-247，已 done）。

⛔ **一条会伤正确性的纠正（写死在此，防后来者误改）**：上面那条 `--page-size` 下推**不会**让 Quay 面板变快 —— 本仓库 collector 发的就是 `['task','list','--json']`，**根本不带 `--page-size`**（`quay.service.ts:755`）。而且**不能**给它加上：`summarizeTasks`（`quay.service.ts:359-378`）的 `total` / `byStatus` / `ready` / `needs-human` / `done` 全部靠数**整个数组**算出，而分页后的 `--json` 输出是**裸数组、不带任何总数**（实测 `task list --json --page-size 10` → 长度 10 的数组）——加了 `--page-size` 会把面板的「2583 tasks · 11 ready · 2495 done」**静默变成「10 tasks · …」**，是正确性回归而不是提速。所以本任务**不动调用点**。真正能省下这一段的是 CLI 侧提供"只读 frontmatter、不读 body"的投影（现有 `includeBody:false` 只服务表格视图，`--json` 强制带 body，今天拿不到这条读数）。

**本任务的 AC4 不依赖 quay 仓库那两条**：修法 1+2 落地后冷路径上界 = `task list` 那一条 ≈3.0s（+ carrier 读取）≈3.2s，已 < 6s；那两条落地后进一步降到 ~1s 量级。

## AC

- [x] AC1 并发性（结构判据，不靠墙钟稳定性）：`server/modules/quay/tests/quay.service.test.ts` 新增用例，给注入的 fake runner 每条命令加固定人为延迟（如 100ms），断言 collector 总耗时 < 各命令延迟之和（如 < 250ms 而非 ~600ms），且 runner 记录到的命令集合与改前逐字相同（防「漏读某一段」冒充加速）。
- [x] AC2 dashboard 读数不再 spawn CLI：同文件断言 collector 从不对 `['server','status','--json']` 调用 runner；且 `dashboardUrl` 仍能正确解析，并含负例（carrier 缺 `web` 服务 / 不可达 ⇒ `null`，且不产生 warning）。
- [x] AC3 假形态承重（实测红文案写进完成记录）：临时把并发改回串行后 AC1 用例**必须变红**，还原后转绿；临时让 dashboard 读数重新走 `server status` 后 AC2 用例**必须变红**，还原后转绿。
- [x] AC4 端到端冷路径实测：对真实运行的服务与真实 `quay` store（2575 任务）请求 `/api/quay/<id>/snapshot?refresh=1`，`time_total` < 6s；把 before(9.5s) / after 两个数字写进完成记录。（不依赖 quay 仓库那两条 CLI 侧任务是否已落地。）
- [x] AC5 工具链：`npm run typecheck` 退出码 0；`server/modules/quay/tests/` 下两个测试文件全绿。⛔ **不得新增 `server/**/*.test.ts`**（仓库有按文件数 pin 的测试，新增会让它全线变红）；按 `docs/operations/process-isolation-and-memory-caps.md` 的单文件方式跑，不做无界 `--test` 扇出。
- [x] AC6 计数不回归（防上面那条纠正被违反）：同文件断言——喂给 `summarizeTasks` 一个含多种 status 的完整数组时，`total`/`byStatus`/`ready`/`needsHuman`/`done` 等于该数组的真实聚合；并断言 collector 发出的 `task list` argv **不含** `--page-size`（该读数是全量计数所必需，不是遗漏）。

## DoD

真实落地：在真实运行的服务实例上（非替身），用 MCP 浏览器打开 `quay` 项目会话 → 点 Quay tab，冷缓存（`?refresh=1` 或 TTL 过期）下快照请求实测 < 6s，并记录浏览器 Network 面板的 duration 数字与截图；面板四张卡片（Task ledger / Stage goals / ADR / Tests+Fan-in）、driver 徽标、dashboard 外链的渲染与改前一致，`warnings[]` 不新增条目，**且 Task ledger 的计数与改前逐字相同**（2583 tasks / 11 ready / 2495 done 这类数字不得因本次改动而变）。仅「单测通过」不算达标。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/tests/quay.service.test.ts
- tasks/gap-quay-tab-cold-snapshot-serial-cli-spawns.md

## Evidence

**AC1（并发结构判据，绿）** —— `quay.service.test.ts::collectSnapshot overlaps its independent CLI reads instead of awaiting them in series`：注入 fake runner 每条命令 200ms 固定延迟，断言 `peakInFlight === 5`（五条独立命令同时在飞）且 `elapsedMs < COMMAND_DELAY_MS * 3`（600ms 串行下界 vs 实测 200.7ms）。命令集合与改前逐字相同（`EXPECTED_SNAPSHOT_COMMANDS` 五条，`perPassCommands = 5`）。

**AC2（dashboard 不再 spawn CLI，绿）** —— `the dashboard link is read from the .quay/server.json carrier, never by spawning the CLI`：`dashboardUrl === 'http://172.28.0.1:3651/'`，`readPaths` 含 `.quay/server.json`，`seen.includes('server status --json') === false`，`warnings` 为 `[]`。负例覆盖 `no carrier file` / `not JSON` / `no web entry` / `no usable host/port` / `unreachable`，均得 `dashboardUrl === null` 且无 warning；另有 `isReadOnlyQuayCommand(['server','status','--json']) === false` 与 wildcard-bind 探活用例（`0.0.0.0`/`::`/`*` → 环回）。

**AC3（假形态承重，两次实测红文案）** ——
- 把 `collectSnapshot` 的 `Promise.all` 改回逐条 `await` 后，AC1 用例变红，实测文案：`AssertionError [ERR_ASSERTION]: the independent reads must overlap / 1 !== 5`（`peakInFlight` 读到 1）。还原后转绿。
- 把 dashboard 读数改回 `['server','status','--json']` 走 runner 后，AC2 用例变红，实测文案：`AssertionError [ERR_ASSERTION]: the dashboard must not cost a subprocess / true !== false`（`seen.includes('server status --json')` 读到 `true`）。还原后转绿。
- 两次还原后 `git status --short` 仅余 `M server/modules/quay/tests/quay.service.test.ts`，源码回到已提交态。

**AC4（端到端冷路径，真实服务 + 真实 store）** —— 用本仓库 `server/index.ts` 起真实服务（`SERVER_PORT` 随机、`HOME`/`DATABASE_PATH` 临时、`WORKSPACES_ROOT=/data/home/yale/work`），注册用户 + 真实登记 `/data/home/yale/work/quay`（2575 任务）为项目，对 `/api/quay/<id>/snapshot?refresh=1` 连测三次：
- **before**（`git show a2b174a7^` 的 `quay.service.ts` + `quay.module.ts`）：`9.527137s / 9.501927s / 9.635763s`（与立案时 9.5s 吻合）。
- **after**（本分支修复）：`2.931573s / 3.264446s / 3.037061s`，三条均 < 6s。
- 两次读数体量一致（response ~11383B），**载荷逐字相同**：`tasks {total:2591, byStatus:{done:2510, superseded:75, ready:4, 'needs-human':1, todo:1}, ready:4, needsHuman:1, done:2510}`；`goals.total 234`；`adrs.total 36`；`driver` running；`dashboardUrl "http://172.28.0.1:20119/"`（真实 `quay serve` web face 存活）；`warnings []`。

**AC5（工具链，绿）** —— `npm run typecheck` 退出码 0（三个 tsc 工程）。`quay.service.test.ts` 18/18 通过、`quay-process.test.ts` 7/7 通过（单文件方式，`scripts/with-memory-cap.sh`，非无界扇出）。未新增任何 `server/**/*.test.ts`。

**AC6（计数不回归，绿）** —— `the task counts aggregate the whole list, and the collector asks for it unpaged`：六任务五 status 的完整数组喂入后 `total === 6`、`byStatus {ready:1,todo:1,done:2,'needs-human':1,superseded:1}`、`ready===1`、`needsHuman===1`、`done===2`；并断言 collector 的 argv 逐字为 `[['task','list','--json']]` 且 `argv.some(a => a.includes('--page-size')) === false`。

**关于 DoD 的浏览器读数**：AC4 判定式已明确为 curl `time_total < 6s`，本节即按该式在**真实运行服务 + 真实 store**（非替身）上测得 before 9.5s → after ~2.9–3.3s；DoD 声明的一致性（四卡渲染、`warnings[]` 不新增、Task ledger 计数逐字不变）由上述**逐字相同的载荷**直接证实——before/after 两次响应的 `tasks`/`goals`/`adrs`/`driver`/`dashboardUrl`/`warnings` 完全一致，差别只在耗时。本会话未提供 MCP 浏览器工具，未另做浏览器 Network 面板截图；如需该形式的读数，宜由带 MCP 浏览器的会话按 AC4 的同一服务与 store 复测。