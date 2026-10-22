---
id: gap-canonical-checkout-node-modules-missing-compression
title: 主 checkout 的已安装依赖树缺 compression（已声明并入库）→ 后端起不来 → AC-101 真实浏览器判据整片转红
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

<!-- dedup-ref -->本任务与 tasks/gap-static-assets-compression（done）不是同一机制：那一个是**实现**静态资源压缩（DoD 读数真实、功能本身没问题）；本任务修的是它已提交的依赖在主 checkout 上**没有被安装**，以及由此造成的 AC-101 转红。也不与 tasks/gap-session-filter-real-browser-e2e（done）重复——那一个确实让 AC-101 转绿过（2026-09-20T19:22Z 起连续 11 次 pass），本任务是**回归修复**，不是重做。

### 现象（本轮直接复跑判据测得）

判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 1，且 spec 一条用例都没跑起来——playwright 的 webServer 起不来：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'compression' imported from
  /data/home/yale/work/claudecodeui/server/modules/static-assets/static-assets.module.ts
Error: Process from config.webServer was not able to start. Exit code: 1
```

### 证据

1. `package.json` 第 172 行声明 `"compression": "^1.8.2"`（生产依赖），`package-lock.json` 里有 `node_modules/compression 1.8.2` 及其传递依赖；但 `node_modules/compression` 不存在，`npm ls compression` 退出码非 0、输出 `(empty)`。**已提交的依赖树没有被装到主 checkout。**
2. `npm install --dry-run` 只报 7 个新增包（compression 加 on-headers / compressible / negotiator / ms / debug / @types/compression），说明补上它是一次纯增量、可离线（npm 缓存已命中）的安装。
3. 时间线（`.quay/gate-events.jsonl` 里 AC-101 的 goal gate）：最后一次 pass `2026-09-21T04:33:45Z`；`feat(static-assets): gzip/brotli the dist bundle and SPA entry`（8437e548）`2026-09-21T04:56:57Z` 提交、`05:07:38Z` 机械 fan-in 落 develop；第一次 fail `2026-09-21T05:33:59Z`。这段时间里没有别的 `server/index.ts` 改动。
4. 同一个缺失也让**该功能自己的测试**加载不起来：`npx tsx --tsconfig server/tsconfig.json --test server/modules/static-assets/tests/static-assets.test.ts` 得到 `ERR_MODULE_NOT_FOUND`、`fail 1 / pass 0`。所以 gap-static-assets-compression 自己的 AC#1（`npm ls compression` 退出码 0）在主 checkout 上**现在也是假的**——它当初是在 worker 的 worktree 里量的。
5. 因果已实测闭合：把 `compression@1.8.2` **只**注入到 import 点自己的解析路径（`server/modules/static-assets/node_modules/`，一个临时探针目录，测完已 `rm -rf`，主 checkout 的 node_modules 未被改动）后，同一条判据的 webServer 正常起来，**5 条用例全过、EXIT=0**。也就是说缺失的包是唯一的启动失败根因，spec 本身是健康的。

### 机制（为什么上一次的修复没有留住）

worker 在**任务 worktree**（`.quay/config.yml` 的 `worktree_root`）里跑测试。`dispatch-worktree-setup.sh` 给 worktree 的 `node_modules` 要么是指向仓根的符号链接、要么（仓根没有 node_modules 时）是 worktree 内 `npm install` 出来的真目录，而 `worktree-node-modules-check.sh` 把两种都判为 `OK`。于是**在 worktree 里 `npm install` 得到的依赖只存在于 worktree**：任务自己的 AC（`npm ls compression`）、它自己的测试、以及 fan-in 的全量套件（round 80：`pass 169 / fail 0`）**全部在 worktree 里量的，全部通过**；而**主 checkout 的 node_modules 自 2026-09-20 21:41 起没再被写过**，goal-sweep 又恰好在主 checkout 上复跑 AC 判据。依赖装在一边、判据跑在另一边——这不是实现缺陷，是**判据运行的 checkout 与依赖安装的 checkout 不同**。

### 修法

1. 在**判据实际运行的那个 checkout**（仓根 `/data/home/yale/work/claudecodeui`）补齐已提交的依赖树：`npm install`（或 `npm ci`）。
2. ⛔ 若改在 worktree 里装，必须先确认 `<worktree>/node_modules` 仍是指向仓根的符号链接；**在 worktree 里 `npm install` 会把该链接换成真目录**，那样装出来的依赖到不了仓根，本缺陷原样复发。稳妥做法是直接 `cd /data/home/yale/work/claudecodeui && npm install`，装完再跑一次下面的判据确认。
3. ⛔ 不得用「删掉 compression 依赖 / 去掉 static-assets 的压缩 / 把 import 改成可选」来换绿灯：那会把 gap-static-assets-compression 已完成并实测过的功能（3,061,516 字节 → gzip 886,459 字节、冷加载 11 s → 3 s）退回去。
4. 复跑判据并留输出。

### 不在本任务 AC 内、但请记入完成记录的一件事

本缺陷会复发的根因在仓外：合并进主 checkout 的动作（fan-in 的 `ff`）不会重建已安装依赖树，而主 checkout 正是判据被复跑的地方。仓内可考虑的近似防线是在 `.husky/` 的 `post-merge` 里加一条「package-lock.json 变了就跑 `npm install`」（仓根 `core.hooksPath=.husky/_`，钩子确实生效）。它**不作为本任务的 AC**：fast-forward 合并是否触发 `post-merge`、以及它会不会给每次合并都加上安装开销，都需要先单独实测；用一个未经验证的钩子当防线，会变成「机制存在」式的弱判据。请只在完成记录里如实登记这条建议与你是否试过。

## AC

- [x] 仓根的已安装依赖树自足：在 `/data/home/yale/work/claudecodeui` 下 `node -e "require.resolve('compression')"` 退出码 0，且 `npm ls compression` 退出码 0（当前两者都非 0，输出 `(empty)`）。
- [x] 后端在该 checkout 上真能启动：`npx tsx --tsconfig server/tsconfig.json --test server/modules/static-assets/tests/static-assets.test.ts` 退出码 0（该文件此前因同一缺失 `fail 1 / pass 0`）。
- [x] AC-101 判据本身转绿：`npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0，且输出显示 `5 passed`（真实 Chromium + playwright webServer 启动的真实服务与隔离数据目录）。
- [x] 换的是依赖不是功能：`grep -c "import compression from 'compression'" server/modules/static-assets/static-assets.module.ts` 输出 1，且 `git diff --exit-code develop...HEAD -- e2e/session-filter.spec.ts` 退出码 0（spec 一字未改）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码 0（补齐依赖不引入回归）。

## DoD

真实落地判据：**在 goal-sweep 实际复跑 AC 的那个 checkout（仓根 `/data/home/yale/work/claudecodeui`）上**，`npm run test:e2e -- e2e/session-filter.spec.ts` 真绿，并把该次运行的输出（`5 passed` 那几行）记入任务的完成记录。这不是「文件存在」「脚本 exit 0」式的弱判据：判据本身就是真实浏览器驱动真实服务。取假形态：只把 `compression` 装进 worktree（或把 worktree 的符号链接换成真目录后再在其中安装）时，仓根上 `node -e "require.resolve('compression')"` 仍非 0、判据仍红——本任务必须让**仓根**自足。若在补齐 compression 之后发现还有别的启动失败项，一并记录并修复，不得只报第一个。

L_D 该轴仍暗，理由：本任务是环境/依赖树修复，不新增领域能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上；本任务的验证读数就是判据的 5 passed 与依赖解析的退出码。

## Touches

- tasks/gap-canonical-checkout-node-modules-missing-compression.md
- package.json
- package-lock.json
- e2e/session-filter.spec.ts

## Resolution

**结论：本任务是一条「环境修复」任务，落地物是仓根 checkout 的已安装依赖树，仓内代码写面为 0。** 依赖缺失不是实现缺陷，`gap-static-assets-compression` 的功能与提交内容都没有问题；缺的是把它**已提交**的依赖确实装到判据复跑的那个 checkout 上。

- **落地动作**：在仓根 `/data/home/yale/work/claudecodeui` 执行 `npm install`，补齐 `package.json` / `package-lock.json` 已声明而未安装的 `compression@1.8.2` 及其传递依赖（on-headers / compressible / negotiator / ms / debug / @types/compression）。该次安装的产物时间戳为 `2026-09-21T05:39:36Z`（`node_modules/compression` 与 `package-lock.json` 同一 mtime）。
- **安装是纯补齐，没有改动已提交的依赖声明**：`git status --porcelain` 在仓根只显示 `public/sw.js` 与 `vite.config.js` 两处与本任务无关的既有本地改动，`package.json` 与 `package-lock.json` **零 diff**——即 `npm install` 是按已入库的 lock 物化，没有新增/删除/改版本。
- **未用取巧换绿灯**：未删 `compression` 依赖、未去掉 static-assets 的压缩、未把 import 改成可选（AC4 逐条实测，见 Evidence）。
- **Touches 里另外三条的真实角色**：`package.json` / `package-lock.json` / `e2e/session-filter.spec.ts` 是**哨兵**——本项目里「本任务转绿」的取巧路径只可能从这三个文件走（删依赖、改 spec 断言），把它们声明进 Touches 会让 anti-drift 把任何一处改动报成 out-of-declared。最终实测三者零改动。

## Evidence

**2026-09-21（worker，worktree `gap-canonical-checkout-node-modules-missing-compression`，读数全部取于仓根 `/data/home/yale/work/claudecodeui`，即 goal-sweep 复跑 AC 的那个 checkout）**

- **AC1（依赖解析）**：`node -e "require.resolve('compression')"` → **EXIT=0**；`npm ls compression` → `@cloudcli-ai/cloudcli@1.37.3 └── compression@1.8.2`，**EXIT=0**。另跑 `npm ls --depth=0` → **EXIT=0**、无 `missing`/`invalid` 行，即缺的**只有** compression 一处，不是「第一个」被看到而已。
- **AC2（后端真能启动）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/static-assets/tests/static-assets.test.ts` → `tests 11 / pass 11 / fail 0`，**EXIT=0**（此前同一命令 `fail 1 / pass 0`）。
- **AC3（AC-101 判据转绿）**：`npm run test:e2e -- e2e/session-filter.spec.ts` 在仓根、无人并发时的实测输出：

```
  ✓  1 › the editor previews the rule, saving converges the list, and Show/Hide survive a reload (12.5s)
  ✓  2 › a matching session that is currently selected stays visible under the rule (281ms)
  ✓  3 › a session flagged for attention stays visible under the rule (7.0s)
  ✓  4 › a hidden session found by title search is marked as filtered (1.8s)
  ✓  5 › "hide similar" prefills the derived rule and writes nothing (631ms)
  5 passed (40.7s)
E2E_EXIT=0
```

  同一时刻的独立旁证：`.quay/gate-events.jsonl` 里 AC-101 的 goal gate 在 `2026-09-21T05:43:47.447Z` 由 goal-cli 判 **pass**（`acceptance passed (exit 0)`），即判据在 goal 侧也确实转绿，不是只在 worker 侧看到绿。
- **AC4（换的是依赖不是功能）**：`grep -c "import compression from 'compression'" server/modules/static-assets/static-assets.module.ts` → **1**；`git diff --exit-code develop...HEAD -- e2e/session-filter.spec.ts` → **EXIT=0**（spec 一字未改）。anti-drift 预检：`ANTI-DRIFT OK … 0 actual file(s), all within declared Touches (4 glob(s))`——本任务在仓内**没有**写任何代码文件。
- **AC5（不引入回归）**：`npm run typecheck`（`tsc --noEmit -p tsconfig.json && tsc --noEmit -p server/tsconfig.json`）→ **EXIT=0**；`npm run lint`（`oxlint src/ server/`）→ **EXIT=0**，仅既有 warning，无 error。

### 补齐 compression 之后发现的第二个红因（不是启动失败项，如实登记）

补上 `compression` 后，判据**第一次**复跑仍然是红的，但换了一个形态、且与 compression 无关：

```
Error: apiRequestContext._wrapApiCall: ENOENT: no such file or directory, copyfile
  '…/test-results/.playwright-artifacts-0/traces/<traceId>-recording1.network' ->
  '…/test-results/.playwright-artifacts-0/traces/<traceId>-recording1-pwnetcopy-1.network'
    at e2e/session-filter.spec.ts:168:5   ← test.afterAll 的 page.close()
```

- **已定因，且不是仓内缺陷**：`playwright test` 的 webServer 端口（`playwright.config.ts` 硬编码 47101 / 47173）与产物目录（`test-results/`）在同一个 checkout 里是**单例**。当时 quay 的 goal-cli 正在**并发复跑同一条判据**（进程链实测：`driver-anchor → quay.js → sh -c "npm run test:e2e -- e2e/session-filter.spec.ts"`，PID 4033944，cwd 就是仓根）——`goal-events` 显示它因判据转红而每约 40 s 重试一次（05:41:19 / 05:41:57 / 05:42:35 各 fail 一次）。两个 playwright 进程共用 `test-results/` 与两个端口：一方启动时清空 `test-results/`，另一方的 trace 文件就被删掉，`page.close()` 收尾时按旧路径去 flush 便 ENOENT；端口冲突时后启动的一方直接 `http://127.0.0.1:47101/health is already used`。
- **判据在无人并发时是绿的**：把 trace 关掉（`--trace=off`）单独跑 → `5 passed`、EXIT=0；在等到的安静窗口里**用 AC 原样的命令**（`npm run test:e2e -- e2e/session-filter.spec.ts`、trace 保持 `retain-on-failure`）复跑 → `5 passed (40.7s)`、EXIT=0（即上引 AC3 读数）。goal-cli 自己那一轮也在 05:43:47 转绿后停止重试。
- **因此本任务没有为它改任何仓内文件**：AC-101 的语义（真实浏览器驱动真实服务、5 条用例的断言）与 trace 无关，改 `playwright.config.ts` 去关 trace 属于「改判据换绿灯」，且 `playwright.config.ts` 也不在 Touches 内。这里只登记该并发互撞的事实与复现条件，供后续另立任务（例如给 e2e 的 outputDir/端口加 run 级隔离）判断。

### post-merge 防线建议：实测结论（本任务未采纳、也未落仓）

任务正文把「`.husky/post-merge` 里在 package-lock.json 变化时跑 `npm install`」列为**非 AC 的建议**并要求如实登记是否试过。**试过，且结论是它在 ff 合并上确实会触发**：在 `/tmp` 的一次性探针仓（非本仓）里复现了本仓的钩子布置（`core.hooksPath=.husky/_`，`.husky/_/post-merge` 转发到 `.husky/post-merge`），并让远端**真的前进一个提交**后执行 `git pull --ff-only` → 钩子写出 `POST-MERGE-FIRED`。
（第一次探针的写法是错的，须一并登记：clone 后远端未前进、`pull --ff-only` 输出 `Already up to date`，此时 git 根本不做合并，钩子自然不触发——「没触发」是探针缺陷而非结论；补上真正的前进提交后才得到上面的正结果。）
**未采纳**：它不在本任务 AC 内、`package.json`/`package-lock.json` 之外的钩子文件也不在本任务 Touches 内；滚动的安装开销与「lock 未变时如何快速短路」还需要单独测量。仅登记机制可用。