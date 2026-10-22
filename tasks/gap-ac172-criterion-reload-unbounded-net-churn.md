---
id: gap-ac172-criterion-reload-unbounded-net-churn
title: AC-172 判据的两处故意 `page.reload()` 重连无守卫：宿主网络抖动（reload 瞬间
  83×net::ERR_NETWORK_CHANGED 突发、无 504）掐断在途模块加载，`.chat-messages-pane` 30s
  超时记红——上一个有界启动守卫（done）明确只覆盖首次导航
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-172
---
## Proposal

来源：本轮 gap-filing 的直接测量（goal-cli，`2026-10-03T21:37:13.206Z`，gate event id `2e6ad405-eb18-4491-92d0-a6782369b32c`）。AC-172 已离开 reverify 范围（GOAL-013 已 achieved、不再活）且未声明 `long-term: true`，台账尾部记为 CURRENTLY FALSE。判据命令不变：`npx playwright test e2e/resident-status-bar.spec.ts`。门限不变：driver-anchor 下 goal gate 硬 60s；`playwright.config.ts` 的 spec 上限 55_000（spec 自身 `elapsed < 55_000` 钉此数）。

**本轮的直接量（不是台账尾巴）**

- 失败轮数据目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-yyZU5g`；`test-results/resident-status-bar-reside-d8f2a-stopping-leaves-the-process/error-context.md` 逐字：`Error: expect(locator).toBeVisible() failed` / `Locator: locator('.chat-messages-pane')` / `Expected: visible` / `Timeout: 30000ms` / `Error: element(s) not found`，失败行 `> 964`（test 2「the walk drives all four states, and stopping leaves the process」）。
- trace `2-trace.trace`：`Page.reload`（call@215）monotonic 20360ms（墙钟 ≈`21:36:42.41Z`）发起、`navigated to "http://127.0.0.1:10765/session/8ace481d-..."` 于 20375ms；随后 `expect('.chat-messages-pane')`（call@217）20565ms 起等 30s，于 endTime 50567ms 抛 `Expect failed`。
- trace `2-trace.network`：reload 文档本身 200；但 reload 瞬间（`21:36:42.4–42.6Z`）共 **167 条资源带 `_failureText`** —— 83×`net::ERR_NETWORK_CHANGED` + 83×`net::ERR_FAILED`（同一事件两种标签）+ 1×`net::ERR_ABORTED`；**全程无 504**。console 逐字 83×`Failed to load resource: net::ERR_FAILED`（monotonic 20444–20453），随后 `[vite] connecting...` / `connected` 与 `SW registered`。整轮 82 条 `/api/*`，**reload 之后为 0** —— 应用入口跑了（SW 注册了），页面内容（`.chat-messages-pane`）再没出现。
- 同窗口直接绿跑：`npx playwright test e2e/resident-status-bar.spec.ts` → `4 passed (32.5s)`，EXIT=0（≈`21:38Z`，author==develop==`a83c8d6f`）——按既有结论，这是间歇宿主抖动的预期补集，不构成矛盾。
- 台账：本 AC 之前**连续 5 轮 pass**（`20:56:50` / `21:05:03` / `21:12:41` / `21:20:23` / `21:28:25`，均 exit 0），`21:37:13` 翻 fail；其间 host load1 从 ~9.5–12 飙到 **44.03–45.71**（`21:35:23–38`），运行窗口内 29–32 → ~20 → 15.96（`21:37:14`）。

**机制**：宿主网络抖动（netlink / docker-veth 变更，仓外触发）在 reload 瞬间成批掐断应用的在途模块请求（83 对 ERR_NETWORK_CHANGED ↔ ERR_FAILED），应用没能 mount。**无 504、无第二次冷预构建 ⇒ 不是 Vite dep-reopt 路径**，客户端预热不是这条红的承重杠杆；能把它变成自愈绿的是**有界的 reload 重放**（家族既有的 `navigateBounded`）。

<!-- dedup-ref -->
**为什么上一次的修法没兜住**：`gap-resident-status-bar-criterion-bounded-boot-guard`（`goal_ac: AC-172`，done）已把 `warmClientStartup` + `navigateBounded` 带进本 spec，但其 AC2 逐字要求两处故意 `page.reload()`（当时 `:793`/`:877`）「保持原样」、守卫「只覆盖启动那一次导航」；spec 自己的注释亦然（现 `:560-562`「the two `page.reload()` calls further down ... are deliberately left as they are; this guard covers the first navigation only」，`:752-753`「stay unguarded」）。于是同一类宿主抖动只是挪到了下一个**无守卫的文档加载**：test 2 的首个故意 reload（现 `:963`，其后 `:964` 的裸 30s `toBeVisible` 即本轮红落点）。

**修法（移植既有守卫，不发明新机制）**：把 test 2 的两处故意 reload（`:963`、`:1044`）改走既有 `navigateBounded(page, landing, 'replay')` —— 落点按各自紧跟的断言取（pane 可见 / mark 到 `busy`），探不到就在其 deadline 内 `page.reload()` 重放（自愈），预算耗尽时**带页面文本 + `requestfailed` 列表大声抛错**，绝不静默继续。预热保持现状（对网络抖动非承重但无害）。⚠️ 不改四态语义、不弱化任何 `expect`、不回退 `gap-claude-resident-status-bar` 已落对的断言。

## AC

- [x] AC1 两处故意 reload 走有界重放：`grep -n "page\.reload(" e2e/resident-status-bar.spec.ts` 的 `:963`、`:1044` 两处均落在 `navigateBounded`（或等价有界重放函数）调用内部；函数体外不再有裸 `page.reload()`。验证：`grep -n` 输出逐行落界 + `npm run typecheck` 退出 0。
- [x] AC2 有界失败实测（承重）：把 reload 的落点临时指向不可能满足的 sentinel 后，`npx playwright test e2e/resident-status-bar.spec.ts` 在 < 55_000ms 内非零退出，输出带页面文本与 `requestfailed` 列表；还原后回到 exit 0。验证：两次运行的 `echo $?` 与 wall time。
- [x] AC3 判定面未变：`git diff develop -- e2e/resident-status-bar.spec.ts | grep -c "^-.*expect("` 为 0；判据命令与 `goals/AC-172-*.md` 的 `criterion:` 逐字一致；`git diff develop -- package.json playwright.config.ts` 为空。验证：三条命令的逐字输出。
- [x] AC4 AC-172 两条假形态仍然红（承重）：(i) 状态条改成读本地状态而不读宿主接口 ⇒ 判据退出非 0，红落在四态那条断言；(ii) 无人轮渲染成用户消息样式 ⇒ 判据退出非 0，红落在无人轮那条断言。恢复后判据回绿。验证：两次变异跑与还原跑的 `echo $?`、失败断言逐字、变异 diff。
- [x] AC5 判据在负载下连续绿：还原后 `npx playwright test e2e/resident-status-bar.spec.ts` 连续 ≥5 次全部 exit 0，且每次 wall < 55_000ms；如实登记宿主 load。验证：逐次 `echo $?` + wall time。

## DoD

真落地标准：把两处故意 reload 移入有界重放后，goal-driver 下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-172 台账尾部不再是 CURRENTLY FALSE），且这条绿在其后**连续多轮**的 round / frozenRecheck 中保持 pass —— 即宿主网络抖动落在 reload 窗口内时不再把它偶发打红。AC1–AC5 的逐字读数（含 AC2 有界失败读数与还原读数、AC4 两条假形态读数与还原读数、AC5 逐次 wall/exit）写进完成记录。⛔ 不得用改断言 / skip / `retries` / 改判据命令 / 改门限换绿；四个用例的 `expect` 一字未改由 AC3 机械证明。完成记录必须写明：触发源（宿主 netlink / docker-veth 网络抖动、ERR_NETWORK_CHANGED 突发）在仓外、不可控；本仓修的是**响应方式**（reload 的无界 30s 等待 → 有界重放），故这条判据的稳定性依赖守卫而非触发源消失；并写明**不是** dep-reopt 路径（全程无 504），预热不是本红的承重杠杆。

## Touches

- e2e/resident-status-bar.spec.ts
- tasks/gap-ac172-criterion-reload-unbounded-net-churn.md

## 完成记录（2026-10-04）

**实现**：提交 `e4703a6c`（分支 `task/gap-ac172-criterion-reload-unbounded-net-churn`，基于 develop `7bb5a0c8`）。只改 `e2e/resident-status-bar.spec.ts`（+24 / −11）：把 test 2 的两处故意 reload 从裸 `await page.reload()` 改为 `await navigateBounded(page, paneLanding, 'replay')`（`paneLanding` 的落点是 `.chat-messages-pane` 可见 —— 文档自己的 mount，与宿主状态无关，故「状态画错」仍由随后的 mark 断言红，不被守卫吞掉）。三处旧注释（`navigateBounded` 的 doc、`:750-753`、两处 reload 各自的注释）一并对齐到「两处重连也走同一守卫」，不再自相矛盾地写「stay unguarded」。

**AC1** `grep -n "page\.reload(" e2e/resident-status-bar.spec.ts` → **仅一行** `:591:        await page.reload({ timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()) });`，落在 `navigateBounded`（`:575`–`:610`）函数体内；函数体外无裸 `page.reload()`（旧的两处已变成`:976`、`:1057` 的 `navigateBounded(page, paneLanding, 'replay')`）。`grep -n "navigateBounded("` → `:760`（first-load）、`:976`、`:1057`（两处 replay）。`npm run typecheck` 退出 **0**（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json`，实测 `real-typecheck-exit=0`）。

**AC2**（有界失败实测）落点临时改为 `appears(page.locator('[data-ac172-impossible-sentinel]'), budgetMs)`：判据 `EXIT=1`，wall **34306ms**（< 55_000），输出逐字 `Error: the chat pane after reconnecting to <armB> never rendered, so this run's client never came up to a document that stays: the page shows "CloudCLI\nStar\nProjects\n…"; console errors: …; failed requests: http://127.0.0.1:5717/api/file-tree/… — net::ERR_ABORTED | …`（页面文本 + `requestfailed` 列表都在）。`git checkout --` 还原后判据 `EXIT=0`、wall **31922ms**。

**AC3** `git diff develop -- e2e/resident-status-bar.spec.ts | grep -c "^-.*expect("` → **0**；`goals/AC-172-*.md` 的 `criterion: npx playwright test e2e/resident-status-bar.spec.ts` 与判据命令逐字一致；`git diff develop -- package.json playwright.config.ts` → **空**。

**AC4**（两条承重假形态，各自 `git diff -- src` 登记、`git checkout --` 还原）：

(i) `ResidentMark.tsx` 的 turn-in-flight 改读本地信号而不读宿主接口 —— `const localTurnInFlight = false; const hostState = readResidentProcessState(host, error !== null); const processState = hostState === 'busy' && !localTurnInFlight ? 'idle' : hostState;`。判据 `EXIT=1`、wall **26567ms**，红**落在四态那条断言**上，逐字 `Error: expect(locator).toHaveAttribute(expected) failed` / `Expected: "busy"` / `Received: "idle"`（`e2e/resident-status-bar.spec.ts:937`，test 2 的 walk）。变异 diff 见本次记录上文的 commit 说明；同 `readResidentProcessState` 的 idle/exited 读数不受影响，故 test 1 全绿、红只落在 busy。

(ii) `MessageComponent.tsx` 的 `rendersAsUser = message.type === 'user' || message.type === UNATTENDED_TURN_MESSAGE_TYPE`（无人轮走用户分支）。判据 `EXIT=1`、wall **32555ms**，红**落在无人轮那条断言**上，逐字 `Error: a turn nobody typed must not wear the user's own bubble style` / `expect(received).not.toBe(expected)` / `Expected: not "user"`（`e2e/resident-status-bar.spec.ts:1122`），同跑打印 `row.class=user isUserStyle=true`（两条无人轮）。user 对照行仍 `isUserStyle=true`，未受影响。

两臂还原后（`git checkout -- src`，`git diff --stat -- src` 空）判据回到 `EXIT=0`、wall **32111ms**（另 AC5 的 5 轮即还原读数）。

**AC5**（负载下连续绿，本机 load1 见下）还原后连续 5 次：`#1 EXIT=0 wall=32078ms load1=9.81`、`#2 32389ms load1=27.08`、`#3 32123ms load1=21.54`、`#4 32177ms load1=16.99`、`#5 32247ms load1=13.66` —— 全部 `exit 0` 且 wall < 55_000ms（无一看门狗 / 60s 门限）。spec 自报 `elapsed=` 分别为 31265 / 31618 / 31372 / 31427 / 31499ms，均 < 55_000。

**触发源与修法定性**：触发源是**宿主 netlink / docker-veth 网络抖动**（reload 瞬间 83×`net::ERR_NETWORK_CHANGED` ↔ 83×`net::ERR_FAILED` 突发），**在仓外、不可控**。本仓修的是**响应方式**：reload 后的无界 30s 等待 → 有界重放（`navigateBounded(..., 'replay')`，探不到就在 deadline 内 `page.reload()` 重放自愈，预算耗尽则带页面文本 + `requestfailed` 列表大声抛错）。因此这条判据的稳定性**依赖守卫**，而不依赖触发源消失。全程**无 504、无第二次冷预构建 ⇒ 不是 Vite dep-reopt 路径**，客户端预热不是本红的承重杠杆（本任务未改预热）。本任务**不**改四态语义、**不**弱化任何断言（四个用例的 `expect` 一字未改，由 AC3 机械证明）、**不**回退 `gap-claude-resident-status-bar` 已落对的断言。
