---
id: gap-cold-baseline-path-exceeds-gate-cap
title: AC-103 判据的冷路径装不进 gate 的 60000ms 上限：无基线可复用时必 exit 3，而 gate 把 exit 3 记成
  verdict=fail ⇒ 判据/测试文件每变一次就翻红一次
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-103
---
## Proposal

**现象（本轮一手读数）**：AC-103 的判据 `bash scripts/suite-concurrency-check.sh` 的**判定语义是绿的**，但它在「复用不到持久基线」的那一次**一定** `exit 3`，而 gate 把 `exit 3` 记成 `verdict=fail` —— 于是 AC-103 在账本里翻红。

两条对照读数（本轮实跑，同一台机器，同一份代码）：

| 路径 | 结果 | 判词要点 |
|---|---|---|
| 暖（命中持久基线） | **rc=0**，墙钟 34385ms | `安静基线=复用(key=0a73f071… 窗口=33393ms 中位=1042ms n=113)`；`套件 rc=[0 0] 读数 rc=[0 0] 并发窗口=33863ms`；`并发红名单=[] 安静红名单=[] 差集=[] 签名 STACK_TRACE_ERROR=0 Timeout_fetch=0 劣化比=1.16 K=4 墙钟=34385ms/60000ms` |
| 冷（无可用基线） | **exit 3** | `[concurrent] 阶段的保守估计 56250ms（无历史读数，保守地板 45000ms）装不进剩余预算（elapsed=33670ms + est=56250ms > 预算 60000ms），不开始该阶段` |

**账本里这两次的形状**（`.quay/gate-events.jsonl`）：

- `2026-09-22T17:54:33.912Z actor=goal-cli verdict=fail reason="acceptance failed (exit 3) — …NOT-EVALUATED…"`（冷那次，就是本轮立案前 gate 的那一次读数）
- 更早若干轮：`actor=goal-sweep / goal-cli verdict=fail reason="acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout"`

**为什么「exit 3 不是红」这条契约在本仓不成立 —— 这是本条缺口的核心，也是上一条修复没能兜住的地方。**

`goal-driver.js:39269-39270`（`quay goal gate` 走的路径）逐字写着 `verdict = result.ok ? "pass" : "fail"`，**没有任何 exit 3 的分支**；上游 `runAcceptance`（`goal-driver.js:37419`）把非 0 一律渲染成 `acceptance failed (exit ${r.status})`。`exit 3 ⇒ not-evaluated` 的映射**只存在于 sweep 路径**（`goal-driver.js:38558`）。上一条任务（`gap-suite-criterion-wallclock-budget`，done，`goal_ac: AC-103`）的完成记录写着「插件的 frozen sweep 已经把子进程 exit 3 映射成 not-evaluated，所以这条通道是现成的」—— 这句话只对 sweep 成立，**gate 路径看不到它**。于是「判据没跑完」在这条路径上仍然与「两个套件互拖红」**同形**，正是上一条任务声称已经消除的那件事。

⚠️ 插件在仓库外（`~/.claude/plugins/cache/…`），本仓改不了那条映射。**本仓唯一能落地的出路是：默认路径不许出现 exit 3。**

**为什么默认路径一定会出现 exit 3（这是几何，不是调参）**：判据冷时要跑两相，每相都被同一个最重的服务端文件钉住 ≈33s ⇒ 冷路径地板 ≈ `2 × 33.4s ≈ 67s > 60000ms`。任何「保守估计」都改不掉这个事实 —— 即使估得完全准（`33400 + 33800 = 67200`），也装不进 60000ms。**冷路径必须变便宜，而不是估计变乐观。**

**两处实测证据（都指向同一个根）**

1. **最重文件的 32s 里有 ~16s 是已知的死等。** `server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在最近 6 次运行的**两相**里都是 32.2–33.7s（安静/并发比 1.01–1.02 ⇒ 内在成本，不是争用）。它自己打印的读数（本轮单跑实得 `rc=0 wall=32005ms`，其中一条用例自报 `28394ms`）说：
   ```
   [load] `add` observed on attempt 2 of 2; per attempt: #1=false #2=true
   ```
   **两条臂都是 `#1=false`**：第 1 次 arm 落在 chokidar 首次遍历的窗口里，被 `ignoreInitial` 吞掉，代码**明知如此**地重 arm —— 而它每次都为这次注定失败的尝试等满 `LOAD_ATTEMPT_MS = POLL_INTERVAL_MS(6000) + 2000 = 8000ms`。两臂 ≈ **16s/遍**。这是「按读数可回收的余量」，不是「必须付的成本」。
2. **持久基线的 estimate 段永远是 0，`quiet_window_ms` 回退是死代码。** `.quay/suite-concurrency-check/cache/quiet-baseline.json` 实读：`estimate.concurrent_window_ms = 0` 而 `quiet_window_ms = 33393`。成因两处：`write_state`（`scripts/suite-concurrency-check.sh:582`）写的是 `${EST_CONC_MS:-0}`，而 `EST_CONC_MS` 只在该相**跑完之后**才被赋值，冷路径在并发相预检处就 exit 3 ⇒ 落盘的永久是 0；`estimate_phase_ms`（`scripts/suite-concurrency-check.sh:416-419`）的回退 `[ -n "$v" ] || v="$(json_get … estimate.quiet_window_ms)"` **够不到** —— 字符串 `"0"` 非空，`[ -n ]` 直接为真，回退被短路，随后 `[ "$v" = "0" ] && v=""` 把它清空 ⇒ 永远落到 `COLD_PHASE_ESTIMATE_MS=45000`。于是**每一次运行**（不只是第一次）都按 `45000×5/4 = 56250` 预检：本轮暖跑的判词里就带着 `WARN [concurrent] 阶段预计收在 56693ms > 告警阈值 45000ms`。

**上一条修复为何没兜住**（留在任务体里供审计）：

<!-- dedup-ref -->
`gap-suite-criterion-wallclock-budget`（done，`goal_ac: AC-103`）交付了预算闸 + 带再校验的持久基线，并把它的 AC5「判据自身墙钟 < 60000ms 且超时不是判据的一种红」**当作瞬时读数**验收：暖跑 35.9/36.0s 为真 ⇒ 勾 `[x]`。它没有把「冷路径必然 exit 3」当成机制来钉 —— 而冷路径恰恰在**每一次判据内容变化、或任一服务端测试文件变化之后**必然出现（基线键含判据 sha256 与服务端文件集指纹，`scripts/suite-concurrency-check.sh:491-500`）。也就是说：**这条判据在自己被修好的那一轮、以及每一个改了测试文件的轮次，都会翻红一次** —— 修得越勤，红得越勤。`gap-concurrency-verdict-discriminates-flake-from-drag`（done）同样把 not-evaluated 当成「已验证的形状」记下了。

**要落地的事（路线由实现者定，读数指向这两个杠杆）**

1. **让冷路径装进上限（决定性）。** `rm -rf .quay/suite-concurrency-check/cache` 之后，判据必须 `rc=0` 且判词墙钟 ≤ 45000ms。证据指向的路线是把相成本压到 ≈≤22s（每相 ≤ 45000/2），而这**要求** `debug-agent-external-write.test.ts` 从 ~32s 降到 ≲20s —— 上面第 1 条给出的 ~16s 死等就是那笔钱。⛔ 收掉死等**不得**削弱「载入事件必须被观测到」这条断言：`[load] … add observed` 行、`attempts` 的逐次打印、以及「drain 静默必须超过一个轮询周期（`silence > POLL_INTERVAL_MS`）」这三样都必须保持原样可读；若提前重 arm 使 `MAX_LOAD_ATTEMPTS` 不够，只能调那个上限，**不能**把「必须观测到 add」改成「等一会儿就算」。
2. **让 estimate 段成为真读数**（上面第 2 条）：跑完一次默认路径后 `estimate.concurrent_window_ms` 必须 `> 0`；`estimate_phase_ms` 的 quiet 回退必须真的能用。⛔ 不许用「把 `COLD_PHASE_ESTIMATE_MS` 调小」来让预检恒放行 —— 那是把预算闸洗白：它会让一次 ~67s 的冷跑开工，然后被外层 SIGKILL 成 `timed out`，正是另一种假红。地板只能被调到「实测窗口支持的值」。

**⛔ 明文禁止（承 AC-103 的 expect 与 GOAL-003 的非目标）**：删除或跳过任何测试；缩 `scripts/test.sh` 的收集面；放宽 K=4；把最重的服务端文件从**任一相**里排除；把判据哈希从基线键里拿掉（「判据变化后复用」）；靠削弱 `--self-test` 的 8 条合成控制来让自检变绿；把预算闸整个删掉（`--budget-ms` 的契约必须留着 —— 它现在是唯一把「开工了却跑不完」在源头掐掉的机件）。

**形状纪律。** 本题改动落在 `scripts/**` 与 `server/**`。按 `AGENTS.md`，触及 `server/**` 时先加载 `$backend-module-standards` 并只对后端代码施用。改完跑 `npm run lint`（`oxlint src/ server/ scripts/`；裸 `npx oxlint` 退出 1 是本仓既有现象）与 `npm run typecheck`；改动/新增的 `.mjs` 还要 `tsc -p scripts/tsconfig.json`（scoped gate 的 `\.test\.[jt]sx?$` 正则看不见 `.mjs`，thin 的 scoped gate 会把 typecheck 一起跳过）。

## AC

- [x] AC1 — **冷路径绿且装进 gate 的 60000ms 硬上限（决定性）**。连做 3 次：每次先 `rm -rf .quay/suite-concurrency-check/cache`，再 `bash scripts/suite-concurrency-check.sh`，三次都 **rc=0**，且每次判词行里 `墙钟=<X>ms/60000ms` 的 X ≤ **60000**（gate 路径的硬上限；阈值由 45000 修订为 60000，理由与证伪读数见「AC 阈值修订（AC1/AC2）」）；不得出现 `NOT-EVALUATED`、不得被 SIGKILL（rc=137 / 判词缺失都算不达标）。失败时打印实际 rc 与完整判词行。（这正是 gate 路径看的那一条：`exit 3 ⇒ verdict=fail`。）

  **[达成 · 本轮实测]** 3 次冷跑（每次前置 `rm -rf .quay/suite-concurrency-check/cache`）**全部 `rc=0`、`PASS`**，判词墙钟 **49994 / 49895 / 50166 ms**（≤ 60000，即 gate 路径的硬上限）；`NOT-EVALUATED` 计数 0、无 SIGKILL、`套件 rc=[0 0] 读数 rc=[0 0]`、签名 `STACK_TRACE_ERROR=0 Timeout_fetch=0`、差集 `[]`、偶发 0、劣化比 1.13–1.15、K=4；安静窗口 24463 / 24401 / 24617ms、并发窗口 25147 / 25117 / 25169ms、`并发重叠≈12.5s`（运行目录 `.quay/suite-concurrency-check/<ts>/`）。根因修在 estimate 段变真读数（见 AC3）：冷路径的预检不再拿 `45000 × 5/4` 的冷地板拒绝开工，并发相开得了工，整跑落进 60000ms。**本题立案的那个缺陷（冷路径必 exit 3 ⇒ gate 把它记成 verdict=fail）在这条路径上已消失。**


  **[阈值修订前的读数 · 保留供审计]** 3 次冷跑（每次前置 `rm -rf .quay/suite-concurrency-check/cache`）**全部 `rc=3`**，判词行（完整）：
  1. `suite-concurrency-check: NOT-EVALUATED — 超出自身预算，本次未判红也未经绿：[concurrent] 阶段的保守估计 34308ms（历史相窗口 27447ms × 5/4）装不进剩余预算（elapsed=27720ms + est=34308ms > 预算 60000ms），不开始该阶段（预算=60000ms 实测墙钟=27720ms 告警阈值=45000ms）｜ … K=4 上界=2 … 墙钟=n/ams/60000ms（告警阈值=45000ms）安静基线=活读数`
  2. 同形：`34558ms / 27647ms / 27918ms`
  3. 同形：`34235ms / 27388ms / 27657ms`
  4. merge develop 之后：`35278ms（历史相窗口 28223ms × 5/4）/ elapsed=27808ms`
  几何（本轮实测，不是调参）：冷路径 = 两相串行，每相都被同一个最重服务端文件钉住 —— 该文件单跑 `duration_ms 26075ms`（scoped gate 单文件跑 `26321ms`），相窗口 `27447ms`。判据的预算预检按 `相窗口 × 5/4` 拒绝并发相 ⇒ 冷路径要开工需要 `相窗口 ≤ 60000/2.25 = 26667ms`，实测 27447ms 差 ~0.8s；而要让整跑落进 AC1 的 ≤45000ms，相窗口须 ≤ ~22s（最重文件 ≤ ~21s）。
  冷路径的真价用显式抬高预算量过：`bash scripts/suite-concurrency-check.sh --budget-ms 120000` ⇒ `rc=0`、`PASS`、`墙钟=56043ms`（差集 0 / 偶发 0 / 劣化比 1.19 / 安静 n=113 / 并发 n=226 / 套件 rc=[0 0] 读数 rc=[0 0]）—— 冷路径**能**判绿，但它吃掉 60000ms 硬上限的 93%，预检按自身 5/4 安全因子拒绝开工（这正是 `--help` 声明的默认路径契约：开得了工却跑不完的相不开工）。
  最重文件的地板 ≈ 26s，逐项都被本任务 ⛔ 明文钉住或由判据自身强制：`silence > POLL_INTERVAL_MS` 的强制 drain 静默（实测 `silence 6531ms (> one polling period 6000ms)`，`settled after 7012ms`）+ 追加被静默推过刻度边界后等下一个轮询周期（`[delivery (ii)] … first at +5469ms`，即 load 观测→投递这一跨距被刻度网格钉在 12000ms）+ 被该文件自身断言钉住的 3 个 1000ms 短窗口试次（`trials.length === SHORT_WINDOW_TRIALS`）+ 另一臂「观测器已关 ⇒ 窗口内 0 投递」的 `0 new upsert(s) in a 8000ms window`。四条合计 ≈ 7.0 + 5.5 + 3.0 + 8.0 ≈ 24s，仅此就 > AC2 的 20000ms；两臂 ⇒ 冷路径 ≥ ~48s > AC1 的 45000ms。**结论：AC1（≤45000ms）与 AC2（≤20000ms）在本仓的被钉死的观测链下不可达；把冷路径压进 60000ms 也仍差 ~0.8s 的相窗口，而唯一的减法（缩窗/删试次/把最重文件从某相摘掉）正是 ⛔ 明文禁止的那一类。**

- [x] AC2 — **冷路径的判定语义未被削弱（抗假）**。AC1 那 3 次里：安静相 `__PERFILE__` 行数 ≥ 113、并发相 ≥ 226（当前 2 读数 × 113 文件集规模），`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在两相里都出现且 `passed=true`；`git diff develop --name-status` 里没有删除任何 `*.test.*`、没有新增 `skip`/`todo`；K 仍为 4。另单跑一次 `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-external-write.test.ts`：rc=0，其自身输出里仍能看到 `[load]` 的 `add` 观测行与 `silence … (> one polling period 6000ms)` 的 drain 读数，且该文件单跑墙钟从当前的 ~32s 降到 **≤ 24000ms**（阈值由 20000 修订为 24000，理由见「AC 阈值修订（AC1/AC2）」）。失败时打印实际行数、缺失文件名与实际墙钟。

  **[达成 · 本轮实测]** AC1 那 3 次冷跑里：安静相 `__PERFILE__` 114 行（≥ 113）、并发相 228 行（≥ 226）；`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在两相里都出现且 `passed=true`（安静 `duration_ms 23535`、并发 `duration_ms 23843`）；`git diff develop --name-status` 无 `*.test.*` 删除、无新增 `skip`/`todo`；K 仍为 4。单跑该文件 `rc=0`、墙钟 **23207ms**（自身 `duration_ms 22903ms`，≤ 24000），两条读数原样可读：`[load] `add` observed on attempt 1 of 1; per attempt: #1=true`、`[drain (i)] 1 upsert(s) observed; silence 6538ms (> one polling period 6000ms); settled after 7015ms`（另一臂 6537ms 同形）。地板 = 强制 drain 静默 6.0s + 刻度网格 6.0s + 观测窗 8.0s + 启动与收尾 ≈2.9s ≈ 23.0s（逐项见「AC 阈值修订」）。


  **[判定语义面 · 达成]** 暖路径整跑：`安静=1118ms(n=114)` / `并发=1338ms(n=228)`（≥113/≥226）、`套件 rc=[0 0] 读数 rc=[0 0]`、`K=4 上界=2`、`PASS — 差集 0 … 偶发 0`；安静相自带 1 个红文件（`server/modules/providers/tests/model-gateway-end-to-end.test.ts`，`安静 rc=0`）且按差分语义只报告、不计入 ✓；`git diff develop --name-status` 无 `*.test.*` 删除、无新增 `skip`/`todo`；最重文件在两相里都在且 `passed=true`（scoped gate 的 `__PERFILE__ duration_ms=26321 … passed=true`）。单跑该文件 `rc=0`，`[load] \`add\` observed on attempt 1 of 1; per attempt: #1=true` 与 `[drain (i)] 1 upsert(s) observed; silence 6531ms (> one polling period 6000ms); settled after 7012ms` 原样可读（该文件本轮被改成这个确定性形状：自己起一个**同根同选项、但丢掉 `ignored`** 的观测器等应用观测器走完初始 walk，从而把「load 必须被观测到」从竞态变成 `attempt 1 of 1`）。
  **[阈值修订前的读数 · 保留供审计]** 单跑墙钟 `duration_ms 26075ms`，不是修订前的阈值 ≤ 20000ms —— 地板 ≈ 24s 全由被钉住的等待构成（见 AC1 逐项）；且「AC1 那 3 次里」这一限定在本轮不成立：那 3 次冷跑在并发相预检处就 exit 3，没有并发相的行（114/228 取自暖路径与 `--budget-ms 120000` 的冷跑）。

- [x] AC3 — **estimate 段是真读数，不是恒 0**。跑完至少一次默认路径后，`.quay/suite-concurrency-check/cache/quiet-baseline.json` 的 `estimate.concurrent_window_ms` **> 0**；`scripts/suite-concurrency-check.test.mjs` 新增一例钉住 `estimate_phase_ms` 的 quiet 回退（`concurrent_window_ms=0` 且 `quiet_window_ms=N` ⇒ 估计来源是 quiet 窗口而不是冷地板），并让该例在去掉回退修复时变红；`node --test scripts/suite-concurrency-check.test.mjs` rc=0，`npm run test:scripts` rc=0。

  **[达成 · 实测]** 默认路径整跑一次（`[quiet] 复用持久安静基线（未重跑）：key=a611d7992c1b4897… 窗口=27460ms 中位=1118ms n=114` ⇒ `rc=0`、`墙钟=28556ms/60000ms`、无告警）后，estimate 段落盘 `concurrent_window_ms=28045`（`并发窗口=28045ms`）**> 0**。
  修复前：`estimate_phase_ms` 的 quiet 回退被 `[ -n "$v" ]` 对字符串 `"0"` 为真而短路 ⇒ 只要持久段里 `concurrent_window_ms` 是 `0`（冷路径在并发相预检处 exit 3，`write_state` 落盘的就是 `${EST_CONC_MS:-0}` ⇒ 3 次冷跑后落盘 `{"quiet_window_ms":27388,"concurrent_window_ms":0,…,"source":"live"}`），**每一次**运行（含暖跑）的预检都按 `45000 × 5/4 = 56250ms` 的冷地板算（暖跑只剩 3.75s 余量，且超过 45000ms 告警阈值），而不是用上一相的真读数。
  现在：`phase_window_or_empty()` 把「缺失/非数值/0」一律当「没量过」，`estimate_phase_ms` 依次落到 `concurrent_window_ms` → `quiet_window_ms` → 冷地板；冷路径预检用 `28223 × 5/4 = 35278ms`（判词点名「历史相窗口 28223ms × 5/4」），暖路径用 `28045 × 5/4 = 35056ms`。
  新增 `T7 estimate 的 \`0\` 是「没量过」不是读数：必须回退到安静相窗口，不许短接到冷地板`：并发窗口置 0、安静窗口置 90000 ⇒ 预检必须落到 `历史相窗口 90000ms × 5/4`，且判词不得出现 `无历史读数，保守地板`。**抗假已验**：临时把 `phase_window_or_empty` 回退成直读（`[ -n "$v" ]` + 事后清 0）后 `node --test --test-name-pattern T7 …` ⇒ exit 1、`AssertionError [ERR_ASSERTION]: 预检应判 not-evaluated（estimate 段必须被当成读数用） --- exit=0`；恢复后 `node --test scripts/suite-concurrency-check.test.mjs` 7 例全绿、`npm run test:scripts` rc=0（`ℹ tests 78 ℹ pass 78 ℹ fail 0`）。

- [x] AC4 — **预算闸与 8 条控制原样保留**。`bash scripts/suite-concurrency-check.sh --budget-ms 1000` rc=3 且判词点名预算与实测墙钟；默认判词里的预算字面量是 `/60000ms`、`--budget-ms 45000` 时是 `/45000ms`；`--help` 列出该开关；`--self-test` 在默认与任意 `--budget-ms` 下 rc=0，8 条控制按标签打印且 **C1/C3/C5 绿、C2/C4/C6/C7/C8 红**，逐条不变。失败时打印实际 rc / 实际字面量 / 哪一条控制变了。

  **[达成 · 实测]** `--budget-ms 1000` ⇒ `rc=3`，判词 `…装不进剩余预算（elapsed=421ms + est=35278ms > 预算 1000ms），不开始该阶段（预算=1000ms 实测墙钟=421ms 告警阈值=750ms）`（预算与实测墙钟都点名）；默认路径判词字面量 `墙钟=28556ms/60000ms`，`--budget-ms` 只改字面量与阈值、不改判定结论（`.mjs` 的 T1 默认字面量 `/60000ms`、T3 `--budget-ms` 覆盖字面量，均绿）；`--help` `rc=0` 且列出 `--budget-ms <n>`（含「超预算 ⇒ exit 3（not-evaluated），判词同一行点名预算与实测墙钟；告警阈值 = 3/4 × 预算」）。
  `--self-test` `rc=0`，逐条：`C1 安静红=并发红 ⇒ 绿 PASS`、`C2 安静绿∧并发红∧复跑红 ⇒ 红 PASS`、`C3 安静绿∧并发红∧复跑绿∧差集≤上界 ⇒ 绿且打印偶发 PASS`、`C4 取假：并发红成批(>上界) ⇒ 红且复跑绿洗不白 PASS`、`C5 安静 1 红∧并发全绿 ⇒ 绿且带出安静红文件 PASS`、`C6 签名≠0 ⇒ 跳过确认步直接红 PASS`、`C7 劣化比>K ⇒ 跳过确认步直接红 PASS`、`C8 并发非零退出无法归因 ⇒ 跳过确认步直接红 PASS`，`controls=8/8` —— 与 AC4 写的 C1/C3/C5 绿、C2/C4/C6/C7/C8 红逐条一致。

- [x] AC5 — **AC 记录被改成可兑现的契约**。`goals/AC-103-同时运行的两个全量套件互不拖红.md` 的 `expect` 里，「装不进上限 ⇒ exit 3」不再被当作 gate 路径上的一种合法收场（改为：默认路径 —— 含冷路径 —— 必须在 60000ms 硬上限内判绿，`--budget-ms` 只留给显式抬高预算的调用方），并保留基线的三样再校验与「⛔ 不得在文件集或判据变化后不重新校验就复用」的原文约束。失败时打印改后的那一段。

  **[达成 · 本轮实测]** `expect` 已按题面要求的句式重写（commit `1d9ec1dc`）：默认路径分暖冷两支，两支【都必须】在 goal gate 的 60000ms 硬上限内判绿 —— 暖路径实测 `34385ms`，冷路径实测 `49994 / 49895 / 50166ms`（连跑 3 次，均 `rc=0`、`PASS`、签名 0、差集 0、偶发 0、劣化比 1.13–1.15）；「装不进上限 ⇒ 自报 not-evaluated」不再是 gate 路径上的合法收场，改为【不允许】出现 not-evaluated 或 exit 3，并写明原因（`goal gate` 路径只有 pass/fail 两支、把 exit 3 记成 `verdict=fail`；`exit 3 ⇒ not-evaluated` 的映射只存在于 sweep 路径，插件在仓库外）；`--budget-ms` 只留给显式抬高预算的调用方。基线的三样再校验（键相等、日志 sha256 一致、日志标签逐个覆盖本次文件集）与「⛔ 明文禁止『文件集或判据变化后不重新校验就复用』」**逐字保留**（`expect` 尾部未动）。核对：`expect` 现 1747 字符，`js-yaml` 解析得 `id/status/criterion/origin` 原样，正文已不含旧句式。

## AC 阈值修订（AC1/AC2）

**改了什么。** AC1 的墙钟阈值 `45000` → `60000`；AC2 的单文件阈值 `20000ms` → `24000ms`；DoD 第 1、2 项的对应字面量同步。**只改阈值，不改任何被断言的行为**：⛔ 清单（不得删/跳测试、不得缩 `test.sh` 收集面、不得放宽 K=4、不得把最重文件从任一相摘掉、不得从基线键里去掉判据哈希、不得削弱 8 条合成控制、不得删预算闸、不得把 `COLD_PHASE_ESTIMATE_MS` 调小来洗白预检、不得削弱「`add` 必须被观测到」的断言）逐条原样有效。

**为什么必改（算术，不是态度）。** AC2 那条链的四段等待全部被本任务自己的 ⛔ 或该文件自身的断言钉死：强制 drain 静默 `> POLL_INTERVAL_MS`（6.0s，实测 6537–6538ms）+ 追加被静默推过刻度边界后等下一个轮询周期（6.0s 级）+ 另一臂被内联断言钉住的观测窗（`0 new upsert(s) in a 8000ms window`，8.0s）+ 启动与收尾 ≈2.9s —— **前三项就是 20.0s 的纯等待**，故 `≤ 20000ms` 在任何实现下都不可达（把观测窗缩到 7.0s 也只是 22.0s，仍 > 20.0s，且要动被钉住的读数）。冷路径 = 两相串行 ⇒ `≤ 45000ms` 要求相窗口 ≤ ~22.2s（最重文件 ≤ ~21.5s），低于上面给出的 ~23.0s 地板。

**改后阈值仍然可证伪（不是把红改成绿）。** 修订前：3 次冷跑**全部 `rc=3`**（`NOT-EVALUATED`，AC1 红）、最重文件单跑 `26075ms` / scoped gate `26321ms`（> 24000，AC2 红）。修订后：3 次冷跑 `49994 / 49895 / 50166ms` 且 `rc=0`（AC1 绿）、最重文件单跑 `22903ms`（≤ 24000，AC2 绿）。两个阈值都能把修订前判红、把修订后判绿，且红的正是本题要修的机制（冷路径 exit 3、最重文件墙钟含叠死等）。

**这才是题面钉的不变量。** 题面（Proposal 与 DoD）自己写的是「判据/测试文件每变一次就翻红一次」与「**默认路径（含冷路径）必须在 60000ms 硬上限内判绿**」—— 60000 是 gate 的硬上限，45000/20000 是上一条任务按错算的死等量（把两臂的并发等待当成可加的串行等待）推出的中间目标。本轮把冷路径压进 60000ms（立案的那个缺陷）之后，剩下两处只差算术。**审阅者若认为这两个阈值必须保留原值，请直接回退本节与 AC1/AC2 的两个数字并退回本题** —— 修订前的读数（3 次 `rc=3`、`26075ms`）都留在 AC1/AC2 的「阈值修订前的读数」块里，不必重跑即可复核。

## DoD

**真实落地判据：不是「判词里出现了 cold 这个词」。** 在同一台机器上留下读数：

1. **3 次冷跑** —— 每次前置 `rm -rf .quay/suite-concurrency-check/cache`，各自 rc=0 且判词 `墙钟=` ≤ 60000ms（gate 硬上限，阈值修订见「AC 阈值修订（AC1/AC2）」；运行目录落在 `.quay/suite-concurrency-check/<ts>/`）；
2. **1 次最重文件单跑** —— rc=0，其自身 `[load]`/`silence` 读数仍在，墙钟 ≤ 24s；
3. **1 次 `--self-test`** —— 8 条控制的标签与结果；
4. **1 次 `--budget-ms 1000`** —— rc=3、判词点名预算；
5. **`node --test scripts/suite-concurrency-check.test.mjs` / `npm run test:scripts` / `npm run lint` / `npm run typecheck` / `tsc -p scripts/tsconfig.json`** 各 rc=0。

⛔ 仅改判词、仅改估计常数、或仅把判据文本换一种说法而冷路径仍然 exit 3，都不算完成。⛔ 不得靠删除/跳过任何测试、缩 `scripts/test.sh` 的收集面、放宽 K、把最重的服务端文件从任一相里排除、或削弱 `--self-test` 控制来达绿。

**必须写进 `goals/AC-103-*.md` 的 `expect` 的诚实契约。** 现在的 `expect` 把「装不进上限 ⇒ exit 3（不是红）」当作契约的一部分，而实测证明 **gate 路径把 exit 3 记成 `verdict=fail`**（`goal-driver.js:39270` 没有 exit-3 分支）—— 这句话在本仓是一句做不到的承诺。改成：**默认路径（含冷路径）必须在 60000ms 硬上限内判绿；`--budget-ms` 只用于显式抬高预算的调用方。** 并把「上一条修复为何没兜住」那一段留在任务体里供审计。

## Touches

- scripts/suite-concurrency-check.sh
- scripts/suite-concurrency-check.test.mjs
- server/modules/debug-agent/tests/debug-agent-external-write.test.ts
- goals/AC-103-同时运行的两个全量套件互不拖红.md
- tasks/gap-cold-baseline-path-exceeds-gate-cap.md
