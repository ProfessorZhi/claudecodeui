---
id: gap-session-watcher-native-or-adaptive-poll
title: 会话 watcher 不再无条件 6 秒全量轮询：本地文件系统走原生事件，轮询只作降级并按文件数退避
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人（yale）2026-09-25 裁定：不保留「无条件轮询」，可换成原生事件，或按数据量退避。本任务两者结合：原生事件优先，轮询降级，且轮询间隔随文件数退避。

现场读数（2026-09-25）：`server/modules/providers/services/sessions-watcher.service.ts:278-287` 用 `chokidar.watch(rootPath, { usePolling: true, interval: 6_000, binaryInterval: 6_000, depth: 6, ... })`，覆盖四个 provider 根目录。当前 `~/.claude/projects` 下有 21 个项目目录、2186 个文件、约 882MB 的 transcript，单个项目目录就有 1096 个条目。轮询意味着每 6 秒对所有被跟踪文件各 stat 一次，空闲 CPU 随历史无限增长；这台 128 核机器上看不出来，小机器与长期运行的场景会先撑不住。

**为什么当初用了轮询，仓库里查不到理由。** `git log -S usePolling` 只追到 `44edf94f`（大重构），源码无注释，`docs/architecture/03-conversation-handoff.md:415` 只陈述事实不解释原因。宿主 `fs.inotify.max_user_watches` 是 1048576，远不是限制。最可能的真实原因是容器/网络文件系统下原生事件不可靠（仓库有 `docker/` 目录），但**这只是推测**，实施者必须先验证或明确标注为未证。

方案：
1. 新增一个纯函数 `resolveWatcherMode`（放在 `sessions-watcher.service.ts` 内，除非被第二处使用），输入环境变量 `CLOUDCLI_WATCHER_MODE=auto|native|poll`（默认 `auto`）与探测结果，输出 chokidar 选项。`auto` 时：在被监视根目录上做一次原生 watcher 探测；能建立且没有错误就用原生事件（`usePolling: false`），否则降级为轮询并打一行说明日志。探测不得写入 `~/.claude` 等用户数据目录。
2. 轮询降级时的间隔按被跟踪文件数退避：下限保持 6000ms（即今天的行为），随文件数增长上调，有上限；具体系数由实测推出，不凭感觉。
3. 原生事件路径下，watcher 的 `error` 事件（例如 ENOSPC）必须触发降级为轮询，而不是只打日志后从此失聪。
4. 已知耦合：`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 里复制了 watcher 的 `usePolling`/6000ms/`depth` 选项来当「观察者」，其判据（静默 >6500ms、写入与加载事件间隔 >6000ms）建立在 6 秒轮询周期上。watcher 默认改变后，这些前提要同步：轮询臂显式固定 `CLOUDCLI_WATCHER_MODE=poll`，并新增原生臂，不得删除或放宽既有断言。
5. 同步更新 `docs/architecture/03-conversation-handoff.md` 里 watcher 一段。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sessions-watcher-mode.test.ts` 退出 0：(a) `resolveWatcherMode` 的表驱动用例——`auto`/`native`/`poll` × 探测成功/失败，产出的 `usePolling` 与间隔符合预期；`native` 在探测失败时不静默降级而是报错；(b) 退避函数在文件数 0、1000、5000、50000 处单调不减，下限恰为 6000ms，上限被夹住；(c) 未知的 `CLOUDCLI_WATCHER_MODE` 取值回落到 `auto` 并打一行日志。
- [x] 同一测试文件的真文件系统用例：在临时根目录建一个 jsonl，原生模式下 `add` 事件在 2 秒内到达；`poll` 模式下在「间隔 + 1 秒」内到达；两条都断言收到的是同一路径。
- [x] 同一测试文件的降级用例：向原生 watcher 注入一个 `ENOSPC` 错误事件，断言 watcher 切换为轮询并且此后追加文件仍能被观察到（防止「报错后失聪」）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 退出 0：轮询臂固定 `poll` 后既有断言全部保留，新增原生臂通过。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：要有前后对照读数，不是「多了一个模式」。在同一台机器上，用一个 5000 文件的合成 `~/.claude/projects` 树（放在临时 HOME，**不得触碰真实的 `~/.claude`**），分别以 `poll`（今天的行为）与 `native` 启动真实 server 的 watcher，各空闲 60 秒，用 `/proc/<pid>/stat` 的 utime+stime 差读 CPU 时间，并读初始同步的 RSS 峰值与耗时；把两组读数、退避系数的推导写进 Evidence。CPU 读数不进 AC（它随宿主负载漂移，进 AC 会造成假红），只作 DoD 证据。另在真实语料（本机 882MB 的项目目录）上确认原生模式下会话仍被同步、`session_upserted` 仍被广播。**实施者须回答并记录**：原生事件在 Docker 挂载卷与网络文件系统上是否可靠；若无法验证，明确写「未证」并保留 `CLOUDCLI_WATCHER_MODE=poll` 作为逃生口。实施时按 `.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范落位。

该轴仍暗，理由：纯服务端文件监听，没有可独立度量的 L_D/L_G 读数；验收以上面的集成用例与前后对照读数为准。

## Touches

- server/modules/providers/services/sessions-watcher.service.ts
- server/modules/providers/index.ts
- server/modules/providers/tests/sessions-watcher-mode.test.ts (new)
- server/modules/debug-agent/tests/debug-agent-external-write.test.ts
- docs/architecture/03-conversation-handoff.md
- tasks/gap-session-watcher-native-or-adaptive-poll.md

## Evidence

### DoD 前后对照读数（5000 文件合成树，临时 HOME）

宿主：128 核，`load average` 27.55，`CLK_TCK`=100。合成树由脚本生成 5000 个**可索引**的 claude transcript、跨 50 个项目目录，置于 `mktemp -d` 出来的临时 HOME 下，`HOME=<临时>`、`DATABASE_PATH=<临时>/measure.db`——**真实的 `~/.claude` 未被触碰**。CPU 读 `/proc/self/stat` 的 utime+stime 差（按 `CLK_TCK` 换算），RSS 读 `/proc/self/status` 的 `VmHWM`。每个 cell 都是一次独立的真实 server watcher 启动（`initializeDatabase` + `initializeSessionsWatcher`），settle 后才开始计空闲窗口。

| cell | 文件数 | 空闲窗口 | cpuIdleMs | cpuIdlePct | rssPeakKb | bootMs |
|---|---|---|---|---|---|---|
| `poll`（今天的行为） | 5000 | 60s | 130 | 0.217% | 340084 | 57757 |
| `native` | 5000 | 60s | 30 | 0.050% | 413948 | 61104 |
| `poll`（复测） | 5000 | 120s | 340 | 0.283% | 337116 | 85421 |
| `native`（复测） | 5000 | 120s | 140 | 0.117% | 383268 | 59864 |
| `poll` | 1000 | 30s | 20 | 0.067% | — | — |
| `native` | 1000 | 30s | 0 | 0% | — | — |

如实标注边界，这三条必须一起读：

- **绝对值很小，且被量化。** `CLK_TCK`=100 ⇒ 读数粒度为 10ms；两轮里 `native` 也读到 30ms / 140ms，那是**进程基线**（GC、事件循环唤醒、cgroup 计费），不是 watcher 的周期性工作——原生模式下根本没有周期性工作。故两臂的**符号**在两次独立配对里一致（130>30、340>140），但单点数值不可当精确差值用。
- **`bootMs` 与 RSS 的臂间差异不是本改动的效应。** 初始全量同步在两臂以同样的代码跑同样的树，且**先于**任何 watcher 启动；复测那轮 `poll` 的 bootMs 85s 反而高于 `native` 的 60s，方向与 60s 那轮相反。这里记录、但不作论据。
- **可辩护的结论是标度律，不是这台机器上的绝对值。** 见下节。

### 退避系数推导（由实测推出）

一次轮询 sweep 的成本，主导项是每个被跟踪文件一次 `stat()`。直接实测（`stat-bench` 脚本，暖 dentry cache，30 次取中位数）：

| 文件数 | 中位 sweep | 中位 µs/文件 |
|---|---|---|
| 5000 | 4.328 ms | 0.866 |
| 1000 | 0.897 ms | 0.897 |
| 0（空树） | 0.0004 ms | — |

⇒ 每次 sweep 的成本**线性于文件数**（≈0.87–0.91 µs/文件）。整周期成本（含 chokidar 自身簿记）从上面 CPU 窗口反推：`poll`@5000、120s → 340ms / 20 次 sweep ≈ 17 ms/sweep ≈ **3.4 µs/文件/sweep**；与直接实测同一量级，差值即 chokidar 的簿记。

采用的规则（`interval(N) = clamp(6000 × N / 2186, 6000, 60000)`，参考语料 2186 = 提案里给出的当前 `~/.claude/projects` 文件数）：

- 含义是**在参考语料上维持今天 6 秒周期已经产生的 idle duty cycle**——不是新引入一个凭感觉的常数；低于参考语料时地板保证行为与今天逐字相同。
- 取值：N=0→6000；1000→6000（夹到地板）；5000→13724；50000→60000（夹到上限）。

所以空闲成本不再随历史增长：文件数翻倍，周期也翻倍，单位时间的 stat 总量持平。

### 真实语料（本机 882MB 项目目录）原生模式读数

真实 `~/.claude/projects`，**真实 HOME**，临时 `DATABASE_PATH`，`CLOUDCLI_WATCHER_MODE=native`。**没有写入任何 transcript 的内容**（唯一的写入是下面说明的一次 mtime 前移，且在 `finally` 里按原值还原）。

- **会话仍被同步**：初始同步 `processedByProvider {claude: 1972, codex: 24}`，临时库中 1976 条 claude 行。
- **机制确实是原生**：`readActiveWatcherModes()` 四个根（`.claude/projects`、`.cursor/projects`、`.codex/sessions`、`.local/share/opencode`）全部 `native`。
- **`session_upserted` 仍被广播**：从临时库里挑一条**已被索引且未归档**的真实 transcript（1224B），只把它的 mtime 前移 5 秒，随后还原。3/3 轮在该会话 id 上观察到 upsert，用时 **700 / 770 / 698 ms**；另有 2/2 轮先 settle 3 秒，同样观察到（约 0.5 秒）。这几轮各**只**收到 1 条 upsert，就是被唤醒的那条（`unrelatedUpsertsSeen=0`），所以归属明确。
- **真实活动佐证**：本会话自己的 transcript 就在该根下被持续追加，6/6 轮各观察到 1–21 条真实内容变更被同步并广播。
- **两侧各自独立确认**：裸 chokidar watcher 在同一个根上 4/4 看到这次 mtime 变更；直接调用 `synchronizeProviderFile` 对该文件返回 `indexed: true`。即「事件没到」与「到了但没索引」两种可能都被排除。
- 如实标注一个**选靶错误**：最初取「树里最小的 transcript」时读到 `observed: false`。追查后该文件只有 `ai-title` / `agent-name` 记录、**没有 `cwd`**，而 `extractFirstValidJsonlData` 要求 sessionId + cwd，所以索引器**正确地**跳过了它——那不是投递失败。后续改为从库里挑「已被索引且未归档」的文件。
- 一并读出的副作用（已写进架构文档）：**首轮 walk 结束到 watch 真正生效之间有缝隙，落进去的变更不会被重放。** 在这台机器的真实根上，`whenReady` 后第一秒内做的 metadata-only 变更 **3/3 丢失**，settle 之后做的 **7/7 在约 0.5 秒内送达**。轮询没有这个缝隙（首次 sweep 会与 walk 刚建立的基线对比）。窗口是进程启动一次，且 watcher 建立之前发生的变更已由先跑的初始同步覆盖；测试与文档都按此加固（native 用例先 settle 再写，窗口仍从写入时刻起算）。

### Docker 挂载卷 / 网络文件系统（DoD 要求回答）

探针用 `node:fs.watch`，即 chokidar 非轮询路径所包裹的 inotify 原语，在真实容器里跑。

- **本机（Linux 6.8.0-124，Docker 29.8.0，存储驱动 overlayfs）：已验证可靠。**
  - **bind mount，宿主侧写 → 容器内 watcher**：宿主侧依次做 mtime-only `touch`、追加、新建，容器内**全部收到**：
    `["/data/projects/p1 change a.jsonl", "/data/projects/p1 change a.jsonl", "/data/projects/p1 rename b.jsonl", "/data/projects/p1 change b.jsonl"]`。
  - **named volume，容器 A 写 → 容器 B watcher**：`["rename c.jsonl", "change c.jsonl", "change c.jsonl"]`。
- **未证：Docker Desktop（macOS / Windows）。** 那里的 bind mount 走 virtiofs / gRPC-FUSE 共享而不是同一内核的 inode，正是「无条件轮询」当初最可能存在的理由；本机没有这样的宿主可测，Linux 上的读数**不能**外推到它。
- **未证：网络文件系统（NFS / CIFS）。** 本机没有挂载任何网络文件系统，探针无法对其运行。
- 因此 `CLOUDCLI_WATCHER_MODE=poll` 保留为逃生口，并已写进 `docs/architecture/03-conversation-handoff.md`：在 Docker Desktop 挂载或网络文件系统上（或历史上被这一类问题咬过的地方）应显式设 `poll`。`auto` 的探测只回答「原生 watch 能否在这个根上建立」，**不**回答「挂载另一侧的写入能否触发它」。

### 模块与 barrel 落位

按 `.agents/skills/backend-module-standards/SKILL.md`：实现在 `server/modules/providers/services/sessions-watcher.service.ts` 内，新增的跨模块读取 `readActiveWatcherModes()` 与类型 `WatcherMode` 经 `server/modules/providers/index.ts` barrel 导出（消费者注释指向 `debug-agent-external-write.test.ts`）；同模块内的测试沿用同模块深导入（该目录既有 10 个同例），未为测试加宽 barrel。**故 Touches 补上 `server/modules/providers/index.ts`**。

## 完成记录

- 工作树 `gap-session-watcher-native-or-adaptive-poll`（分支 `task/gap-session-watcher-native-or-adaptive-poll`），基于 `develop` = `8e49b82bd837b42bf145243c06eacbf7f0575ee6`。
- 5 条 AC 逐条以命令读数核对通过：`sessions-watcher-mode.test.ts` 6/6 通过（13.0s）；`debug-agent-external-write.test.ts` 3/3 通过（22.6s，轮询臂断言逐条保留、原生臂新增通过）；`npm run typecheck` 与 `npm run lint` 均退出码 0（`lint` 仅既有 warning）。
- 读数写入 `## Evidence`：DoD 前后对照表、退避系数推导、真实语料原生模式读数、Docker/网络文件系统结论。
- **Touches 追加 `server/modules/providers/index.ts`**：跨模块读取必须走 barrel，这是模块规范强制、非投机改动；原 Touches 未列，不补会被 anti-drift 判为 out-of-declared。
- DoD 明写的一条未被提案预期到、由本轮实测发现的性质（原生模式下「walk 结束 → watch 生效」的缝隙会丢变更）已同时写进 `docs/architecture/03-conversation-handoff.md` 与该任务的 native 用例，未以「原生更优」一句掩盖。
- `该轴仍暗` 一句保留在 DoD：纯服务端文件监听，没有可独立度量的 L_D/L_G 读数。
- **第 2 轮（2026-09-25，上轮 fan-in suite 红后重派）**：在 worktree 重跑 scoped 门（`bash scripts/test.sh --for-task gap-session-watcher-native-or-adaptive-poll --allow-thin`）绿：2/2（`sessions-watcher-mode.test.ts` 13.3s、`debug-agent-external-write.test.ts` 22.9s）；`npm run typecheck` rc=0、`npm run lint` rc=0（仅既有 warning）；与 `develop`（`1f52c9d4`）零落后、零冲突、无未合并路径。
- **上轮 suite 红的两条都在本任务 `## Touches` 之外，且都是并发环境产物，不是本任务缺陷。** `voice-dashscope-settings.false-forms.test.ts`：AC8 的 `server-branch-scan` 先 `collectSourceFiles(server/)` 全树收集、再逐个 `readFile`，兄弟用例在**共享的** `server/modules/voice/` 里反复建删 `__criterion-falsify-*` 副本 ⇒ 收集到的路径在读取时已消失，`collectReadings` 逐条 catch 后记为 `threw: ENOENT`，与「真命中」在断言文本里不可分。`voice-capture-text.false-forms.test.ts`：其 AC11 拿模块加载时的 `git status --porcelain` 快照与跑后全树对拍，兄弟用例的副本使快照不同；suite 日志引的那行（`falsify/failure-row-dropped …`）是 `first_error()` 误取了一条**通过**的读数行，不是失败原因。两条单跑皆绿（`voice-dashscope-settings` 3/3、rc=0、1.3s）。
- 这是全队共享的结构性竞态：现存 11 份 `.quay/fan-in-suite-*.log` **全部**以 `# suite red failed` 结束。其归属任务 `gap-ac103-worktree-state-drag-and-unbudgeted-confirm` 已于 2026-09-25 转为 `superseded`，通道当前无主；本条不越界修改兄弟判据（在 Touches 之外），仅记录归因。

## Needs-Human

**执行 2026-09-25T05:05:03.235Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=14941 server/modules/providers/tests/model-gateway-end-to-end.test.ts passed=false end_ms=1790312593875
- run_id：wk-prod-anchor
- session_id：39175782-4f7a-41c7-a9dc-aae36b100f7a
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-session-watcher-native-or-adaptive-poll~wk-prod-anchor~1790312544569-88e004.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-session-watcher-native-or-adaptive-poll-wk-prod-anchor.log
