---
id: gap-session-filter-criterion-bounded-boot-guard
title: AC-101 判据的启动阶段无界：一次渲染器侧模块加载中断（net::ERR_NETWORK_CHANGED，实测 10 连发 / 5 个模块同时
  ERR_FAILED）被拖到 55s 自带看门狗 SIGKILL 记红——本族既有的有界预热+启动探针只活在三份 spec 里，未回灌到
  e2e/session-filter.spec.ts
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
depends_on:
  - gap-voice-false-forms-siblings-pid-attribution
---
## Proposal

来源：本轮 gap-filing 的直接测量，不是台账尾巴。AC-101 已离开 reverify 范围、台账尾部记为
CURRENTLY FALSE，本轮在立案前又直接重跑了判据本身一遍。

判据命令（不变）：`npm run test:e2e -- e2e/session-filter.spec.ts`；门限仍是 driver-anchor 下
`runAcceptance({ timeoutMs: 6e4 })` 的硬 60s。

**两次红的原始读数**（读的是失败轮的 trace，不是台账 `reason` 里那条 stderr 尾巴）：

- 轮 `quay-e2e-KrUH9q`：`t=3737 [vite] connecting/connected` → **`t=6949–6952` 一次 10 连发的
  `net::ERR_NETWORK_CHANGED`** → `t=8183 SW registered` 之后页面再无可用内容。死在 `beforeAll`
  的 onboarding：`locator.fill … waiting for locator('#username')`，记为 `Error: Channel closed`。
- 轮 `quay-e2e-psHPZt`：第一次 boot 正常（`t=5408` 连上、`t=14772` React DevTools、`t=15148` SW）。
  `t=17022` 出现第二次 `[vite] connecting` —— 即 `beforeAll` 第 171 行那次 `page.reload()` ——
  `t=17932` 应用自身的 5 个模块 URL 同时 `net::ERR_FAILED`（`Network.loadingFailed` 侧即
  `net::ERR_NETWORK_CHANGED`），`t=17952 SW registered` 之后再无可用内容；`expandProject()` 的
  `projectRow().click()` 无界等待，`t=55517` 的 `[vite] server connection lost` 是自带看门狗
  SIGKILL 掉 vite 服务的回声。

**整轮读数对照**：两次红 ≈55.4s / 55.6s —— 正是 `playwright.config.ts` 的
`RUN_CEILING_MS = 55_000`（启动阶段对应 `BOOT_CEILING_MS = 40_000`）；通过轮 35.1s / 29.7s，
round-104 recheck 23.6s。两次红都死于启动阶段，5 个用例一个都没跑到。

**已排除（都量过，不要再走一遍）**：不是冷预打包降级 —— 四次运行的 `vite-cache/deps` 文件数都是
2334，与共享缓存一致；不是磁盘（`/data` 剩 3.6T）；不是 cgroup（scope `memory.max=max`、
`oom_kill 0`）；不是 react-syntax-highlighter 请求风暴 —— 失败轮 1307 次、通过轮 1300–1775 次，
同量级；也不是 `504 Outdated Optimize Dep` + Vite 客户端 `location.reload()` 那条老路（两次红的
控制台都没有 504，也没有第二次 `[vite] connected`）。

**机制（本仓能修的那一半）**：触发源在渲染器之外 —— Chromium 的 `net::ERR_NETWORK_CHANGED` 把
应用在途的模块请求整批打断（本机存在 docker/veth 变动，是网络变更通知的真实来源），页面停在 boot
中途。本仓能修的不是触发源，而是**响应方式**：`e2e/session-filter.spec.ts` 的启动阶段既没有客户端
预热、也没有有界启动探针，于是「一次瞬时的模块加载中断」被拖成「无界等待 → 55s 看门狗 SIGKILL →
`Channel closed` → 台账记红」，而不是一次自愈的重放。

<!-- dedup-ref -->
**为什么之前的修法没兜住**：守卫家族在本仓早已成立，但只活在三份 spec 里 ——
`e2e/voice-dashscope-written.spec.ts:330 warmClientStartup` 与
`:264 / :838 STARTUP_PROBE_DEADLINE_MS / STARTUP_RELOAD_PROBE_MS`、
`e2e/transcript-follow.spec.ts:1739 warmClientStartup` 与 `:1874-1882` 的有界 reload 探针
（含 `:1867` 的 `requestfailed` 证据捕获）、以及 `e2e/voice-trim.spec.ts`。
`gap-ac101-criterion-bounded-under-gate-cap`（done）给本判据加了 `BOOT_CEILING_MS` /
`RUN_CEILING_MS` 两道**封顶**，把「整轮跑不完」变成「在 55s 被有归因地杀掉」，但没有给页面里的
无界等待一条恢复路径；`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，本仓唯一提到
`ERR_NETWORK_CHANGED` 的文件）把预热+探针落在它自己那份 spec 里，没有回灌到
`e2e/session-filter.spec.ts`。于是本条判据是这一族里最后一份**只有封顶、没有守卫**的 spec。

**修法（移植既有守卫，不发明新机制）**：把家族既有的两个杠杆搬进
`e2e/session-filter.spec.ts` 的启动路径，并覆盖该 spec 真实存在的**每一次**导航 —— `beforeAll`
第 156 行 `page.goto('/')`、第 171 行 `page.reload()`，以及测试体第 227 行的 `page.reload()`
（第二次红正死在 reload 之后的 boot 上）：

1. **有界客户端预热**（在任何页面之前）：对 `baseURL` 依次取 `/`、`/src/main.tsx`、以及从 entry
   文本里读出的一个本次运行当前的优化依赖 URL，直到 200；每步各自带 deadline，超时或非 200 时按
   url + status 指名抛错（照 `warmClientStartup` 的形态与语义，含「客户端接了连接却不答」也要按名字
   失败）。
2. **有界启动探针**（每次导航之后）：用短预算探「本次导航的落点已经就绪」—— 首次 boot 探
   `#username`，reload 之后探项目行；未就绪就在预算内 `page.reload()` 重放，并收集
   `page.on('requestfailed')` 与 console 证据；预算耗尽时**带页面文本 + 失败请求列表大声抛错**，
   绝不静默继续。

预热与探针留在 spec 内，不动 `playwright.config.ts`：`globalSetup` 需要一个 `e2e/*.ts` 新文件，
会触发 lint 边界（与 `gap-transcript-follow-criterion-boot-dep-reopt-race` 同一条理由）。

⛔ 不变式（与 `gap-ac101-criterion-bounded-under-gate-cap` 的 ⛔ 一脉相承）：判据命令不改；60s
门限不动；5 个用例的 `expect` 一字不动；不加 Playwright `retries`；不开
`reuseExistingServer: true`；不 stub、不 skip；不把过滤搬到客户端；不删 `keepSessionIds`。守卫只
允许**重放导航**，不允许替 5 个用例下任何结论 —— 探针探不到时必须红，而且红得可读。

取假形态：把守卫写成「探不到就当已就绪继续跑」时，5 个用例会在空白页上各自等到自己的超时
（≥120s），整轮必然越过 60s 门限记红 —— 这就是守卫没有变成静默放行的证明。

## AC

- [x] 预热在首次导航之前真实生效：`e2e/session-filter.spec.ts` 里有 `warmClientStartup`（或其等价
      命名）的定义与调用，逐 URL 带 deadline，非 200 / 超时按 url 指名抛错。验证：该 spec 的
      typecheck `exit 0`，且 `grep -n "warmClientStartup" e2e/session-filter.spec.ts` 同时命中定义行
      与 `beforeAll` 内的调用行。
- [x] 每一次导航都走同一个有界探针：`grep -n "page\.goto(\|page\.reload(" e2e/session-filter.spec.ts`
      的每一处行号都落在探针函数体内部，函数体外没有任何裸导航；探针耗尽预算时抛出携带页面文本与
      `requestfailed` 列表的错误。验证：上述 `grep -n` 输出逐行落界 + 该 spec typecheck `exit 0`。
- [x] 有界失败的实测（照 `e2e/voice-dashscope-written.spec.ts:251-255` 的有界失败变体）：把探针落点
      临时指向一个不可能存在的 sentinel 后，`npm run test:e2e -- e2e/session-filter.spec.ts` 在
      **30s 内**以非零退出，且输出里带页面文本与失败请求列表；还原后该读数与还原读数一并登记。验证：
      两次运行的 `echo $?` 与 wall time。
- [x] 判据在负载下连续绿：`npm run test:e2e -- e2e/session-filter.spec.ts` 连续 ≥5 次全部 `exit 0`，
      且每一次 wall < 55_000ms（一次都不触发自带看门狗，`Channel closed` 零次），其中至少一次与 ≥4
      份兄弟 spec 并发。验证：逐次 `echo $?` + wall time 记录。
- [x] 判据命令、门限与断言语义未变：与 develop 的 diff 中 `package.json` 与
      `playwright.config.ts` 无 `test:e2e` / `RUN_CEILING_MS` / `BOOT_CEILING_MS` 的增删，且
      `e2e/session-filter.spec.ts` 的 diff 里删除行不含 `expect(`。验证：
      `git diff develop -- package.json playwright.config.ts` 为空，且
      `git diff develop -- e2e/session-filter.spec.ts | grep -c "^-.*expect("` 为 0。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`
（台账尾部不再是 CURRENTLY FALSE）。且这条绿不是「恰好那次没抖」—— AC4 的 ≥5 连绿（含一次 ≥4 份
兄弟 spec 并发）的逐次 wall/exit 读数写进完成记录；AC3 的有界失败读数（探不到时 <30s 红、带页面
文本与失败请求列表）以及还原后的读数一并登记。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿；
5 个用例的 `expect` 一字未改由 AC5 机械证明。完成记录里必须写明：本仓修掉的是**响应方式**（无界
等待 → 有界重放），触发源（宿主层 `net::ERR_NETWORK_CHANGED`）不在本仓可控范围内 —— 因此这条判据
的稳定性依赖守卫，而不是依赖触发源消失。

## Touches

- e2e/session-filter.spec.ts
- tasks/gap-session-filter-criterion-bounded-boot-guard.md

## 完成记录

**实现提交**：`069c663d`（`e2e/session-filter.spec.ts`，+271 / −7）。改动只落在 Touches 的第一条；
本段由 `task_write` 写进 Touches 的第二条。worktree 分支
`task/gap-session-filter-criterion-bounded-boot-guard`。

**落地形态（移植，不发明）**：家族既有的两个杠杆搬进本 spec 的启动路径 ——
`warmClientStartup(clientUrl)`（形态与语义取自 `e2e/voice-dashscope-written.spec.ts` /
`e2e/transcript-follow.spec.ts`）在任何页面存在之前跑；`navigateBounded(page, landing, kind)` 是本文件
**唯一**导航点，按 deadline 重放导航，预算耗尽时带页面文本 + `requestfailed` 列表大声抛错。三处导航
（`beforeAll` 的首次 goto、`beforeAll` 的 reload、测试体那次 reload）全部改走守卫。5 个用例的 `expect`
一字未改。

**AC1** —— `grep -n "warmClientStartup" e2e/session-filter.spec.ts` 命中两行：
`127:const warmClientStartup = async (clientUrl: string): Promise<number> => {`（定义行）与
`391:    await warmClientStartup(clientUrl);`（`beforeAll` 内调用行）。逐 URL 带 deadline，非 200 / 超时
按 url 指名抛错（含「接了连接却不答」）。`npx tsc --noEmit -p tsconfig.json` → EXIT=0。

**AC2** —— `grep -n "page\.goto(\|page\.reload(" e2e/session-filter.spec.ts` 只有两行：`272:` 与 `274:`，
两行都落在 `const navigateBounded`（260 行起）到其闭合 `};`（295 行）之间；函数体外没有任何裸导航。
`npx tsc --noEmit -p tsconfig.json` → EXIT=0。

**AC3（有界失败，两次读数 + 还原）** ——
(i) `ACCOUNT_FORM_PROBE` 临时改为 `#impossible-sentinel-for-the-bounded-failure-reading`：
`npm run test:e2e -- e2e/session-filter.spec.ts` → **EXIT=1 / wall 25472ms（<30s）**，原文
`Error: the account form (#impossible-sentinel-for-the-bounded-failure-reading) never rendered, so this run's client never came up to a document that stays: the page shows "Create Account\n\nSet up your account to get started\n\nUsername\nPassword\nConfirm Password\n\nAt least 3 characters for username, 6 for password.\n\nCreate Account\n\nThis is a single-user system. Only one account can be created.\n\nCloudCLI is open source"; console errors: Failed to load resource: … 401 (Unauthorized) | … 401 (Unauthorized) | … 401 (Unauthorized) | Failed to check TaskMaster installation status | … 401 (Unauthorized); failed requests: <none>`。
页面文本在，`failed requests` 字段在 —— 但该变体里它是 `<none>`：页面本身健康，只有探针落点被改坏，
本轮**本来就没有失败请求**。如实登记，不把「字段在」写成「有失败请求」。
(ii) 为证明 `requestfailed` 列表真的会被填充（并同时覆盖「导航本身失败」那条分支），另跑一次：探针
里那次 goto 临时指向 `http://127.0.0.1:1/` → **EXIT=1 / wall 25827ms**，原文
`… never rendered, so this run's client never came up to a document that stays (the navigation itself failed: page.reload: net::ERR_UNSAFE_PORT): the page shows ""; console errors: …; failed requests: http://127.0.0.1:1/ — net::ERR_UNSAFE_PORT | http://127.0.0.1:1/ — net::ERR_UNSAFE_PORT | http://127.0.0.1:1/ — net::ERR_UNSAFE_PORT`。
失败请求列表**非空**，三条都在；页面文本读到 `""`（Chromium 错误页无正文），与 (i) 互补。
还原：`git checkout -- e2e/session-filter.spec.ts`；`git status --short` 为空；
`grep -n "ACCOUNT_FORM_PROBE = \|page.goto('"` 回到 `186:const ACCOUNT_FORM_PROBE = '#username';` 与
`272:        await page.goto('/', { timeout: … });`，与提交状态一致。

**AC4（负载下连续绿，逐次读数）** —— 6 次全部 `5 passed`、EXIT=0、wall 均 < 55_000ms、`Channel closed` 零次：

| # | 形态 | EXIT | wall (ms) |
|---|------|------|-----------|
| 1 | 单独 | 0 | 26905 |
| 2 | **与 4 份兄弟 spec 并发** | 0 | 27938 |
| 3 | 单独 | 0 | 29969 |
| 4 | 单独 | 0 | 26582 |
| 5 | 单独 | 0 | 25421 |
| 6 | 单独 | 0 | 22234 |

第 2 次是同一时刻起 5 份：`e2e/session-filter.spec.ts`（判据）+ `e2e/transcript-follow.spec.ts` +
`e2e/voice-trim.spec.ts` + `e2e/voice-dashscope-written.spec.ts` + `e2e/mobile-composer-send-key.spec.ts`。
**如实登记**：那一批里 `transcript-follow` 与 `voice-trim` 各自 EXIT=1、wall 55755ms / 55804ms —— 是
`playwright.config.ts` 自己的 `RUN_CEILING_MS = 55_000` 看门狗把被 5 路并发饿住的整轮结束掉（原文
`ceiling at 55001ms and is ending here with exit 1`），属本机负载产物；本次改动只落在
`e2e/session-filter.spec.ts` 一份文件上，与它们无关。被守卫的**这一份**在同一批里 27.9s 跑完。
6 次运行里守卫都记了自己的工作：`[e2e] client warm-up: pre-bundle committed in …ms` 一次 +
`[e2e] client startup: … landed after …ms (attempt 1)` 三次（首次落 `#username`，两次 reload 落项目行），
**没有一次用到重放** —— 这 6 次都走健康路径，守卫没有替用例放行任何东西。

**AC5（判定面未变）** —— `git diff develop -- package.json playwright.config.ts` 输出为空；
`git diff develop -- e2e/session-filter.spec.ts | grep -c "^-.*expect("` = **0**；
`git diff develop --stat` 只有 `e2e/session-filter.spec.ts | 278 ++++--`（1 file changed, 271 insertions(+),
7 deletions(-)）。没有加 `retries`、没有开 `reuseExistingServer`、判据命令与 60s 门限未动。

**门禁** —— `bash scripts/test.sh --for-task gap-session-filter-criterion-bounded-boot-guard --allow-thin`
→ EXIT=0（scoped 集合为 thin：Touches 里的 `*.spec.ts` 不在 scoped 门读的 `\.test\.[jt]sx?$` 集合内；
`suite-scope-check` PASS）。scoped-gate cache 已写：`--develop-sha 18263d2b99f711901ae714f1fb5e4ba0c377d4f0`，
该 sha 是 HEAD 的祖先。

**如实登记（DoD 点名要写的那一条）** —— 本仓修掉的是**响应方式**：把「一次瞬时的模块加载中断 →
无界等待 → 55s 看门狗 SIGKILL → 台账记成 `Channel closed`」换成「有界重放 → 要么落到 document，
要么带页面文本与失败请求列表大声红」。**触发源不在本仓可控范围内**：`net::ERR_NETWORK_CHANGED` 由宿主层
网络变更通知（本机 docker/veth 变动）产生，本任务既不检测也不抑制它。因此这条判据的稳定性**依赖守卫，
不依赖触发源消失** —— 触发源再出现时，这条判据的行为是「多花一次 reload」，而不是「记一次
`Channel closed`」。

**未关闭的残留（如实登记）** —— 守卫的预算（首次落点 8s、每次重放 3s、单次导航 8s、总 deadline 14s）
是量出来的、不是猜的：健康落点实测 1.2s–3.6s，deadline 对它有 4× 以上余量；同时 14s 的 deadline 是
AC3 那次 25.5s 整轮红能落在 30s 之内的原因。若将来落点在有守卫的负载下稳定超过 ~10s，先量再调 ——
把 deadline 调大就会把 AC3 的 30s 读数顶破。触发源本身（宿主网络抖动）不在本条范围内。

### 2026-09-25 复核轮：那次 suite 红的归因与解除（实现未变）

这一轮的起因是上一轮 `exited-not-landed`：suite 红在 `server/modules/voice/tests/voice-capture-text.false-forms.test.ts`。
**实现提交未变（仍是 `069c663d`），本任务 diff 仍只有 `e2e/session-filter.spec.ts`（271+/7−）** —— 这一轮只做归因、预合并与门禁。

**归因（读真因日志，不读台账 `reason` 的 stderr 尾巴）** ——
`/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-session-filter-criterion-bounded-boot-guard~wk-prod-anchor~1790332379121-02be41.log`
里 `passed=false` **只有一处**：`server/modules/voice/tests/voice-capture-text.false-forms.test.ts`（`duration_ms=27136`）。
该日志的 `not ok` 行引的是它自己的 `falsify/failure-row-dropped mutant: …` **读数行 —— 是一条通过的读数**
（`scripts/test.sh` 的 `first_error()` 抓的是首个含 `failed` 字样的行，而 `why=a failed attempt builds no row` 文本里恰好有
`failed`）；真因因此不在那一行上。同一份读数在本 worktree 单独跑时同样打印、而文件是绿的。

**舰队级证据（20 份日志扫过）** —— `.quay/fan-in-suite-*.log` 共 20 份，其中 **14 份**红在该文件，
横跨 **8 个互不相干的任务**：`gap-ac027-gateway-wait-weaker-than-assertion`、`gap-claude-session-cgroup-scope`、
`gap-mobile-layout-e2e-viewport-matrix`、`gap-session-hosts-default-wrap-four-providers`、
`gap-transcript-follow-ac110-case-nav-skips-boot-guard`、`gap-voice-capture-audio-file`、`gap-voice-error-notice-browser-e2e`、
本任务。这 8 份的 diff 里没有任何一个 voice 文件 —— 与本任务的 `e2e/session-filter.spec.ts` 更无因果关系。

**根因** 就是 frontmatter `depends_on` 里已登记的那条 `gap-voice-false-forms-siblings-pid-attribution`
（现 **done**）：三个兄弟 `*.false-forms.test.ts` 把 `__criterion-falsify-*` 变异临时副本写进**共享的**
`server/modules/voice/`，却按整树 `git status --porcelain` 快照比对，读到邻居在途的副本即红。
本 worktree 单独跑该文件：`npx tsx --tsconfig server/tsconfig.json --test <file>` → **EXIT=0、`tests 6 / pass 6 / fail 0`（39725ms）**。

**预合并** —— `git merge --no-edit develop` → 干净合并（无冲突、无 UU，未手改任何一边）；
`git merge-base --is-ancestor develop HEAD` 成立（HEAD=`40e2e199`，HEAD²=`97458b6f`），
带入 `d5f7904b voice false-forms: attribute the shared directory's temp copies by pid`。
合并后该文件的收尾读数已是修好的形态：
`falsify/leftovers: git.status-clean=true unchanged=true own-temp-copies=none temp-copies-any=0 foreign-temp-copies=0 raw-unchanged=true added=0 removed=0 concurrent-foreign-only=false`。

**并发复现（旧红条件在窗口里真实存在，现已不红）** —— 同时起 5 份兄弟 `*.false-forms.test.ts`
（capture-off / capture-text / error-contract / error-classification / dashscope-settings），**五个全部 EXIT=0**；
其中 3 份的收尾读数记到 `concurrent-foreign-only=true`（`removed=1` / `removed=1` / `removed=2`），
`voice-error-classification` 记到 `concurrent-foreign-copies=1` ——
**即本轮运行窗口里确实有兄弟的在途临时副本**（旧逻辑下正是这一点把该文件记红），现已按 pid 正确放过。

**范围门** —— `bash scripts/test.sh --for-task gap-session-filter-criterion-bounded-boot-guard --allow-thin` → **EXIT=0**
（thin：`no scoped test files for gap-session-filter-criterion-bounded-boot-guard`；`suite-scope-check` PASS，`tasks=196 active=18`）。
scoped-gate 缓存已写：`--develop-sha 97458b6ffefa340164813ef952dc858d3166b323`（= HEAD²，HEAD 的祖先）。

**本轮未做** —— 没有改任何实现、断言、判据命令或门限；没有把 suite 红当成实现缺陷去"修"。
suite 本身仍由 driver 的 fan-in 跑，本任务不自行运行全量 suite。

## Needs-Human

**执行 2026-09-25T10:35:34.278Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=27136 server/modules/voice/tests/voice-capture-text.false-forms.test.ts passed=false end_ms=1790332441827
- run_id：wk-prod-anchor
- session_id：f20f81a3-b465-4a71-affc-f62a92d057de
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-session-filter-criterion-bounded-boot-guard~wk-prod-anchor~1790332379121-02be41.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-session-filter-criterion-bounded-boot-guard-wk-prod-anchor.log

**2026-09-25 复核轮 —— 本条已归因并解除（RESOLVED），上面那条"归因不出任何失败测试文件"的判词不成立。**

- **能归因**：那份 suite 日志里 `passed=false` 只有一处，就是 `voice-capture-text.false-forms.test.ts`；
  之所以此前读不出来，是因为日志引的 `not ok` 行是一条**通过的**读数行（见「复核轮」段的 `first_error()` 说明）。
- **与本任务无因果**：该文件在 20 份 fan-in 日志里红 14 份、横跨 8 个互不相干的任务；本任务 diff 只有
  `e2e/session-filter.spec.ts`。根因是共享目录串扰，即 `depends_on` 里那条
  `gap-voice-false-forms-siblings-pid-attribution`（现 **done**，`d5f7904b` 已在 develop）。
- **旧红条件已复现且已不红**：5 份兄弟并发全部 EXIT=0，其中 3 份记到 `concurrent-foreign-only=true`。
- **门禁**：scoped gate EXIT=0，缓存已写（`--develop-sha 97458b6f…`）。
- 因此本条不再有需要人类介入的阻碍；把它留在正文里只为保留当时的原始判词与日志路径，供审计对照。