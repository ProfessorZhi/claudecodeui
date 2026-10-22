---
id: gap-ac254-boot-guard-mcp-settings-criterion
title: "AC-254 判据 e2e/mcp-settings.spec.ts 启动路径无界：宿主 net::ERR_NETWORK_CHANGED
  打断在途模块加载被拖成 #username 30s 超时；移植 warmClientStartup + navigateBounded 有界启动守卫"
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-254
---
## Proposal

<!-- dedup-ref --> 同机制溯源（本段只作溯源，不声明任何依赖边）：`grep -rn '^goal_ac: *AC-254' tasks/*.md` 只命中两份**已 done** 的任务 —— `gap-ac254-mcp-settings-block-scope-checkboxes`（AC-254 的 UI/scope 出货）与 `gap-ac254-criterion-harden-against-repo-dotenv`（把判据从部署方 `.env` 解耦）。按 `standing-violated` 的规矩，done 不是重复而是「早先那次出货没有守住」的证据，故本条另立新任务。在飞（todo/ready/needs-human）任务里没有任何一份带顶层 `goal_ac: AC-254`（`gap-ac255-mcp-settings-i18n-completeness` 顶层是 `goal_ac: AC-255`，正文里提到 AC-254 只是溯源）。本条的机制与前两份都不同：前两份是「读数 / 环境耦合」，本条是「启动路径无界」。

**红因（本轮直接测量，非台账残影）**

- 台账：`.quay/gate-events.jsonl` 中 AC-254 最近四条 ——
  - `2026-10-06T03:10:38.631Z` verdict=pass treeSha=8c913f5c508f0b78c2bc0f074a49826a1e23036c
  - `2026-10-06T03:13:22.149Z` verdict=pass treeSha=eae097a097deabaa96726b2b98518792760f6370
  - `2026-10-06T03:15:47.995Z` verdict=pass treeSha=eae097a097deabaa96726b2b98518792760f6370
  - `2026-10-06T03:18:31.665Z` verdict=fail treeSha=eae097a097deabaa96726b2b98518792760f6370（reason 被截成 `acceptance failed (exit 1) — [WebServer] [BABEL] Note: …`，尾行不是失败点）
  同一 treeSha `eae097a0…` 先 pass 两次再 fail 一次 ⇒ **是 flake，不是稳定的回归**。本检出 `git rev-parse HEAD^{tree}` 正是 `eae097a0…`（HEAD `1bf3cd8e`）。
- 失败现场（driver 那次运行的数据目录仍在）：`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-092BfG/test-results/mcp-settings-CloudCLI-MCP--72d80--renders-no-connect-command/error-context.md`，逐字：

```
Error: expect(locator).toBeVisible() failed
Locator: locator('#username')
Expected: visible
Timeout: 30000ms
Error: element(s) not found
  281 | const reachAppShell = async (page: Page): Promise<void> => {
> 283 |   await expect(page.locator('#username')).toBeVisible({ timeout: LANDING_TIMEOUT_MS });
```

- 同目录 `trace.zip` 的 `1-trace.network`：导航本身成功（`GET /`、`/src/main.tsx`、`/src/App.tsx` 均 200），紧接着 **9 条在途模块请求以 `net::ERR_NETWORK_CHANGED`（status `-1`）收场**：`@fs/…/deps/react-router-dom.js`、`@fs/…/deps/react-i18next.js`、`src/shared/context/ThemeContext.tsx`、`src/shared/context/UiPreferencesContext.tsx`、`src/modules/auth/index.ts`、`src/modules/task-master/index.ts`、`src/shared/context/WebSocketContext.tsx`、`src/modules/plugins/index.ts`、`src/modules/project-workspace/index.ts`。模块图未执行、React 未挂载 ⇒ `#username` 永不出现 ⇒ 无界的 30s 等待（`LANDING_TIMEOUT_MS = 30_000`，`e2e/mcp-settings.spec.ts:54`）被拖成红。

**机制（本仓能修的那一半）**：触发源在渲染器之外 —— Chromium 的 `net::ERR_NETWORK_CHANGED`（本机 docker/veth 变动是网络变更通知的真实来源）把应用在途的模块请求整批打断，页面停在 boot 中途。`e2e/mcp-settings.spec.ts` 的启动路径既没有客户端预热、也没有有界导航探针：本轮实测 `grep -c warmClientStartup` = **0**、`grep -c navigateBounded` = **0**，文件里唯一的导航是 `:324` 的裸 `page.goto(booted.clientUrl, { waitUntil: 'domcontentloaded' })`，其后 `reachAppShell` 的 `#username` 30s `toBeVisible` 是这条路上唯一的等待。于是一次瞬时的模块加载中断被拖成红，而不是一次自愈的重放。

**为什么早先那次没守住**：`gap-ac254-criterion-harden-against-repo-dotenv` 的 AC6 明确要求「若出现 `net::ERR_NETWORK_CHANGED` 或空白页一类非确定性失败，如实记录并给出修法」，但它只把读数从部署方 `.env` 解耦，**没有**在启动路径上加守卫（所以今天这两个计数仍是 0/0）。

**交付（移植既有杠杆，不新造、不弱化断言）**

1. 把 `e2e/access-tokens-settings.spec.ts` 的两个既有杠杆移植进 `e2e/mcp-settings.spec.ts`（同仓已有实现在该文件 `:43` 的 `warmClientStartup` 与 `:137` 的 `navigateBounded`；`e2e/model-library.spec.ts`、`e2e/session-filter.spec.ts`、`e2e/resident-running-view.spec.ts` 等兄弟 spec 同形）：
   - 有界客户端预热 `warmClientStartup(clientUrl)`：在 `bootState()` 返回（Vite 已 200）之后、`context.newPage()` 之前，对该态自己的 `booted.clientUrl` 预热 shell + `/src/main.tsx` + 一条已优化的 dep，把冷预构建移出测量窗口。
   - 单一有界导航探针 `navigateBounded(page, landing)`：把 `:324` 的裸 `page.goto` 改为经探针导航；landing 用「`#username` 或 Settings 按钮」；探不到就在 ≤14s 预算内 `page.reload()` 重放，超预算则以页面文本 + 失败请求列表**大声红**（不是静默等 30s）。
2. 两态（`MCP_ENABLED` 开 / 关）各自的 `bootState` 都有自己的 `VITE_CACHE_DIR`，所以预热与探针都要按态做（serial 模式下顺序执行）。
3. **不改任何断言**：三个假形态 (i)(ii)(iii) 与 (a)–(e) 读数一字不改；不加 `retries`、不 `skip`、不 stub、不改判据命令、不改 `LANDING_TIMEOUT_MS` 的语义。`server/`、`src/`、`shared/` 零改动。
4. 在文件顶部加注释，指名触发源（宿主 `net::ERR_NETWORK_CHANGED`）在仓库之外，本仓修的是**响应方式**（无界等待 → 有界重放）；守卫的稳定性依赖重放，不依赖触发源消失。

真落地标准：driver 下一轮 goal-gate 重跑该判据翻绿并把 pass 写进 `.quay/gate-events.jsonl`。

## AC

- [x] AC1 红因与「flake 非回归」可复验：贴出 `grep -h '"item_id":"AC-254"' .quay/gate-events.jsonl | tail -4` 的逐字输出，指出同一 treeSha `eae097a0…` 的 pass/pass/fail 序列，并贴 `git rev-parse HEAD^{tree}`（应为 `eae097a0…`）。
- [x] AC2 因可归因：贴失败现场 `error-context.md` 的逐字失败块（`locator('#username')` / `Timeout: 30000ms` / `element(s) not found`，spec `:283`），以及 `1-trace.network` 中 9 条 `net::ERR_NETWORK_CHANGED`（status `-1`）的模块 URL 列表；读者据此能解释「导航成功 + 模块图未执行 ⇒ React 未挂载 ⇒ `#username` 不出现」。
- [x] AC3 守卫已移植：`grep -c warmClientStartup e2e/mcp-settings.spec.ts` ≥1 且 `grep -c navigateBounded e2e/mcp-settings.spec.ts` ≥1；`grep -n 'page.goto' e2e/mcp-settings.spec.ts` 显示导航只出现在探针内（不再有裸 `page.goto(booted.clientUrl` 的启动路径）。贴命令与输出。
- [x] AC4 守卫承重（可证伪）：做一次负控制 —— 把探针改成「不重放、直接返回」或把 `STARTUP_PROBE_DEADLINE_MS` 置 0，令一次加载中断不再自愈 ⇒ 判据红，且红形与 driver 这次同形（`#username` 超时 / 页面证据）；恢复守卫即回绿。逐字记录变异 diff、两次读数、恢复命令。如实登记：driver 那次红的触发源本轮是否能确定性复现；不能则写明用的是「不重放 ⇒ 无界等待复现」这一等价负控制。
- [x] AC5 判据未变宽：`git diff develop...HEAD -- e2e/mcp-settings.spec.ts` 中不出现对 `expect(` 断言行的删改；三个假形态 (i) 写 scope 默认勾选 ⇒ (d) 红、(ii) 关闭态仍渲染接入命令 ⇒ (b) 红、(iii) 命令内嵌真实令牌 ⇒ (c) 红，三条各自只红被指名的读数，逐条记录变异 diff、逐字失败行、恢复命令。
- [x] AC6 稳定性：连续跑判据 ≥5 次都退出 0（写下每次 tests/passed/failed 与 wall）；其中至少一次与 ≥3 份兄弟 spec 并发（抬高负载）仍退出 0。若出现非确定性红，如实记录并给出修法，不得靠放宽读数掩盖。
- [x] AC7 不回归与仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（写下计数）；`e2e/access-tokens-settings.spec.ts`（AC-228）不改一字仍通过。
- [x] AC8 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐；`git diff --stat develop HEAD -- server/ src/ shared/` 输出为空（出货源码零改动），把该输出原样打印。

## Touches

- `e2e/mcp-settings.spec.ts`（移植 `warmClientStartup` + `navigateBounded` 有界启动守卫，路由唯一导航）
- `tasks/gap-ac254-boot-guard-mcp-settings-criterion.md`（本任务自身）

## DoD

driver 的下一轮 goal-gate 重跑 AC-254 判据（`for f in e2e/mcp-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/mcp-settings.spec.ts`）退出 0，并把 pass 写进 `.quay/gate-events.jsonl` —— AC-254 的台账尾部不再是 fail。且这条绿不是「恰好那次没抖」：AC6 的 ≥5 连绿（含一次 ≥3 份兄弟 spec 并发）逐次读数写进完成记录；AC4 的负控制读数（不重放 ⇒ 红在同形 `#username` 超时）与恢复后的读数一并登记；AC5 机械证明三个假形态仍各自只红被指名的读数、且断言行未被改动。完成记录里必须写明：本仓修掉的是**响应方式**（无界等待 → 有界重放），触发源（宿主层 `net::ERR_NETWORK_CHANGED`）不在本仓可控范围内 —— 因此该判据的稳定性依赖守卫，不依赖触发源消失。⛔ 不得用改断言 / skip / `retries` / 改判据命令换绿。

## Evidence

完成记录（worker 在 worktree `task/gap-ac254-boot-guard-mcp-settings-criterion` 上实现；判据提交 `1e995cd1` + `84ef9039`，基于 develop `e89ee2e8`）。**本仓修掉的是响应方式（无界等待 → 有界重放），触发源（宿主层 `net::ERR_NETWORK_CHANGED`，docker/veth 网络变更通知）不在本仓可控范围内** —— 该判据的稳定性依赖守卫的重放，不依赖触发源消失。

### AC1 红因与「flake 非回归」可复验
```
$ cd /data/home/yale/work/claudecodeui && grep -h '"item_id":"AC-254"' .quay/gate-events.jsonl | grep 'eae097a0'
{"id":"2313f048-…","verdict":"pass","timestamp":"2026-10-06T03:13:22.149Z","payload":{"reason":"acceptance passed (exit 0)","treeSha":"eae097a097deabaa96726b2b98518792760f6370"}}
{"id":"48f7f969-…","verdict":"pass","timestamp":"2026-10-06T03:15:47.995Z","payload":{"reason":"acceptance passed (exit 0)","treeSha":"eae097a097deabaa96726b2b98518792760f6370"}}
{"id":"23465279-…","verdict":"fail","timestamp":"2026-10-06T03:18:31.665Z","payload":{"reason":"acceptance failed (exit 1) — [WebServer] [BABEL] Note: …","treeSha":"eae097a097deabaa96726b2b98518792760f6370"}}
```
同一 treeSha `eae097a0…`：pass(03:13:22) / pass(03:15:47) / fail(03:18:31) ⇒ flake，非稳定回归。

**漂移如实登记**：立案时引用的 `git rev-parse HEAD^{tree}` = `eae097a0…`（HEAD `1bf3cd8e`）。本轮复验时主检出已前进：`git rev-parse HEAD HEAD^{tree}` → `0bafb3a96af1854902dc3011c98a492dac839f95` / `602d1d8d776afbae5fe4d7800de8cc5b46fd29a6`；且 AC-254 台账尾部四条已变成 pass（03:33:36 tree `1641374a…`、03:35:39 tree `80036cbf…`、03:38:08 tree `80036cbf…`、03:40:15 tree `602d1d8d…`）。即立案后的四次 goal-gate 未再复发该 flake —— 正因为触发源是间歇性的宿主事件，本条修的是响应（重放），不是触发源。

### AC2 因可归因
`error-context.md` 逐字失败块：
```
Error: expect(locator).toBeVisible() failed
Locator: locator('#username')
Expected: visible
Timeout: 30000ms
Error: element(s) not found
  281 | const reachAppShell = async (page: Page): Promise<void> => {
> 283 |   await expect(page.locator('#username')).toBeVisible({ timeout: LANDING_TIMEOUT_MS });
```
`1-trace.network` 中 `grep -c ERR_NETWORK_CHANGED` = **9**，模块 URL（`unzip -p … 1-trace.network | grep ERR_NETWORK_CHANGED | …`）：
```
@fs/…/deps/react-router-dom.js
@fs/…/deps/react-i18next.js
src/shared/context/ThemeContext.tsx
src/shared/context/UiPreferencesContext.tsx
src/modules/auth/index.ts
src/modules/task-master/index.ts
src/shared/context/WebSocketContext.tsx
src/modules/plugins/index.ts
src/modules/project-workspace/index.ts
```
导航成功但模块图未执行 ⇒ React 未挂载 ⇒ `#username` 不出现（30s 无界等待被拖成红）。

### AC3 守卫已移植
```
$ grep -c warmClientStartup e2e/mcp-settings.spec.ts
2
$ grep -c navigateBounded e2e/mcp-settings.spec.ts
2
$ grep -n 'page.goto' e2e/mcp-settings.spec.ts
412: * The one place this spec navigates — every `page.goto`/`page.reload` in this file is inside this function, …
439:        await page.goto(clientUrl, {
```
唯一的 `page.goto` 调用在 `navigateBounded` 内（412 行为注释）；启动路径再无裸 `page.goto(booted.clientUrl`。

### AC4 守卫承重（可证伪）
宿主 `net::ERR_NETWORK_CHANGED` 本轮不可确定性复现，故用**等价负控制**：一次性打断首份文档的全部模块脚本（`route.abort('internetdisconnected')`，仅 `document` 计数 ≤1 时 abort，重放的 `reload()` 放行），令首份文档模块图不执行 —— 与 `#username` 不出现同机理。

变异 diff（临时）：
```
+  // TEMP AC4 NEGATIVE CONTROL
+  let documentLoads = 0;
+  await page.route('**/*', async (route) => {
+    const request = route.request();
+    if (request.resourceType() === 'document') documentLoads += 1;
+    if (request.resourceType() === 'script' && documentLoads <= 1) {
+      await route.abort('internetdisconnected'); return;
+    }
+    await route.continue();
+  });
-const STARTUP_PROBE_DEADLINE_MS = 14_000;
+const STARTUP_PROBE_DEADLINE_MS = 5_000;   // 不重放 / 不自愈
```
读数①（打断 + 守卫不自愈）判据红，红形为守卫的页面证据（同族，账户表单 = `#username` 之门）：
```
Error: the account form or the app shell never rendered, so this run's client never came up to a document that stays: the page shows ""; console errors: Failed to load resource: net::ERR_INTERNET_DISCONNECTED | …; failed requests: http://127.0.0.1:…/@vite/client — net::ERR_INTERNET_DISCONNECTED | http://127.0.0.1:…/src/main.tsx — net::ERR_INTERNET_DISCONNECTED | http://127.0.0.1:…/@react-refresh — net::ERR_INTERNET_DISCONNECTED
```
读数②（同一打断 + 恢复守卫 deadline 14_000、重放开启）判据绿，证明重放承重：
```
[e2e] client startup: the account form or the app shell landed after 10108ms (attempt 2)
2 passed (40.8s)
```
恢复命令：`git checkout -- e2e/mcp-settings.spec.ts`。
**附带修掉的真缺陷**：负控制暴露出 `firstLanding.present` 曾把同一 `budgetMs` 先后交给两个 `appears`，空白页会耗尽 ~16s > 14s deadline 而根本不重放 —— 这正是守卫存在的意义。已改为两个探针共享一个 budget（提交 `84ef9039`），恢复后正常路径仍在 attempt 1 落地（~2.2s）。

### AC5 判据未变宽
三条假形态逐条临时改出货源码、跑完即 `git checkout --` 恢复，各自只红被指名的读数：
(i) 写 scope 默认勾选（`src/modules/settings/hooks/useCredentialsSettings.ts` 的 `defaultNewTokenScopes` 追加 `cloudcli:session:send`）⇒ 仅 (d) 红，(b) 臂绿：
```
Expected: false
Received: true        (> expect(initialChecked[scope]).toBe(false))
```
恢复 `git checkout -- src/modules/settings/hooks/useCredentialsSettings.ts`。
(ii) 关闭态仍渲染接入命令（`McpGatewaySection.tsx` 关闭分支追加 `mcp-gateway-command` 块）⇒ 仅 (b) 红：
```
(b) … connect-command nodes=1; "Bearer" anywhere on page=true
Expected: 0
Received: 1           (> expect(commandCount).toBe(0))
```
恢复 `git checkout -- src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx`。
(iii) 命令内嵌真实令牌（`connectCommand` 用字面 `ccp_0000…` 取代 `<token>`）⇒ 仅 (c) 红，(b) 臂绿：
```
Expected pattern: /Authorization:\s*Bearer\s*<token>/
Received string:  "claude mcp add --transport http cloudcli http://127.0.0.1:16901/mcp --header \"Authorization: Bearer ccp_0000…\""
```
恢复 `git checkout -- src/modules/settings/tabs/api-settings/sections/McpGatewaySection.tsx`。
断言行未改：`git diff develop...HEAD -- e2e/mcp-settings.spec.ts | grep '^[-+].*expect('` 输出为空。

### AC6 稳定性
连续 5 次独立 `npx playwright test e2e/mcp-settings.spec.ts`（tests/passed/failed=2/2/0，wall 为整次 invocation）：
```
RUN 1 exit=0 :: 2 passed (23.8s)
RUN 2 exit=0 :: 2 passed (23.1s)
RUN 3 exit=0 :: 2 passed (23.6s)
RUN 4 exit=0 :: 2 passed (23.7s)
RUN 5 exit=0 :: 2 passed (23.9s)
```
负载臂（`scripts/with-memory-cap.sh` 单 scope，判据与 ≥3 份兄弟 spec 并发，`QUAY_MEMORY_UNIT=ac254-load`）：
```
=== CRITERION exit=0 wall=25s ===
  2 passed (24.9s)
sib1 session-filter exit=0
sib2 model-library exit=0
sib3 access-tokens exit=0
```
判据 5+1 次全绿，无 `net::ERR_NETWORK_CHANGED`、无空白页。

### AC7 不回归与仓库门
- `npm run typecheck` EXIT=0。
- `npm run lint` EXIT=0；`grep -c ': error '` = **0**（输出仅既有 warning）。
- `e2e/access-tokens-settings.spec.ts`（AC-228）未改一字（`git diff --stat develop HEAD -- e2e/access-tokens-settings.spec.ts` 空输出）仍通过（负载臂 sib3 exit=0）。

### AC8 diff 与 Touches 逐条对齐
```
$ git diff --name-only develop...HEAD
e2e/mcp-settings.spec.ts
tasks/gap-ac254-boot-guard-mcp-settings-criterion.md

$ git diff --stat develop HEAD -- server/ src/ shared/
(空输出)
```
`## Touches` 两条与 `develop...HEAD` 两条逐条对齐：`e2e/mcp-settings.spec.ts`（实现，`git diff --stat develop...HEAD -- e2e/mcp-settings.spec.ts` = 1 file changed, 226 insertions(+), 2 deletions(-)）与 `tasks/gap-ac254-boot-guard-mcp-settings-criterion.md`（ABI 的 AC tick）。`task_write` 的 tick 提交落在主检出的 `author` 分支上（不在 worker 的 worktree 里），按既定的 worker 退出把它 cherry-pick 进任务分支 —— 这既是 fan-in 的 ac-precheck 读 `<worktree>/tasks/<id>.md` 所必需，也正是让三点 diff 与 `## Touches` 呈现 2↔2 的原因（`ac8-diff-touches-alignment-needs-the-abi-tick-cherry-picked`）；用 `git diff --name-only`（不随内容微调漂移）而非 `--stat` 行数记录。出货源码 `server/`、`src/`、`shared/` 逐字空输出，零改动。