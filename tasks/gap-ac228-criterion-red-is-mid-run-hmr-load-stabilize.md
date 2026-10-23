---
id: gap-ac228-criterion-red-is-mid-run-hmr-load-stabilize
title: AC-228 判据在负载与运行中重载下假红：e2e/access-tokens-settings.spec.ts 首跑引导有界化 + 预算对齐
  55s watchdog，载重读数 (a)–(e) 一条不动
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-228
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-10-06）：`grep -rl "goal_ac: *AC-228" tasks/*.md` 只命中 `tasks/gap-ac228-access-tokens-settings-e2e.md`（`status: done`）与 `tasks/gap-ac229-access-tokens-i18n-completeness.md`（`goal_ac: AC-229`，`done`）；`grep -rl "access-tokens-settings" tasks/*.md` 另命中 ac227 / ac254×3 / ac266，全部 `done`。⇒ 无 todo/ready/needs-human 的认领任务。已 done 的 AC-228 任务不是重复，而是「上一次修复没守住」的证据；本条是新案。

**判据物。** 逐字取自 `goals/AC-228-真实浏览器里设置页能创建个人访问令牌-明文只显示一次-刷新后只剩前缀-吊销后消失-旧的-api-key-创建入口不再存在.md` 的 `criterion:`：`for f in e2e/access-tokens-settings.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test e2e/access-tokens-settings.spec.ts`。

**本轮读数（自己直跑，不是推断）。** 静默态 `npx playwright test e2e/access-tokens-settings.spec.ts` → `1 passed (14.9s)`，exit **0**；读数逐字：(a) `POST /api/settings/access-tokens -> 201; plaintext matches ccp_<64 hex> = true`；(b) `after reload: plaintext hits in content = 0, in body.innerText = 0, in localStorage = false, in sessionStorage = false; row shows prefix "ccp_4531"`；(c) `option values = ["7","30","90"]; default = 30`；(d) `token-info with the live token -> 200`、`after revoke: ... token-info -> 401`；(e) `contains "New API Key" = false; contains "api-docs.html" = false; anchors to it = 0`。⇒ **判据今天在静默态是真的**；本条写「让判据在负载与运行中重载下稳定跑绿」，不是「把坏掉的担保修好」。

**driver 红在哪（读判据自己的工件，不读台账 reason）。** 台账最后一笔 `2026-10-06T07:19:55Z`（actor `goal-cli`，treeSha `4f62f2ee` = develop，exit 1），工件在 `~/.cache/quay-e2e-tmp/quay-e2e-3M5fId/`：

1. `watchdog-state.json` 逐字：`{"armed": true, "fired": true, "ceilingMs": 55000, "detail": "ceiling crossed at 55007ms"}` ⇒ 判据在 playwright 自己的 `SINGLE_SPEC_CEILING_MS = 55_000`（`playwright.config.ts:317`）上触顶，看门狗关掉了浏览器。
2. `test-results/access-tokens-settings-per-305e9-evocation-really-rejects-it/error-context.md` 逐字：`Error: Channel closed` 与 `Error: locator.click: Target page, context or browser has been closed` / `waiting for getByRole('button', { name: 'Complete Setup' })`，失败指到 `e2e/access-tokens-settings.spec.ts:222`——即 `beforeAll` 的首跑引导（Git Configuration 步）在点 `Complete Setup` 时被看门狗连同浏览器一起杀掉；页面快照停在 `Git Configuration` 步、`Next` 可用。同一 treeSha 下 `07:15:28Z` 与 `07:17:25Z` 两笔是 pass——同树 pass/pass/fail，是运行中假红，不是担保回归。

**根因（读 trace 得到，不是猜）。** 3M5fId 的 `trace.zip`（`1-trace.network`）里，点 `Next` 触发的 `POST /api/user/git-config` 记为 **status -1**（无响应——被随后导航中止），紧接着 ~12.35s 出现第二次文档 `GET /`（12348ms）与带 `?t=1791271152902` 的 Vite 全量重载（`/src/modules/onboarding/*` 全部以新 `t=` 重新取），引导组件重挂载回 `currentStep=0`（16.09s 又有一次 `/api/user/onboarding-status` + `git-config` GET）。spec 的引导走法是写死的两击 `getByRole('button', { name: 'Next' }).click()` → `getByRole('button', { name: 'Complete Setup' }).click()`：**既没有把 `navigateBounded` 的守卫延伸到引导步，也没有对「一次客户端重载把向导复位」做任何有界恢复**。重载后 `Complete Setup` 不再存在，playwright 的 `click` 自动等待一直空等，直到 55s 看门狗杀进程 ⇒ 红落在引导步而不是任一 (a)–(e) 断言上。触发那次全量重载的是主检出（on-disk 检出，非 worktree）上并发写入触发的 Vite reload——与 AC-171/175/184 同机制（见 [[criterion-red-is-mid-run-hmr-of-live-edited-main-checkout]]）；第 1 步须从本次运行自己的工件把触发点钉死。

**为什么「上一次修复」看着没过（其实没回归）。** AC-228 无代码回归：`bb440ed7` 在 develop 上，`AccessTokensSection.tsx` / `NewAccessTokenAlert.tsx` / `server/modules/oauth/token-info.routes.ts` 都在、`ApiKeysSection.tsx` 已删，本轮静默态 1 passed 即证。红只长在判据自己的一处鲁棒性缺口：`beforeAll` 的首跑引导是一次不可重入的写死点击序列，对抗不了负载下的一次运行中重载；它没有自己的有界失败点，于是把红推给了看门狗。

**要建的东西（最小充分集）。** 让 `e2e/access-tokens-settings.spec.ts` 在装载状态下、在门限内、且运行中发生一次客户端重载时**稳定跑绿**：(1) 把 `beforeAll` 首跑引导从写死两击换成**有界、状态驱动**的走法——在一个总预算内反复：`settingsButton` 可见即完成；否则补填空的 Git 字段并点当前可用的 `Next` 或 `Complete Setup`，每步有界等待；一次重载把向导复位后能续走而不是空等；(2) 引导走法耗尽预算时**抛具名错误**（附 `readStartupEvidence()` 一类页面证据），使红在读得懂的地方结束，而不是骑到 55s 看门狗；(3) 让用例的显式预算与判据门限相称（现 `test.describe.configure({ timeout: 120_000 })` 高于 55s 看门狗，等于把超时外包给看门狗）。

**非目标。** 不改生产代码与令牌语义；**不弱化任何载重读数**——(a)–(e) 断言逐字保留，**不 stub 任何请求**，不 API 直建令牌；不靠「关掉客户端的重载/HMR」回避（那是环境不是担保）；不动 `SINGLE_SPEC_CEILING_MS` / `playwright.config.ts`（判据要装进 55s，不是把 55s 拉高）；不额外起并发压测（见 [[defer-load-problems-do-not-stress-test-inline]]）。三条取假形态 (i)/(ii)/(iii) 仍须真红。

## Plan

1. **红态复现与定位（第一步）**：静默态连跑判据 ≥3 次，登记每次 `duration` 与 (a)–(e) 读数；在自然负载下尝试复现一次运行中重载（不额外加并发）。读 `e2e/access-tokens-settings.spec.ts:193-225` 的 `beforeAll` 引导与 `playwright.config.ts` 的 watchdog 契约（`SINGLE_SPEC_CEILING_MS` / `BOOT_CEILING_MS`），标出写死的两击与缺失的有界失败点；从本次运行自己的 trace 钉死触发全量重载的写入源。
2. **引导走法有界、状态驱动（承重）**：实现一个有界引导走法（建议名 `completeOnboardingBounded(deadlineMs)`）——在预算内循环：`settingsButton` 可见即返回；否则按当前步补填空的 Git 字段并点当前可用的 `Next`/`Complete Setup`；每次点击/导航有界；总预算耗尽时抛具名错误（含页面证据）。使一次重载复位后能续走。
3. **预算对齐门限**：给用例一个在 55s 看门狗以内的显式预算（收窄 `test.describe.configure({ timeout })`，或逐 test 显式预算），并确保引导走法在耗尽时先抛错、不骑到看门狗。
4. **跑绿**：连续 3 次绿，登记每次 `duration`（需有明显余量，且都 < 55s）；若仍触顶，继续收窄启动/引导固定开销，**不得**弱化断言。
5. **假形态承重**：按 AC-228 expect 的三条——(i) 列表行渲染完整明文 ⇒ (b) 红；(ii) 保留旧创建按钮/文档链接 ⇒ (e) 红；(iii) 吊销只改前端、不调 DELETE ⇒ (d) 的 401 红——先提交再变异，逐条登记变异 diff / 逐字失败行 / 恢复命令，恢复后复绿。
6. **契约面**：`npm run lint`、`npm run typecheck` 绿；`git diff --name-only $(git merge-base develop HEAD) HEAD` 落在 Touches 内。

## AC

- [x] AC1 判据绿且稳定：连续 3 次 `npx playwright test e2e/access-tokens-settings.spec.ts` 均 exit 0，逐次登记 `duration`（均 < 55s 且有明显余量）与 (a)–(e) 读数。红态基线：2026-10-06T07:19:55Z 台账 exit 1，工件 `quay-e2e-3M5fId`。
- [x] AC2 红已定位到判据自身的引导鲁棒性，而非担保为假：`## Evidence` 里逐字登记 3M5fId 的 `watchdog-state.json`（`fired:true / ceilingMs:55000 / crossed at 55007ms`）与 `error-context.md`（`Channel closed` + `Complete Setup` 处 `Target page...closed`，指到 `:222`），以及 trace 里 `POST /api/user/git-config` 的 `-1` 与 ~12.35s 的第二次 `GET /` 全量重载。
- [x] AC3 承重（引导有界、状态驱动）：`grep -nE "Complete Setup" e2e/access-tokens-settings.spec.ts` 命中的点击位于一个有界循环内（含每次的 deadline/预算判断），不是一次性写死两击；引导走法在耗尽时抛具名错误（`grep` 命中该错误构造点，且其消息含页面证据）。
- [x] AC4 承重（预算与门限相称）：首跑引导/导航每一步都有显式或有界预算，实现在 55s 看门狗以内自证失败（抛具名错误）而非骑到看门狗；spec 内不存在无界裸 `click()` 的引导步，用例预算不超过门限。
- [x] AC5 载重读数不弱化（承重）：(a)–(e) 的 `expect` 逐字保留——`grep -cE "PLAINTEXT_PATTERN|toContainText\(prefix\)|\['30', '7', '90'\]|toBe\(401\)|RETIRED_BUTTON_TEXT|RETIRED_DOCS_PATH|docsAnchors" e2e/access-tokens-settings.spec.ts` ≥ 现行值；不 stub、不 API 直建令牌。
- [x] AC6 假形态三条仍红（承重）：(i) 列表行渲染完整明文 ⇒ (b) 的 `documentHits`/`textHits` 断言红；(ii) 保留旧创建按钮/文档链接 ⇒ (e) 红；(iii) 吊销只改前端、不调 DELETE ⇒ (d) 的 `expect(revokedResponse.status).toBe(401)` 红。逐条登记变异 diff、失败断言逐字、退出码与恢复命令，恢复后复绿。
- [x] AC7 契约面：`npm run lint` 退出 **0**；`npm run typecheck` 退出 **0**；`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内（若被迫写 Touches 之外的文件，先用 task_write 加进 Touches 再写）。

## Evidence

**AC1 — 合并 develop 后在任务树上连续 3 次绿（每次 `npx playwright test e2e/access-tokens-settings.spec.ts`，exit 0）：**

| run | duration | exit | (a) | (b) | (c) | (d) live | (d) revoked | (e) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 20.2s | 0 | `-> 201; plaintext matches ccp_<64 hex> = true` | `hits in content = 0, in body.innerText = 0, in localStorage = false, in sessionStorage = false; row shows prefix "ccp_da51"` | `option values = ["7","30","90"]; default = 30` | `-> 200` | `-> 401` | `contains "New API Key" = false; contains "api-docs.html" = false; anchors to it = 0` |
| 2 | 20.5s | 0 | 同上 | 同上，prefix `ccp_8fd4` | 同上 | `-> 200` | `-> 401` | 同上 |
| 3 | 20.1s | 0 | 同上 | 同上，prefix `ccp_b69a` | 同上 | `-> 200` | `-> 401` | 同上 |

三次均 exit 0、均 < 55s（余量 ≈35s）；(a)–(e) 的逐字 `console.log` 行见上表。红态基线：`2026-10-06T07:19:55Z` 台账 exit 1，工件 `quay-e2e-3M5fId`。

**AC2 — 红定位到判据自身的引导鲁棒性（读 `~/.cache/quay-e2e-tmp/quay-e2e-3M5fId/` 自己运行留下的工件）：**

- `watchdog-state.json` 逐字：
  ```json
  {"armed": true, "fired": true, "ceilingMs": 55000, "detail": "ceiling crossed at 55007ms"}
  ```
- `test-results/access-tokens-settings-per-305e9-evocation-really-rejects-it/error-context.md` 逐字：
  ```
  Error: Channel closed
  Error: locator.click: Target page, context or browser has been closed
    - waiting for getByRole('button', { name: 'Complete Setup' })
  > 222 |       await page.getByRole('button', { name: 'Complete Setup' }).click();
  ```
- `trace.zip` 的 `1-trace.network`：`POST http://127.0.0.1:30557/api/user/git-config` → `"time":-1`（被随后导航中止，`startedDateTime 2026-10-06T07:19:12.823Z`）；第二次文档 `GET http://127.0.0.1:30557/` → `"status":200` 且 `"_monotonicTime":12348.85`（另一条 `12348.045`）——即 ~12.35s 的 Vite 全量重载，把引导复位回 `currentStep=0`。

**AC6 — 三条假形态真跑、真红（提交 `8304fed4` 之后再变异，每条 `git checkout -- <file>` 恢复，恢复后复绿 `1 passed (20.2s)` exit 0）：**

(i) 列表行渲染完整明文 ⇒ (b) 红。变异 diff：
```
+      // MUTATION (i): persist the one-time plaintext so the row can render it after a reload.
+      window.localStorage.setItem('e2e-mutation-plaintext', payload.token.plaintext);   [useCredentialsSettings.ts]
-                  <code className="text-xs text-muted-foreground">{token.tokenPrefix}</code>
+                  {/* MUTATION (i): the row renders the full one-time plaintext, not just its prefix. */}
+                  <code className="text-xs text-muted-foreground">{window.localStorage.getItem('e2e-mutation-plaintext') || token.tokenPrefix}</code>   [AccessTokensSection.tsx]
```
逐字失败行：`(b) after reload: plaintext hits in content = 1, in body.innerText = 1, in localStorage = true, in sessionStorage = false; ...` 与
```
    Expected: 0
    Received: 1
    > 436 |     expect(documentHits).toBe(0);
```
退出码 **1**；恢复命令：`git checkout -- src/modules/settings/hooks/useCredentialsSettings.ts src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx`。

(ii) 保留旧创建按钮/文档链接 ⇒ (e) 红。变异 diff（`AccessTokensSection.tsx` 头部保留）：
```
+      {/* MUTATION (ii): the retired API-key entry point (old button text + its docs link) is kept. */}
+      <div>
+        <button type="button">New API Key</button>
+        <a href="api-docs.html">API documentation</a>
+      </div>
```
逐字失败行：
```
    > 458 |     expect(finalText).not.toContain(RETIRED_BUTTON_TEXT);
```
退出码 **1**；恢复命令：`git checkout -- src/modules/settings/tabs/api-settings/sections/AccessTokensSection.tsx`。

(iii) 吊销只改前端、不调 DELETE ⇒ (d) 的红 401 断言。变异 diff（`useCredentialsSettings.ts`：`revokeAccessToken` 不再 `api.settings.revokeAccessToken(...)`，改为把 id 记入 `localStorage['e2e-mutation-revoked-ids']`，`fetchData` 里把该集合叠加成 `revokedAt`）：
```
+const MUTATION_REVOKED_KEY = 'e2e-mutation-revoked-ids';
+      // MUTATION (iii): overlay the browser-only revocations onto the server list.
+      const revokedIds = new Set(readMutationRevokedIds());
+      setAccessTokens((tokensPayload.tokens || []).map((token) => ( ... revokedAt: new Date().toISOString() ... )));
-      const response = await api.settings.revokeAccessToken(tokenId);
+    // MUTATION (iii): mark the token revoked in the browser only; no DELETE reaches the server.
+    window.localStorage.setItem(MUTATION_REVOKED_KEY, JSON.stringify([...revokedIds]));
```
逐字失败行：`(d) after revoke: id=1 row still present and marked Revoked; token-info -> 200` 与
```
    Expected: 401
    Received: 200
    > 452 |     expect(revokedResponse.status).toBe(401);
```
退出码 **1**；恢复命令：`git checkout -- src/modules/settings/hooks/useCredentialsSettings.ts`。

**AC7 — 契约面。** `npm run lint` exit 0（仅既有 warning，无 error）；`npm run typecheck` exit 0；`e2e/` 不在 `tsconfig.json` 的 include 内，spec 另以 standalone `tsc --noEmit --strict ... e2e/access-tokens-settings.spec.ts` 校验，exit 0；`git diff --name-only $(git merge-base develop HEAD) HEAD` = `e2e/access-tokens-settings.spec.ts`（⊆ `## Touches`）。

**续做轮（2026-10-06）fan-in `step=suite` 红的分类：与本任务 delta 无关的负载假红。** 红落在 `server/modules/providers/tests/claude-sessions.test.ts`（`AssertionError [ERR_ASSERTION]: open-d.jsonl was opened by a scan that should have skipped it`，fan-in suite 日志 `...~wk-prod-anchor~1791274426106-fc7a06.log`，窗口 2026-10-06T08:13:46Z–08:17:07Z）。本任务 `git diff --name-only $(git merge-base develop HEAD) HEAD` 仅 `e2e/access-tokens-settings.spec.ts`，无 import/机制关系；且该测试文件末次改动为 `022cda53`（2026-09-23），套件时点之后 develop 无相关修复。重跑核验：该文件单跑 `26/26 pass, exit 0`（含 `a scan does not open the transcripts its cursor excludes` 329ms 通过）；8 路并发单跑 8/8 `exit 0`；`server/modules/providers/**` 442 测试仅 4 个 resident/CLI cold-boot 环境态失败、该文件通过 ⇒ 判为全量套件 16 路并发下的 atime/birthtime 时序假红，非本任务回归。续做轮未改任何被 `## Touches` 约束的实现文件，仅合并 develop（已 up-to-date）后重交 fan-in。

## DoD

- 判据在 55s 看门狗与 60s 门限内、装载状态下**稳定**跑绿：3 次连续绿、每次 `duration` 有明显余量（登记实测值），且判据自己读完收尾。
- 一次运行中客户端重载（Vite 全量 reload）不再能让首跑引导空等到看门狗：引导要么有界续走成功，要么在耗尽时抛具名错误、红在读得懂的引导步。
- 载重读数 (a)–(e) 与今天逐字相同；`beforeAll` 失败时 `readStartupEvidence()` 的页面/控制台/失败请求证据仍被打印。
- 假形态三条真跑、真红，红落在 (b)/(e)/(d) 各自断言上；只动 `## Touches` 列出的文件。

## Touches

- e2e/access-tokens-settings.spec.ts
- tasks/gap-ac228-criterion-red-is-mid-run-hmr-load-stabilize.md（自触）
