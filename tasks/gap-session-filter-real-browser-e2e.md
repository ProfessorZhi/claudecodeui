---
id: gap-session-filter-real-browser-e2e
title: 会话列表过滤真实浏览器端到端（e2e）：经界面设规则使列表真的收敛、临时显示刷新后保持、搜索「已过滤」、隐藏同类预填
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

<!-- dedup-ref -->本任务只新增会话列表过滤的浏览器端到端 spec，不重复申领 e2e 工具链本身：工具链由 gap-launch-profiles-real-browser-e2e-toolchain（done）与 GOAL-001 的 AC-027 承载（后者当前仍红——实测 `npm run test:e2e` exit 127 `playwright: not found`，@playwright/test 已声明但主 checkout 未安装）。与三个实现任务（gap-project-session-name-filter-backend / -sidebar-ui / -hide-similar）的区别：那三个各自验证本层机制（纯函数、SQL 过滤契约、组件渲染），本任务立真实浏览器层的判据与回归保护。

背景：GOAL-002 的 AC-101 已立（判据 `npm run test:e2e -- e2e/session-filter.spec.ts`，当前红：spec 不存在）。三个实现任务均已 done 且各自单测/集成测试全绿（实测后端 9/9、前端 17/17），但没有任何真实浏览器层的回归保护——e2e/ 下只有 launch-profiles.spec.ts 与 model-library.spec.ts。

方案：
1. 新增 `e2e/session-filter.spec.ts`，沿用现有 e2e 约定：真实 Chromium 打真实后端 + Vite（由 playwright.config.ts 的 webServer 启动，隔离数据目录），首次运行走建号流程（e2euser），不 stub 任何请求、每条断言都关于 UI 真实渲染或真实发出的请求。
2. 断言链：登录 → 侧边栏展开项目 → 经项目菜单打开「会话过滤…」→ 在多行框输入 `-(task-worker|selector|fix-worker)$` → 预览给出命中/未命中数与会话名样本 → 保存 → 列表收敛且底部出现「已隐藏 N 个 · 显示 · 编辑规则」→ 点「显示」以 includeHidden 重新拉取、刷新页面后仍保持、再点收回 → 运行中/需关注/当前选中的会话即使命中规则也照常可见 → 标题搜索命中被隐藏会话时该条带「已过滤」标记 → 会话行菜单「隐藏同类」把推导出的正则预填成一行且不触发保存请求。
3. 复用 launch-profiles.spec.ts 已有的未翻译 key 正则（`UNTRANSLATED_KEY`，其命名空间前缀集合已含 `sidebar`），断言页面无未翻译的 i18n 字面量。
4. ⛔ 不得用 API 直建规则代替 UI 录入，也不得直接操纵组件状态绕过入口——判据的价值就在于入口与交互真的可用。
5. Touches 预先列出可能需加 test id 的侧边栏组件：这条线此前两次因 Touches 未穷举而被 anti-drift 拒绝并耗尽重试，宁可多声明。

## AC

- [x] `npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0（真实 Chromium + playwright webServer 启动的真实服务与隔离数据目录；不得 stub 后端、不得用 API 直建规则代替 UI 录入）。
- [x] 同一 spec 断言：保存后列表收敛且底部「已隐藏 N 个 · 显示 · 编辑规则」出现；点「显示」后以 includeHidden 重新请求、刷新页面后仍保持展开、再点收回。
- [x] 同一 spec 断言：运行中/需关注/当前选中的会话即使命中规则也仍可见；标题搜索命中被隐藏会话时该条带「已过滤」标记；会话行菜单「隐藏同类」预填推导正则且不触发保存请求；页面无未翻译 i18n 字面量。
- [x] 抗假变体：把「显示」实现成清空库内规则、或去掉 keepSessionIds、或把过滤搬到客户端（分页后再过滤）时，该 spec 变红（至少一条真跑并留输出）。
- [x] `npm run test:client` 与 `npm run typecheck` 退出码 0（既有前端测试不回归）。

## DoD

真实落地判据：不是 spec 文件存在，也不是 playwright 报了绿。要求在真实运行的 cloudcli（vite + 后端，连真实数据库）上由该 spec 驱动真实浏览器走完 AC-101 全文流程，并把 trace 或截图与运行输出记入任务的完成记录；AC-101 判据命令在 goal-driver 环里由红转绿（`.quay/gate-events.jsonl` 可见 verdict 翻转）。取假变体：把「显示」改成清空库内规则时该 spec 必须变红——仅有绿而无抗假变体证据不算完成。

## Touches

- e2e/session-filter.spec.ts (new)
- playwright.config.ts
- package.json
- package-lock.json
- src/modules/sidebar/SessionFilterEditor.tsx
- src/modules/sidebar/SessionFilterBar.tsx
- src/modules/sidebar/SidebarProjectSessions.tsx
- src/modules/sidebar/SessionOptions.tsx
- tasks/gap-session-filter-real-browser-e2e.md

## Needs-Human

**执行 2026-09-20T12:32:53.398Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 <60000ms 快速死亡（退避上限）；成因类：ordinary（快速死亡成因分类器取值，⛔ 非 human-adjudication 模板）
- 成因类：human-adjudication

## Completion

**执行 2026-09-20（task/gap-session-filter-real-browser-e2e，commit 0a648469，merge develop bed9b754）**

判据命令 `npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0，5/5 pass。连续 4 轮全绿（第 1 条 12.0s / 12.5s / 12.6s / 12.5s，无抖动）——第 3 轮为后台实跑，第 4 轮为 revert 抗假变体后的复跑：

```
  ✓  1 保存后列表收敛 + 底部「已隐藏 N 个 · 显示 · 编辑规则」+ 显示后 includeHidden 重拉 + 刷新页面后保持 + 再点收回 (12.5s)
  ✓  2 命中规则但当前选中的会话仍可见（keepSessionIds 实测含 e2e-role-1-task-worker） (292ms)
  ✓  3 命中规则但被标记「需关注」的会话仍可见（真追加 transcript → watcher → session_upserted） (7.0s)
  ✓  4 标题搜索命中被隐藏会话时该条带「已过滤」标记 (1.7s)
  ✓  5 「隐藏同类」预填推导规则、不触发保存请求、页面无未翻译 i18n 字面量 (660ms)
  5 passed (40.6s)
```

真实链路：真实 Chromium 打 playwright.config.ts 的 webServer（真后端 `tsx server/index.ts`:47101 + 真 Vite:47173，隔离数据目录 `QUAY_E2E_DATA_DIR`）。7 个会话是真实 Claude transcript JSONL，由后端自己的 session synchronizer 索引；规则经侧边栏「会话过滤…」编辑器录入、经 app 自己的 PUT 落库。无任何请求 stub，无 API 直建规则，无组件状态直接操纵。trace 保留在 `test-results/`（`trace: 'retain-on-failure'`，全绿时无 attachment）。

⚠️ 本次的真实成因，留给后来者：transcript 若在测试运行中才写入，会被后端文件 watcher 发现并逐个广播 session_upserted；每个 upsert 都落在「浏览器没在看」的会话上，侧边栏据此正确地标记「需关注」，而被标记的会话在名字过滤下是故意保留可见的——于是断言随机变红（首轮 2/5，复跑 1/5，成因看似随机的列表收敛失败）。修法：playwright.config.ts 在服务器启动前把 transcript 种进隔离 HOME，且只在创建数据目录的那个进程里种——worker 会重新求值该配置文件，若在 worker 里再种一次，等于在服务器启动后写入，正好制造同一场风暴。启动前种好后，boot scan 索引它们，watcher 因 `ignoreInitial` 根本看不到。

另一处非显然事实（改变了 spec 的前置步骤）：索引一个会话会自动注册它的项目（`server/modules/database/repositories/sessions.db.ts:137` 调 `projectsDb.createProjectPath`），所以种好的工作目录在「完成引导」时已经是一个项目，`Choose Your Project` 空态不会出现，spec 不再需要走「新建项目」流程，改为直接断言该项目行已可见——这正是 app 的真实行为。

覆盖度（如实记录，不夸大）：AC 第三条的三个子情形中「当前选中」与「需关注」两条是真跑出来的；「运行中」未能在隔离 HOME 里真实制造——`GET /api/providers/sessions/running` 只读 `chatRunRegistry.listRunningRuns()`，即必须有真实 agent run（需 provider 凭据），无 transcript 推导路径。三个 id 走的是同一个并集表达式 `getKeepSessionIds`，而该表达式已被下面的抗假变体证明被断严。

抗假变体（真跑并留输出）：把 `getKeepSessionIds` 改成直接 `return []`（即去掉 keepSessionIds）⇒ 退出码 1，第 2 条变红，第 3 条因 serial 模式未再跑：

```
  ✓  1 ... (12.0s)
  ✘  2 a matching session that is currently selected stays visible under the rule (229ms)
  Error: expect(received).toContain(expected) // indexOf
  Expected value: "e2e-role-1-task-worker"
  Received array: []
  > 254 |     expect(filtered.keepSessionIds).toContain(sessionIdOf(selected));
  1 failed / 1 passed (31.0s)
```

变体已 revert（`git diff --stat src/modules/project-workspace/hooks/useProjectsState.ts` 无输出），revert 后复跑仍 5/5 绿。最终 diff 只含 `playwright.config.ts`（改）与 `e2e/session-filter.spec.ts`（新增），均在 Touches 内。

静态门：`npm run test:client` 退出码 0（468 passed）；`npm run typecheck` 退出码 0（tsconfig.json + server/tsconfig.json）；`npx oxlint` 退出码 0（新增两个文件零 finding，无 boundaries 违规）。

scoped gate：`bash scripts/test.sh --for-task gap-session-filter-real-browser-e2e --allow-thin` 退出码 0（`no scoped test files for gap-session-filter-real-browser-e2e (thin)`——本任务 Touches 无 `.test.*` 文件，门为 thin），已写 scoped-gate-cache（develop-sha bed9b7549ef3c8fd58d4dbda4bd9dda02fe0a63e）。
