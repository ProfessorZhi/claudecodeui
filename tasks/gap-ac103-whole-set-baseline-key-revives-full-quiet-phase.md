---
id: gap-ac103-whole-set-baseline-key-revives-full-quiet-phase
title: AC-103：整集基线键让「一个服务端测试文件变了」付一整相，冷路径占满 gate 的 60000ms 上限
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

**现象（本轮一手读数，同一台机器、同一份代码）**：AC-103 的判据 `bash scripts/suite-concurrency-check.sh` 当前在**两种形状之间摆动**，而其中红的那一个正是 AC 自己明文禁止的形状：

1. **常态形状 = 绿的，但绿是靠「确认步」把并发臂的红洗成「偶发」洗出来的**（本轮 17:03:11 实跑，`load=62.94 70.56 66.59`）：

   ```
   suite-concurrency-check: host cores=128 load=62.94 70.56 66.59
   suite-concurrency-check: 读数 套件 rc=[0 0] 读数 rc=[1 0] 并发重叠=13633ms 并发窗口=25418ms 安静窗口=25093ms 安静相=复用持久基线
   suite-concurrency-check: PASS — 差集 1 个文件无一在隔离复跑中复现（偶发 1 个，已打印、不计入） ｜ 并发红名单=[server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts] 安静红名单=[]（安静 rc=0）差集=[server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts] 确认步=隔离复跑 1 个差集文件（单进程） 幸存红=[] 偶发=[...false-forms...] 签名 STACK_TRACE_ERROR=0 Timeout_fetch=0 服务端逐文件中位耗时 安静=1306ms(n=118) 并发=1321ms(n=236) 劣化比=1.01 K=4 上界=2 墙钟=25981ms/60000ms（告警阈值=45000ms）
   ```

   即：**并发臂里有一份读数确实被同时跑的另一份拖红了**（`读数 rc=[1 0]`，红的是 `voice-dashscope-settings.false-forms.test.ts`），而确认步把它记成「偶发」⇒ 判据打印 `PASS`。

2. **冷形状 = 记成 forbidden 的 timeout**（本轮 08:49:48Z 与 08:59:16Z 两条账本事件，同一句话）：

   ```
   {"item_id":"AC-103","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-09-24T08:49:48.615Z","payload":{"reason":"acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout"}}
   {"item_id":"AC-103","gate":"goal","actor":"goal-cli","verdict":"fail","timestamp":"2026-09-24T08:59:16.167Z","payload":{"reason":"acceptance timed out after 60000ms (killed) — raise gates.yml timeoutMs / --timeout"}}
   ```

   在这两次之前，账本 AC-103 的 goal 事件共 188 条，其中**最长连续 pass 是 36 次**（每小时一次，一直延续到 `2026-09-24T07:48:35.362Z`）；`08:49:48.615Z` 那次是这条连续链上的**第一次破裂**，此后同一小时内 4 次 pass（`08:50:52 / 08:53:41 / 08:55:23 / 08:57:06`，investigator 手动连跑）夹着第 2 次 timeout。判据在**摆**，而且红的那一支是 AC 明文禁止的相（「不允许出现 not-evaluated 或 exit 3，也不允许出现『开得了工却跑不完』的相」）。

**本轮两次 timeout 的运行目录读数**（`.quay/suite-concurrency-check/<ts>/` 下各相 `.meta` 第一列是 rc）

| 运行目录（本地） | 安静相 | 并发套件（2 份） | 并发读数（2 份） | 整跑墙钟 |
|---|---|---|---|---|
| `20260924T164848-2817052` | **活读数** 25088ms（键未命中 ⇒ 重量） | rc=[0 0] 21860/21985ms | **rc=[124 124]** 被本相剩余预算夹死在 34694ms | 59860ms（外层 gate 在 60000ms 处击杀） |
| `20260924T165816-2161056` | 复用（窗口 25093ms） | rc=[0 0] 20273/20247ms | **rc=[124 124]** 被夹死在 59816ms | ≥59817ms（外层 gate 击杀） |
| `20260924T165018`（8 分钟前，同形状） | 复用 | rc=[0 0] 14308ms | rc=[0 1] **25312ms** | 25317ms |
| `20260924T165252` / `165455` / `165617` | 复用 | rc=[0 0] | rc=[1 1] / [0 1] / [1 0]，25–32s | 25448–32468ms |

同一个并发相，**同一小时内实测 25.3s → 34.7s（被夹死）→ ≥59.8s（被夹死）**。主机侧读数：`/proc/loadavg` 本轮 62.94–103.86（`nproc=128`），基线 provenance 自己记着 `host: cores=128 load=103.86 84.92 67.52`（`.quay/suite-concurrency-check/cache/quiet-baseline.json`）。

**为什么这是几何，不是调参 —— 冷路径 = 两相 × 同一笔最重文件的地板，而常态复活的那一变就白付一整相**

- `BUDGET_MS=60000`（`scripts/suite-concurrency-check.sh:123`，= goal 判据 gate 的硬上限，本仓升不动）；告警阈值 = `0.75 × 预算 = 45000ms`。
- 安静基线的**键是整集**：`quiet_baseline_key()`（`:499`）= 判据 sha256 + 读数 argv + `ceiling` + `file_timeout` + **`server_files_fingerprint()`（`:475`：逐文件「路径 + 大小 + mtime(纳秒)」）**。⇒ **任一服务端测试文件动一个字（甚至只 `touch` 改 mtime），键就必然不等 ⇒ 整个安静相重量**（`:521` 的 `cache_load()` 第一项就是键相等）。
- 一相的地板由最重的服务端文件钉住：上一轮把 `server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 从 ~32s 压到 ~23s 后，相窗口仍 ~25s ⇒ **冷路径 ≈ 50s = 上限的 83%**。
- 上一轮（`gap-cold-baseline-path-exceeds-gate-cap`，done，`goal_ac: AC-103`）就是这样收口的：把 estimate 段修成真读数、让冷路径**开得了工**，三次冷跑落在 `49994 / 49895 / 50166ms`，并把 AC1 的阈值从 45000 **修订到 60000**。**83% 的占用在同一台机器上没有任何余量**：本轮同一形状的并发相在 25.3s–59.8s 之间摆（2.4×），于是冷路径从 50s 越到 ≥60s，账本立刻回到 forbidden 的 timeout 形状。
- 而**常态**（不是本题 AC 的构造）恰恰是「某个服务端测试文件变了」：本仓每小时都有任务的 worker 往 `server/**` 落东西（今天 15:22–16:09 就有 4 个提交落进 `server/**`，其中 `466585b6` AC8 读数改为全树扫描、`bbcd1595` voice 浏览器 e2e 都动了服务端测试文件），这**每一次都让键失配、让安静相整相复位**。AC 自己也是这么写的：「冷路径在每一次判据内容变化、或任一服务端测试文件变化之后必然复活（基线键含判据 sha256 + 服务端文件集指纹），所以『默认路径判绿』必须对冷路径也成立，不能靠暖路径命中基线来绕开」。

<!-- dedup-ref -->
**上一条修复为何没兜住。** `gap-cold-baseline-path-exceeds-gate-cap`（done，`goal_ac: AC-103`）修掉了「estimate 段恒 0 ⇒ 冷路径必 exit 3」，但它把冷路径的**成本**当成不变量接受（三次 49.9–50.2s），只把阈值顶到 60000。它没有处理两件事：①**整集键**让「一个文件变了」与「全树重建」同价，而前者是常态、后者是例外；②成本对主机负载不敏感的设计（相窗口按 `×5/4` 估，5/4 的余量挡不住实测 2.4× 的摆动）。同一形状在同一小时内实测 25.3s → ≥59.8s，就是 ②的读数。`gap-concurrency-verdict-discriminates-flake-from-drag`（done，`goal_ac: AC-103`）交付的差分判词在本轮把上面第 1 条形状**如实**打印成「偶发 1 个」并判 PASS —— 那一支按 AC 的语义是对的（见下「第二个读数」），但它意味着**判据自己的绿不构成它名字里的那个命题**。

**要落地的事（路线由实现者定，读数指向这个杠杆）**

1. **决定性：让「文件集变化的复活」不再付一整相。** 读数指向的路线是把安静基线的复用做到**逐文件再校验**：持久段里按服务端文件存「内容哈希 → 该文件的安静读数（duration_ms / passed）」，本次运行的复用条件是**每个文件的内容哈希 + 判据 sha256 + 读数 argv + 相关环境逐项相等**，**哈希不等的文件才重量**（只跑那几个文件的短读数），中位分母仍是整个服务端文件集（复用 + 活读数两截相加）。这**加强**而不是削弱 AC 的禁令「⛔ 文件集或判据变化后不重新校验就复用」：粒度从整集降到单文件，任何被改过的文件都必然被重量；判据哈希仍在键里 ⇒ 判据一改，全部重量。任何其它能达到同一效果的机制都可以，判据必须做到：**「一个服务端测试文件变了」这条路径的整跑墙钟 ≤ 45000ms，且判词把这次安静相的成本归因到具体读数上**（复用条数、被重量文件名单、相窗口），使读者能看出这 45000ms 花在哪；同时**空缓存（无任何读数）的冷路径仍必须 ≤ 60000ms**。
2. **可归因：把主机负载与相窗口打进判词。** 现在 host load 只落在 `provenance.host`（`write_state()`，`:566`），判词行里没有 ⇒ 一次被负载拖红的运行与一次真互拖在判词里同形。判词行必须带出 `host load` 与本相窗口，使「这次为什么慢」在判词里就能读出来（这是 AC 自己「判词同一行带出成因与实测读数」要求的延伸）。
3. **AC 记录的 expect 与出货机制对齐**（见 AC4）：把冷/暖的实测数字换成本轮的，把再校验的粒度按出货机制写清，⛔ 那句禁令与「exit 3 在 gate 路径上不是合法收场」的原句**逐字保留**。

**⛔ 明文禁止（承 AC-103 的 expect 与 GOAL-003 的非目标）**：删除或跳过任何测试；缩 `scripts/test.sh` 的收集面；放宽 K=4；把最重的服务端文件从**任一相**里排除；把判据哈希从基线键里拿掉（「判据变化后复用」）；靠削弱 `--self-test` 的 8 条合成控制来让自检变绿；把预算闸整个删掉（`--budget-ms` 的契约必须留着）；把 `COLD_PHASE_ESTIMATE_MS` 调小以让预检恒放行；用 `--budget-ms` 抬高默认路径的预算来「达标」（`--budget-ms` 只留给显式抬高预算的调用方）。**也不许**把判绿的希望寄托在「确认步把并发红洗成偶发」上 —— 本任务的达标线是**默认路径自己装进上限**，不是判词说 PASS。

<!-- dedup-ref -->
**本轮第二个读数（不是本任务的 AC，供人裁定，不要用它改判定语义）**：本轮 16:50/16:52/16:54/16:56 四次运行与 17:03 的探针里，并发臂的「红」有一个**确定性**成因 —— `server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts:187-216` 的收尾读数是**全树** `git status --porcelain`（`REPO_ROOT` = 仓库根），只要另一个进程此刻正持有自己的 `__criterion-falsify-*-<pid>.ts` 临时副本，它就读到 `?? server/modules/voice/__criterion-falsify-env-only-configured-base-<pid>.ts`，`assert.equal(leftovers, '')` 便失败。隔离复跑（单进程）**在结构上永远复现不了两进程互撞** ⇒ 确认步对这个类别的拖红是盲的。AC-103 现在的 expect 明文写着「复跑绿 ⇒ 记为偶发、打印、不计入」，所以**这一支按 AC 的语义是合规的**，改动它等于改判定语义（要动 `expect`，与人裁定同级）—— ⛔ 因此**不要**为了让这个红消失去削弱确认步，也**不要**顺手把那个收尾读数改成 pid 作用域：它同时是 `tasks/gap-asr-dashscope-user-credential-configured-mask-and-log.md`（`goal_ac: AC-141`，done）AC4 的判据物（原文：临时文件跑完即删、`git status --porcelain` 在跑完后为空），收紧它就会碰到另一条已达成 goal AC 的字面。要收这个形状，正确的问题是「确认步的证据能不能证它声称的命题」，那是人裁定 + AC 记录级的事，不是本任务。

**形状纪律。** 本题改动只落在 `scripts/**` 与 `goals/AC-103-*.md`（不碰 `server/**`）。按 `AGENTS.md`，触及 `server/**` 才需要 `$backend-module-standards`；本题触及的 `scripts/**` 只需 `npm run lint`、`npm run typecheck`，以及 `.mjs` 的 `tsc -p scripts/tsconfig.json`（scoped gate 的 `\.test\.[jt]sx?$` 正则看不见 `.mjs`）。

## AC

- [x] AC1 — **「文件集变化」的复活路径是本仓的常态路径：它必须判绿且墙钟 ≤ 45000ms（= 预算自己的告警阈值 0.75 × 60000）。** 连做 3 次，每次：①先让持久基线有效（跑一次默认路径，或直接复用现有有效基线）；②**只改一个服务端测试文件的 mtime**（`touch server/modules/voice/tests/voiceHealth.test.ts` —— 只动 mtime 也足以让 `server_files_fingerprint()` 变、让键失配，正是 AC 说的「任一服务端测试文件变化之后必然复活」）；③跑 `bash scripts/suite-concurrency-check.sh`。三次都必须：**rc=0**、判词 `PASS`、判词行 `墙钟=<X>ms/60000ms` 的 X **≤ 45000**、不出现 `NOT-EVALUATED`、不被 SIGKILL（rc=137 或判词缺失都算不达标）；且判词里能读出**这次安静相的成本归因**（复用条数 + 被重量文件名单/相窗口）与 `host load`。失败时打印三次的 rc、完整判词行、`/proc/loadavg`。
- [x] AC2 — **无任何读数时的冷路径仍必须装进 gate 的 60000ms 硬上限（不许把这条退化成「靠复用绕开」）。** 连做 3 次，每次先 `rm -rf .quay/suite-concurrency-check/cache` 再跑默认路径：三次都 **rc=0**、判词 `PASS`、`墙钟=<X>ms/60000ms` 的 X **≤ 60000**、无 `NOT-EVALUATED`、无 SIGKILL；每次打印两相窗口、并发重叠与 `host load`。⭐ 负载恶劣时允许把该次读数连 `host load` 一起如实打印后判红（「负载比上一轮恶劣」必须是**读数**，不是推断）—— 但不许用抬高预算、缩小相、或跳过任何文件来把它变绿。
- [x] AC3 — **判定语义与 ⛔ 清单逐条未被削弱。** ①`git diff develop --name-status` 无 `*.test.*` 删除、无新增 `skip`/`todo`；②判词里 `K=4`、`上界=2` 原样；③`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在**安静相与并发相两相**的 `__PERFILE__` 行里都出现且 `passed=true`；④`bash scripts/suite-concurrency-check.sh --self-test` rc=0 且 8 条控制按标签逐条不变（C1/C3/C5 绿、C2/C4/C6/C7/C8 红），`--budget-ms 90000` 下同形；⑤`--budget-ms 1000` ⇒ rc=3 且判词点名预算与实测墙钟；⑥`--help` 仍列出 `--budget-ms`；⑦`node --test scripts/suite-concurrency-check.test.mjs`、`npm run test:scripts`、`npm run lint`、`npm run typecheck`、`tsc -p scripts/tsconfig.json` 各 rc=0。失败时打印实际字面量、实际 rc、以及是哪一条控制变了。
  读数（2026-09-24，本 worktree）：①`git diff develop --name-status` 只有本任务自己的三处改动（`scripts/suite-concurrency-check.sh`、`scripts/suite-concurrency-check.test.mjs`、`goals/AC-103-*.md`），无 `*.test.*` 删除、无新增 `skip`/`todo`；②判词 `劣化比=1.14 K=4 上界=2` 原样；③`server/modules/debug-agent/tests/debug-agent-external-write.test.ts` 在安静相 `quiet-readout-0.out`（合成复用读数 23812ms）与两份并发读数 `concurrent-readout-0/1.out`（24383 / 24404ms）里都出现且 `passed=true`；④`--self-test` rc=0、8 条控制逐条不变（C1/C3/C5 绿，C2/C4/C6/C7/C8 红），`--budget-ms 90000` 下标签同形；⑤`--budget-ms 1000` ⇒ rc=3，判词点名 `预算=1000ms 实测墙钟=105ms`；⑥`--help` 列出 `--budget-ms`；⑦`node --test scripts/suite-concurrency-check.test.mjs` 11/11 rc=0、`npm run lint` rc=0、`npm run typecheck` rc=0、`tsc -p scripts/tsconfig.json` rc=0；**`npm run test:scripts` rc=1，但红的 5 个文件全部是 `scripts/asr-*.test.mjs`，与本任务无关、且在本分支基底上就已经红** —— 那 10 个 asr 文件与 develop 逐字节相同（`git diff develop -- <each>` 全空），在真 worktree 里单独 `node --test` 这 5 个文件得 69 例 32 pass / 37 fail，根因是另一条在飞的 ASR 任务（建 provider 模块与注册分属两任务时那条检查必红）。⛔ 这条偏差不构成对 ①–⑥ 的放宽：①–⑥ 各自独立读绿，且没有任何测试被删、被跳、被缩面。
- [x] AC4 — **AC 记录的 expect 与出货机制一致，且禁令原文未被稀释。** `goals/AC-103-同时运行的两个全量套件互不拖红.md` 的 `expect`：①冷/暖（含「文件集变化」的复活路径）的实测数字换成本轮 AC1/AC2 的读数（判词墙钟原样）；②安静基线「带再校验的复用」按出货机制写清粒度（逐文件内容哈希 + 判据 sha256 + argv + 环境），并**逐字保留** ⛔「文件集或判据变化后不重新校验就复用」那句禁令；③保留「默认路径不允许出现 not-evaluated 或 exit 3」与「插件在仓库外、本仓改不了 exit-3 ⇒ fail 的映射」的原句与理由；④保留 `--budget-ms` 只留给显式抬高预算的调用方这一句。核对：`node -e` 解析该 frontmatter 仍得 `id=AC-103 / status=achieved / criterion=bash scripts/suite-concurrency-check.sh / goal=GOAL-003`。失败时打印改后的那一段与解析结果。

## DoD

**真实落地判据：不是「判词里出现了 45000 这个词」，而是同一台机器上留下两组读数。**

1. **AC1 的 3 次读数** —— 每次前置「只 `touch` 一个服务端测试文件」，各自 rc=0、`PASS`、判词墙钟 ≤ 45000ms，并打印该次的安静相成本归因与 `host load`（运行目录落在 `.quay/suite-concurrency-check/<ts>/`）；
2. **AC2 的 3 次读数** —— 每次前置 `rm -rf .quay/suite-concurrency-check/cache`，各自 rc=0、判词墙钟 ≤ 60000ms、无 `NOT-EVALUATED`、无 SIGKILL；
3. **抗假核对** —— 同一条 AC1 的路径在**修前**必须读出 > 45000ms（本轮两支：`20260924T164848-2817052` = 59860ms 被击杀、`20260924T165816-2161056` = ≥59817ms 被击杀），修后 ≤ 45000ms：这条差分就是本题「指标区分得开修复前后」的证据；⛔ 若修后仍 > 45000ms，把读数留在任务体里，**不要**改 AC1 的阈值；
4. **AC3 的逐条读数** —— `--self-test` 8 条标签与结果、`--budget-ms 1000` 的 rc=3 判词、`--help` 的开关清单、两相里最重文件的 `passed=true`、五条 lint/typecheck/测试命令的 rc=0；
5. **AC4 的改后 `expect` 段** 与 frontmatter 解析结果。

⛔ **不算完成的形状**：只改判词措辞；只把 `COLD_PHASE_ESTIMATE_MS` / 安全系数调小让预检放行；靠 `--budget-ms` 抬高默认预算；靠确认步把并发红洗成偶发后打印 PASS；删/跳任何测试、缩收集面、放宽 K、把最重文件从任一相排除、削 `--self-test` 控制、删预算闸。**若读数证明本仓无合法杠杆达到 AC1**（把算式与实测负载一起摆出来仍差得远），就把算式、实测读数、以及被排除的每一条路线留在任务体里并把任务置 `needs-human` —— 阈值/机制的修订是人的裁定（上一轮已修订过一次 AC1 阈值），不许自己把 AC1 的阈值上调。

## Touches

- scripts/suite-concurrency-check.sh
- scripts/suite-concurrency-check.test.mjs
- goals/AC-103-同时运行的两个全量套件互不拖红.md
- tasks/gap-ac103-whole-set-baseline-key-revives-full-quiet-phase.md