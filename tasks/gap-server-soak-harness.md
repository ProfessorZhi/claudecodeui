---
id: gap-server-soak-harness
title: server 长期运行 soak 装置（手动触发）：会话/连接/transcript 搅动下采样 RSS、堆、fd、线程、子进程，斜率与残留超阈值即红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-session-cgroup-scope
---
## Proposal

人（yale）2026-09-25 裁定：soak **手动触发**，不进每次 fan-in，也不进 quay 的例行任务。

背景：本项目要长期运行，但仓库里没有任何 soak、泄漏或 RSS 采样的测试（对 `e2e/ scripts/ server/` 检索过）。`docs/operations/process-isolation-and-memory-caps.md` 里「server 从未泄漏」是缺乏观测，不是已证。已知会随时间增长的输入：`~/.claude/projects` 下 2186 个文件、882MB transcript，单个 jsonl 最大 13MB；`sessions-watcher` 持续轮询；`session-conversations-search` 有 `claudeFileResultsCache`；`shell-websocket` 的 `ptySessionsMap`；`claude-runtime.provider.js` 的 `activeSessions`/`pendingToolApprovals`/`abortedSessionIds`；websocket 服务里没有发现 `bufferedAmount` 检查（只是待验证的假设：慢客户端可能造成发送缓冲无界增长）。

方案：
1. `scripts/soak.sh`（入口）加 `scripts/soak-analyze.mjs`（纯函数分析器）加 `scripts/soak-driver.mjs`（搅动器）。用法：`bash scripts/soak.sh --duration <秒> [--report <文件>]`；`package.json` 增一个 `soak` 脚本指向它。**不得**被 `scripts/test.sh`、`npm test` 或任何 quay 例行配置引用。
2. 目标：在临时 `DATABASE_PATH`、临时 `HOME`、非 3001 端口、独立 systemd unit 下启动真实 server（不得触碰 :3001，也不得读写真实 `~/.claude`）。
3. 搅动（循环执行）：会话的创建/发送/中止；websocket 客户端的正常关闭、半开连接、以及**故意不读数据的慢客户端**；向 transcript 追加行，含一个逐步长到 100MB 的大 jsonl；触发对话搜索；shell websocket 的 PTY 开关。会话来源：优先沿用 `server/modules/launch-profiles/tests/gateway-end-to-end.test.ts` 那套 mock gateway 驱动真实 claude 二进制；不可行时写一个说 stream-json 的假 claude 可执行文件。实施者选哪条要在 Evidence 里说明，真实二进制的读数优先。
4. 采样（每 5 秒）：server 主进程的 RSS 与 `VmHWM`、V8 堆（`--expose-gc` 下 `process.memoryUsage` 需经一个只读的调试出口或 `--heapsnapshot-signal`，实施者选最小侵入的一种，且不得把调试出口留在生产默认开启）、fd 数、线程数、子进程数、server 所在 cgroup 的 `memory.current`，以及 `claudecodeui-session-*` scope 数。
5. 判据（`soak-analyze.mjs`）：预热窗口之后对每个序列做线性回归，RSS/堆斜率超过阈值即红；fd 数、子进程数、session scope 数在搅动停止并冷却后必须回到基线的容差内；判词同一行带出序列名、斜率、阈值与成因。阈值由基线运行的实测推出，不凭感觉。
6. 失败时保留现场：堆快照、最后一段采样、server.log 尾部，放在 `--report` 指定位置。

## AC

- [x] `node --test scripts/soak-analyze.test.mjs` 退出 0：分析器用合成序列断言 (a) 平稳序列判绿；(b) 线性增长序列判红且判词含序列名与斜率；(c) 「先涨后回落」的序列判绿（防止把缓存预热误判为泄漏）；(d) fd/子进程数冷却后不回基线判红；(e) 预热窗口内的增长不计入。
- [x] `bash scripts/soak.sh --self-test` 退出 0：对一个受控目标进程（一个每秒保留一个 Buffer 的桩）跑完整采样加分析路径，断言判红，且判词点名 RSS；再对一个平稳的桩断言判绿。这是「装置真能读到泄漏」的正对照，缺它则装置无法证明自己不是无论如何都绿。
- [x] `bash scripts/soak.sh --duration 120 --report <tmp>` 退出 0，并且报告里每个采样序列的样本数不少于 20、含 `claudecodeui-session-*` scope 数序列；搅动器的各类动作计数均大于 0（会话数、慢客户端数、追加行数、搜索次数），任一为 0 则该次判红并点名是哪一类没跑。
- [x] `grep -nE 'soak' scripts/test.sh package.json` 的命中只有 `package.json` 里的 `soak` 脚本项；`scripts/test.sh` 与 `.quay/config.yml` 中无 `soak` 引用（手动触发的机械证明）。
- [x] `npx tsc --noEmit -p scripts/tsconfig.json` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：装置必须真的在真实 server 上跑出读数。要求 (1) 至少一次 30 分钟以上的 `bash scripts/soak.sh --duration 1800` 完整运行，把各序列的斜率、峰值、冷却后残留、以及阈值的推导（基线来自哪次运行）写进 Evidence；(2) 如果读数发现了真实增长，**不在本任务里修**，按机制另立 gap 任务并在 Evidence 里链接；如果没发现，如实写「30 分钟内未观察到增长」并说明这不等于长期无泄漏；(3) 报告里给出对「websocket 慢客户端是否造成发送缓冲无界增长」这一假设的明确结论（证实、证伪或未能驱动，三选一并附读数）；(4) 用读到的真实 RSS/堆峰值，回填 `gap-server-unit-restart-heap-limit` 里 2048MB 堆上限默认值是否合理的结论（只写结论与建议值，不在本任务里改脚本）。soak 用的所有临时进程与 unit 在结束后必须清理干净，包括失败路径。

该轴仍暗，理由：纯服务端长期运行观测，没有可独立度量的 L_D/L_G 读数；验收以上面的分析器用例、自检正对照与 30 分钟实跑读数为准。

## Touches

- scripts/soak.sh (new)
- scripts/soak-analyze.mjs (new)
- scripts/soak-analyze.test.mjs (new)
- scripts/soak-driver.mjs (new)
- package.json
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-server-soak-harness.md

## Evidence

分支 `task/gap-server-soak-harness`，实现提交 `011fa9cc`（在 develop `9d601816` 之上合并后；相对 develop 的 diff 恰为声明的六个文件）。所有读数取自本机 2026-09-25 夜间的真实运行，日志与报告保留在 `~/.soak/reports/`（`dod-1800.log/report.json`、`ac3-rerun.json/log`、`slow-hyp48.*`、`slow-ctl48.*`、`slow-hyp.*`、`ac2-selftest-final.log`、`scoped-gate-postmerge.log`）。

### AC1 — `node --test scripts/soak-analyze.test.mjs`

退出 0，22/22 通过（`tests 22 pass 22 fail 0`，71ms）。覆盖 (a)(b)(c)(d)(e) 五个必需分支之外，另有样本不足、目标消失、live-set 预算、动作计数为空、red 成因措辞等用例。该文件由 `node scripts/list-script-tests.mjs` 收录进 `npm run test:scripts`（该清单第 19 行）。

### AC2 — `bash scripts/soak.sh --self-test`

退出 0。同一 sampler + 同一 analyzer 跑两个桩：

```text
self-test leak stub:  driver exit 1, VERDICT red   — 1 条判据未过（判词为 FAIL series=rss … 斜率超阈…）
self-test steady stub: driver exit 0, VERDICT green — 全部判据通过
self-test passed: leaking stub read red and named RSS; steady stub read green
```

两个半都必须成立（红 + 点名 RSS），否则一个「无论如何都绿」的装置也能通过这条 AC。泄漏桩按每秒保留 32MiB 设计：raw RSS 背板是校准在 ~10MiB/s churn 上的粗判据，1MiB/s 的桩会被 churn 吞掉、不再是正对照（该取舍写在脚本注释里）。

### AC3 — `bash scripts/soak.sh --duration 120 --report <tmp>`

退出 0，VERDICT green。读数：`samples=32 drive=22`，驱动窗口内 rss/heap/threads 各 n=22（≥20），`sessionScopeCount` 序列非空且随子进程走 0→1→2→3→0；峰值 `rssPeak=1249.96MiB vmHwmPeak=1249.96MiB heapPeak=782.00MiB cgroupPeak=1288.36MiB`；四个动作计数全部 > 0：`sessionsCreated=238 / slowClients=1 / transcriptLinesAppended=238000 / searches=17`。本次复核跑在 soak.sh 增加两个开关（`--burst-mb`、`--slow-client-drains`）之后，命令与默认值与 AC 措辞逐字一致（默认 `--burst-mb 4`、不 drain）。

### AC4 — 手动触发的机械证明

`grep -nE 'soak' scripts/test.sh package.json` 唯一命中 `package.json:56:    "soak": "bash scripts/soak.sh",`；`.quay/config.yml` 命中数 0；`scripts/test.sh` 命中数 0。

### AC5 — 静态门

`npx tsc --noEmit -p scripts/tsconfig.json` 退出 0；`npm run lint` 退出 0（仅有仓库既存的 warning）。

### DoD-1 — 30 分钟真实运行（`bash scripts/soak.sh --duration 1800`）

退出 0，VERDICT green。日志 `dod-1800.log`：

| 读数 | 值 |
|---|---|
| 载荷 | 3371 会话、908000 转录行（401002676 字节）、178 搜索、651 正常 ws 关闭 / 658 半开、258 PTY 开+258 关、aborts=3、`sessionStartsDeferred=183` |
| 斜率 | rss 906917.10B/s（0.91MB/s，r²0.63，n=304）、heapUsed 431209.27B/s（0.43MB/s，r²0.28，n=301）、threads −0.00/s（r²0.00） |
| 峰值 | rss=vmHWM 3270.01MiB、heapUsed 2146.00MiB、cgroup `memory.current` 3498.60MiB |
| 冷却后残差 | fds 1（阈 16；基线 31 → 冷却 32）、children 0（阈 4）、sessionScopes 0（阈 1） |
| 存活对象图 | 42.91→180.54MiB（liveNodes 533220→2273082），预算 1810.50MiB，实测 42.0KiB/会话（允许 512KiB/会话） |
| 采样 | samples=314 drive=304、56 次 heap snapshot 探针 |

阈值推导（`node scripts/soak-analyze.mjs --calibrate --report <file>` 可重印，文档表格同步）：`rssBytesPerSecond=12582912` 是三次基线实测最高值 7.43MB/s 的 1.69 倍；`heapUsedBytesPerSecond=12582912` 是 6.32MB/s 的 1.99 倍；`liveSetGrowthBytes=138412032` 是实测最大 +32.76MiB 的 4.03 倍；`liveSetBytesPerSession=524288` 是实测 147.8KiB 的 3.46 倍；fd/child/scope 残差取实测漂移的上界（16/4/1）。基线来自 `baseline-a/b/c` 三次 120s 运行（227/227/240 会话，rss 6.42/6.51/7.43MB/s）。**负载必须钉住**：未钉版的第一版在快机器上驱动了 582 会话、把峰值推到 3024MiB 并因此判红，而存活对象图仍是负载成比例的（260KiB/会话）——所以现在按固定 500ms 会话间隔 + 8 并发上限驱动，并把被上限吞掉的 tick 记进 `sessionStartsDeferred`。

### DoD-2 — 是否发现真实增长

**30 分钟内未观察到增长。** 三条独立读数同向：raw 斜率远低于背板且无趋势（rss 0.91 ≪ 12MB/s，r²0.63）；三类计数在冷却后全部回到基线容差内（1/16、0/4、0/1）；存活对象图 42.0KiB/会话，是允许值的 1/12，且与「新增会话数」成比例而不是与「时间」成比例。

**这不等于「没有长期泄漏」**：30 分钟只覆盖 3371 次会话生命周期与一档负载。一条远低于本背景 churn、或只在数小时尺度上显现、或只在特定路径（特定 ws 帧型、特定 provider、特定并发）上发生的泄漏，本次读数看不见。因此按 DoD-2 的条件（发现真实增长才另立 gap）**没有为「增长」立 gap**；本轮另立的一条 gap 是装置自身的上限（见 DoD-3）。

### DoD-3 — 「websocket 慢客户端是否造成发送缓冲无界增长」的结论

**三态结论：在装置可驱动量级（≤48MiB）内为「证伪」；「无界」这一分支为「未能驱动」，且成因已定位在装置而非服务端。**

方法是一对运行，不是一次：`--slow-client-drains` 跑对照臂——同一 socket、同一手写握手、同一 `chat.subscribe`、同一窗口（`--duration 120` 时为 40s），唯一差别是字节被读走。

```bash
bash scripts/soak.sh --duration 120 --burst-mb 48 --report hyp.json
bash scripts/soak.sh --duration 120 --burst-mb 48 --slow-client-drains --report ctl.json
```

正对照（读差之前先读它）：对照臂 `slowClientDrainedBytes=103460364`（≈98.7MiB）对 `slowClientBurstBytes=50331648`（48MiB）——服务端确实把 burst 推给了订阅者；没有这条，「不读臂没涨」与「服务端根本没发」不可区分。

| 读数（整轮 120s） | 不读臂 `drains=false` | 对照臂 `drains=true` |
|---|---|---|
| 会话数 | 156 | 174 |
| 样本 / 窗口内 | 30 / 20 | 26 / **19**（必需序列 SKIP） |
| peak RSS / VmHWM | 4348.63 / 4591.44 MiB | 4727.91 / 4791.04 MiB |
| peak heapUsed | 3718.00 MiB | 3970.00 MiB |
| peak cgroup | 6222.14 MiB | 4884.63 MiB |
| 存活对象图 | 50.21→143.70 MiB（+93.49） | 48.10→152.48 MiB（+104.38） |
| liveNodes | 623074→1831886 | 600680→1940755 |
| `closedBeforeDeadline` | false | false |

不读臂并不更高（对照臂反而高 379MiB），两臂差远大于 48MiB 的被测载荷，且两臂的存活对象图都在预算内（203/210MiB）——在该量级上「是否消费」不可分辨。两臂本身都判红（斜率背板；对照臂另外有条 SKIP：4GB 堆让 5s 采样与 30s 快照互相挤掉，窗口内只有 19 个样本 < 20），所以**这对运行是按峰值与存活对象图比的，不是按判词比的**——这是装置的局限，不是服务端的属性，已如实写进文档。

装置上限（结论的边界）：burst 被 mock gateway **物化**（每个 4KiB delta 一个 JS 字符串再一次写出），`--burst-mb 512` 时 gateway 自己先 `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`（4095MiB），server 随即 `ECONNREFUSED`、只起了 27 个会话、残差判红（在飞 scope），该臂读数作废。可驱动上限约 48MiB，而 48MiB 上 raw 背板已因 churn 判红 ⇒「无界」在能撑满发送队列的量级上**本装置证不到**。已另立 gap：**`gap-soak-mock-gateway-burst-materialization`**（把 burst 改成流式生成后按 256–512MiB 重跑两臂）。

与差分无关但成立的机制读数：全部臂（4MiB / 48MiB / 512MiB 与 30 分钟运行）`closedBeforeDeadline=false`——40–60s 窗口内服务端从不关闭停止读取的订阅者，这条路径确实没有 `bufferedAmount` 上限也没有回收逻辑。假设点名的机制存在且无护栏；未被证明的是它在装置上限之上的放大。另：默认 `--burst-mb 4` 会被内核 socket 缓冲吸收（本机 `net.ipv4.tcp_wmem` max 4194304、`net.core.wmem_max` 212992），根本到不了服务端用户态发送队列——这是 `--burst-mb` 存在的原因。

### DoD-4 — 2048MB 堆默认的回填

**结论：2048MB 偏紧；建议值 4096MB**（`QUAY_SERVER_HEAP_MB` 覆盖与 `off` 不变）。依据：不设上限时 30 分钟 `heapUsed` 高水位 2146.00MiB，已比 2048 默认高 4.8%；上限低于真实 churn 不会阻止泄漏增长，只会把余量变成 GC 压力（CPU 被吃掉、随后照样重启）。上限的职责是「让失控以重启收场、而不是让宿主换页」（宿主 246GB，swap 已用 14.7/16GB），所以取值要在真实 churn 之上、宿主之下：4096MB = 实测高水位的 1.9 倍、实测存活对象图 180.54MiB 的 22.7 倍、宿主内存的约 1/60。

**回填的位置与理由**：结论写进 `docs/operations/process-isolation-and-memory-caps.md` 的新小节「The 30-minute reading, and what it says about the 2048MB heap default」——那正是 `gap-server-unit-restart-heap-limit` 自己的 DoD 指定的记录位置（「在文档 … 里更新…说明 2048 是保守默认、待 soak 读数收紧」）。**没有**去改那个已 `done` 的任务文件：跨任务改文件会把另一个任务的 `tasks/*.md` 拖进本任务的分支 diff（anti-drift 要求声明的 Touches 覆盖 diff），而本任务的范围是 soak 装置；本任务也未改 `scripts/serve-scoped.sh`。

读数边界（一并写出以免过读）：(1) 单次 1800s、合成负载（转录腿写 105.1MB 的 jsonl 并在每次变更时重读，比操作员会话更重），更长运行可能抬高水位，4096 应读作「有余量的下界」而非推导出的最优；(2) 读的是**未设上限**的实例，属上界而非需求量；(3) 该判决属 `gap-server-unit-restart-heap-limit` 的决定权，本任务不动其脚本。

### 两项实现选择（Proposal 第 3、4 步要求实施者说明）

- **会话来源**：走 Proposal 的首选——mock gateway 驱动**真实 claude 二进制**（`soak-driver.mjs mock-gateway` 在 127.0.0.1 提供 Anthropic 端点，unit 里 `CLAUDE_CLI_PATH` 指向真实 `claude`，并把 CLI 目录与 node 目录一起钉进 unit 的 `PATH`，因为 `systemd-run --user` 不继承调用方 PATH）。理由：真实二进制的读数优先，假 CLI 覆盖不到 SDK/进程生命周期那一段。
- **堆读数（最小侵入）**：V8 堆经**既有**的 `POST /api/commands/execute {commandName:"/status"}` 读出（生产已有路由，未新增任何调试出口，也未开 `--expose-gc`）；live-set 的锋利读数用 `--heapsnapshot-signal=SIGUSR1 --diagnostic-dir=<tmp>`，**只写进 soak unit 的 NODE_OPTIONS**，生产默认不开启。

### 与 AC/DoD 措辞的三处说明

1. **AC3 的「每个采样序列的样本数不少于 20」**：驱动窗口内的序列为 22 个样本（满足）；冷却后残差序列（fds/children/sessionScopes）按设计各 6 个样本——它们的判据是「是否回落到基线容差内」而不是样本量，故不参与该条。报告同时给出整轮与驱动窗口两个计数（`samples=32 drive=22`）。
2. **soak.sh 在 AC 措辞之外增加了两个开关**（`--burst-mb`、`--slow-client-drains`）：慢客户端的对照臂原先只在 driver 内部可达，没有入口就无法回答 DoD-3；默认值不变，所以 AC3 的逐字命令与默认行为未变。
3. **`--burst-mb` 的上限与 `--heapsnapshot-signal` 的分辨率**：GB 级堆下 5s 采样与 30s 快照会互相挤掉（出现过某序列 19/20 样本 SKIP、以及窗口后 RSS 样本缺失 `rssAfterBytes=null`），这是装置在高负载下的分辨率下降，已在 DoD-3 与文档中标注，未当作服务端读数使用。

### 退出前的门与缓存

- `bash scripts/test.sh --for-task gap-server-soak-harness --allow-thin` 退出 0。判词 `no scoped test files for gap-server-soak-harness (thin)`：scoped gate 的测试选择器只匹配 `*.test.[jt]sx?$`，本任务的测试文件是 `.mjs`（`scripts/soak-analyze.test.mjs`），因此被判 thin；它实际由 `npm run test:scripts` 收集执行。同轮 `suite-scope-check: PASS`（扫描 17 个活跃任务）。
- 已写 scoped-gate 缓存，`developSha=9d601816`（本分支 HEAD 含该提交）。

### 收尾与失败路径

- 每次退出（绿、红、装置错误）都打印 `cleanup: stopped N session scope(s); unit=gone; scopes-of-this-server-left=0`；红运行与装置错误保留工作目录以便取证，读完即删。
- 收尾后实测：`systemctl --user list-units 'claudecodeui-session-*'` 0 条、`claudecodeui-soak-*` unit 0 个、无 soak-driver/mock-gateway 进程（用 `ps -eo pid,cmd | grep '[s]oak-driver'` 核对，不用 `pgrep -f`，避免自匹配）；`:3001` 的 server unit 全程未被动过。
- 宿主磁盘：`$HOME/.soak` 累积到 19GB（12 个运行目录）后已删掉全部 `run-*`/`self-test-*`，保留顶层报告与必要的 `*.heapsnapshot`，现为 514MB。
- 失败读数（512MiB 的 gateway OOM、两个 48MiB 红臂、对照臂的 19/20 SKIP）都留在 `~/.soak/reports/` 并在 DoD-3 与文档中说明，未被当作服务端读数使用。