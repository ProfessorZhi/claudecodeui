---
id: gap-e2e-shared-vite-dep-cache-invalidates-inflight-page
title: AC-121 判据在并发 e2e 下偶发假红：所有 checkout / worker 共用 node_modules/.vite
  依赖缓存，一个运行的重预构建把另一个在飞行页面的依赖图作废（504 → ChatInterface 错误边界 → composer 缺席）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-121
---
## Proposal

**本轮的直接测量（不是台账尾巴）**：driver 的 goal-cli 在 `2026-09-23T06:08:02.327Z` 记 AC-121 `fail`。该次运行的现场产物还在，红因可以逐行指认 —— 它**既不是判据本身的缺陷，也不是上一轮修复的回归**。

**现场（可直接复核）**：`/data/scratch/yale/quay-e2e-nZOkjk/test-results/voice-trim-the-voice-path--69d20-plete-when-the-switch-is-on/`（`error-context.md` + `trace.zip`，run dataDir 的 mtime `14:07:46`，与 14:08:02 的 fail 同一次运行）。

- `error-context.md`：`expect(locator).toBeVisible() failed — Locator: locator('[data-slot="prompt-input-textarea"]') / Error: element(s) not found`，落在 `e2e/voice-trim.spec.ts:470`（`openComposer` 里那一次 `toBeVisible`）。页面快照显示侧栏、项目、会话、workspace tab 全在，**聊天面板换成了 app 自己的错误边界**：`heading "Something went wrong"` + `An error occurred while loading the chat interface.` + `button "Try Again"`。
- `trace.zip` 的 `3-trace.trace` 控制台，按时间顺序：
  - `Failed to load resource: the server responded with a status of 504 (Outdated Optimize Dep)` ×4
  - `The above error occurred in the <ChatInterface> component: … at ErrorBoundary (…/node_modules/.vite/deps/react-error-boundary.js?v=b031e593) at WorkspaceErrorBoundary (…/src/modules/project-workspace/WorkspaceErrorBoundary.tsx:138:3)`
  - `ErrorBoundary caught an error: TypeError: Cannot read properties of null (reading 'useMemo') at useMemo (…/node_modules/.vite/deps/chunk-CUGJLZHG.js:1094) at useDropzone (…/node_modules/.vite/deps/react-dropzone.js?v=b031e593:2802) at useChatComposerState (…/src/modules/chat/hooks/useChatComposerState.ts:434)`

即：**页面在飞行中被重新预构建的依赖图切断了** —— 同一次加载里混入不同 `?v=` 的 chunk，React 的 dispatcher 变 `null`，`useDropzone` 里的 `useMemo` 抛错，`ChatInterface` 的错误边界接住，composer 永不渲染，`openComposer` 在 15s 上限处红。这与既有记忆 `e2e-vite-shared-dep-cache-504-blank-page` 记的是同一个机制，**但症状不同**：不是空白页，而是 app 自己的错误边界。所以 spec 里针对「空白页 + `#username`」的冷加载重试（`e2e/voice-trim.spec.ts:684` 起，注释里已写明这条共享缓存机制）根本看不见它 —— 这次崩溃发生在 onboarding 之后、某一腿 `page.goto` 之后。

**为什么这是资源争用而不是判据缺陷（三条可复核的对照）**：

1. **同一棵树、同一命令，单独跑为绿**：本轮实测 `npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` **连跑 5 次，5/5 `exit 0`**，wall `19.21 / 17.85 / 18.19 / 19.30 / 18.05`s，playwright 自报 `1 passed (17.3~18.7s)`。远在 goal gate 的 60s 上限之内 —— 排除「超时被杀」那条路径。
2. **树的差异为零**：`git diff --stat 9179f394 HEAD` 只有 `tasks/gap-voice-dual-replay-absent-under-shipped-recogniser.md` 一个文件。而 `9179f394`（06:01:38Z）之后的 `06:01:57` / `06:03:53` / `06:06:03` 三次 sweep **全 pass**。06:08:02 的红与代码变化无关。
3. **同刻确有并发的 e2e 运行**：`/data/scratch/yale/quay-e2e-*` 下 `14:07:09` / `14:07:43` / `14:07:46` / `14:08:11`（本机本地时）四个 run dataDir，其中 `14:07:46` 那个就是本次 goal 运行自己（`quay-e2e-nZOkjk`）。

**机制那一跳（仓库侧，可读可验）**：

- 每个 quay worktree 的 `node_modules` 是**指向主 checkout 的软链**（本轮实测：`.claude/worktrees/gap-voice-upload-leg/node_modules -> /data/home/yale/work/claudecodeui/node_modules`），于是 Vite `cacheDir` 的默认值 `node_modules/.vite` 是**所有 checkout、所有并发 worker 共用的一个可变目录**。
- `vite.config.js` **没有**设 `cacheDir`（`grep -c cacheDir vite.config.js` 本轮读数 `0`）；`playwright.config.ts` 的 client webServer（`npx vite --host 127.0.0.1 --strictPort`）只传 `SERVER_PORT` / `VITE_PORT` / `HOST`，**没有任何按运行隔离的缓存目录**，也没有 `retries`（`grep -c retries playwright.config.ts` = `0`）。
- 该共享目录**今天真的在运行窗口内被重写过**：`node_modules/.vite/deps/_metadata.json` 的 mtime 本轮读到 `2026-09-23 14:11:29`，其 `browserHash = b031e593` 正是上面失败 trace 里 `?v=b031e593` 的那一个；同目录还留着一次未完成预构建的孤儿 `deps_temp_c5d410aa/`（mtime `01:46:38`）—— 这是并发预构建互撞的指纹，`gap-e2e-hardcoded-ports-collide` 也记过同类。

**如实登记：本轮未能自造出那次红。** 把同一条命令在 ~1s 内并发起两次（两次的 Vite 服务器都与对方重叠），**两次都 `exit 0`**，且 `_metadata.json` 的 mtime 前后未变（两次运行依赖图相同 ⇒ 没有触发重预构建）。这与机制吻合：作废在飞行页面的**不是「另一个运行」，而是「另一个运行触发的重预构建」**（Vite 在发现未预打包的新依赖时会重写 `_metadata.json` 并换 `browserHash`，此时所有在飞行页面的 `?v=旧hash` 请求得到 504）。所以本条的证据是：**06:08:02 的 trace 里 504 与 dispatcher-null 崩溃的因果链是确定的，而「谁触发了那次重预构建」在本轮无法从产物回溯**。任务不假装复现过它，见 AC4 的写法。

**为什么不把「加重试」当修复**：onboarding 已经为冷加载写了有界重试，这次红恰恰是重试够不着的地方；再往下加一层是把红藏起来。`gap-e2e-hardcoded-ports-collide` 已经把 `reuseExistingServer: true` 与 `retries` 明文列为「不是修复」，`gap-ac101-criterion-concurrency-determinism` 也明文禁止收窄判据自己的上限。同理不改断言、不改 `-g`、不加 `--trace=off` —— 那是把判据改成绿，不是把机制修好。

**同一机制的上游遗产（如实登记，不是本任务的重复）**：`gap-e2e-hardcoded-ports-collide`（done，`goal_ac: AC-027`）**已经点名并明确推迟**了这件事，见其第 85 行：「另一条与端口无关的共享资源：`node_modules` 由 `dispatch-worktree-setup.sh` 软链到主 checkout，故 `node_modules/.vite` 为所有 worktree 共享，其下遗留 5 个 `deps_temp_*` 孤儿目录……本任务**不**把 vite 缓存按运行隔离：那会让每次运行都付一次冷预构建（数十秒），反而制造新的抖动，且不在本任务 AC 范围内；此处仅如实登记，供后续任务取舍。」本任务就是那次「取舍」：**要隔离，但不许把每次运行都变成冷预构建。**

**同机制去重结论**：`task_list` 全文搜索「vite / 依赖缓存 / Optimize Dep / cacheDir / 并发」只命中三条 —— `gap-e2e-hardcoded-ports-collide`（done，端口与 `outputDir`，已把本条推迟）、`gap-ac101-criterion-concurrency-determinism`（done，启动期 `EADDRINUSE→120s→被杀→孤儿` 那条路径）、`gap-vitest-worker-pool-unbounded`（vitest worker 池，与浏览器侧无关）。三者都不是「按运行隔离 Vite dep cache」，本任务不与其中任何一条重复。

### 本任务做什么

让**同一条判据命令在并发下也可靠为绿**：消除「一个运行时对共享 dep cache 的重写会作废另一个在飞行页面的依赖图」这一共享可变状态，同时保住热启动（不回到冷预构建）。

1. `vite.config.js` 的 `cacheDir` 改为**可由环境变量指定**（未指定时保持今天的默认值，保证 `npm run dev` 与既有工具链零变化）。
2. `playwright.config.ts` 给每次运行分配**自己的** dep cache 目录（放在该运行已经私有的 `dataDir` 下，与 `auth.db` / 本次已私有的 `outputDir` 同一处），并在启动前把**主 checkout 那份热缓存拷过去当种子** —— 隔离的是「谁能写它」，不是「要不要付预构建」，于是既不互撞也不回到冷启动。
3. `e2e/voice-trim.spec.ts` **只改失败信息、不改任何断言**：`openComposer` 这类位置在 composer 缺席时，把页面上错误边界的文本与收集到的 `console.error` 一起抛出来，使下一次同因红能自己说出 `504 (Outdated Optimize Dep)`，而不是又一条 `element(s) not found`（今天 gate 记下的失败因由被 500 字符的 stderr 头部挤空，见 `runAcceptance`/`withFailureOutput`）。

边界（不做）：不动 `goals/AC-121-*.md` 的 `criterion` 串；不给 `playwright.config.ts` 加 `retries`；不删/不弱化 `e2e/voice-trim.spec.ts` 的任何断言；不改被测的裁剪链路（`src/shared/voiceTrim.ts`、`src/modules/chat/hooks/useVoiceInput.ts`、`shared/asr/**`、`src/shared/api.ts`）；不改 `ErrorBoundary`/`WorkspaceErrorBoundary` 的行为；不做拖拽/批量上传；不引入新依赖。

## Plan

- **S0 基线（先量再改）**：干净工作树上取三组读数并进 DoD —— (a) 单跑：`npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` 的退出码与 wall；(b) 并发对：同一命令 ~1s 内起两次，两个退出码与两份 wall；(c) `stat -c %Y node_modules/.vite/deps/_metadata.json` 在 (b) 前后的读数。
- **S1 隔离**：`vite.config.js` 读一个新环境变量（例如 `VITE_CACHE_DIR`）作为 `cacheDir`，未设时保持 `node_modules/.vite`；`playwright.config.ts` 在配置求值时取 `path.join(dataDir, 'vite-cache')`，先把主 checkout 的 `node_modules/.vite` 拷进去当种子，再作为 `VITE_CACHE_DIR` 传进 client webServer 的 `env`。改动面收在这两个文件内，`src/` 与 `shared/` 零改动。
- **S2 复核**：重跑 S0 的 (a)(b)(c)，并跑 AC4 的干涉形态（见下）。
- **S3 不回归**：`npm run typecheck`、`npm run lint` 退出 0；`npx playwright test e2e/voice-trim.spec.ts` 整文件（AC-119/120/121/122 全腿）的退出码与逐腿读数记进 DoD。

## AC

- [x] AC1 判据单独跑仍为绿且不超预算：`npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` 退出 0；wall 记进 DoD（本轮基线 5/5 为 `17.3~19.3s`，`1 passed`；gate 上限 60s）。改动不得把它推过 60s。
- [x] AC2 并发对两腿都绿：同一命令在 ~1s 内起两次（第二次的 Vite 服务器与第一次的页面重叠），两个退出码**都是 0**，两份日志各自 `1 passed`。命令原文与两个退出码记进 DoD。
- [x] AC3 隔离是机械可读的，不是「跑得更快」：一次完整运行前后 `stat -c %Y node_modules/.vite/deps/_metadata.json` 读数**相同**（该共享目录不再被任何一次运行写入）；且 `grep -c 'VITE_CACHE_DIR' playwright.config.ts` 与 `grep -c 'VITE_CACHE_DIR' vite.config.js` 各自 ≥ 1；且该次运行自己的 `dataDir` 下确实出现了 dep cache 目录（`test -d` 退出 0）。
- [x] AC4 干涉形态（带正控）：在 AC-121 运行**进行中**，从第二个进程对**共享**目录制造一次重写（例如 `npx vite optimize --force`，或把 `node_modules/.vite/deps/_metadata.json` 覆盖成 `browserHash` 不同的副本），要求：(a) 正控 —— 该共享文件的 mtime 在运行窗口内**确实变了**（前后读数打印，证明干涉真的落地，否则本条空洞）；(b) 该运行仍 `exit 0`。两项读数（mtime 前后值 + 退出码）记进 DoD。⚠️ 干涉只打共享目录，不得打该运行自己的 cacheDir；跑之前用 `pgrep -af '[p]laywright test'` 确认没有别的 e2e 在飞行，避免把干涉泼到别人身上。
- [x] AC5 判据与断言都没有被削弱：`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^goals/'` 输出 `0`；`grep -c "the switch was off and the chain printed a trim reading anyway" e2e/voice-trim.spec.ts`、`grep -c "the chain printed no \[voice:trim\] reading for this capture" e2e/voice-trim.spec.ts`、`grep -c "the switch-on capture printed more than one trim reading" e2e/voice-trim.spec.ts` 各自输出 `1`；且 diff 未给 playwright 加 `retries`（`git diff $(git merge-base HEAD develop)..HEAD -- playwright.config.ts | grep -c '^+.*retries'` 输出 `0`）。
- [x] AC6 不回归：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npx playwright test e2e/voice-trim.spec.ts`（整文件全腿）退出 0 —— 若某一腿因本任务之外的既有原因红，逐条登记红因与该腿单独跑的读数，**不得因此改动该腿**。

## DoD

- **账本翻正**：driver 下一轮直接重跑 AC 记录里的 `criterion`，`.quay/gate-events.jsonl` 里 AC-121 的尾巴由 `2026-09-23T06:08:02.327Z` 的 fail 转回 pass，并在其后**连续多轮** sweep 中保持 pass（并发不再把它偶发打红）。
- **真落地**：不是一个更长的等待，而是**共享可变状态被移除**：一次运行不再写 `node_modules/.vite`，别的运行对它重新预构建也不再能作废它的依赖图。证据是 AC2 的两个退出码、AC3 的 mtime 前后值与 cacheDir 存在性、AC4 的正控落地后仍 `exit 0`。
- **三次读数原文**（命令 + 退出码 + 失败行）：S0 的基线并发对；AC2 修后并发对；AC4 干涉形态的退出码与 mtime 前后值。
- **前提与不可复现项如实登记**：完成记录里必须逐条复述三条对照（单跑 5/5 绿、`9179f394..HEAD` 树差异为零、同刻并发 run dataDir 四个），并写明**本轮未能自造出 06:08:02 那次红**（并发对两次都绿、`_metadata.json` mtime 未变），以及 06:08:02 的现场产物路径 —— 不得把它写成「已复现」。同时写明本任务的红**不是** `gap-voice-trim-default-flipped-by-unregistered-first-adapter`（修复 `9c809952`，fan-in `da6bfd5c`）的回归。
- **L_D 该轴仍暗，理由**：本任务只改 e2e 运行期的资源隔离与失败信息，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：同上 —— 读数是运行期退出码与缓存目录 mtime，不是生成质量轴读数；目标层判据仍由 GOAL-006 的其余判据承担。

### 完成记录（读数原文，2026-09-23 本机）

**根因（本轮实测，比 Proposal 里登记的更进一步）**：Proposal 写「谁触发了那次重预构建在本轮无法从产物回溯」。本轮把它读出来了：`getConfigHash` 把 `root` 计入 `configHash`（`node_modules/vite/dist/node/chunks/dep-CuuNgwUk.js:11234` 附近的 `getConfigHash`，字段 `root: config$2.root`），而 Vite 的 `root` 默认取进程 cwd。worktree 的 cwd 与主 checkout 必然不同 ⇒ **worktree 里的每次运行都判定共享缓存 "stale because vite config has changed" 而重预构建**，不是偶发，是结构性必然。实测该共享 `_metadata.json` 的 `configHash` / `browserHash` 在两组值之间来回翻：

- 主 checkout root：`configHash=1eff4809`、`browserHash=b031e593` ← **`b031e593` 正是 06:08:02 红 trace 里 `?v=b031e593`**（即那次红是「主 checkout 的运行持旧 hash，被一个 worktree 运行的重预构建作废」）。
- worktree root：`configHash=31546897`、`browserHash=06bf98e6`。

**S0 基线（改动前，安静机）**：

- (a) 单跑 `npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` → `exit 0`，wall `19.58s`，`1 passed (18.9s)`。
- (b) 并发对（同命令 ~1s 内起两次）→ `run1 exit=0 wall=19.17s`、`run2 exit=0 wall=18.35s`，两份日志各自 `1 passed (18.6s / 17.8s)`。
- (c) 共享 `_metadata.json`：`before=<absent>` → `after=1790144260`。**基线读数此处有假**：`before` 读不到，因为一次普通的 e2e 运行本身就把该共享目录整个重写了一遍（Vite 写 `_metadata.json` 用「改名 `deps`→`deps_temp_*`、再改名回来」的原子替换，替换窗口内该路径不存在）。这恰好是该机制的直接观测：**改动前，一次普通运行就会重写共享缓存**。

**AC1（修后）**：`npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` → `exit 0`，wall `18.82s`，`1 passed (18.2s)`。60s 预算内。

**AC2（修后并发对）**：同一命令 ~1s 内起两次 → `run1 exit=0 wall=20.00s`、`run2 exit=0 wall=19.56s`，两份日志各自 `1 passed (19.3s / 18.9s)`；命令原文 `npx playwright test e2e/voice-trim.spec.ts -g "AC-121"`（worktree 内，两次 `&` 后台 + `sleep 1`）。

**AC3**：该次运行前后 `stat -c %Y node_modules/.vite/deps/_metadata.json` = `1790144308` → `1790144308`（**相同**）；另一次完整运行 `1790144785` → `1790144785`（**相同**）；`grep -c 'VITE_CACHE_DIR' playwright.config.ts` = `1`，`grep -c 'VITE_CACHE_DIR' vite.config.js` = `1`；该运行的 `dataDir` 下 `<dataDir>/vite-cache/deps` 存在（`test -d` 退出 0，2334 个条目）。

**AC4 干涉形态**：跑前 `pgrep -af '[p]laywright test'` 计数 `0`（安静窗口）。运行进行到 `t+8s` 时，从第二个进程执行 `env -u VITE_CACHE_DIR bash -c 'tail -f /dev/null | npx vite optimize --force'`（worktree 内，即**故意用共享 cacheDir**；stdin 必须是打开的管道，vite CLI 遇 stdin EOF 会静默 exit 0）。

- (a) 正控 —— 共享目录在运行窗口内**确实被重写**：`mtime 1790144308 → 1790144785`、`configHash 1eff4809 → 31546897`、`browserHash b031e593 → 61e3e5cc`、`_metadata.json` 的 sha `579cff1db548 → 04e75af5a627`，且**共享的 chunk 文件本身** `deps/react.js` 的 sha `84250d8977ce → 95babec4de75`。干涉自己的日志含 `Forced re-optimization of dependencies`（exit 0，wall 2.00s）。
- (b) 该运行仍 `exit 0`，wall `19.51s`，`1 passed (18.9s)`。
- 注：`browserHash` 离开 `b031e593` 这一步就是机制本身 —— 主 checkout 的在飞行页面持有的正是该 hash。另：运行自己的 `vite-cache`（`quay-e2e-H1P6mA`，mtime `1790144780`）未被干涉触碰。

**AC5**：`git diff --name-only $(git merge-base HEAD develop)..HEAD | grep -c '^goals/'` = `0`；三条 spec 字符串 grep 各 = `1`；`git diff … -- playwright.config.ts | grep -c '^+.*retries'` = `0`。改动文件仅 `vite.config.js` / `playwright.config.ts` / `e2e/voice-trim.spec.ts` 三个。

**AC6**：`npm run typecheck` 退出 `0`；`npm run lint` 退出 `0`（仅既有 warning）；`npx playwright test e2e/voice-trim.spec.ts` 整文件 → `exit 0`，wall `39.56s`，`4 passed (38.9s)`，逐腿 AC-119 `8.3s` / AC-120 `4.0s` / AC-121 `9.6s` / AC-122 `8.5s`，无一腿因既有原因红。

**种子契约的单独验证**（S1 的正确性，与 AC 无关但决定「不回到冷预构建」是否真成立）：

- 冷预构建实测只加 `~1.2s`（空 cacheDir 首跑 `19.88s` vs 次跑 `18.71s`）—— 故 `gap-e2e-hardcoded-ports-collide` 担心的「数十秒」在本仓库不成立，种子是廉价保险而非命脉，拷贝失败一律退化为冷路径而非让运行失败。
- 拷贝必须只重写 `src`、**不能**动 `file`：Vite 把两者都存成「相对写它的 deps 目录」并在读取时按当前目录还原（`stringifyDepsOptimizerMetadata` / `parseDepsOptimizerMetadata`）。`file` 是 deps 目录**内部**的 chunk 裸名（拷贝已带过来），若也按源目录还原，运行的 chunk 请求会指回共享目录 —— 隔离就破了，sibling 的重预构建又能把 chunk 改名掉。`src` 指向未随拷贝走位的 `node_modules`，必须重算。
- 实测：重写后 `src` 95/95 可解析、0 缺失；`file` 95/95 保持裸名且存在。把这样一份「同 root 的缓存重定位」交给 Vite，它 `ready in 101 ms`（**未预构建**）且 `_metadata.json` 哈希三元组前后不变 —— 即被当作新鲜缓存接受，种子路径成立。

**前提与不可复现项如实登记（照 DoD 要求逐条）**：

1. 三条对照照录：单跑 5/5 绿（`19.21 / 17.85 / 18.19 / 19.30 / 18.05`s）；`git diff --stat 9179f394 HEAD` 树差异仅 `tasks/gap-voice-dual-replay-absent-under-shipped-recogniser.md` 一个文件；同刻并发 run dataDir 四个（`14:07:09 / 14:07:43 / 14:07:46 / 14:08:11`，其中 `14:07:46` 即本次 goal 运行 `quay-e2e-nZOkjk`）。
2. **本轮仍未自造出 06:08:02 那次红**：Proposal 记的并发对两次都绿、`_metadata.json` mtime 未变；本任务修后的 AC2 并发对同样两次都绿。**不得把它写成「已复现」。** 06:08:02 现场产物路径：`/data/scratch/yale/quay-e2e-nZOkjk/test-results/voice-trim-the-voice-path--69d20-plete-when-the-switch-is-on/`。本轮自造出的、与之同机制且可复核的是 AC4 的干涉形态（正控落地：共享 `browserHash` 与 `deps/react.js` 双双被重写，运行仍 `exit 0`），以及本机实测的 `configHash`/`browserHash` 在两组 root 值之间反复翻转。
3. 本任务的红**不是** `gap-voice-trim-default-flipped-by-unregistered-first-adapter`（修复 `9c809952`，fan-in `da6bfd5c`）的回归：那条改的是被测裁剪链路的默认开关，本条红在 `openComposer` 的 composer 缺席，且 trace 里的 `504 (Outdated Optimize Dep)` + `Cannot read properties of null (reading 'useMemo')` 与裁剪逻辑无关。

## Touches

- vite.config.js
- playwright.config.ts
- e2e/voice-trim.spec.ts
- tasks/gap-e2e-shared-vite-dep-cache-invalidates-inflight-page.md


判据退役登记（2026-10-04，人 yale 授权，见 tasks/gap-voice-single-continuous-input-path.md 的 Resolution）：本任务 AC1 与 AC6 的判据都点名 `e2e/voice-trim.spec.ts -g "AC-121"`（AC6 为整文件全腿），该腿随 AC-121 一同退役，判据命令必然 No tests found，不得再把它的红读成本任务的回归。同因：AC5 里对该 spec 的两处字符串读数（grep 计数「the switch was off and the chain printed a trim reading anyway」等）随被删的腿一起归零。本任务修的缺陷（所有 checkout 共用 node_modules/.vite 依赖缓存，被并发运行的重预构建作废）不受影响：AC3 的机械读数（VITE_CACHE_DIR 隔离、_metadata.json 的 mtime 不变）与 AC4 的干涉正控仍然可测，e2e 侧的隔离改由 e2e/voice-continuous.spec.ts 承担（同样经 playwright.config.ts 起隔离 cacheDir）。