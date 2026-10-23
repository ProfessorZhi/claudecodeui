---
id: gap-e2e-hardcoded-ports-collide
title: e2e 判据去抖动：playwright 端口按运行分配，消除并发 e2e 互撞造成的 AC-027 假红（判据命令可重复为绿）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-027
---
## Proposal

AC-027 的判据命令 `npm run test:e2e -- e2e/model-library.spec.ts` 今天被驱动器复跑判红（`.quay/gate-events.jsonl` 2026-09-21T07:41:38.803Z goal-sweep fail、07:41:40.141Z goal-cli fail，criterionHash 与上次通过时同为 `7239b0aabc705fcb`，即判据命令没变）。**红因不在被测功能链上，而在判据本身不可重复**：它绿不绿，取决于此刻机器上还有没有别的 e2e 在跑。

实测（2026-09-21，canonical checkout `/data/home/yale/work/claudecodeui`，HEAD `330410fd`）：

- 单独跑，三连全绿，用时 13.5s / 12.9s / 12.7s：

```
  ✓  1 creates a model from the gateway template through the Models page (548ms)
  ✓  2 after a reload the secret is only shown as set and its value is nowhere to be found (1.6s)
  ✓  3 the model is selectable in the composer and the gateway receives the request with its token (1.9s)
  3 passed (13.5s)                     EXIT=0
```

- 只要同时有第二个 e2e 在跑，它**在 0.42s 内**退出 1：

```
  Error: http://127.0.0.1:47101/health is already used, make sure that nothing is running
  on the port/url or set reuseExistingServer:true in config.webServer.
  B_EXIT=1  B_DURATION=0.420655418s
```

机制（`playwright.config.ts:13-14` 与 `:84-105`）：两个端口写死 `47101` / `47173`，且 `reuseExistingServer: false`。端口是**机器级**资源而不是 checkout 级的——任何 worktree、任何 agent 只要跑 `npm run test:e2e`，就与 canonical checkout 的同一对端口互斥；后到者不是跑出一条真实红灯，而是连服务器都起不来。

为什么 07:41 那次红必然是这个机制（三条独立读数）：

1. **1.34s 的间隔本身即证明并发**：两次失败相隔 1.34s，而该判据真跑一次需要 ~13s。串行的两次真实运行不可能只差 1.34s，所以两次运行**重叠**，其中至少一次是瞬间死（实测瞬间死的量级是 0.42s）。
2. **同一签名在 GOAL-004 的六条判据上成批出现**：一次 sweep 内 AC-106..111 各自失败、相邻只差 0.65s（07:39:18.663→22.045 与 07:40:52.757→56.162 两组），而它们每一条也是 e2e 判据；0.65s 与实测 0.42s 的瞬间死同量级。
3. **确实有第三方占着端口**：`.claude/worktrees/gap-transcript-follow-on-content-resize/test-results/.last-run.json` 的写入时间是 15:41:46（该 worktree 的 playwright 运行，`status: passed`），即 15:41:3x–15:41:46 期间那对端口被占用，而驱动器复跑 AC-027 的两次正好落在 15:41:38.8 / 15:41:40.1。

判据记录下来的失败原因串也**不可归因**：`runAcceptance` 只取 stderr **头部** 500 字符（`plugin/scripts/dist/driver-anchor.js` 的 `withFailureOutput` / `boundedExcerpt`），而 playwright 把真正的错误写在 stdout，stderr 头部只有 `NO_COLOR ... FORCE_COLOR` 的 node 警告——所以记录里的 reason 只剩那两行警告，看不出是端口撞了还是断言挂了。本任务顺带把选中的端口写进运行输出，让下一次红可归因。

为什么早先两次修复没挺住（本任务存在的理由）：

- `gap-model-library-browser-e2e`（done）与 `gap-e2e-onboarding-anchor-seeded-transcripts`（done）修的都是**内容**：前者补 spec，后者把登录后置锚点从 `Choose Your Project` 空态换成 app 外壳（commit `eb128a0e`）。
- 两次都没碰端口。所以这条判据从建立起就只在「此刻没有别的 e2e 在跑」时成立——而舰队今天已不再满足这个条件：GOAL-004 的六条判据全是 e2e（AC-106..111），每条都有 filing agent 与 worker 在各自 worktree 里跑 `npm run test:e2e`，驱动器每轮还会复跑它们。

方案（最小切片：只改夹具入口，不动任何 spec、不动被测功能）：

1. `playwright.config.ts` 在配置求值时**按运行分配空闲端口**（用 `node:net` 起一个 `listen(0)` 的临时 server，取回内核分配的真实端口后立即关闭；server 与 client 各分配一个），替换写死的 `47101` / `47173`。`baseURL`、两个 `webServer.env` 的 `SERVER_PORT` / `VITE_PORT` 已全部由这两个常量派生（`vite.config.js:25,39,45-55` 读的正是这两个环境变量），故改动面收在这一个文件内。
2. 保持 `reuseExistingServer: false` **不动**。⛔ 不得改成 `true` 换绿：那会让一次运行静默复用**别人的**服务器，而对方的 `QUAY_E2E_DATA_DIR`、`HOME`、`DATABASE_PATH` 全都不同——那是假绿，比红更坏。
3. 给每次运行独立的 `outputDir`（落在该次运行自己的 `dataDir` 下），使同一 checkout 内的两次并发运行不再互踩 `test-results/`（trace 与错误上下文都落在这个目录）。
4. 配置求值时把选中的两个端口打到 stdout（如 `[e2e] server=… client=…`），让将来任何一次红都能从记录里读出「用的哪对端口」。
5. ⛔ 不得以任何方式削弱判据：不加 `retries`（重试会把真回归掩盖成慢红）、不加 `--grep` / `test.skip`、不删任何断言、`e2e/**/*.spec.ts` 一行不改。

取假形态（必须真跑并留输出）：把两个端口改回写死（其余保持），并发跑两次 `npm run test:e2e` → 必须至少一次以 `is already used` 在 1s 内退出 1；改回按运行分配后，同一并发对必须两次都退出 0。

<!-- dedup-ref -->同区域但不同机制，仅作溯源：`gap-transcript-follow-*`（AC-106..111，todo/ready）是同一并发下的**受害判据**，它们的 Touches 里虽有 `playwright.config.ts`，但写的是夹具播种而不是端口分配；本任务不代它们完成任何 AC。`gap-session-filter-real-browser-e2e`（done）与 `gap-e2e-onboarding-anchor-seeded-transcripts`（done）是上面已说明的前两次内容侧修复。

## AC

- [x] `npm run test:e2e -- e2e/model-library.spec.ts` 退出码 0（AC-027 的判据命令），且运行输出证明它真的跑完（3 passed、wall time ~13s 量级），不是瞬间失败。
- [x] **并发不再互撞（本任务的正面判据）**：同一秒内启动两次 e2e 运行（例如 A 跑 `e2e/model-library.spec.ts`、B 跑 `e2e/model-library-layout.spec.ts`），两次**都**退出码 0；两次输出里各自打印的 `[e2e] server=… client=…` 必须是**不同的**端口对。⛔ 必须真并发（两次启动相隔 <1s、进程时间上重叠），串行跑两次不算证据。
- [x] 抗假变体真跑并留输出：只把端口分配改回写死 `47101` / `47173`（其余不动），同一并发对必须变红，红灯原文含 `is already used` 且失败发生在 1s 内；变体须还原（还原后 `git diff` 只剩本任务的改动）。
- [x] `git diff develop -- e2e/` 无输出（一个 spec 断言都没动）；`git diff develop --name-only` 的全部改动都落在 Touches 内。
- [x] 同一运行内多个 spec 共用同一对动态端口，证明端口贯通 server 与 client 两条 webServer（**判据命令已按不变式收窄，见下方 amendment**）：`npm run test:e2e -- e2e/model-env-kind-explanations.spec.ts e2e/model-library-layout.spec.ts` 退出码 0，输出里 `[e2e] server=… client=…` **只出现 1 次**（整轮只分配一对端口），2 个 spec 文件、5 条测试全部通过。
- [x] `npm run typecheck` 退出码 0、`npm run lint` 退出码 0。

<!-- amendment: AC-5 -->
**AC-5 收窄说明（原判据命令在 develop 上同样不可满足，非本任务引入）。** 原命令把 `e2e/model-library.spec.ts` 与 `e2e/model-library-layout.spec.ts` 放进**同一次运行**。一次运行 = 一对 webServer = 一个 `DATABASE_PATH`，而 `model-library-layout.spec.ts`（文件名排序在前）的 `ensureSignedIn` 会先把账号建好；`model-library.spec.ts` 的 `beforeAll` 却假定自己面对的是首次运行的 Create Account 页（无条件填 `input[type=password]` 的第 0、1 个并点 `Create Account`）。于是它落在登录页、`input[type=password]` 只有 1 个、`nth(1).fill()` 一直等到 60s hook 超时。实测（2026-09-21，canonical checkout `/data/home/yale/work/claudecodeui` HEAD `e3777763`，**develop 原配置、spec 一行未改**，即本任务改动之外的对照）：`EXIT=1`，layout 4 passed，随后 model-library `"beforeAll" hook timeout of 60000ms exceeded`，错误现场页面为 `Welcome Back` 登录页（含 `Your session expired. Please log in again.`）。即该命令在 develop 上同样必红，与本任务无关；而 AC-4 明文禁止改任何 spec，故该命令在本任务范围内不可能满足。AC-5 原本要守的不变式是「一次运行只分配**一对**端口，且这一对同时贯通 server 与 client 两条 webServer」——收窄后的命令用两个**登录态容忍**的 spec 保持这条不变式，且可重复为绿。

<!-- evidence -->
**证据（全部真跑，输出留在 `/tmp/ports-task-evidence/`）。** AC-1/AC-2 用同一条命令取证：同一 shell 内并发启动 A=`e2e/model-library.spec.ts`、B=`e2e/model-library-layout.spec.ts`（PID 698326/698327，间隔 <1s），**A EXIT=0 / 3 passed / 13.71s，B EXIT=0 / 4 passed / 16.12s**，两者在时间上重叠（A 与 B 均存活到 T0+13.7s 之后），端口对分别为 `server=11759 client=2057` 与 `server=7187 client=8315`（互不相同）。AC-3 抗假变体：只把端口改回写死 `47101`/`47173`，两种并发形态都跑过 —— (i) 同一秒内并发启动：抢输的一方 `EXIT=1`、`[WebServer] Error: listen EADDRINUSE: address already in use 127.0.0.1:47101`、`Process from config.webServer was not able to start. Exit code: 1`（总 wall 1.68s，含 ~0.4s 的 npm/node 启动）；(ii) 相隔 5s 启动（复刻 Proposal 里记录的形态）：后到者 **EXIT=1、duration 0.435s**，原文 `Error: http://127.0.0.1:47101/health is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.`，而先到者同一次运行仍 `3 passed / EXIT=0`（两者共存即证明变体下这一对确实互撞）。变体随后 `git checkout -- playwright.config.ts` 还原，还原后 `git status` 干净、配置里已无 `47101`/`47173`。AC-6：`typecheck` EXIT=0；`lint` EXIT=0（仅 pre-existing warning，0 error）。

## DoD

真实落地判据：不是「端口变量被引入了」，也不是「某一次恰好绿」。要求 (a) AC-027 的判据命令在**有并发 e2e 在跑**的条件下仍退出 0——这正是它今天判红的条件；(b) 并发互撞这一机制被正面证伪（两次重叠运行都绿，且各自用了不同的端口对），而不是靠重试或 `reuseExistingServer: true` 遮住；(c) 抗假变体（改回写死端口）真跑变红，证明绿来自端口分配本身。落地后 AC-027 在驱动器下一轮经 `goal_ac: AC-027` 独立核验时不再因并发而翻红。

环境噪声须如实登记：本机 128 核但负载常年 7~11（实测 `/proc/loadavg` = 10.89）。并发跑两次 e2e 时若出现与被测机制无关的红（例如 vite 依赖缓存争用），须写明红因并给出「单独跑为绿」的对照读数，不得把它当作本任务已修好的证据，也不得靠删断言或加重试换绿。

环境噪声登记（2026-09-21 实跑读数）：本轮 `e2e/model-library.spec.ts` 单跑共 6 次，**第 1 次（新建 worktree 后的首次冷跑）以 `"beforeAll" hook timeout of 60000ms exceeded` 判红**、总 wall 65.9s，其错误现场页面已是登录后的 app 外壳且 `Settings` 已打开；随后同一条命令连跑 4 次全部 `EXIT=0`、wall 13s 量级（`3 passed`），并发形态下 2 次也全部 `EXIT=0`。即该红**单独跑时为绿**，是与被测机制无关的冷启动/负载读数，**不作为本任务已修好的证据**。独立旁证：同一条 `model-library-layout` 首条用例在负载高时 5.8s、负载低时 2.2s（同一份代码），而本机负载常驻 `/proc/loadavg` ≈ 10.8~13.9、`/scratch/yale` 下同一分钟内有其他 agent 的多个 e2e dataDir。另一条与端口无关的共享资源：`node_modules` 由 `dispatch-worktree-setup.sh` 软链到主 checkout，故 `node_modules/.vite` 为所有 worktree 共享，其下遗留 5 个 `deps_temp_*` 孤儿目录（2026-09-20 21:47~21:59），是并发 vite 依赖预构建互撞的指纹。本任务**不**把 vite 缓存按运行隔离：那会让每次运行都付一次冷预构建（数十秒），反而制造新的抖动，且不在本任务 AC 范围内；此处仅如实登记，供后续任务取舍。

L_D 该轴仍暗，理由：本段只改夹具的端口分配，不新增领域能力。
L_G 该轴仍暗，理由：同上；判定面由 AC-027 的既有断言承担。

## Touches

- playwright.config.ts
- vite.config.js (仅当并发运行时 vite 依赖缓存需要按运行隔离才写；否则不动)
- e2e/model-library.spec.ts (覆盖面登记，⛔ 不写入；本任务明文禁止改 spec 一行)
- e2e/model-library-layout.spec.ts (覆盖面登记，⛔ 不写入；同上)
- tasks/gap-e2e-hardcoded-ports-collide.md
