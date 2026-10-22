---
id: gap-resident-ui-layout-criterion-bounded-boot-guard
title: AC-177 判据的启动阶段无界：一次渲染器侧模块加载中断（net::ERR_NETWORK_CHANGED 实测 10 连发）被拖到夹具项目行
  30s 超时记红——本族既有的有界预热+启动探针未回灌到 e2e/resident-ui-layout.spec.ts
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-177
---
## Proposal

来源：本轮 gap-filing 的直接测量，不是台账尾巴。AC-177 已离开 reverify 范围（其 GOAL-013 已 achieved、不再活），且未声明 `long-term: true`，台账尾部记为 CURRENTLY FALSE；本轮在立案前直接重跑了判据本身，并读失败轮的 trace，而不是台账 `reason` 里那条 stderr 尾巴。

判据命令（不变）：`npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"`。门限不变：driver-anchor 下 `runAcceptance({ timeoutMs: 6e4 })` 的硬 60s；spec 自身另有 `playwright.config.ts:317` 的 `SINGLE_SPEC_CEILING_MS = 55_000`。

**红的原始读数（读失败轮的 trace，不读台账 `reason` 的 stderr 尾巴）**

- 失败轮目录 `/data/scratch/yale/quay-e2e-5xRz5q`（对应台账 goal-sweep 那条 `2026-09-30T10:40:21.504Z` 的 AC-177 fail）与 `/data/scratch/yale/quay-e2e-Lq9APg`（对应 goal-cli `2026-09-30T10:43:12.520Z` 的 fail）。两轮 `test-results/.last-run.json` → `"status":"failed"`，且都只失败**一个**用例：`resident-ui-layout.spec.ts >> resident ui layout >> the popover close is reachable at a narrow viewport and closes the process`。
- 两轮 `test-results/resident-ui-layout-residen-2769e-port-and-closes-the-process/error-context.md` 逐字相同：`TimeoutError: locator.waitFor: Timeout 30000ms exceeded.` / `waiting for getByRole('button', { name: /^resident-ui-layout-workspace/ }).first() to be visible`，代码帧落在 `e2e/resident-ui-layout.spec.ts:697` 的 `revealSession`（`projectRow(...).waitFor({ state: 'visible', timeout: 30_000 })`）—— 夹具的项目行始终没出现，一个读数都没取到。
- `Lq9APg` 的 trace（同目录 `trace.zip`，其 `3-trace.network` / `6-trace.network`）逐条：`http://127.0.0.1:26247/` → 200、`/src/main.tsx` → 200、`/src/App.tsx` → 200，紧接着**一批在途模块请求以 `net::ERR_NETWORK_CHANGED`（status `-1`）收场**——`src/shared/context/ThemeContext.tsx`、`src/shared/context/UiPreferencesContext.tsx`、`src/modules/auth/index.ts`、`src/modules/task-master/index.ts`、`src/shared/context/WebSocketContext.tsx`、`src/modules/plugins/index.ts`、`src/modules/project-workspace/index.ts`、`src/modules/i18n/config.ts`、`src/modules/i18n/LanguageSelector.tsx`、`src/modules/i18n/languages.ts`（共 **10** 条，一笔未落地）。**没有 504**（trace 里无 `Outdated Optimize Dep`），**全程没有 `[vite] connected`** ⇒ 是宿主网络抖动那条路，不是 `504 Outdated Optimize Dep` + Vite 客户端 `location.reload()` 那条老路。

**已排除（都量过，不要再走一遍）**：不是冷预打包 —— 失败轮的 `vite-cache/deps` 文件数与通过轮一致；不是 504 dep-reopt 路径（见上）；不是磁盘 —— e2e 暂存卷 available-bytes 3.67 TB。

**机制（本仓能修的那一半）**：触发源在渲染器之外 —— Chromium 的 `net::ERR_NETWORK_CHANGED` 把应用在途的模块请求整批打断（本机 docker/veth 变动是网络变更通知的真实来源），页面停在 boot 中途：shell、`main.tsx`、`App.tsx` 已 200，但模块图未执行、React 未挂载，夹具项目行永不出现。`e2e/resident-ui-layout.spec.ts` 的启动路径既没有客户端预热、也没有有界启动探针（本轮实测 `grep -c warmClientStartup` = **0**、`grep -c navigateBounded` = **0**）：文件里 `page.goto` 共 4 处（`:303` 的 `openSession` 助手、`:752` 的 describe `beforeAll`、`:1013` 与 `:1048` 的 AC-178 用例），全是有界之外的裸导航；`revealSession` 对项目行的 `waitFor({ timeout: 30_000 })` 是这条路上唯一的等待。于是一次瞬时的模块加载中断被拖成 30s 超时记红，而不是一次自愈的重放。

<!-- dedup-ref -->
**为什么上一次的修法没兜住**：`gap-resident-popover-close-reachable-narrow-viewport`（`goal_ac: AC-177`，**done**，portal 到 `document.body`，提交 `7b0e553d`）把弹层移出被 `overflow:hidden` 裁剪的输入区、让关闭按钮的命中读数在源头上成立，方向是对的 —— 判据连续 8 轮 goal-sweep pass（`2026-09-30T02:35` → `09:39`，`criterionHash` 恒为 `953a10c122926b47`）也证明那次修法成立；但它没有把这一族既有的启动守卫带回本 spec。守卫家族在本仓早已成立、且已回灌到多份兄弟 spec（逐份实测 `grep -c warmClientStartup` ≥ 2）：`e2e/session-filter.spec.ts`、`e2e/transcript-follow.spec.ts`、`e2e/voice-dashscope-written.spec.ts`、`e2e/voice-error-messages.spec.ts`、`e2e/voice-identifier-repair.spec.ts`，以及**同日刚落地的** `e2e/resident-running-view.spec.ts`（`gap-resident-running-view-criterion-bounded-boot-guard`，`goal_ac: AC-173`，**done**，提交 `e963c867`）—— 那是一份同缺陷、同 spec 家族、同宿主触发源的先例。`e2e/resident-ui-layout.spec.ts` 是这一族里下一份「只有封顶、没有守卫」的 spec —— 封顶即 `playwright.config.ts` 的 `BOOT_CEILING_MS` / `RUN_CEILING_MS` / `SINGLE_SPEC_CEILING_MS`，它把红限制在 55s 内、但不给页面里的无界等待一条恢复路径。

**修法（移植既有守卫，不发明新机制）**：把 `e2e/resident-running-view.spec.ts:502-660` 的两个杠杆搬进 `e2e/resident-ui-layout.spec.ts`：

1. **`warmClientStartup(clientUrl)`**（在任何页面的 `context.newPage()` 之前）：对 `/`、`/src/main.tsx`、以及从 entry 文本里解析出的一个本次运行当前的优化依赖 URL，逐 URL 带 deadline 取到 200；非 200 / 超时按 url + status 指名抛错（含「客户端接了连接却不答」）。本 spec 有三条独立启动路径（AC-179 的 `:318` 用例、AC-177 的 describe `beforeAll`、AC-178 的 `:975` 用例），用 worker 内一次性惰性 promise 包住，保证「任何页面之前」只预热一次。
2. **`navigateBounded(page, url, landing, kind)`**（把兄弟版的写死 `/` 泛化成任意 url）：`page.goto(url)` 落进探针函数体；首次探到 `landing` 即返回，探不到就在 deadline 内 `page.reload()` 重放并重探，耗尽则**带页面文本 + `requestfailed` 列表大声抛错**，绝不静默继续。文件里 4 处 `page.goto` 全部改成经它导航：
   - `:303` `openSession` → landing = `.chat-messages-pane`（PANE；其后的 `expect(page.locator(PANE)...).toBeVisible` 一字不动）；
   - `:752` describe `beforeAll` → landing = `projectRow(page, workspaceName)`（其后的 `revealSession` 不动）；
   - `:1013` / `:1048` AC-178 用例 → landing = PANE（其后的 `expect(page.locator(PANE)...).toBeVisible` 一字不动）。

预热与探针留在 spec 内，不动 `playwright.config.ts`：`globalSetup` 需要一个 `e2e/*.ts` 新文件，会触发 lint 边界（与 `gap-session-filter-criterion-bounded-boot-guard`、AC-173 同一条理由）。

⛔ 不变式：判据命令不改；60s 门限与 55s spec 上限不动；三个用例的 `expect` 一字不动（`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c '^-.*expect('` = 0）；不加 Playwright `retries`；不开 `reuseExistingServer: true`；不 stub、不 skip；不把 AC-177 的真实点击 + 宿主读回、1440x900 正控制、注入覆盖元素假形态搬走。守卫只允许**重放导航**，不允许替用例下任何结论 —— 探针探不到时必须红，而且红得可读。

取假形态：把守卫写成「探不到就当已就绪继续跑」时，AC-177 用例会在空白页上等满自己的 30s `expect`，整轮必然越过 55s spec 上限 / 60s 门限记红 —— 这就是守卫没有变成静默放行的证明（见 AC6）。

## AC

- [x] AC1 有界客户端预热真实生效：`e2e/resident-ui-layout.spec.ts` 里有 `warmClientStartup`（或等价命名）的定义、与「任何页面之前」的调用，逐 URL 带 deadline，非 200 / 超时按 url 指名抛错。验证：`grep -n "warmClientStartup" e2e/resident-ui-layout.spec.ts` 同时命中定义行与调用行，且 `npx playwright test e2e/resident-ui-layout.spec.ts --list` 退出 **0** 并列出三个用例（该文件不在 `tsconfig` 的 `include` 里，typecheck 对它恒为空读数，故以 Playwright 自身加载为准）。
- [x] AC2 每一次导航都走同一个有界探针：`grep -n "page\.goto(\|page\.reload(" e2e/resident-ui-layout.spec.ts` 的每一处行号都落在 `navigateBounded`（或等价探针）函数体内部，函数体外没有任何裸导航；探针耗尽预算时抛出携带页面文本与 `requestfailed` 列表的错误。验证：上述 `grep -n` 输出逐行落界（应恰为探针函数体内的 4 处）+ `--list` 退出 **0**。
- [x] AC3 有界失败的实测：把探针落点临时指向一个不可能存在的 sentinel 后，`npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"` 在 **30s 内**以非零退出，且输出里带页面文本与失败请求列表；还原后该读数与还原读数一并登记。验证：两次运行的 `echo $?` 与 wall time。
- [x] AC4 判据在负载下连续绿：`npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"` 连续 ≥5 次全部 `exit 0`，且每一次 wall < 55_000ms（一次都不触发 55s 看门狗 / 60s 门限），其中至少一次与 ≥4 份兄弟 spec 并发。验证：逐次 `echo $?` + wall time。**如实登记**：本机负载高（实测 load1 > 30），并发那一次若兄弟 spec 自己红，须点名归因，不得算到本条头上。
- [x] AC5 判定面未变：`git diff develop -- package.json playwright.config.ts` 为空（无 `test:e2e` / `RUN_CEILING_MS` / `BOOT_CEILING_MS` / `SINGLE_SPEC_CEILING_MS` 的增删），且 `git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c "^-.*expect("` 为 **0**。验证：两条命令的逐字输出。
- [x] AC6 守卫不是静默放行（承重的负控制）：把探针改成「探不到就当已就绪继续跑」后，判据命令退出**非 0**（AC-177 用例在空白页上等满自己的 30s `expect`，整轮越过 55s spec 上限 / 60s 门限）；登记失败读数（越限的 wall、看门狗 / 门限行逐字）；恢复后判据回绿。验证：变异跑与还原跑的 `echo $?` + wall。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-177 的台账尾部不再是 CURRENTLY FALSE）。且这条绿不是「恰好那次没抖」—— AC4 的 ≥5 连绿（含一次 ≥4 份兄弟 spec 并发）的逐次 wall/exit 读数写进完成记录；AC3 的有界失败读数（探不到时 <30s 红、带页面文本与失败请求列表）以及还原后的读数一并登记；AC6 的负控制读数（探不到就继续 ⇒ 越过 55s/60s 记红）与还原读数一并登记。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿；三个用例的 `expect` 一字未改由 AC5 机械证明。完成记录里必须写明：本仓修掉的是**响应方式**（无界等待 → 有界重放），触发源（宿主层 `net::ERR_NETWORK_CHANGED`，本机 docker/veth 变动）不在本仓可控范围内 —— 因此这条判据的稳定性依赖守卫，而不是依赖触发源消失。

## Touches

- e2e/resident-ui-layout.spec.ts
- tasks/gap-resident-ui-layout-criterion-bounded-boot-guard.md

## Completion record

修法：把 `e2e/resident-running-view.spec.ts` 的两个既有杠杆移植进 `e2e/resident-ui-layout.spec.ts` —— 有界客户端预热 `warmClientStartup`（worker 内一次性惰性 promise，任何 `context.newPage()` 之前）与单一有界导航探针 `navigateBounded(page, url, landing, kind)`；文件里 4 处 `page.goto` 全部改为经探针导航。判据命令、60s 门限、`SINGLE_SPEC_CEILING_MS=55_000`、三个用例的 `expect` 一字未改（AC5 机械证明）；不加 `retries`、不开 `reuseExistingServer`、不 stub、不 skip。本仓修掉的是**响应方式**（无界等待 → 有界重放）；触发源（宿主层 `net::ERR_NETWORK_CHANGED`，本机 docker/veth / 网络变更通知）不在本仓可控范围内 —— 该判据的稳定性因此依赖守卫，不依赖触发源消失。

AC1 机械读数：`grep -n warmClientStartup e2e/resident-ui-layout.spec.ts` 命中定义行 330 与调用行 391（包装器内的 `warmClientStartup(clientUrl)`），另有两处「任何页面之前」的调用：532（`openPage` 顶部，早于 `browser.newContext`）、1000（AC-177 describe 的 `beforeAll`，早于 `newContext`）。`npx playwright test e2e/resident-ui-layout.spec.ts --list` 退出 0，列出 3 个用例（575 / 1029 / 1242）。

AC2 机械读数：`grep -n "page\.goto(\|page\.reload(" e2e/resident-ui-layout.spec.ts` 恰 2 行 —— 500（`page.goto(url, …)`）与 502（`page.reload(…)`）—— 均在 `navigateBounded` 函数体（487–523）内，函数体外无任何裸导航。**如实登记**：该 grep 是 **2** 行（探针内每个原语一次），不是 4 行；本案的「4 处」是被守卫的 4 个导航调用点（`navigateBounded(` 于 555 / 1015 / 1280 / 1320）。探针耗尽预算时抛出的错误携带页面文本与该轮 `requestfailed` 列表（见 AC3/AC6 的逐字错误行）。

AC3 有界失败：把 AC-177 `beforeAll` 的落点临时换成不可能出现的 sentinel（`[data-sentinel-never-mounts]`）后，`npx playwright test e2e/resident-ui-layout.spec.ts -g "close is reachable"` → EXIT=1，WALL=21993ms（<30s），错误逐字 `the project row for resident-ui-layout-workspace never rendered, so this run's client never came up to a document that stays: the page shows "CloudCLI\\nStar\\n13.9k\\nProjects\\n…"; console errors: <none>; failed requests: <none>`。还原后 EXIT=0，WALL=11758ms。

AC4 负载下连续绿（判据命令，逐次读数）：

| 次 | 形态 | exit | wall |
|---|---|---|---|
| 1 | 单独 | 0 | 12299ms |
| 2 | 单独 | 0 | 11474ms |
| 3 | 单独 | 0 | 11595ms |
| 4 | 单独 | 0 | 11666ms |
| 5 | 单独 | 0 | 11418ms |
| 6 | 与 4 份兄弟 spec 并发（load1≈28–31） | 0 | 12549ms |

并发那一次同时跑 `resident-running-view`（3 passed）、`session-filter`（5 passed）、`transcript-follow`（rc=1）、`voice-error-messages`（1 passed）。**归因**：`transcript-follow` 的红是它自己的 55s 单文件看门狗越限（日志逐字 `[e2e] watchdog: this run crossed its own 55000ms ceiling at 55001ms and is ending here with exit 1 at 55004ms — stuck at stage "browser-launch-or-cases"`），发生于 5 路并发之下，属兄弟 spec 自身预算 + 宿主负载，不是本任务 delta（本任务只改 `e2e/resident-ui-layout.spec.ts`）；判据本身在同负载下绿。

AC5 判定面未变：`git diff develop -- package.json playwright.config.ts` 为空；`git diff develop -- e2e/resident-ui-layout.spec.ts | grep -c "^-.*expect("` = 0。

AC6 守卫不是静默放行：把探针耗尽路径由 `throw` 改为「探不到就当已就绪继续跑」（`return`），并注入触发源（`serviceWorkers: 'block'` + `page.route('**/src/main.tsx*', r => r.abort('failed'))`，等价于一次模块加载中断）后 → EXIT=1，WALL=51637ms，失败形式是**裸** `TimeoutError: locator.waitFor: Timeout 30000ms exceeded`（落在 `e2e/resident-ui-layout.spec.ts:951` 的 `revealSession`），无归因。同一注入下保留守卫（`throw`）→ EXIT=1，WALL=21829ms，错误带页面文本与失败请求列表：`the project row for resident-ui-layout-workspace never rendered, …: the page shows ""; console errors: Failed to load resource: net::ERR_FAILED …; failed requests: http://127.0.0.1:12189/src/main.tsx — net::ERR_FAILED | …`。还原后 EXIT=0，WALL=11758ms。**如实登记两点**：(a) 该负控制只在**空白页**下才咬人 —— 在健康客户端上单独做「静默继续」变异是 no-op 绿（sentinel 落点 + 静默继续仍绿，因为用例自身的真实选择器是兜底），故负控制必须连同触发源一起注入；(b) 注入时必须 `serviceWorkers: 'block'`：Playwright 的 `page.route` 不拦截 Service Worker 发起的取，`public/sw.js` 的 network-first 分支会把被 abort 的 entry 从网络重新取回，否则注入被 SW 救活、变异仍绿。

DoD：真落地的裁决（driver 下一轮 goal-gate 重跑该判据翻绿并写入 `.quay/gate-events.jsonl`）由 driver 完成；本轮登记的是判据本身的逐次读数（AC4 表）与三处变异/还原读数（AC3 / AC6）。
