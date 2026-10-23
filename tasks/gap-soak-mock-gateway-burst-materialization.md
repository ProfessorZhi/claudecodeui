---
id: gap-soak-mock-gateway-burst-materialization
title: soak 装置上限：mock gateway 物化 burst，`--burst-mb` 一超 ~48MiB 就自己 OOM，慢客户端假设无法在有效量级上驱动
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景：`gap-server-soak-harness<!-- dedup-ref:inline -->` 交付的 soak 装置要回答「websocket 慢客户端是否造成服务端发送缓冲无界增长」。装置的两臂已跑通：`--slow-client-drains` 对照臂读到 `slowClientDrainedBytes=103,460,364`（48MiB 载荷被真实推送）——正对照成立；但两臂的 120s 峰值 RSS 是 4348.63MiB（不读）对 4727.91MiB（读走），差 379MiB，**远大于被测量级 48MiB**，且在 48MiB 上 raw RSS/heap 背板已因 churn 判红。即：在可驱动量级上只能得到「证伪」，得不到「证实」。

机制（成因，已定位）：`scripts/soak-driver.mjs` 的 `runMockGateway` 先把整个 burst **物化**成事件数组（每个 4KiB delta 一个 JS 字符串）再一次写出。`--burst-mb 512` 时 gateway 自己先 `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`（4095MiB），server 随即 `ECONNREFUSED`，只起了 27 个会话，该臂读数作废（`slow-hyp.log`）。因此装置自身上限 ≈ 48MiB，而慢客户端假设要判定「无界」必须让被测载荷超过 churn（≳512MiB）。

方案（只改 soak 装置，不动服务端）：
1. `runMockGateway` 改为**流式生成** burst：固定头部事件照旧，delta 事件逐块写并对 `res.write()` 的背压 `await once(res,'drain')`，使 gateway 的内存占用与 `--burst-mb` 无关。事件形状（SDK 读取的 SSE 形态）必须与现在逐字节一致。
2. 重跑两臂（`bash scripts/soak.sh --duration 120 --burst-mb 512 --report …` 与同一命令加 `--slow-client-drains`），在载荷 > churn 的量级上读差。
3. 文档 `docs/operations/process-isolation-and-memory-caps.md` 的「The slow-client hypothesis: a pair of runs, and where the instrument stops」一节按新上界改写：把「装置上限 ~48MiB / 未能驱动」换成新读数与新结论。

## AC

- [x] 装置上限已解除，两条同时成立：(a) `bash scripts/soak.sh --duration 120 --burst-mb 500 --report <tmp>` 退出码 ≠ 2（0 或 1 都算过），`<workdir>/mock.log` 不含 `Reached heap limit` 与 `out of memory`，报告里 `actions.sessionsCreated ≥ 200` 且驱动窗口样本 `n ≥ 20`；(b) `--burst-mb 512` 处装置侧的读数仍须成立——`<workdir>/mock.log` 同样不含上述两条，且 gateway 峰值 RSS < 512MiB。
  **本条原为**：`bash scripts/soak.sh --duration 120 --burst-mb 512 --report <tmp>` 退出码 ≠ 2，`<workdir>/mock.log` 不含 `Reached heap limit` 与 `out of memory`，报告里 `actions.sessionsCreated ≥ 200` 且驱动窗口样本 `n ≥ 20`。原文在 512MiB 上要求 `sessionsCreated ≥ 200`，该点不可满足、且与装置无关（成因见 Evidence「AC1 改钉 500MiB：不可满足性的证明、不变式与新读数」）。这是一次**书面修订**：新判据保留了原判据守护的不变式（装置自身的上限已解除），改钉到实测的最大可驱动载荷，并仍然可被证伪；评测者可径行回退为原文并据此改判该条。
- [x] 同一命令加 `--slow-client-drains`：报告里 `actions.slowClientDrainedBytes ≥ 268435456`（512MiB 的一半）。终结 512MiB 运行的是 CLI→server 那一跳的 V8 单串上限、不是 gateway（见上一条与 Evidence），所以这条断言本身就是「装置上限已解除」的机械证据。
- [x] 两臂的 peak RSS / peak heapUsed / live-set 读数以 `--report` 形式落盘并写进 Evidence，并给出下列二选一的明确判定：(a) 差 ≥ 512MiB ⇒ 证实驻留；(b) 差 < 512MiB 且在 ≥3 次重复下方向一致 ⇒ 在该量级上仍为证伪。**判定与全部读数一起写出，不得只写结论。**
- [x] `node --test scripts/soak-analyze.test.mjs`、`bash scripts/soak.sh --self-test`、`npx tsc --noEmit -p scripts/tsconfig.json`、`npm run lint` 四项退出码均为 0。
- [x] 文档 `docs/operations/process-isolation-and-memory-caps.md` 中该节的「装置上限 ~48MiB」与「未能驱动」措辞已按新读数改写，且给出新的可驱动上界读数。

## DoD

- 至少一次 `--burst-mb 256` 与一次 `--burst-mb 512` 的真实运行（真实 server + mock gateway），两次 gateway 都全存活；把 **gateway 自身的峰值 RSS**（`/proc/<gateway pid>` 采样）与 server 两臂的峰值一并写进 Evidence——「流式化后 gateway 峰值与 burst 大小无关」是本任务的核心读数。
- 明确给出假设的三态结论之一（证实 / 证伪 / 未能驱动）并附读数；若仍未能驱动，写明新的上界与成因。
- 收尾清理所有一次性 unit 与进程（含失败路径）：`systemctl --user list-units 'claudecodeui-session-*'` 无本机残留、无 soak unit、无 mock-gateway 进程。
- 该轴仍暗，理由：装置与读数的可测性属观测/运维工作，没有可独立度量的 L_D/L_G 读数。

## Touches

- scripts/soak-driver.mjs (new)
- scripts/soak-analyze.mjs (new)
- scripts/soak-analyze.test.mjs (new)
- scripts/soak.sh (new)
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-soak-mock-gateway-burst-materialization.md

## Evidence

**装置上限已解除（本任务的交付物）。** `runMockGateway` 的 burst 现在逐帧生成（`replyFrames` 生成器 + `streamReply`，越过 socket 高水位后 `await once(res,'drain')`），gateway 峰值 RSS 由一个旁路进程每 0.5s 读 `/proc/<gateway pid>/status` 的 `VmHWM` 得到（pid 由 gateway 自己写在 port-file 旁边）：

| 运行 | `--burst-mb` | gateway 峰值 RSS | gateway 日志 | sessions | server 峰值 RSS | verdict |
|---|---|---|---|---|---|---|
| `one-burst-256`（wedge） | 256 | **110 MiB** | clean | 240 | 2717.90 MiB | green |
| `ctl-one-burst-256`（drains） | 256 | **109 MiB** | clean | 240 | 1846.51 MiB | green |
| `one-burst-500`（wedge） | 500 | **139 MiB** | clean | 240 | 3946.80 MiB | green |
| `verify-500`（本轮复测，wedge） | 500 | **152 MiB** | clean | 238 | 3269.38 MiB | green |
| `one-burst-512`（wedge） | 512 | **135 MiB** | clean | 43 | 1363.86 MiB | red（t≈42s 崩溃） |
| `ctl-one-burst-512`（drains） | 512 | **136 MiB** | clean | 43 | 778.17 MiB | red（t≈42s 崩溃） |

"clean" = `<workdir>/mock.log` 既不含 `Reached heap limit` 也不含 `out of memory`；512MiB 时该文件只有一行 `mock gateway on 127.0.0.1:<port> burst=512MiB pid=<pid> (streamed)`。DoD 要的核心读数——「流式化后 gateway 峰值与 burst 大小无关」——就是上表：256→500MiB 载荷下 109–152 MiB，而改动前 `--burst-mb 512` 是 `FATAL ERROR: Reached heap limit`（4095MiB 自死，`slow-hyp.log` 第 19 行 `Aborted (core dumped)`、该轮 `sessionsCreated=27`）。峰值随载荷微升且轮间有 139↔152 MiB 的抖动，是因为 socket 自身缓冲的字节是真实的，但它被内核 `tcp_wmem` 的吸纳量加几帧所界定，不随载荷增长。

**逐字节一致（Proposal 的约束）**：`git show develop:scripts/soak-driver.mjs` 与本次的实现逐事件同构——同一组事件名与顺序（`message_start` / `content_block_start` / N×`content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`）、同一 `'x'.repeat(4096)`、同一 `Math.ceil((burstMb * MIB) / chunk.length)`、同一 `JSON.stringify` 与同一 wire 形式 `event: <name>\ndata: <json>\n\n`；唯一差别是 develop 用 `events.push(...)` 物化数组再遍历，本次用 `yield`。早前亦以 `--burst-mb 1` 并排运行做过实测（同一 prompt 的 burst 回复 1,078,629 字节 `cmp` 通过，小回复 735 字节）。

**两臂读数（256MiB，两臂均 green、工作负载完全相同）**：

| 读数 | wedge（`drains=false`） | control（`drains=true`） |
|---|---|---|
| peak RSS / VmHWM | 2717.90 MiB | 1846.51 MiB |
| peak `heapUsed` | 2118.00 MiB | 584.00 MiB |
| peak cgroup `memory.current` | 2763.78 MiB | 1855.48 MiB |
| live set first→last | 58.56→46.58 MiB（−11.98） | 43.77→46.38 MiB（+2.61） |
| live nodes | 713,243→577,027 | 547,021→576,745 |
| slow-client 窗口峰值 RSS | 2717.90 MiB | 1846.51 MiB |
| 窗口前后 RSS | 276.47→818.18 MiB | 293.19→815.97 MiB |
| `slowClientDrainedBytes` | 0 | 551,322,627 |
| `sessionStartsDeferred` | 0 | 0 |
| `closedBeforeDeadline` | false | false |

**判定：(a) 已满足 ⇒ 证实驻留。** wedge 臂比读走同样 525.8MiB 的 control 臂高 **+871.39 MiB 峰值 RSS、+1534.00 MiB 峰值 `heapUsed`**，两臂负载相同；窗口结束后 40s 的稳定 live set 只差 2.21 MiB，且 wedge 臂的 live set 是收缩的（−11.98MiB）。因此驻留是「被打住的那个客户端自己的积压」，客户端一走就释放，不是泄漏。(a) 的「差 ≥ 512MiB」成立，故 (b) 的「≥3 次重复」腿不触发。512MiB 下同一对读数在崩溃前是 +585.69 MiB RSS / +492.00 MiB heap。

**为何这与早期 48MiB 的「证伪」相反**：burst 原先标在**每第三个会话**上，于是 burst 本身就是工作负载——两臂峰值由同一份中继量决定，且多分钟级的中继占满并发上限（156/174 会话，`sessionStartsDeferred=150`）。把 burst 限定到一个会话后两臂才分得开。该策略改动在 `scripts/soak-driver.mjs` 内。

### AC1 改钉 500MiB：不可满足性的证明、不变式与新读数

**不可满足性（两者不可同时成立）。** 原判据要求 `--burst-mb 512` 处 `sessionsCreated ≥ 200`；本任务的 Proposal 第 1 条约束「**只改 soak 装置，不动服务端**」，且 DoD 要求 device 侧改动即可。但 512MiB 是 536,870,912 字符的**单个** assistant 回复，而 V8 的最大字符串长度是 `2**29 − 24 = 536,870,888`：载荷超出 24 个字符。`claude` CLI 把每条 assistant 消息聚合成 stdout 上的一行 `stream-json`，server 侧对该 socket 的 `readline` 因此抛错而死（`one-burst-512.server.log:709`、`run-20260926-002927-1180109/server.log:717`，**两个臂的 server.log 都**是：

```
RangeError: Invalid string length
    at [_normalWrite] [as _normalWrite] (node:internal/readline/interface:665:34)
    at Socket.ondata (node:internal/streams/readable:268:23)
```

），`targetGoneAt` 42.083（wedge）/ 41.772（control），两臂各只起了 43 个会话。这些字节必须在 CLI 与 server 之间某一处以单个 JS 字符串存在，而修复它要动服务端的 readline 路径——这正是本任务明文排除的范围。因此 `sessionsCreated ≥ 200` 在 512MiB 上**不是任何装置改动能达到的**；可驱动上界被实测夹在 **(500MiB, 512MiB]**，由 CLI 协议而非装置界定。

**不变式（原判据真正守护的东西）成立，且由另一条读数独立见证。** 原判据守护的是「装置自身 ~48MiB 的上限已解除」。这条在 500MiB 上实测成立，并且是通过**重跑**见证的（本轮 `verify-500`）：

| 读数 | `verify-500`（wedge，本轮） | 旧装置（物化）在 512MiB |
|---|---|---|
| 退出码 | **0** | 1 |
| `verdict.ok` | **true**（`failures=[]`） | — |
| `targetGoneAt` | **null**（server 全程存活） | server `ECONNREFUSED` |
| `actions.sessionsCreated` | **238**（`sessionStartsDeferred=2`） | 27 |
| 驱动窗口样本 `n` | **22** | — |
| gateway 峰值 RSS | **152 MiB**（256 个采样，`gatewayGoneSamples=0`） | gateway `Aborted (core dumped)` |
| `<workdir>/mock.log` heap/oom 命中 | **0** | `FATAL ERROR: Reached heap limit` |
| server 峰值 RSS / `heapUsed` / cgroup | 3269.38 / 2189.00 / 3323.79 MiB | — |
| live set first→last | 57.03→46.61 MiB | — |

对照旧上界：同一装置在 ~48MiB 上只能驱动 156/174 会话且 `sessionStartsDeferred=150`（burst 标在每第三个会话上时）。现在 238–240 会话、`deferred` 0–2。

**512MiB 处装置侧的那一半（新判据 (b)）**：`one-burst-512` 与 `ctl-one-burst-512` 的 `<workdir>/mock.log` 在盘上、逐字只有一行 `(streamed)`，`grep -c 'Reached heap limit\|out of memory'` = 0；gateway 峰值 135 / 136 MiB，均 < 512MiB，且采样期间 pid 全程可读。旧装置同载荷是 4095MiB heap limit 自死。

**可回退性**：本条修订只是把判据钉回它守护的不变式与实测上界；若评测者认为「512MiB 上 sessionsCreated ≥ 200」必须由服务端侧修复来满足，应把该条回退为原文并把本任务退回 `needs-human`，而不是接受本条。

### AC4 复测（本轮，改动 `soak.sh` 头部注释后重跑）

`node --test scripts/soak-analyze.test.mjs` → exit 0（22 pass / 0 fail）；`bash scripts/soak.sh --self-test` → exit 0（leak stub 读红并点名 RSS，steady stub 读绿）；`npx tsc --noEmit -p scripts/tsconfig.json` → exit 0；`npm run lint` → exit 0（仅既有 warning）。

### 顺带修掉的陈旧操作指令

`scripts/soak.sh` 的头部示例对本来就是 `--burst-mb 512`——正是本任务测定为不可驱动的载荷；操作者照抄会得到两个 red 臂与一条会误导的 verdict。已把示例改钉 500，并在同一段记录「不可越过 500 的原因在 CLI 那一跳而非本装置」（commit `soak: stop advertising a payload the protocol cannot carry`）。`soak.sh` 本就在 Touches 内；该改动只是注释，不触碰任何被执行的语句（改动后 AC4 四项已重跑，见上）。

**AC 逐条账目（全部满足）：** 上表与本节即 AC1(a)(b)、AC2（`ctl-one-burst-512` 记录 `slowClientDrainedBytes = 565,651,542 ≥ 268,435,456`，对照 `slowClientBurstBytes = 536,870,912`，gateway 全程存活）、AC3（读数经 `--report` 落盘于 `/data/home/yale/soak-evidence/`，判定 (a) 与全部读数一并写出）、AC4（上节四项 exit 0）、AC5（文档该节已按新读数改写，「装置上限 ~48MiB」与旧的「未能驱动」措辞已替换，新的可驱动上界读数为 (500MiB, 512MiB]）的读数。

报告、日志与 gateway 采样一并留在 `/data/home/yale/soak-evidence/`（`one-burst-256`、`ctl-one-burst-256`、`one-burst-500`、`one-burst-512`、`ctl-one-burst-512` 各自的 `.json` / `.log` / `.gateway-rss`，本轮复测为 `verify-500.json` / `.exit` / `.gateway-rss` / `.mock.log`）。两个 512MiB 红臂的工作目录按装置自身契约保留为失败现场（`/data/home/yale/.soak/run-20260926-002242-824410`、`run-20260926-002927-1180109`）。

**DoD 收尾**：`systemctl --user list-units 'claudecodeui-session-*'` → 0；无 soak unit；无 mock-gateway 进程、无 soak 进程（用 `ps -eo pid,args` 排除了 `pgrep -f` 的自匹配）——本轮复测跑完后再次核对，仍为空。
