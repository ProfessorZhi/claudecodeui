---
id: gap-voice-capture-real-db-timing-attribution
title: AC-148 判据的 real-db-untouched 用「窗口内动过 + 空闲期不再动」作时序归因：外部写者（:3001
  生产服务）在窗口内写一次、随后静默超过剩余预算，判据就把它记在自己账上红掉（跨 9 天 11 次；strace 全程 0 次触碰真库）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-148
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何依赖边）：立案时 `grep -rho '^goal_ac: *AC-148' tasks/*.md` 命中两份，都是 `status: done` —— `gap-voice-capture-real-process`（写下这条判据）与 `gap-voice-capture-criterion-hardened-root`（把判据世界从部署方 `.env` 里摘出来）；按 standing-violated 的规矩它们不是重复，而是「早先那次出货没有守住」的证据。在飞（todo/ready/needs-human）任务里带 `goal_ac: AC-148` 的：零。`grep -rln 'real-db-untouched' tasks/` 只命中 `gap-voice-capture-real-process`（done）。本条与那两份机制都不同：`gap-voice-capture-criterion-hardened-root` 修的是 `EMPTY_READING`（exit 2，判据根本测不了「未设置」那一半）；本条修的是 exit 1 的**归因**红 —— 判据测得出，但把别人的写记在了自己账上。

**现状（本轮直接测量，可复验）**

判据载体：AC-148 记录的 `criterion` 行 = `node scripts/voice-capture-process-check.mjs`（36841 B，sha256 `d9a00149c035514b9b4cd97dca49719f29619e2e57a8a182b78b95f4cd5693db`；`git diff --stat develop...HEAD` 对该文件为空 ⇒ 下面所有读数就是在被裁定的那份产物上取的）。

| 读什么 | 读数 |
|---|---|
| 台账 | `.quay/gate-events.jsonl` 里 AC-148 共 2117 条：pass 2045 / fail 72；其中 **11 条**的 `check.failure` 是 `real-db-untouched is false`，跨 2026-09-25 → 2026-10-02（09-25×5、09-26×2、09-27×1、10-01×1、10-02×2），最近两条是 `2026-10-02T08:01:55Z`(goal-sweep) 与 `2026-10-02T08:11:08Z`(goal-cli) |
| 同一小时的绿 | 08:11:08Z 那次红之后的 4 次直接重跑（16:12–16:15 +08）全部 **exit 0**，且 `real-db-churn=external`、`real-db-untouched=true` —— 判据不是恒红，是相位相关 |
| 失败运行的空闲读数 | `real-db-idle-waited-ms` = 40055 / 39812 / 39810 / 39808 / 39813 / 40061 / 40070 / 40057（09-25..09-27，当时的全预算）与 36303 / 36057 / 35807（10-01/10-02，硬化副本改动把预算缩到 ~36 s）—— 每次都把剩余预算耗光仍未再见动 |
| **判据自己从不碰真库** | `strace -f -qq -e trace=openat,open,openat2,unlink,unlinkat,rename,renameat,renameat2 -o … node scripts/voice-capture-process-check.mjs` → 250064 行追踪里 `/data/home/yale/.cloudcli/auth.db` **0 命中**：判据进程与它派生的每一个子进程都没有 open/unlink/rename 过真库 |
| 真库的写者是谁 | `lsof /data/home/yale/.cloudcli/auth.db` → PID 3092737 `node dist-server/server/index.js`，`SERVER_PORT=3001`，cwd `/data/home/yale/work/claudecodeui`：本机的生产/会话宿主服务，与判据无关（记忆 never-restart-3001-from-inside-a-session-it-hosts） |
| 那个写者是突发的 | 不跑判据、纯空闲采 120 s：真库 mtime 动了 17 次，间隔最长 24 samples ≈ 29 s；写不写由 :3001 上的会话流量决定 |
| 失败形态有多容易命中 | 它要求「窗口内动过 **且** 之后的空闲窗一次都不动」——外部写者只要在窗口内写一次、然后静默 ≥ 剩余预算（~36 s），就精确命中 |

**根因：判据的归因是时序推断，而时序分不开「我的」和「别人的」。** `scripts/voice-capture-process-check.mjs:836` 的 `realDbUntouched = !movedDuringRun || movedWhileIdle` 只用了两个时间读数：窗口内动过没有（`:822`）、之后的空闲窗里动过没有（`:835`）。判据**自己**的泄漏形态（子进程若继承了部署方 `DATABASE_PATH`，服务只在它 ~5 s 的生命周期里写几下，随后被收掉）恰好也是「一阵写 + 之后静默」，与外部突发写者同形，所以空闲再久也证明不了归属。10-01/10-02 的三次红就是 :3001 在窗口内写了一次、随后恰好静默过了剩余预算。

**要交付的**：把这条读数从时序归因换成**归属**证据 —— 判据要能证明「跑判据的这棵树没有碰过真库」（例如在子进程存活期间读它与其后代的 fd 集合，或换成一条直接读数：跑完之后真库从未被这棵树打开过），只在有归属证据时才红。⛔ 不允许把这条读数删掉或放宽到永远为真 —— 它挡的泄漏（子进程拿到部署方的 `DATABASE_PATH`）是真的，见 AC2 的负控制。⛔ 判据仍不得改出货源码（`service-source-imports=0` 与 `note.shipped-source-changed=false` 保持），改动只落在 `scripts/` 的两个文件里。

## AC

- [x] AC1 `node --test scripts/voice-capture-process-check.false-forms.test.mjs` 新增一条腿**确定性**复现本缺陷：把判据的 `DATABASE_PATH` 指到一个受控临时库，另起一个辅助写者在该判据的运行窗口内写它一次、随后静默到空闲截止之后（复刻 08-01/08-11 的相位），断言判据 exit 0 且 AC-148 真正点名的读数逐条不变。**今天这条腿必须红**：在未修的本判据上跑，它给出 exit 1 且 `check.failure` 是 `real-db-untouched is false`。
- [x] AC2 负控制（不许靠删读数通过）：把 `scripts/voice-capture-process-check.mjs:356` 的 `childEnv.DATABASE_PATH = options.databasePath;` 去掉（子进程于是继承部署方的 `DATABASE_PATH`），AC1 的那条腿必须**非 0** 退出，且失败文本来自归属证据（点名是自己的子进程用了真库），不是时序推断。
- [x] AC3 `node scripts/voice-capture-process-check.mjs` 在 :3001（PID 3092737）活着并正在写真库的主机上连续 5 次 exit 0；每次读数里 `real-db` 指向该库、`real-db-untouched=true`、`service-source-imports=0`、`real-upstream-calls=0`。
- [x] AC4 判据点名的读数逐条不变：`startup.text.count=1`、`startup.text.line=voice.capture mode=text`、`capture.lines=1`、`upstream.exact=true`、`double.requests=1`、`double.path=/audio/transcriptions`、`http.status=200`、`unset.captureLines=0`、`unset.startup.line=voice.capture mode=off`、`unset.double.requests=1`、`check.failures=0`。
- [x] AC5 出货面零改动：`git diff --stat -- server/ src/ shared/` 为空。

## DoD

- **真对象操过**：在部署方那个真实检出上，:3001 生产服务正持有 `/data/home/yale/.cloudcli/auth.db` 的当下跑判据，exit 0；并且用一个并行 mtime 采样器证明这一次判据的运行窗口里真库**确实被外部写过至少一次**（判据自己的读数相应地不再是 `criterion-only`）—— 「外部写者活着并且真的写了」与「判据绿」同时成立，不是等它静默了才测。
- **反向也真**：把 AC2 的变异打进去，判据非 0，且失败原因来自归属证据。
- AC1/AC2 的两条腿在 scoped gate 的 test 通道里绿；AC3 的 5 次读数与 DoD 的采样时间线留在任务 Notes 里。
- 除 `scripts/voice-capture-process-check.mjs` 与 `scripts/voice-capture-process-check.false-forms.test.mjs` 外零改动（`git status --porcelain` 只剩 `tasks/gap-voice-capture-real-db-timing-attribution.md`）。

## Touches

- `scripts/voice-capture-process-check.mjs` （`:822`/`:835`/`:836` 的归因判定与 `main()` 里的空闲窗）
- `scripts/voice-capture-process-check.false-forms.test.mjs` （AC1 的腿与 AC2 的变异腿）
- `tasks/gap-voice-capture-real-db-timing-attribution.md` （自触）

## Notes

**实现。** `scripts/voice-capture-process-check.mjs`：`real-db-untouched` 从时序归因改为**归属**读数 —— 子进程存活期间读 `/proc/<pid>/fd`，只扫**本进程及其后代**；命中继承来的 `DATABASE_PATH`（或它的 `-wal`/`-shm`/`-journal`）才判 false，`:3001` 不在本进程树里故它的句柄看不见。新增读数 `real-db-opened-by-tree`、`real-db-openers`；`real-db-churn` 改为 `criterion-only`（有归属证据）/`external`（动过但无归属证据）/`none-observed`；`IDLE_PROOF_*` 空闲窗整体删除。运行窗读到「could not measure」但已有归属证据 → exit 1（属性已被测量并违反），无证据仍是 exit 2。`scripts/voice-capture-process-check.false-forms.test.mjs`：AC1 腿（受控真库 + 窗口内写一次后静默的外部写者 ⇒ exit 0）与 AC2 腿（删 `childEnv.DATABASE_PATH = options.databasePath;` ⇒ exit 1 且失败来自归属证据）。

**AC3 五次读数**（`DATABASE_PATH=/data/home/yale/.cloudcli/auth.db`，:3001 PID 3092737 持有该库，2026-10-02）：5/5 exit 0，每次 `real-db-untouched=true`、`real-db-opened-by-tree=false`、`service-source-imports=0`、`real-upstream-calls=0`、`check.failures=0`；`real-db-churn` 依次 = external(4094ms) / external(4140ms) / none-observed(3999ms) / external(4133ms) / none-observed(4026ms)。

**DoD 并行采样（第 1 次运行）。** 旁路采样器每 150ms 读一次真库 `mtimeMs`，14s 内观测到 5 个不同值：`t=0 → 1790930914062.3362`、`t=151 → 1790930918638.3198`、`t=2406 → 1790930920893.3115`、`t=8268 → 1790930926683.2908`、`t=8418 → 1790930926896.29`（t 为相对采样起点的 ms）。判据本次 `real-db-before-ms=1790930918638.3198`、`real-db-after-ms=1790930920893.3115` ⇒ 采样器独立证明真库在这次判据的运行窗口里确实被外部写过至少一次，同时判据 exit 0 —— 「外部写者活着并且真的写了」与「判据绿」同时成立，不是等它静默之后才测。**未修版本的复现（本轮直接测量）**：`DATABASE_PATH=/data/home/yale/.cloudcli/auth.db node scripts/voice-capture-process-check.mjs` → exit 1、`real-db-churn=criterion-only`、`real-db-untouched=false`、`real-db-idle-waited-ms=38308`。

**旁证测试基建修正（同一 Touches 文件内）**：`buildCopy` 的副本根改到检出的兄弟目录（本机 `/tmp` 在 `/dev/vda2`、检出在 `/dev/vdb`，`cp -al` 逐条 `Invalid cross-device link`，判据自己的 `HARDENED_ROOT_PREFIX` 已记为同一坑）；`readReadings` 的键正则放宽以读到大写键（`unset.captureLines` 等 AC-148 点名的读数此前读不到）。

**scoped gate 的形状（上游限制，登记）**：`scripts/test.sh` 的 `--for-task` 文件集过滤器是 `\.test\.[jt]sx?$`，**不匹配 `.mjs`**，故本条 scoped gate 读到 `no scoped test files for gap-voice-capture-real-db-timing-attribution (thin)`、exit 0 —— 这是本仓对 `scripts/**/*.test.mjs` 的既有性质，不是本条的改动（`test.sh` 不在本条 Touches，按规矩不动它）。两条腿的真实证据是直接跑 `node --test scripts/voice-capture-process-check.false-forms.test.mjs` = 5/5 绿；`.mjs` 的类型面由 `npx tsc --noEmit -p scripts/tsconfig.json`（exit 0）覆盖，fan-in 全量 suite 的 typecheck stage 会再跑一次。