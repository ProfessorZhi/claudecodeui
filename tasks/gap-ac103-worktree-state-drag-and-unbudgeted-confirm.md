---
id: gap-ac103-worktree-state-drag-and-unbudgeted-confirm
title: AC-103 现在是红的：两个 voice false-forms 测试读共享 worktree 状态 ⇒ 并发组必红、差集地板=2 吃光
  DIFF_MAX 的余量（一个普通偶发即「成批死亡」判红）；而把差集洗成偶发的确认步成本既不在判词墙钟里也不受预算闸管 ⇒ 外层 60000ms
  击杀后被记成 fail；冷路径地板 62–70s 也装不进同一条上限
status: superseded
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

**现象（本轮一手读数，同一台机器、同一份代码，criterionHash `790fab152ee594aa`）**：AC-103 的判据 `bash scripts/suite-concurrency-check.sh` 现在是**红的**，而且它判绿的形状也装不进 goal gate 的 60000ms 硬上限。本轮四次实跑（墙钟用**外部** `date +%s%3N` 包夹，同时抄下判词行自报的 `墙钟=`）：

| # | 形状 | 外部墙钟 | rc | 判词要点 |
|---|---|---|---|---|
| A | 暖（复用持久基线） | **65.16s** | 0 | `PASS — 差集 2 个文件无一在隔离复跑中复现（偶发 2 个）`；判词 `墙钟=38860ms/60000ms`；确认步跑了 2 个文件（`voice-capture-off.false-forms.test.ts` **23815ms** + `voice-dashscope-settings.false-forms.test.ts` 1539ms，都 `passed=true`） |
| B | 暖 | 40.11s | 0 | `PASS — 差集 1 个`；确认步 1 个文件 ≈2s |
| C | **冷**（`rm -rf .quay/suite-concurrency-check/cache` 之后） | 35.27s | **3** | `NOT-EVALUATED — [concurrent] 阶段的保守估计 35090ms（本次运行刚实测的相窗口 35090ms（同一台机器、间隔以秒计，不乘 5/4））装不进剩余预算（elapsed=35223ms + est=35090ms > 预算 60000ms），不开始该阶段` |
| D | 暖 | 38.34s | **1** | `FAIL — 差集规模 3 > 上界 2（成批死亡，不交确认步）`；并发红名单 = `server/modules/projects/tests/projects-session-filter.integration.test.ts`（`[TypeError: fetch failed]`）+ 两个 voice false-forms |

**账本里这一轮的形状**（`.quay/gate-events.jsonl`，AC-103，`gate:"goal"`）：

- `2026-09-24T10:16:49.699Z actor=goal-sweep verdict=not-evaluated` —— `acceptance failed (exit 3) … 安静基线=活读数 … 重跑窗口=24549ms`（冷那次）
- `2026-09-24T11:17:25.082Z actor=goal-sweep verdict=pass`
- `2026-09-24T12:19:10.608Z actor=goal-sweep verdict=**fail**` —— `acceptance timed out after 60000ms (killed)` ← 运行目录 `20260924T201810-1013054`：起 12:18:10Z，安静相活读数窗口 24.5s，并发读数在 12:19:10Z 收尾的**同一秒**被击杀，判词没来得及打印
- `2026-09-24T12:20:19.840Z actor=goal-cli verdict=**fail**` —— `acceptance timed out after 60000ms (killed)` ← 运行目录 `20260924T201919-1113320`：并发相 37.7s + 确认步 25.2s ≈ 67s

四种形状里三种是 AC 明文禁止的相（exit 3 / 被击杀），第四种（A）越过了同一道上限。AC 的 expect 写着「默认路径不允许出现 not-evaluated 或 exit 3，也不允许出现『开得了工却跑不完』的相」「默认路径判绿必须对冷路径也成立」。

**根因一：确认步的成本不在判据自己的账里，也不受预算闸管**（这是「开得了工却跑不完」仍然同形的直接成因）

`confirm_outcome()`（`scripts/suite-concurrency-check.sh:351`；`server/*` 走 `bash scripts/test.sh --test-concurrency=1 <file>`，`:364`）**没有夹取**，它由 `differential_verdict()`（`:369`）在 `:411` 调用；而 `R_WALL_MS` 在这**之前**就算好了（`:1252`），预算闸在 `:1261-1266`，`differential_verdict` 的调用在 `:1283`。于是确认步的耗时**既不进判词打印的 `墙钟=`，也不进预算闸**：A 那一跑判词写 `墙钟=38860ms/60000ms`（看着安全），进程实际活了 **65.16s** —— 超出的 26.3s 全部是确认步（23815+1539ms 加起停）。判据因此**不可能**为这一段自报 exit 3；它唯一的表达就是外层 SIGKILL，然后被记成 `fail`，正是 AC 要消除的同形。（并发相与服务端阶段都有夹取：`:738`、`:993-1026`，`budget_preflight` 三处调用 `:1110/:1129/:1158`；确认步一个都没有。）

**根因二：差集里现在有 2 个「必红」成员，`DIFF_MAX=2` 的余量被吃光**（D 判红的成因，也是 A/B 必须付确认步的成因）

两个 voice false-forms 测试在**并发组**里红、在**安静相**与**隔离复跑**里绿。红的**不是负载**（签名 `STACK_TRACE_ERROR=0 Timeout_fetch=0`，劣化比 1.11–1.16 « K=4），是它们读**共享 worktree 的状态**：

- `server/modules/voice/tests/voice-capture-off.false-forms.test.ts`：模块体快照 `PRE_RUN_PORCELAIN`（`:74`）与运行后的整个 `git status --porcelain`（`:319`）比较（`:336` `assert.equal(unchanged, …)`）。并发臂里**另一份读数**的临时副本在这两次读之间出现/消失 ⇒ `AssertionError: this run changed the worktree's git status: ?? .codex/`（判定语打印的是 porcelain 的**第一行**；`.codex/` 是本工作区既有的未跟踪目录，不是成因，成因是兄弟读数的临时副本）。
- `server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts`：`:191-192` 按 `TEMP_PREFIX` **单独**过滤 porcelain，而它自己的副本带 PID 后缀（`:123-124` `${TEMP_PREFIX}${name}-base-${process.pid}.ts`）⇒ 它把**兄弟读数**（本轮实测 PID `1974625`）留下的副本算成自己的 ⇒ `assert.equal(leftovers, '', …)`（`:202`）报 `the run left temp copies behind: … __criterion-falsify-env-only-configured-base-1974625.ts …`。

两个文件自己的注释写着它们欠的读数是「**THIS RUN** 留下过什么」（capture-off `:66-70`：`what AC7 owes is that THIS RUN adds nothing`；dashscope `:204`：`the property the case owns is still checked above`）—— 所以按全树 / 按 PREFIX 过滤是**与它自己声明的意图相反的实现**，不是一条更严的断言。

于是差集地板 = 2：任何一次普通偶发把它推到 **3 > 上界 2** ⇒ 防洗白跳过确认步 ⇒ **判红**。D 那一跑的第三个成员正是一次本仓 known 的偶发（`projects-session-filter.integration.test.ts` 的 `[TypeError: fetch failed]`）。`DIFF_MAX=2` 的取值依据（`上界=2(依据:102 次实跑两组红名单最大规模=1)`）在**负载**通道上仍然成立 —— 被吃掉的余量来自这条**新出现**的「共享 worktree 状态」通道。

**这条通道正在被成批复刻**：`grep -c porcelain tasks/*.md` 命中 `gap-voice-capture-text-payload`（ready）、`gap-voice-capture-audio-file`（todo）、`gap-voice-capture-secrets-three-modes`（todo，3 处）、`gap-voice-capture-isolation`（todo，AC9 明写「变异体复制到同树临时路径…… `git status --porcelain` 在跑完后为空」）—— 四份在飞任务各要新增一份 `*.false-forms.test.ts`。只修现在这两个文件，下一轮差集地板会变成 6。

**根因三：冷路径的地板 = 2 × 最重服务端文件 + 并发相的 ≈12s 非文件开销，已经 ≥60000ms**

冷路径实测（C，运行目录 `20260924T202424-1881064`）：安静相活读数窗口 **35090ms**；并发相预检按**刚实测的相窗口**诚实估算 35090ms ⇒ `35223 + 35090 > 60000` ⇒ 不开工（exit 3）。同一形状的历史读数与之同阶：安静相窗口 24549–35090ms（随主机负载摆），并发相窗口 **37479 / 37748ms**（`20260924T202203-1357345` 的两份 `concurrent-readout-*.meta`），而该并发相里最重的文件只有 25470ms ⇒ 并发相除最重文件外还有 **≈12s** 的非文件开销（`scripts/test.sh` 的 prelude/stage 与 2 份 vitest 池在这 13.3s 内重叠；本形状未再往下拆）。持久基线的逐文件读数（`.quay/suite-concurrency-check/cache/quiet-baseline.files`，n=121）前四名：

```
25016ms  server/modules/voice/tests/voice-capture-off.false-forms.test.ts
23385ms  server/modules/debug-agent/tests/debug-agent-external-write.test.ts
13461ms  server/modules/providers/tests/model-gateway-end-to-end.test.ts
 9761ms  server/modules/debug-agent/tests/debug-agent-control-plane.test.ts
```

⇒ 冷路径地板 ≈ `最重文件 25s + (12s + 25s)` ≈ **62–70s**，装不进 60000ms；AC 的 expect 记的冷路径 `50809 / 55080 / 51274ms` 是 n=118、最重文件更小时的读数。这个最重的文件**不是被争用拖慢的**：安静相 25016ms / 并发相 25470ms / 单跑 `scripts/test.sh --test-concurrency=1` 实测 23447ms（安静/并发比 1.02），成本是内在的。

**上几条修复为何没兜住**（留在任务体里供审计）：

<!-- dedup-ref -->
`gap-suite-criterion-wallclock-budget`（done，`goal_ac: AC-103`）交付了预算闸 + 带再校验的持久基线，把「判据自身墙钟 < 60000ms」当**瞬时读数**验收（暖跑 35.9/36.0s）—— 它没有把**确认步**纳入那条墙钟。`gap-concurrency-verdict-discriminates-flake-from-drag`（done，`goal_ac: AC-103`）交付了差分判词与 `DIFF_MAX=2`，依据是「102 次实跑两组红名单历史最大规模 1 个文件」—— 那时还没有这条共享 worktree 通道。`gap-cold-baseline-path-exceeds-gate-cap`（done，`goal_ac: AC-103`）修掉「estimate 段恒 0 ⇒ 冷路径必 exit 3」，把冷路径的**成本**当不变量接受（三次 49.9–50.2s），只把阈值顶到 60000。`gap-ac103-whole-set-baseline-key-revives-full-quiet-phase`（done，`goal_ac: AC-103`）交付的**逐文件内容哈希再校验**今天仍然有效（本轮 `模式:cached 复用=121/121 重跑=[无] 重跑窗口=0ms`），它解掉的是「一个文件变了付一整相」，没有碰确认步与差集这两条通道。

**要落地的事（路线由实现者定，读数指向这三个杠杆）**

1. **让这两个（以及将要来的同类）测试不再读别人的 worktree 状态**：`leftovers` 的过滤必须收窄到**本次 run 自己的**副本（自己的 PID / 自己的快照差），`unchanged` 只对**本次 run 自己**的增删敏感。⛔ 不许把它做成恒真 —— 见 AC3 的两条取假形态。若判断「同树临时副本」这条形状本身不可救，就改成让副本带一个本 run 唯一标识、断言只认这个标识（把副本挪到不了 `git status` 的位置会让断言变空，不算修）。
   - 这条的最优解应当把这个形状**广播**给同类工装（若四份在飞任务之间已有共用模块/模板，就改模板）；无法广播时，至少在判据侧补一条识别，让「同一 test 文件在并发红名单里重复出现」不被当成独立成员。
2. **把确认步纳入判据自己的账**（根因一）：`R_WALL_MS` 必须覆盖确认步，或确认步前重算预算并受同一 `budget_verdict` 闸约束。⛔ 不许用「删掉确认步」或「把确认步的夹取当作判定结果」绕过 —— 确认步是差分语义里唯一能把偶发与拖红分开的机件。
3. **让默认路径真的装进 60000ms**（根因三）：冷支与暖支都要 rc=0 且外部墙钟 ≤60000ms。读数指向两条独立的路：把「最重文件」压下来（`voice-capture-off.false-forms.test.ts` 今天 25016ms 安静 / 25470ms 并发 / 23447ms 单跑，单文件单用例，是本相地板；上一轮同形状的先例是把 `debug-agent-external-write.test.ts` 的 ≈16s 死等收掉，从 32s 压到 23s），或把并发相那 ≈12s 的非文件开销收掉。⛔ 不许靠「把最重文件从某一相里排除」「缩小 `scripts/test.sh` 的收集面」「调小 `COLD_PHASE_ESTIMATE_MS`」「放宽 `K=4`」「抬高 `DIFF_MAX`」让读数变绿。

**⛔ 明文禁止（承 AC-103 的 expect 与 GOAL-003 的非目标）**：删除或跳过任何测试；缩 `scripts/test.sh` 的收集面；放宽 `K=4`；抬高 `DIFF_MAX`（`2` 的取值依据在负载通道上仍成立，被吃掉的是新通道的余量，正确做法是移掉通道而不是放宽上界）；把判据 sha256 从基线键里拿掉（「判据变化后复用」）；靠削弱 `--self-test` 的 8 条合成控制让自检变绿；把预算闸整个删掉；把确认步的夹取当成判定结论。

**形状纪律。** 本题改动落在 `scripts/**` 与 `server/modules/voice/tests/**`。按 `AGENTS.md`，触及 `server/**` 时先加载 `$backend-module-standards` 并只对后端代码施用。改完跑 `npm run lint`（`oxlint src/ server/ scripts/`；裸 `npx oxlint` 退出 1 是本仓既有现象）与 `npm run typecheck`；改动/新增的 `.mjs` 还要 `tsc -p scripts/tsconfig.json`（scoped gate 的 `\.test\.[jt]sx?$` 正则看不见 `.mjs`）。

## AC

- [x] AC1 默认路径在**冷**（`rm -rf .quay/suite-concurrency-check/cache` 之后）与**暖**（紧接的第二次）两支上各连跑 ≥3 次，每次 `rc=0` 且**外部** `date +%s%3N` 包夹实测墙钟 ≤ 60000ms；判词里不出现 `NOT-EVALUATED`、不出现 exit 3、也不出现被击杀（外部实测 > 60000ms 即算被击杀）。逐次打印 `run=<n> mode=<cached|live|partial> rc=<n> wall_ms=<n> 安静窗口=<n> 并发窗口=<n> 最重文件=<path:ms> 差集=<n> 确认步=<…>`。
- [x] AC2 差集回到历史形状：连续 ≥5 次默认路径运行，`差集` 的文件数 ≤1，且 `server/modules/voice/tests/voice-capture-off.false-forms.test.ts` 与 `server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts` **不再**出现在 `并发红名单` 里。逐次打印 `并发红名单=[…] 安静红名单=[…] 差集=[…]`。
- [x] AC3 AC2 不是把读数做成恒真（两条可执行的取假形态，沿用这两个文件自己的 `CASES`/锚点形状）：(i) 让该 run 自己留下**一份自己的**临时副本不删 ⇒ `leftovers` 判红（`passed=false` 且判词指名该副本）；(ii) 让该 run 自己相对自己的起点新增/删除一个未跟踪文件 ⇒ `unchanged` 判红。两条都**先要求未变异的同一份读数退出 0**。逐条打印 `mutation=<name> baseExit=0 mutantRed=<b> whichReading=<leftovers|unchanged>`。
- [x] AC4 确认步成本进判据自己的账：`scripts/suite-concurrency-check.test.mjs`（或该测试文件既有入口）新增一条合成读数控制，退出 0 并打印 `confirm-accounted=true` —— 构造「已 elapsed + 确认步成本 > 预算」的合成形状必须以判据**自报 exit 3** 收场（而不是把确认步跑完再被外层击杀），且该形状的判词 `墙钟=` 覆盖确认步；另在任一**真实**含确认步的运行上，判词 `墙钟=` 与外部包夹实测之差 ≤ 2000ms（本轮 A 跑该差为 26.3s）。
- [x] AC5 不退化（逐条打印退出码，不是空过）：`bash scripts/suite-concurrency-check.sh --self-test` 打印 `controls=8/8` 且 8 行逐条 PASS（C1/C3/C5 绿、C2/C4/C6/C7/C8 红）；`--help` 仍列出 `--budget-ms`；`npm run lint`、`npm run typecheck`、`tsc -p scripts/tsconfig.json`、以及该判据的测试文件入口全部退出 0。

## DoD

真实落地判据：不是「判据这一次绿了」，而是**判据在 goal gate 自己的路径上（60000ms 硬上限，`runAcceptance({ timeoutMs: 6e4 })`，本仓改不了那条映射）稳定判绿**：冷支与暖支各 ≥3 次、外部计时 ≤60000ms、`rc=0`；并且**账本的尾巴真的翻过来** —— `.quay/gate-events.jsonl` 里 AC-103 的 `gate:"goal"` 事件在本次修复之后连续若干条为 `pass`，其中至少一条来自 gate 路径的实测事件（`actor=goal-cli` / `goal-sweep`），而不是人工 `--self-test`。

**承重性由三件读数证明**：

(a) **差集的余量回来了**（AC2 + AC3）：两个必红成员在并发组里绿，而它们自己那一份「本次 run 留下过东西」的读数仍能被取假形态打红 —— 所以这不是把断言做成恒真。

(b) **确认步不再能把判据送出预算之外**（AC4）：合成形状以 exit 3 自报、真实形状的判词墙钟与外部实测之差 ≤2s。今天这个差是 26.3s：一条真的活了 65.16s 的进程对自己报「38.9s，安全」。

(c) **冷路径装得下**（AC1 冷支）：`rm -rf cache` 之后连跑 ≥3 次都 ≤60000ms 且 rc=0，并逐次打印两相窗口与最重文件 —— 因为按 AC 原文「冷路径在每一次判据内容变化、或任一服务端测试文件变化之后必然复活」，不能靠暖路径命中基线绕开。

**必须如实登记**：冷路径地板是 `(最重服务端文件) + (并发相 ≈12s 非文件开销 + 最重文件)`；本轮最重文件是 `voice-capture-off.false-forms.test.ts`（25016ms 安静 / 25470ms 并发 / 23447ms 单跑），不是它在争用下变慢（安静/并发比 1.02），所以**任何**「把 estimate 调乐观」的路线都不成立。若实现者选择压低该文件成本，登记它压的是哪一段等待、以及为什么那一段不是承重断言。

**本轮登记的第三条，与压掉的那一段等待**：除两个必红成员外，同形状的第三条也一并收窄 —— `server/modules/voice/tests/voice-capture-text.false-forms.test.ts`，它在今天替代 capture-off 成为判据服务器文件集里**最重**的一个（安静 27768ms / 并发 30706ms / 单跑 25466ms，且冷路径预检正是被它顶出预算：三次冷跑分别以 `并发相保守估计 38556ms`、`确认步保守估计 34710ms` 撞上 60000ms 而 exit 3）。它同时吃两条通道：AC11 与那两个文件一样读全树 porcelain，而它自己的探针也会被兄弟进程当成残留。压掉的等待是它 AC10 的八条 `execFileSync`（六份既有判据 + `npm run typecheck` + `npm run lint`，其中 typecheck 单条约 12s）：原来串行，于是把这**八次等待之和**记在该文件头上；改成 `spawn` + `Promise.all`（与 capture-off 的 AC6 同形状）后单跑 **25466ms → 12520ms**。那一段不是承重断言 —— AC10 只断言退出码与用例数（并断言用例数非零），从不断言耗时、也从不断言八条被串行过；断言集合逐条不变。AC11 的两条读数收窄到 `-<pid>.ts`，并补上两条互不重叠的取假形态（漏留自己的副本 ⇒ `leftovers` 红；自己新增未跟踪文件 ⇒ `unchanged` 红），跳过的兄弟副本条数以 `other-process-copies=` 打印而不是静默丢弃。

**`__criterion-falsify-*` 是生成物，不是源码**：oxlint 先枚举目录、再逐个打开文件，兄弟进程在这两步之间删掉自己的探针会让 `npm run lint` 因 `ENOENT` 退出 1（本轮实测 `error: Failed to open file …/__criterion-falsify-truncated-always-true-base-3727593.ts with error "No such file or directory (os error 2)"`）；`server/tsconfig.json` 的 `include` 同理会把一个随时可能消失的文件放进 program。两处都把它与 `dist-server/**` 并列排除（`.oxlintrc.json` 的 `ignorePatterns`、`server/tsconfig.json` 的 `exclude`）。这一条是「把该形状广播给同类工装」的那一半：四份在飞任务新增的 `*.false-forms.test.ts` 不必各自改配置就能免掉这条噪声。

**已知不等价点**：AC3 的两条取假形态证明的是「收窄到本 run 自己」这件事仍然可红，不是「任何别人的副本都不会被误判」的穷举；AC4 的合成控制证明的是判据自己的账覆盖确认步，不证明外层 gate 不会再以别的理由击杀（那由 AC1 的外部计时覆盖）。四份在飞任务（`gap-voice-capture-text-payload`<!-- dedup-ref:inline --> / `gap-voice-capture-audio-file`<!-- dedup-ref:inline --> / `gap-voice-capture-secrets-three-modes`<!-- dedup-ref:inline --> / `gap-voice-capture-isolation`<!-- dedup-ref:inline -->）会各新增一份同形状的 `*.false-forms.test.ts`，本条若只修两个文件而不改模板/工装，下一轮差集地板会变成 6 —— 这个残余风险登记在案，由后续轮次的读数暴露（并发红名单里同一形状的成员数）。

L_D 该轴仍暗，理由：本条读数全是计数、布尔与墙钟毫秒，判据没有「性能读数」这一维；相窗口与中位耗时是判定输入，不是被评的量。

L_G 该轴仍暗，理由：目标层要的是「两个全量套件互不拖红」在**真实全量套件**（`scripts/test.sh` 两遍）上的现场，本条读的是判据自己构造的两个过订阅相（`--full-suites` 那个形状超出 60000ms 上限，装不进 gate）。

## Touches

- .oxlintrc.json（AC1 冷支 / AC2：`__criterion-falsify-*` 是判据探针的生成物，纳入 `ignorePatterns` 才能让并发相里的 `npm run lint` 不因兄弟进程删探针而 ENOENT 退出 1）
- server/tsconfig.json（同上，`include` 会把兄弟进程随时会删掉的探针放进 program）
- scripts/suite-concurrency-check.sh
- scripts/suite-concurrency-check.test.mjs
- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts（AC1 冷支：判据最重的服务端文件；AC2：同形状的共享 worktree 读数，第三条）
- server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts
- scripts/asr-dashscope-omni-check.test.mjs（AC1 冷支：判据最重文件 AC7 的第 6 条命令；14 个独立用例的串行探针 ⇒ `spawn` + 并发 describe，53834 → 8719ms，锚点/token/断言一字未动）
- scripts/asr-contract-invariants-check.test.mjs（同上，第 7 条命令；23940 → 5599ms）
- server/modules/voice/tests/voice-error-classification.false-forms.test.ts（AC1 冷支：develop 合并带进来的 119497ms 服务端文件，改前是判据的安静相地板；AC7 十五条门命令 `spawnSync` 串行 ⇒ `spawn` + `Promise.all`，117284 → 12732ms）
- src/shared/tests/voiceErrorClassification.test.ts（AC1 默认路径：并发相里客户端套件恒红的成因；它的 AC1 残渣读数收窄到**本 run 自己**的路径 —— `.quay` 运行目录、`tmp/__criterion-falsify-<name>-<pid>/` 副本、`*-probe-<pid>.<ext>` 与带 `__criterion-falsify-` 组件的兄弟探针）
- server/modules/voice/tests/voice-error-contract.false-forms.test.ts（AC1 冷支：该文件 AC 的九条命令原以 `execFileSync` 串行跑，把**九次等待之和**记成它的单价而成为相位地板；改 `spawn` + `Promise.all`，断言逐条不变 —— 上一轮 commit 52f2a721 的改动，本条补登记）
- tasks/gap-ac103-worktree-state-drag-and-unbudgeted-confirm.md

## 完成记录

本轮把 AC1 的冷支从「结构性不可达」推到 **3 冷 + 3 暖全绿**（外部 `date +%s%3N` 包夹实测
58102 / 32040 / 57354 / 32043 / 59468 / 33744ms，全部 rc=0、无 NOT-EVALUATED、无 exit 3、无击杀）。
修的是上一轮登记的三条「读共享 worktree 状态」通道 —— 全部是**别人的判据把兄弟进程的产物读成自己的红**，
不是重做前几轮的成果；前 13 条 commit 的改动（两个 voice false-forms 的读数收窄、确认步进账、
`-pid.ts` 收窄、`.txt` 探针、`__criterion-falsify-*` 排除、起跑表按当前读数降序、
三处串行等待改并发）逐条仍在。

### 一、本轮收窄的两条通道（commit ee08c324 / d26afb19）

| # | 通道 | 现象（本轮实测） | 收窄 |
|---|---|---|---|
| 1 | `src/shared/tests/voiceErrorClassification.test.ts` 的 AC1 残渣读数 walk 整棵仓库树 | 并发相里**客户端套件恒红**（`concurrent-suite-*.out rc=1`）⇒ 判据恒 rc=1 ⇒ AC1 不可能绿。残渣是**判据自己的运行目录**（`.quay/suite-concurrency-check/<run>/`：`.gitignore` 覆盖，AC 声明的机制 `git status --porcelain` 本就不会报）、**兄弟进程当时活着的探针**（`server/modules/voice/__criterion-falsify-*-<pid>.ts`）、以及 `tmp/__criterion-falsify-<name>-<pid>/` 下的副本 | `SKIP_DIRS` 加 `.quay`；`ownedByAnotherProcess()` 认领两族工装名 —— 带 `__criterion-falsify-` 组件的路径，以及 `*-probe-<pid>.<ext>`。带本进程 pid 的路径永不外归 |
| 2 | `voice-error-classification.false-forms.test.ts` 的 `SCRATCH_DIR` 是**全进程共享**的 `tmp/__criterion-falsify-voice-error-classification/`（文件名带 pid、目录不带），而每个副本 AC8 的 `finally` 都 `rmSync` 整个目录 | 兄弟副本刚写下的 `drift-mut-<pid>.ts` 在 tsc 读之前被删 ⇒ `error TS5058: The specified path does not exist`、exit 1、既不指名 `NO_SPEECH_DETECTED` 也不指名 `AsrErrorCode` ⇒ **一次机器造成的红被读成漂移红**，该文件成为冷支差集的唯一成员 ⇒ 冷支自报 exit 3。四副本实测（修前）：3 个指名漂移、1 个报 TS5058；**修后四副本全部 `mutantExit=2 names-the-deleted-code=true`** | 目录改带本进程 pid（`SCRATCH_DIR` 后缀 `-${process.pid}`；文件后缀本来就有） |
| 3 | 同文件 AC8 的 tsc 臂在过订阅下「没给出答案」 | `mutantExit=1` 且不指名（`runCommand` 的 `code ?? 1`：被信号杀死时 `code` 为 null）⇒ 同上 | `runArm()` 在该臂未给出**可用答案**时再驱动一次（`ARM_ATTEMPTS_MAX=2`）：base 未绿 / mutant 红但不指名。编译是确定性的 ⇒ 真正的漂移红必复现、仍判红；两次都无答案仍失败并打印最后一次的输出 |

**取假控制（两个方向都实测，不是空过）**：本 run 窗口内新增的普通未跟踪文件
（`src/shared/zz-residue-control-<n>.txt`）⇒ `git-clean-after=false` 且判词指名该路径（rc=1）；
三族兄弟路径（`tmp/__criterion-falsify-…-<pid>/`、`ac11-untracked-probe-<pid>.txt`、
`__criterion-falsify-*-<pid>.ts`）与 `.quay` 写入同时出现 ⇒ `git-clean-after=true`（rc=0）。

### 二、AC1 的六条读数（本轮最终树；冷跑前 `rm -rf .quay/suite-concurrency-check/cache`）

| run | mode | rc | 外部墙钟 | 判词墙钟 | 安静窗口 | 并发窗口 | 最重文件 | 差集 |
|---|---|---|---|---|---|---|---|---|
| cold1 | live | 0 | 58102 | 58056 | 25909 | 31861 | debug-agent-external-write.test.ts:25403 | [] |
| warm1 | cached | 0 | 32040 | 32001 | 25909 | 31560 | 同上:25403 | [] |
| cold2 | live | 0 | 57354 | 57306 | 25686 | 31317 | 同上:25217 | [] |
| warm2 | cached | 0 | 32043 | 32007 | 25686 | 31576 | 同上:25217 | [] |
| cold3 | live | 0 | 59468 | 59418 | 25663 | 32013 | 同上:25187 | [agent.routes.test.ts] |
| warm3 | cached | 0 | 33744 | 33709 | 25663 | 31665 | 同上:25187 | [voice-dashscope-settings.test.ts] |

判词 `墙钟=` 与外部包夹之差 = 46 / 39 / 48 / 36 / 50 / 35ms（≤2000ms，AC4 的第二半）。
`差集` 非空的两条（cold3 / warm3）都交了确认步、隔离复跑绿 ⇒ 判「偶发」⇒ PASS —— 正是判据设计的形状。

**如实登记冷支的余量**：59468ms 那条距 60000ms 只剩 **532ms**（0.9%）。冷路径地板 = 安静窗口
（25.7s，= 最重服务端文件的固有测量窗口）+ 并发窗口（31.9s，= 同一文件在 4 路过订阅下的窗口）。
两条都在别人判据的承重读数里（`DRAIN_SILENCE_MS=6500 > POLL_INTERVAL=6000`、`OBSERVATION_WINDOW_MS=8000`、
探测子进程的 `CHILD_TIMEOUT_MS`），压它等于改弱那份判据 —— 本轮**没有**动它。
**这是本条最重要的残余风险：冷支现在能过，但过在 0.5–2.6s 的余量上。**

### 三、AC 逐条核验（读数全部为本轮、最终树）

- **AC1 — 满足，`- [x]`**：上表 3 冷（live）+ 3 暖（cached），每条 `rc=0`、外部 ≤ 60000ms、判词无 NOT-EVALUATED / exit 3 / 击杀。
- **AC2 — 满足，`- [x]`**：同一批 **6 条连续**运行的 `差集` = 0,0,0,0,1,1（全部 ≤1）；
  `并发红名单` = [] , [] , [] , [] , [agent.routes.test.ts] , [voice-dashscope-settings.test.ts]；
  `voice-capture-off.false-forms.test.ts` 与 `voice-dashscope-settings.false-forms.test.ts` 一次都不出现。
- **AC3 — 满足，`- [x]`**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts` rc=0，
  两条取假形态逐条打印 `mutation=own-copy-left-behind baseExit=0 mutantRed=true whichReading=leftovers` 与
  `mutation=own-untracked-file-added baseExit=0 mutantRed=true whichReading=unchanged`。
- **AC4 — 满足，`- [x]`**：`node --test scripts/suite-concurrency-check.test.mjs` rc=0，打印
  `confirm-accounted=true 装不下 run: exit=3 判词墙钟=652ms 外部=661ms 确认步开工=no ｜ 真跑 run: exit=0 判词墙钟=4670ms 外部=4704ms 差=34ms`。
- **AC5 — 满足，`- [x]`**：`bash scripts/suite-concurrency-check.sh --self-test` rc=0 且 `controls=8/8` 逐条打印
  （C1/C3/C5 预期绿实得绿、C2/C4/C6/C7/C8 预期红实得红）；`--help` 第 12 行仍是 `--budget-ms`；
  `npm run lint` rc=0、`npm run typecheck` rc=0、`npx tsc -p scripts/tsconfig.json` rc=0、该判据测试入口 rc=0。

### 四、明确没有做的事

没有抬高 `--budget-ms` / `DIFF_MAX` / `K`；没有缩小 `scripts/test.sh` 的收集面；没有把任何文件从某一相里排除；
没有删预算闸、没有跳过确认步、没有把确认步的夹取当判定结论；没有压 `debug-agent-external-write.test.ts`
的任何窗口（这正是冷支余量只剩 0.5–2.6s 的原因，如实登记）；没有手改 AC 复选框字符（本节由 ABI 写入）。

### 五、修前那六条的读数（留档：为什么不能只跑一次就下结论）

修前（ee08c324 之前）的 3 冷 + 3 暖里 **3 条红**，三条红都落在上面三条通道：
`warm1` 差集=[`debug-agent-external-write.test.ts`] —— 它 25s 级单价的确认步（估计 31.25s）装不进
暖跑剩余预算（elapsed 31.8s）⇒ exit 3；`warm2` 并发组非零退出但无法归因（通道 1）；
`cold3` 差集=[`voice-error-classification.false-forms.test.ts`]（通道 2/3）。
另外，第三节的 AC3/AC4/AC5 在**修前**的树上也没有可用读数：客户端套件恒红使判据恒 rc=1。

**仍存的两条同类通道（不在本条杠杆内，供后续轮次）**：

1. **别人的判据在过订阅下把「子进程被夺走资源」读成红**：`voice-error-classification.false-forms.test.ts`
   的 AC7 驱动十五条命令，其中被驱动的**别的**判据会红（四副本 × 15 命令实测
   `src/shared/asr/tests/asrContractInvariants.test.ts`）⇒ AC7 判「a surface this task must not have
   moved is red」。本判据的并发相只有 2 份读数、压力较低（本轮 6 条运行里未出现），但它是同类通道。
2. `debug-agent-external-write.test.ts` 的探测子进程在过订阅下会 `Command failed`（实测 `warm1`
   的 `bypass: the probe child printed no reading`），而它 25s 级的单价意味着**它在任一相里的
   一次并发红都是致命的**（AC4 要求确认步装不下时自报 exit 3，不给 rc=0）。修法不在本条：
   要改那份判据的子进程重试，而重试会把它推高到可能把整相越过 60000ms。

### 六、DoD 的账本条件（本轮不能由本条满足，如实登记）

`.quay/gate-events.jsonl` 里 AC-103 的 `gate:"goal"` 尾巴目前仍是
`2026-09-24T12:20:19Z goal-cli fail`、`12:31:14Z goal-cli fail`、`12:31:55Z goal-sweep not-evaluated`、
`13:47:08Z` / `15:34:57Z` / `16:42:57Z goal-sweep not-evaluated`（本轮读出的最后 6 条）。
**这条尾巴由 goal 层的 sweep 在本分支落进 develop 之后复跑 AC-103 时翻过来** —— 现在 sweep 读的是
develop 的树，而本条的五处修复还只在本分支上；本轮**不**自行触发 goal gate（那是 goal 层的动作，
且并发触发会与 sweep 抢同一批 AC 的立案）。本轮能提供的、也是翻尾巴的输入，就是第二节那六条
`rc=0` 的默认路径读数（0.9–4.4% 余量，见该节的风险登记）。

### 七、形状纪律

按 `AGENTS.md`：改 `src/shared/tests/**` 前加载并施用了 `$frontend-module-standards`，改 `server/**`
前加载并施用了 `$backend-module-standards`。收尾逐条复跑：`npm run lint` rc=0、
`npm run typecheck` rc=0、`npx tsc -p scripts/tsconfig.json` rc=0。

## Needs-Human

**执行 2026-09-24T17:18:27.278Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：43cfb38a-421b-4238-97f6-03efe9e97d9b
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac103-worktree-state-drag-and-unbudgeted-confirm~wk-prod-anchor~1790270229484-e6744d.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-ac103-worktree-state-drag-and-unbudgeted-confirm-wk-prod-anchor.log
