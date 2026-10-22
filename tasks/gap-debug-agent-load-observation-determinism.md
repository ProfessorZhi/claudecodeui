---
id: gap-debug-agent-load-observation-determinism
title: AC-125 的装载观测由推断改为读数：观察者自身的就绪证据 + 确定性伪证臂（判据从偶发红转可靠绿）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-125
---
## Proposal

**交付物：`goals/AC-125` 的判据从「偶发红」变成「可靠绿」——把装载事件的观测（load step）从推断改成读数。**

判据逐字为 `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts`。

**现场读数（本仓，2026-09-25）。**

- 驱动自己的 gate 记录（`.quay/gate-events.jsonl`）里 AC-125 共 116 条 `goal` 事件、45 条 FAIL；其中 43 条是 2026-09-22 的**红先行**期（测试文件尚不存在，红因逐字是 `Could not find 'server/modules/debug-agent/tests/debug-agent-external-write.test.ts'`）。**文件落盘之后（2026-09-22T16:08 之后）72 次运行里红 2 次**，都在今天：`2026-09-25T08:29:34Z`、`2026-09-25T09:07:27Z`。
- 同一时刻驱动的 frozen recheck 把 AC-125 记为 `verdict=pass / outcome=cleared / cause=now-true`，连过 7 轮（round 96–102，各约 23.1s）。⇒ gate ledger 说 violated、recheck 说 cleared，两读并存——这正是偶发判据的指纹。
- 在 author 检出上直接跑同一命令 4 次：**红 1 次、绿 3 次**。

**红在哪里（本条任务的全部要点）。** 两次记录在案的失败与这次复现形状一致，且都**没有走到送达断言**：

- 父进程在 `requireReading`（`server/modules/debug-agent/tests/debug-agent-external-write.test.ts:688`，调用点 `:809`）抛 `external-write: the probe child printed no reading`；
- 子进程真正的红在 `armObservedFixture`（`:433`）：`the observer never logged an add for 3 armed fixture(s), so there is no load event to drain`，三次 attempt 全 `addObserved:false`（`LOAD_ATTEMPT_MS = POLL_INTERVAL_MS + 2000 = 8000`、`MAX_LOAD_ATTEMPTS = 3`，见 `:117-118`）。

也就是说判据的 (i) 排空、(ii) 新的 upsert、(iii) 正面控制、(iv) REST 重取**一条都没被评估**——红的是**装载事件本身没被观测到**。这与「外部写入没送达」是两件事：今天的红**不能**读成产品链路坏了，但**能**读成这条 AC 的 ledger tail 不可信。

**为什么早先的修复没有站住。** 认领本 AC 的 `tasks/gap-debug-agent-external-write-path.md`（`done`）与随后两笔只动同一文件的性能提交——`bd756211`「收掉最重文件的死等」、`a78b6db9`「短窗口试次并入臂内终态等待，收掉最重文件的叠死等」——改的都是这个文件的**时长**，不是它 load step 的**确定性**：

- 装载就绪靠 `waitForObserverWalk()`（`:360-378`）：它**另起一个探针 watcher**，把**探针的 `ready`** 当成「观察者的首次遍历已完成」的证据，理由只是一条排序论证（探针建得更晚、要走更多树，所以不可能先 ready）。产品侧没有可等的就绪信号，所以这是**推断**而不是读数。
- 就绪之后 `armObservedFixture` 的补试上限是 3 × 8s；文件自己的注释写明补试「stays the bound it is documented to be rather than the normal path」，即补试**不该是承重路径**。一旦探针的 `ready` 与观察者自己的遍历不一致（或轮询周期在负载下超过 8s），三次全 miss，判据在评估任何断言之前就红。
- 那两笔提交在 `waitForObserverWalk` / `armObservedFixture` 里一个字符都没改。⇒ **红一直在**，只是两次都盯着别的读数。

**诊断口径（实施者必须自己定，不要照抄本条）。** 本任务只证明「红在装载观测」，**根因归属未证**。要么是 harness 的就绪推断（探针 `ready` ≠ 观察者遍历完成；8s 窗口没绑在观察者自己的证据上），要么是产品侧（watcher 构造时根不存在 / 遍历窗口内落下的文件被 `ignoreInitial` 吞掉）。实施者必须用读数把这两条分开（例如打印：装载时 fixture 根是否已存在、观察者是否对**任何**文件报过事件、`ensureProviderWatchRoots()` 是否建了根），再决定改哪一侧。

**三条硬边界。**

1. **不许削弱判据**：(i) 排空静默 > 一个轮询周期、(ii) 写入后一条**新的** upsert、(iii) 观察者自己的 `change event for provider` 行、(iv) REST 重取含追加内容——四条与抗假 bypass 臂（它必须让 (ii)+(iii) 红、盲判据仍绿）**等强保留**。把「必须观测到 add」改成「等一会儿就算」是禁止的。
2. **不许拿 sleep 换确定性**：加固定 sleep 或单纯抬高窗口，只是把偶发红换成更长的偶发红。`bd756211` / `a78b6db9` 正是为**收掉**这个文件的死等而做的（见 `tasks/gap-cold-baseline-path-exceeds-gate-cap.md`、`tasks/gap-suite-criterion-wallclock-budget.md`），本任务不得把时长加回去。
3. **Touches 只许这两个文件**：`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 与本任务文件。若诊断落到**产品侧**，不要擅自扩围——先在任务体里登记读数并退回，由下一轮另立。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务。`tasks/gap-debug-agent-external-write-path.md` 认领本 AC 但状态是 **`done`**——按 `standing-violated` 的规则它是「早先修复没站住」的证据，不是重复。相邻而机制不同的是 `tasks/gap-session-watcher-native-or-adaptive-poll.md`（`needs-human`）：它改的是 watcher 的**机制选择与轮询退避**，并声明会同步本文件的轮询臂；本条改的是**装载观测的确定性**，两者不重复。它与本条只是 Touches 重叠，实施者按当前 `develop` 形状落改动并把改动限制在 load step 内即可减小后续合并冲突。

## Plan

1. **先把判定性测出来**：安静与受载两种条件下各跑判据若干次，逐次记录 `[load]` 行（`attempt` 与每条 `addObserved`）、装载时 fixture 根是否存在、观察者是否报过任何事件。把「红的条件」写成可复现读数，而不是「偶发」。
2. **把就绪从推断改成读数**：让 load step 等到**观察者自己的**证据（产品侧已暴露就绪就等它；否则用观察者对该根下某个文件的**自己的日志行**作证据），并把装载尝试的窗口绑在**超过一个轮询周期**的观察者证据上，而不是一个 8s 的猜测。
3. **加一条确定性伪证臂**：把今天红的那个条件显式构造出来（就绪证据不成立时装载，或遍历完成前装载），让判据在**未修**的形态下必红、修后必绿，并把两读打印出来。
4. **复核等强与时长**：逐条核对 (i)–(iv) 与 bypass 臂；并对比本任务前后的 `duration_ms`。

## AC

- [x] AC1 判据本身绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 退出码 0、输出含 `fail 0`，且打印的 `[load]` 行给出**逐次 attempt 的 addObserved**。失败时把 `[load]`、`[criterion]`、`[control (iii)]` 三行原样打印。
- [x] AC2 就绪是读数不是推断：同一次运行的输出里存在以 `[readiness]` 开头的一行，说明就绪证据来自**观察者自身**（不是第二个 watcher 的 `ready`）并给出该证据的实测值；该行数 ≥ 1。失败时打印实际存在的全部 `[` 前缀行。
- [x] AC3 确定性伪证臂真跑并留两读：把今天红的条件显式构造出来时判据必须红、且红因逐字是「装载事件未被观测到」（never logged an add）而**不是**送达断言；还原后 AC1 绿。两段输出都贴进 Evidence，`git status` 干净。
- [x] AC4 等强未削弱：AC1 命令的输出里四项读数齐备且都成立——(i) 排空静默 > 6000ms。(ii) 写入后新 upsert 数 ≥ 1。(iii) 该文件的 change 行数在写入后 > 0。(iv) REST 重取含追加内容。同一次运行里抗假 bypass 臂仍绿（它自己 (ii)+(iii) 红）。缺项时逐条打印实际值。读数为 `[drain (i)]`、`[delivery (ii)]`、`[control (iii)]`、`[history (iv)]` 四行。
- [x] AC5 时长不增：AC1 命令的 duration_ms 不高于基线（现场单跑 ~25.6s、驱动 gate ~23.1s）；把前后两读并列打印。若确有增加，必须说明为何必要，且不得使该文件逼近 60s（goal 判据闸是 60s 硬超时，不可抬）。
- [x] AC6 未触及 Touches 之外的文件：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都能对应到 Touches 里的一条；命中之外时逐行打印并以非 0 退出。
- [x] AC7 `npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：**这条 AC 的 ledger tail 从「说 violated」变成「稳定说 pass」**，而不是「这一次碰巧绿」。承重性由三件事正面证明：

(a) **就绪有读数**（AC2）——就绪证据来自观察者自身，能指着它说「观察者已完成首次遍历」，而不是指着第二个 watcher 的 ready 推断；
(b) **确定性伪证臂真跑过**（AC3）——把今天红的条件显式构造出来时必红，证明修的是一个**可达的**原因，而不是把偶发当运气；
(c) **等强与时长都被核对**（AC4/AC5）——没有把断言削成「等一会儿就算」，也没有把死等加回来。

另需如实登记：**连续跑若干次（建议 ≥5 次）的 `[load]` 逐次读数**（AC1 命令，安静条件），证明补试路径不承重；以及**受载条件下**的读数（本条 AC 的现场红正是在 load1 ≈ 18 时复现的）。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制里「装载观测」这一环的确定性，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的 `[load]`/`[readiness]` 读数与 AC3 的两读承担。
L_G 本目标的判据是 `goals/AC-125`（外部写入经真实文件观察者送达客户端，判据自带排空与正面控制），本任务的 AC1/AC4 即该判据的命令与它的四项读数；AC3 是它的抗假与确定性对照。

## Touches

- server/modules/debug-agent/tests/debug-agent-external-write.test.ts
- tasks/gap-debug-agent-load-observation-determinism.md


## Evidence

**诊断口径：读数把「harness 侧」与「产品侧」分开了。** 本任务实测两条：

1. 观察者**会**宣告走查之后落下的文件——两个机制都如此（开发期 v2 形态实测：装载夹具在 `initializeSessionsWatcher()` 返回后 ~0.5s 落盘时被吞掉，`#1 addObserved=false`、waited ≈6528/6532ms；同一夹具晚一个窗口再落，则轮询机制 5481ms、native 15ms 被 `add` 宣告。v2 形态已被本次实现取代，此处只作诊断读数登记）。
2. 它**不会**宣告走查已经读过的目录里的文件——`ignoreInitial` 的抑制是**永久性**的：文件被登记为初始状态，它的 `add` 永不再来。

⇒ 归属落在 **harness 侧的就绪推断**：`waitForObserverWalk()` 用第二个 watcher 的 `ready` 推断「观察者已完成首次遍历」，那段 1.5s 的推断期正好落在走查窗口内，装载夹具是赌走查是否已经过了那个目录；产品侧的 `ignoreInitial` 语义是确定的，不缺能力。故不扩围、不退回，改动全部落在本判据文件内。

本次实现给出的是这条**同源读数**（就在标准输出里）：轮询机制的就绪握手需要 **12 次**追加（6006–6009ms / 500ms）才能拿到观察者的一行——前面那 11 次落在走查读该文件之前，观察者无从作答；native 机制只需 **2 次**（511ms）。这个次数本身就是「走查窗口有多长」的读数，而它现在由观察者自己的行来收尾，而不是由一个猜出来的等待。

**AC1** 命令逐字：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts`。退出码 0、`ℹ fail 0`，连跑 6 次（含一次刻意加重负载）均如此。轮询臂 `[load]` 行（第 1 次）：

```
[load] observer's own `add` line observed on attempt 1 of 1; per attempt: #1 addObserved=true window=6500ms waited=5983ms
```

同一次运行另外两臂：native `#1 addObserved=true window=6500ms waited=15ms`；bypass `#1 addObserved=true window=6500ms waited=5985ms`。`fail 0` 覆盖四条臂（轮询、native、抗假、伪证）。第 3 行形状与字段名（`addObserved` 逐次）保持未变。

**AC2** 每次运行、每条臂各一行 `[readiness]`（6 次 × 3 臂 = 18 行，≥1）。逐字（第 1 次轮询臂，中段以 … 略）：

```
[readiness] evidence=observer-own, second watcher used: none — the observer's own `change` line for the sentinel bf998a47-…jsonl, a file armed BEFORE the observer existed. … Measured 6008ms from the handshake's first poke to that line, over 12 append(s) at 500ms apart (bound: 13000ms = two polling periods of the observer's own clock)
```

实测值：轮询机制 6006–6009ms（12 次 poke），native 机制 511ms（2 次 poke）。该行的证据来自**观察者自身**：哨兵在观察者构造**之前**落盘，走查因此把它登记为初始状态、`add` 被 `ignoreInitial` 永久抑制，观察者唯一能对它说的一句话就是 `change`；而只有握有该文件基线的观察者才可能说这句话，建立基线的唯一途径就是走查读过它所在的目录。断言同时钉住 `secondWatcher === 'none'`、`eventType === 'change'`（`add` 会意味着走查当时还没登记它，正是本任务要移除的赌注）、`transcriptPath !== fixture.transcriptPath`（哨兵不是装载夹具）。

**AC3** 两读：

(a) 伪证臂（把观察者在装载步之前移出循环），用该臂自己的环境直接跑，退出码 1，红因逐字：

```
Error: the observer never logged an `add` for 3 armed fixture(s), so there is no load event to drain: [{"attempt":1,…"addObserved":false,"windowMs":6500,"waitedMs":6530},{"attempt":2,…"addObserved":false,"windowMs":6500,"waitedMs":6525},{"attempt":3,…}]
```

红因里没有 `(ii)`/`(iii)`、没有 readiness 字样——它是装载步自己的因，不是送达断言，也不是就绪握手的。该臂构造的正是记录在案那次红的条件（观察者不在环内时装载），因此它证明修的是一个**可达**的原因，而不是「这一次碰巧绿」。

(b) 还原（观察者在环内）后同一份代码绿：`[criterion] failures=[]`、`ℹ fail 0`（见 AC1；同一次运行里这条腿也由判据测试自身断言）。

**AC4** 同一次运行（第 1 次）四行读数：

```
[drain (i)] 2 upsert(s) observed; silence 6560ms (> one polling period 6000ms); settled after 7014ms
[delivery (ii)] 1 new upsert(s) in a 8000ms window; first at +5443ms
[control (iii)] add=1 change=1 (after the write: 1)
[history (iv)] 5 message(s), total 5; appended content present: true; seed present: true
```

抗假臂在同一次运行里 `[criterion] failures=["(ii) no NEW upsert arrived after the external write (0 in a 8000ms window)","(iii) the observer logged no `change` event for this transcript after the write (0 change line(s) for this file in total), so the upsert cannot be attributed to it"]`，而同一臂的 `[blind criterion] failures=[]`（satisfied by an upsert that predates the write: true）——(ii)+(iii) 红、盲判据绿，与前置等强。

**AC5** 前后并列（同一主机、同一命令，逐次 `ℹ duration_ms`）：

| 树 | 逐次 duration_ms | 均值 |
| --- | --- | --- |
| develop 版（前置基线；主检出该文件与 `git show develop:server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 逐字节相同，sha1 1ded716b） | 22998.57 / 22450.83 / 22422.07 / 22460.31 / 22447.14 | 22956 |
| 本任务版 | 28476.07 / 28504.66 / 28392.59 / 28489.70 / 28551.05 / 28619.23 | 28506 |

⇒ **确有增加：+5.55s（+24%）**。**为何必要**：就绪必须是**读数**（硬边界 1 + Plan 第 2 步把「等一会儿就算」定为禁止），而一个轮询观察者能给出的任何读数都只能落在它自己的轮询边界上，即**一个轮询周期 6000ms**——前置基线的 1.5s 之所以便宜，正因为它不是读数而是推断，而那个推断正是本任务要移除的东西。装载尝试窗口（6500ms = 观察者自己的 6000ms 轮询 + 500ms 去抖）与补试上限（3 次）**一分未加**，也没有把死等加回来（硬边界 2）；28.5s 距该判据的 60s 硬闸尚远，未逼近。

**AC6** `git diff --name-only "$(git merge-base develop HEAD)"` 逐行输出：

```
server/modules/debug-agent/tests/debug-agent-external-write.test.ts
```

一行，对应 Touches 第一条（本任务文件自身由 `task_write` 落在 develop 上，因此通常不在这条 diff 里；若出现，它同样是 Touches 的第二条）。之外无命中。

**AC7** `npm run typecheck` 退出码 0；`npm run lint` 退出码 0（`debug-agent` 相关 0 条）。

### DoD：(a)(b)(c) 与逐次读数

**(a) 就绪有读数。** 见 AC2：证据是观察者自己的 `change` 行，指着它可以说「观察者已完成首次遍历」——哨兵在观察者构造之前落盘，走查因此把它当初始状态，`add` 被 `ignoreInitial` 永久抑制，唯一能说的一句话就是 `change`；而只有握有该文件基线的观察者才可能说这句话。装载夹具紧接着落进**同一个目录**，于是第一次尝试就被宣告（6/6 次 attempt 1 of 1，`addObserved=true`）——补试路径不承重。

**(b) 伪证臂真跑过。** 见 AC3 (a)：红因逐字是装载步自己的因（`never logged an add` + 三次 `"addObserved":false` 的逐次读数），不含送达断言与就绪字样。

**(c) 等强与时长都被核对。** 见 AC4（四条读数齐备、抗假臂仍红 (ii)+(iii) 而盲判据仍绿）与 AC5（前后两读并列、增加的理由与 60s 距离）。

**≥5 次连续读数（AC1 命令）**：

| # | load1 | `[readiness]` 实测 | 装载 attempt | waitedMs | fail | duration_ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 17.41 | 6008ms | 1 of 1 | 5983 | 0 | 28476.07 |
| 2 | 22.04 | 6008ms | 1 of 1 | 5982 | 0 | 28504.66 |
| 3 | 19.59 | 6006ms | 1 of 1 | 5981 | 0 | 28392.59 |
| 4 | 19.75 | 6009ms | 1 of 1 | 5989 | 0 | 28489.70 |
| 5 | 26.89 | 6008ms | 1 of 1 | 5984 | 0 | 28551.05 |
| 6（另加 16 个 CPU spinner） | 24.85→27.06 | 6009ms | 1 of 1 | 5985 | 0 | 28619.23 |

**如实登记两处偏差。**

1. DoD 要的是「安静条件」下的读数，但本机在测量窗口内的 load1 已经是 17–27（同一窗口里 develop 版基线也同样跑出 22.42–22.50s），安静条件在本机拿不到；第 6 次是刻意加重（16 个 spinner）的受载读数。**受载条件下**（load1 24.85→27.06）装载仍在 attempt 1 of 1 被宣告、`fail 0`。
2. AC 现场那次红（load1 ≈ 18）在本机**未能复现**：develop 版（与 develop blob 逐字节相同）今天连跑 5 次全绿（22.42–22.50s，装载均 attempt 1 of 1）。所以本任务的伪证臂是**构造**那个条件而不是等它出现；红在装载步的机制读数为上面第 1 条的 v2 形态实测，以及握手在轮询机制下需要 12 次追加才拿到一行（走查窗口的直接读数）。

## 完成记录

- **改了什么。** 只改 `server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 的装载步：删掉 `waitForObserverWalk()`（第二个 watcher 的 `ready`）与 `chokidar` 依赖，新增 `awaitObserverReadiness()`——哨兵夹具在观察者构造前落盘，握手每 500ms 向它追加一行，直到观察者自己为它记一行；拿到该行（就绪读数）之后才把装载夹具落进同一个目录。`armObservedFixture()` 保留其补试与部分重叠尝试（上限仍 3 次，窗口仍是观察者自己的 6000+500ms），并新增 AC3 的伪证臂与它的判据测试。
- **未改（等强）。** (i)–(iv) 四条与抗假 bypass 臂一字未动；`[drain (i)]`/`[delivery (ii)]`/`[control (iii)]`/`[history (iv)]` 四行与 `[load]` 行的字段名保持；补试上限与窗口宽度未加；未新增任何固定 sleep。
- **Touches。** 只动了列出的两个文件（AC6 一行）。
- **L_D 该轴仍暗，理由**：本任务交付的是调试/测试机制里「装载观测」这一环的确定性，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的 `[load]`/`[readiness]` 读数与 AC3 的两读承担。
- **L_G** 本目标的判据是 `goals/AC-125`（外部写入经真实文件观察者送达客户端，判据自带排空与正面控制），本任务的 AC1/AC4 即该判据的命令与它的四项读数；AC3 是它的抗假与确定性对照。




### 续跑轮（suite-red 归因，2026-09-25 18:5x）

**本轮未改任何代码。** 分支相对 develop 的 delta 仍是 Touches 第一条那一个文件；`task_check` 读回 `acTotal=7 acChecked=7 ok=true`。上轮 fan-in 的 suite 红落在 `server/modules/voice/tests/voice-capture-text.false-forms.test.ts`——与本任务 delta 无关，归因读数如下。

- **不在 Touches，且与 develop 逐字节相同**：`git rev-parse HEAD:<f>` = `git rev-parse develop:<f>` = `fb86bfac8e95472eef3071fbf77a0f1f9806f977`。本任务唯一的 delta 文件（`debug-agent-external-write.test.ts`）在同一次 suite 里 `passed=true duration_ms=29435`。
- **单跑绿**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-text.false-forms.test.ts` → exit 0、`pass 6`、`fail 0`、`duration_ms=25338`。
- **舰队级而非本任务**：`.quay/` 的 19 份 `fan-in-suite-*.log` 里该文件红 12 次，横跨 6 个任务（`gap-transcript-follow-ac110-case-nav-skips-boot-guard`、`gap-session-filter-criterion-bounded-boot-guard`、`gap-session-hosts-default-wrap-four-providers`、`gap-claude-session-cgroup-scope`、`gap-voice-error-notice-browser-e2e`、本条）。17:59 起连续 7 次 fan-in 全红（该窗口内 18:14 有三个 fan-in 同时在跑）。
- **机制（自读源文件，非转述）**：AC11（`:444`）在**模块加载时**抓全树 `git status --porcelain` 存为 `PRE_RUN_PORCELAIN`（`:88`），跑结束再抓一次（`:445`）比 `porcelain === PRE_RUN_PORCELAIN`（`:451`），断言 `unchanged === true`（`:468`）。`gitStatusPorcelain()` 是**全工作树**读（`:73`、`cwd: REPO_ROOT`），而 `server/modules/voice/` 是**跨进程共享**目录：兄弟判据在跑期建删 `__criterion-falsify-*` 临时副本，只要落在两次读之间，`unchanged` 即为 false。独跑时无兄弟进程 ⇒ 绿（实测 `git.status-clean=true unchanged=true temp-copies=none`）；并发时红。
- **suite 日志引的那行不是红因**：`not ok - ... falsify/failure-row-dropped ... predicted=[failRow=0] red=4` 是**通过**的读数行（单跑同样打印 `red=4` 而该 case `✔` 且整文件 `pass 6`），被 `first_error()` 误取；真正的红是 AC11 的 `this run changed the worktree git status`。
- **不扩围**：该文件不在 Touches（硬边界 3），且其认领任务 `gap-voice-capture-text-payload` 已是 `done`，`tasks/` 内无在飞任务认领此竞态。读数登记于此，由下一轮/管理者另立。

**本轮 2b**：`git merge develop` → `Already up to date`（`develop == HEAD^2 == 46454a07`），无 UU；scoped 门 `bash scripts/test.sh --for-task gap-debug-agent-load-observation-determinism --allow-thin` → exit 0、`passed=true`、`fail 0`、`duration_ms=29096`、`suite-scope-check: PASS`；scoped-gate 缓存已写（key `46454a0718967c04456be1667b2e6dc9caf25324`）。