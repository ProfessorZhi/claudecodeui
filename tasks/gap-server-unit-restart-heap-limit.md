---
id: gap-server-unit-restart-heap-limit
title: :3001 server unit 化收尾：崩溃自动拉起、V8 堆上限让泄漏变成「重启」而不是「换页拖死宿主」
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景：`scripts/serve-scoped.sh`（`ade2dfb4`）把 server 放进独立的瞬态 unit，解决了「别人的 OOM 波及 server」。但对「本项目需要长期运行」还差两块：(1) 该 unit 没有 `Restart=`，server 一旦崩溃或被 OOM 杀，就一直停着，直到有人发现；这正是 9/25 那次「server.log 戛然而止、没有崩溃行」之后只能靠人肉发现的原因。(2) server 没有 V8 堆上限，宿主 252G，真有泄漏时会一路涨到把宿主拖进换页（宿主 swap 当下已用 14.7G/16G），而不是在一个可预期的点上崩溃并被重启。

现场读数（2026-09-25）：server 进程刚启动约 224MB RSS、11 个线程、28 个 fd。**没有任何长时间读数**，「server 从未泄漏」目前是缺乏观测而非已证；上限值因此先取保守默认并可覆盖，等 soak 读数出来再收紧。

方案（只改 `scripts/serve-scoped.sh` 与文档）：
1. 给 `systemd-run` 加 `--property=Restart=on-failure`、`RestartSec=5`，并限制重启风暴（`StartLimitBurst`/`StartLimitIntervalSec`，风暴时停止重启并留下可读的失败状态，不无限循环）。正常 `stop` 不属于失败，必须不触发重启。
2. 通过 `--setenv=NODE_OPTIONS=--max-old-space-size=<MB>` 给 server 加堆上限，默认 2048，`QUAY_SERVER_HEAP_MB` 覆盖，`off` 不加。上限触发后 Node 以非零退出，由 1 拉起。要保留调用方已有的 `NODE_OPTIONS`（追加而非覆盖）。
3. `status` 子命令补充输出：重启次数（`NRestarts`）、当前 `MemoryCurrent`、`MemoryPeak`，便于一眼判断是否在悄悄重启。
4. 不给 server 加 `MemoryMax`，与文档原有立场一致：上限会让 server 成为 OOM 受害者而非旁观者。会话已由另一任务移出该 cgroup 之后，若 soak 读数显示需要，再单独加一个宽松的 `MemoryHigh`。
5. 为了让脚本可被测试，允许新增一个最小的环境变量接缝（例如 `QUAY_SERVER_CMD` 覆盖被托管命令，默认仍为 `npm run server`）；不得改变默认行为。

## AC

- [x] `bash scripts/serve-scoped-check.sh` 退出 0：用假的 `systemd-run`（PATH 前置，记录 argv 到文件）跑 `start`，断言 argv 含 `Restart=on-failure`、`RestartSec=`、`NODE_OPTIONS=` 且其值含 `--max-old-space-size=2048`；`QUAY_SERVER_HEAP_MB=off` 时不含该参数；调用方已有 `NODE_OPTIONS=--trace-warnings` 时结果同时含两者。任何一项不满足，判词在同一行带出实际 argv。
- [x] 同一脚本的真机段：用真实 `systemd-run --user` 起一个一次性 unit（`QUAY_SERVER_UNIT` 取带随机后缀的名字，命令为 `node -e "setInterval(()=>{},1000)"` 一类的存活桩），对其主进程 `kill -9`，15 秒内该 unit 回到 active 且 `MainPID` 已变、`NRestarts` 为 1；对另一个同样的 unit 执行 `serve-scoped.sh stop`，之后 `NRestarts` 仍为 0 且 unit 不再存在。收尾必须清理这些一次性 unit，包括失败路径。
- [x] 同一脚本的堆上限段：以桩命令 `node -e` 不断保留对象，在真实 unit 里带默认 `NODE_OPTIONS` 运行，断言它在有限时间内以非零退出并被拉起一次（读到 `NRestarts` ≥ 1），且整个过程中该 unit 的 `MemoryPeak` 不超过堆上限的 2 倍。
- [x] `node --test scripts/serve-scoped-check.test.mjs` 退出 0：覆盖上面各分支的判词（含「无 systemd user manager 时脚本给出明确报错而不是静默」）。
- [x] `bash scripts/serve-scoped.sh` 无参数仍以退出码 2 打印 usage；`status` 输出含 `NRestarts`（真机段里验证）。
- [x] `npx tsc --noEmit -p scripts/tsconfig.json` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：不是脚本多了几个 `--property`。要求在**非 3001** 端口与临时 `DATABASE_PATH` 下，用改好的 `serve-scoped.sh` 真实起一个 server unit（**不得重启 :3001**，也不得在 server 托管的会话里执行 stop/restart，见记忆条目），读到：正常提供 `/api` 响应；对其主进程 `kill -9` 后自动恢复并再次响应；把堆上限压到一个很小的值重跑，读到堆耗尽退出并被拉起；`status` 输出里的 `NRestarts`。把这三次读数写进 Evidence，并在文档 `docs/operations/process-isolation-and-memory-caps.md` 里更新「server 有意不设上限」一节：说明现在的策略是「重启 + 堆上限」而不是 cgroup 上限，以及 2048 是保守默认、待 soak 读数收紧。**没有做的事要写明**：server.log 的轮转与降噪（当前 4729 条多行的同步日志、无轮转）不在本任务内。

该轴仍暗，理由：纯运维脚本，没有可独立度量的 L_D/L_G 读数；验收以上面的脚本判据与真机读数为准。

## Touches

- scripts/serve-scoped.sh
- scripts/serve-scoped-check.sh (new)
- scripts/serve-scoped-check.test.mjs (new)
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-server-unit-restart-heap-limit.md

## Evidence

分支 `task/gap-server-unit-restart-heap-limit`；实现提交 `66755b75`；合并 develop（`10bed1d9`）后 HEAD `91e00d61`。相对 develop 的改动恰为声明的文件（第五个是经 ABI 写入的本任务文件）。

### AC1 — `bash scripts/serve-scoped-check.sh`（退出 0，14.3s）

假的 `systemd-run` 记录到的 argv 读数：

```text
ok   fake/default:             Restart=on-failure RestartSec=5 StartLimitBurst=5 StartLimitIntervalSec=60
                               --setenv=NODE_OPTIONS=--max-old-space-size=2048 -- npm run server
ok   fake/heap-off:            argv 中不含 --max-old-space-size
ok   fake/caller-node-options: --setenv=NODE_OPTIONS=--trace-warnings --max-old-space-size=2048
ok   fake/cmd-override:        -- node /tmp/…/serve-scoped-check-stub.js
ok   fake/no-user-manager:     退出 3，报错点名 "no usable systemd user manager"，不是静默成功
ok   fake/usage:               无参数退出 2 并打印 usage
serve-scoped-check: PASS
```

判词本身的有效性由变异对证明（`scripts/serve-scoped-check.test.mjs`：先在同一棵树上断言退出 0，再变异并断言非零）。实际判词形态（`--property=Restart=on-failure` → `--property=Restart=no`）：

```text
FAIL fake/default: argv is missing: Restart=on-failure; actual argv: --user --quiet --collect --unit=check-fake-… --property=Restart=no --property=RestartSec=5 … -- npm run server
```

### AC2 — 真机重启段 / 干净停止段

- 重启段：`kill -9 734467` 后 5s 内 unit 回到 `ActiveState=active`、`MainPID` 变为 `739096`、`NRestarts=1`。
- 停止段：停之前 `NRestarts=0`；`serve-scoped.sh stop` 之后 unit 被卸载（`LoadState=not-found`，不是 active）——干净停止不是失败路径，不触发重启。
- 收尾：整轮跑完 `systemctl --user list-units --all | grep serve-scoped-check` 无残留（EXIT trap 覆盖失败路径）。

### AC3 — 真机堆上限段

桩命令（`node <file>`，不断保留对象）在真实 unit 里带默认上限 2048MB 运行：有限时间内出现 node 的堆耗尽行、进程非零退出、14s 内被拉起一次（`NRestarts=1`），全程 `MemoryPeak=388MB ≤ 4096MB`（上限的 2 倍）。多次运行的 MemoryPeak 读数为 754MB / 795MB / 388MB / 1087MB，均在上限 2 倍以内。

### AC4 — `node --test scripts/serve-scoped-check.test.mjs`

12 个用例全过（约 1.0s）。覆盖每个分支的「先绿后红」变异对（Restart 属性被删、堆上限未合成、调用方 NODE_OPTIONS 被覆盖、`off` 分支不可达、默认命令被改、`QUAY_SERVER_CMD` 接缝被忽略、`exit 3` 变 `exit 0`、usage 退出码被改），以及「无可用 user manager 时真机段报 SKIP 而非静默 pass」。

### AC5 — usage 与 `status`

无参数退出 2，stderr 打印 `usage: serve-scoped.sh start|stop|restart|status`；`status` 输出含 `NRestarts`（真机重启段读到 `NRestarts=1`），另含 `MemoryCurrent`/`MemoryPeak`/`MainPID`/`LoadState`/`ActiveState`。

### AC6 — 静态门

`npx tsc --noEmit -p scripts/tsconfig.json` 退出 0；`npm run lint` 退出 0。

### DoD — 真机三次读数（非 3001 端口、临时 `DATABASE_PATH`）

入口是 `serve-scoped.sh start`，`QUAY_SERVER_UNIT=serve-scoped-dod-*`、`SERVER_PORT=3199`（第二次 3198）、`QUAY_SERVER_LOG=<tmp>/heap.log`，被托管命令经文档化的接缝传入：
`QUAY_SERVER_CMD="env DATABASE_PATH=/tmp/serve-scoped-dod/auth.db npm run server"`。
**未重启 :3001，也未在 server 托管的会话里执行 stop/restart。**

1. 正常服务：`curl /api/auth/status` → `http=200 {"needsSetup":true,"isAuthenticated":false}`；unit 计数 `MainPID=663822 NRestarts=0 MemoryCurrent=200916992 MemoryPeak=201543680 ActiveState=active`。
2. 对其主进程 `kill -9 663822`：t=6s 已自动恢复，`MainPID 663822 → 673444`、`NRestarts=1`，`/api` 再次回答 `{"needsSetup":true,"isAuthenticated":false}`。
3. 堆上限压到 32MB 重跑（`QUAY_SERVER_HEAP_MB=32`）：journal 记 `Main process exited, code=exited, status=134/n/a`；日志第 36 行是 `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`；t=30s 观察到被拉起，`NRestarts=1`。

隔离性证明：对活着的 unit 的进程读 `/proc/<pid>/environ`，得到 `DATABASE_PATH=/tmp/serve-scoped-dod/auth.db`、`NODE_OPTIONS=--max-old-space-size=2048`、`SERVER_PORT=3197`、`HOST=127.0.0.1` —— 这个临时 server 写的是临时库。所有一次性 unit 已清理（0 残留）。

### 与 AC 措辞的两处偏差（已在脚本与文档中记录）

1. 桩是 `node <file>` 而不是 `node -e "<code>"`：`QUAY_SERVER_CMD` 按词切分，`-e` 的代码串含空格无法在其中存活；AC 的措辞是「`node -e "…"` 一类」，此处属于该「一类」。
2. 额外增加了 `QUAY_SERVER_LOG` 接缝，使检查用的一次性 unit 不往仓库的 `server.log` 追加。

另有一条现场发现：`systemd-run --user` 的瞬态 unit **不继承调用方环境**（实测 `FOO_MARKER` 读作 `<unset>`），所以 DoD 的临时 `DATABASE_PATH` 只能经 `QUAY_SERVER_CMD` 接缝传入；脚本刻意不把 `DATABASE_PATH` 加进 `--setenv` 透传列表，以免改变默认行为。

### 没有做的事

`server.log` 的轮转与降噪（当前 4729 条多行同步日志、无轮转）不在本任务内，已写入文档 `docs/operations/process-isolation-and-memory-caps.md` 的「Not done here — `server.log`」一节。
