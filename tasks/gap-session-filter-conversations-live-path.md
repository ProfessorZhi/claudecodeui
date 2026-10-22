---
id: gap-session-filter-conversations-live-path
title: 会话过滤覆盖 Conversations 视图的实时更新：session_upserted
  对命中规则的会话不再插入，已有行改名为命中规则后移除，实时列表与重新加载一致
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-279
---
## Proposal

<!-- dedup-ref -->本任务补的是会话名过滤在 Conversations（最近会话）视图实时更新路径上的缺口。同一条线上的相邻工作各管一层：gap-project-session-name-filter-backend 管服务端分页与 recent 接口的过滤（均已 done，本任务不改服务端）；gap-project-session-name-filter-sidebar-ui 管 Projects 列表的条与编辑器；提交 e3a08557 修的是 Projects 列表（useProjectsState.ts）里先无名后命名的新会话。三者都没有碰 Conversations 视图自己的那份状态。

现象（用户 2026-10-05、10-06 两次报告）：规则已保存并生效，Projects 列表与整页刷新后的 Conversations 都是干净的；但停在 Conversations 视图时，过一会儿命中规则的会话（quay drivers 新建）又冒出来。修复 e3a08557 已进构建并重启后仍然如此。

根因（已读代码确认）：`src/modules/sidebar/hooks/useSidebarController.ts` 第 356 行起的 `session_upserted` 订阅。对列表里还没有的会话（约第 380 到 408 行）无条件插入一行；对已有行（约第 423 到 429 行）只更新标题与活动时间，名字后来补成命中规则也不移除。整个文件没有任何 sessionFilter、hiddenCount 或 isSessionHiddenByProjectFilter 的引用，而 recent 接口本身已按项目规则过滤，所以只有实时路径漏。库里的事实是干净的（10-05 12:00Z 之后新建的会话，claudecodeui 命中 320 个、其余 8 个都是真人会话）。

方案：
1. 让 Conversations 的实时更新使用与 Projects 列表同一个判定：`useProjectSessionFilter.ts` 里已有的 `isSessionHiddenByProjectFilter(project, session, keepSessionIds, isShowingHidden)`，规则来自控制器已持有的 `projects` 中对应项目的 `sessionFilter`。新会话命中规则则不插入；已有行改名后命中规则则从列表移除；先无名、后补命中名字的会话净效果是不可见。
2. 一致性是这个任务的判据，不是字面实现：实时更新后的列表成员，必须与随后重新加载 Conversations（`api.recentConversations`）得到的成员一致。recent 接口目前不接收 keepSessionIds，所以对运行中、需关注、当前选中这三类豁免，实现者须让实时路径与 recent 接口的实际语义一致，并把选择及理由写进完成记录；不要让实时视图比重新加载视图更宽松，那正是这次的 bug。
3. ⚠️ 模块边界：project-workspace 已经从 `@/modules/sidebar` 导入（useProjectSessionFilter.ts 的第 5 行），sidebar 反向导入 project-workspace 会成环，被 boundaries lint 拒绝。匹配谓词请经 props 由 useProjectsState 一侧传入，或把纯函数下沉到 shared。新增测试必须经模块 barrel 导入。
4. 正对照不可省：真正的判据是「推送确实送达了该视图，而且命中规则的被挡住」。所以 e2e 里必须有一条同样方式新建、名字不命中规则的会话出现在列表里，否则「没冒出来」可能只是什么都没发生。
5. 已有 e2e 的约定要沿用：session-filter.spec.ts 的注释写明，中途写入的转录会被文件监听器发现，其广播的 upsert 会把会话标为需关注，而需关注是过滤刻意保持可见的例外；开头种下的转录在服务启动前写入，以避开这一点。本任务要测的正是中途新建，所以新 spec 要自己处理这一点（e3a08557 已在 Projects 侧对无名 upsert 跳过需关注标记），并在完成记录里说明 Conversations 一侧的取舍。

## AC

- [x] `npx vitest run src/modules/sidebar/tests/recentConversationsSessionFilterLive.test.tsx` 退出码 0（新文件）：对未知会话的 `session_upserted`，所属项目规则命中其标题时不插入，不命中时插入（对照）；已有行改名为命中规则的标题后被移除；先无名插入、随后补成命中名字的会话净效果不可见；项目无规则时行为与现状完全一致；每个断言后紧跟一次「重新加载」的等价读数，成员必须与实时结果相同。
- [x] `npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts` 退出码 0（新文件，真实 Chromium 与 playwright webServer 启动的真实服务）：规则经侧边栏编辑器保存（不得 API 直建）；页面停在 Conversations 并加载完之后，经真实转录写入新建一个命中规则的会话和一个不命中的会话；不命中的出现（正对照），命中的在同一时间窗内不出现；先无名后命名与已有行被改名两种形态各一条；切走再切回与整页刷新之后列表成员与实时结果一致；页面无未翻译 i18n 字面量。
- [x] 抗假变体至少各真跑一次并把输出记入完成记录：去掉新会话插入分支里的过滤判断，单测与 e2e 都必须变红；去掉改名分支里的移除，单测必须变红。
- [x] 既有测试不回归：`npx vitest run src/modules/sidebar/tests/sessionFilterBar.test.tsx src/modules/sidebar/tests/sessionFilterEditor.test.tsx src/modules/project-workspace/tests/projectsStateSessionFilterLateName.test.ts src/modules/sidebar/tests/recentConversationRowActions.test.tsx` 退出码 0，且 `npm run test:client` 退出码 0。
- [x] `npm run typecheck` 与 `npx oxlint` 退出码 0（含 boundaries 规则，sidebar 与 project-workspace 之间无环、无跨模块深导入）。

## DoD

真实落地判据：不是单测绿，也不是新 spec 文件存在。要求 AC-279 的判据命令在 goal-driver 环里由红转绿（`.quay/gate-events.jsonl` 里 AC-279 的 verdict 翻转），并且 e2e 的正对照与抗假变体真的跑过：在完成记录里贴出去掉过滤判断后 spec 变红的输出，以及正常实现下「不命中的出现、命中的不出现」的断言读数。本任务不负责重新构建或重启用户正在使用的 3001 服务（那是人的操作，且不得在托管它的会话里做）；合入后由人重建重启，AC-279 是该行为的机械凭据。

## Touches

- src/modules/sidebar/hooks/useSidebarController.ts
- src/modules/sidebar/Sidebar.tsx
- src/modules/sidebar/index.ts
- src/modules/project-workspace/hooks/useProjectSessionFilter.ts
- src/modules/project-workspace/hooks/useProjectsState.ts
- src/modules/project-workspace/index.ts
- src/shared/types.ts
- src/modules/sidebar/tests/recentConversationsSessionFilterLive.test.tsx (new)
- e2e/session-filter-conversations-live.spec.ts (new)
- playwright.config.ts
- tasks/gap-session-filter-conversations-live-path.md

## 完成记录

**结论：实时路径已按 recent 接口的语义判定，两个抗假变体各自真跑并变红，五条 AC 全绿。实现提交 `298f1af0`（10 文件，+795/-15），未改服务端、未重启 3001。**

### AC1 —— 单测（新文件）

```
$ npx vitest run src/modules/sidebar/tests/recentConversationsSessionFilterLive.test.tsx
 ✓ src/modules/sidebar/tests/recentConversationsSessionFilterLive.test.tsx (5 tests) 27ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
EXIT=0
```

五个用例逐条对应 AC 的四种形态，并且每个用例的每一次断言之后都紧跟 `assertMatchesReload(result)` —— 它走控制器自己的 `reloadRecentConversations()` 重新读一遍，再用 `assert.deepEqual(reloaded, live)` 要求成员相同。判据的实现不是把谓词抄一遍：`serverVisibleRows()` 把服务端语义（不分大小写、任意规则命中即隐藏）独立写了一遍，reload 读数由它产生，所以断言是两个实现之间的等价，不是自证。用例名即 AC 的四种形态：命中不插入/不命中的对照、已有行改名后移除、先无名后命名净效果不可见（先断言它以 `New Session` 占位标题被插入，再断言命名后消失）、无规则项目行为不变。另加一条「upsert 不带项目」的用例：项目判不出来时列表原样不动。

### AC2 —— e2e（新文件，真实 Chromium + webServer）

```
$ npm run test:e2e -- e2e/session-filter-conversations-live.spec.ts
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-dt8tjv free-bytes=3564870148096 min-free-bytes=1073741824
  ✓  1 e2e/session-filter-conversations-live.spec.ts:251:3 › the Conversations feed under a saved session-name rule › a session that arrives matching a saved rule never enters the feed, and one that does not arrives (5.3s)
  1 passed (16.8s)
EXIT=0  WALL=17602ms
```

规则是经侧边栏自己的编辑器填好、经应用的 PUT 保存的（`projectRow().getByTitle('Session filter…')` → 填 `-live-worker$` → `Save`），全程没有调 API 直建。页面的停靠顺序是「先在 Projects 建规则 → 切到 Conversations 等列表加载完 → 再写转录」，所以中途写入时视图已经在 Conversations 上。

那次运行强制成立的读数（判据不是「文件存在」）：

- 正对照：不命中规则的新会话 `live-new-human` **出现**；
- 命中规则的新会话 `live-new-live-worker` 在同一时间窗内**不出现**——先 `toHaveCount(0)`，再空转 1.5s 后**再判一次** `toHaveCount(0)`，所以迟到的插入也会被抓到；
- 已有行被改名：种下的 `live-seed-human` 的转录被追加一条命中规则的 `custom-title`，其行**消失**（`toHaveCount(0)`）；
- 先无名后命名：`live-late-session` 以一条 `isMeta: true` 的 user 记录到达（标题阶梯刻意跳过 isMeta，于是落到应用的占位名），此时**不命中**所以出现；round B 给它追加命中规则的 `custom-title` 后其行**消失**；
- 切走再切回：`membersAfterSwitchingAwayAndBack()` 先断言列表真的卸载、再断言重挂载后正对照可见，然后读成员，`toEqual(live)`；
- 整页刷新：`page.reload()` 后重进 Conversations，成员 `toEqual(live)`；
- i18n：`body.innerText()` 不匹配未翻译字面量（`sidebar.recentConversations` 下的键名）。

「同一时间窗」是夹具的属性而不是断言的运气：round A 的四次写入落在同一个 debounce 窗口里（watcher 500ms 去抖、上限 2s），一次 flush 把它们一起广播。

### AC3 —— 抗假变体（各真跑一次，输出如下，跑完均已还原）

**变体 a：去掉插入分支的过滤判断**（把 `if (isHidden) { return previous; }` 去掉）。

单测变红：

```
 × a new session whose name matches the project rules is not inserted, and one that does not match is
   → AssertionError: Expected values to be strictly deep-equal:
   [ 'seed-1', + 'worker-1' ]
 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)      EXIT=1
```

e2e 同时变红：

```
 ✘ 1 e2e/session-filter-conversations-live.spec.ts:251:3 › ...
     Error: expect(locator).toHaveCount(expected) failed
     Expected: 0
     Received: 1
       14 × locator resolved to 1 element
  1 failed
```

**变体 b：去掉改名分支的移除**（把 `if (isHidden) { return previous.filter(...); }` 去掉）。

单测两个用例变红（AC 只要求单测红，e2e 也一并红了）：

```
 × an existing row renamed into a matching rule is removed
   → [ + 'seed-1', 'seed-2' ]
 × a session inserted nameless and named into a rule afterwards is invisible in the net result
   → + [ 'late-1' ]  - []
 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)      EXIT=1
 ✘ e2e ... (31.3s)  Expected: 0  Received: 1   1 failed
```

还原后的绿读数：单测 `5 passed`，e2e `1 passed (16.7s)`；`git diff` 为空，即还原后实现与 `298f1af0` 逐字节相同。

### AC4 —— 既有测试不回归

```
$ npx vitest run src/modules/sidebar/tests/sessionFilterBar.test.tsx \
    src/modules/sidebar/tests/sessionFilterEditor.test.tsx \
    src/modules/project-workspace/tests/projectsStateSessionFilterLateName.test.ts \
    src/modules/sidebar/tests/recentConversationRowActions.test.tsx
 ✓ src/modules/sidebar/tests/recentConversationRowActions.test.tsx (6 tests)
 ✓ src/modules/sidebar/tests/sessionFilterBar.test.tsx (3 tests)
 ✓ src/modules/project-workspace/tests/projectsStateSessionFilterLateName.test.ts (3 tests)
 ✓ src/modules/sidebar/tests/sessionFilterEditor.test.tsx (7 tests)
 Test Files  4 passed (4)      Tests  19 passed (19)      EXIT=0

$ npm run test:client
 Test Files  166 passed (166)
      Tests  1069 passed | 1 skipped (1070)      CLIENT_EXIT=0
```

### AC5 —— 静态门

```
$ npm run typecheck     # EXIT=0（root + server + scripts 三个 tsc --noEmit）
$ npm run lint          # EXIT=0（oxlint src/ server/ scripts/ shared/，0 error、218 warning，全是既有告警，
                        #   没有一条来自本次改动）
```

**关于裸 `npx oxlint`：**它退出码 1，但报错全部落在 `e2e/`、`experiments/`、`plugin/scripts/` —— 仓库自己的 lint 作用域（`npm run lint`）不含这三处，`e2e` 与 `experiments` 的既有报错在 develop 上同样存在（本任务的新 spec 一个报错都没有）。判据按仓库的作用域记 `npm run lint` 为 0。

**边界与环：**谓词没有让 sidebar 反向导入 project-workspace —— 控制器把它当 prop 收（`isSessionHiddenByProjectFilter` 由 `useProjectsState` 一侧经 `Sidebar.tsx` 传入），`src/shared/types.ts` 里加的是这个 prop 的类型；新测试经 `@/modules/sidebar` 与 `@/modules/project-workspace` 两个 barrel 导入。boundaries 规则在 `npm run lint` 里通过，sidebar 与 project-workspace 之间没有新增环，也没有跨模块深导入。

### 设计取舍（Proposal 第 2、3、5 条要求写进记录的部分）

1. **实时路径用空 keepSessionIds、`isShowingHidden = false`**，因为 `GET /api/providers/sessions/recent` 正是这样判的：它既不带 keepSessionIds 也不带 includeHidden。判据是「实时成员 == 重新加载成员」，所以运行中/需关注/当前选中这三类豁免在 Conversations 侧一律不适用 —— 让实时视图比重新加载视图宽松正是这次的 bug。
2. **不拿旧标题兜底。** 若 upsert 里判不出项目，列表原样不动；命不命中只看这次送来的标题。实时插入的行由 session id 命名，而规则本来就可能命中 id，不去猜一个更早的标题。
3. **`recentConversationsTotal` 不随移除调整。** 成员集合是契约，计数由下一次重新加载重新导出；为一次删除去改计数只会让两个视图在计数上又分叉。
4. **Conversations 侧的「需关注」取舍。** 中途写入的转录被 watcher 发现、广播的 upsert 会把会话标为需关注；Projects 列表把需关注列为刻意可见的例外，而 Conversations 的实时路径没有这条例外（与 recent 接口一致）。因此 e2e 只在服务启动前种下一行（用来把「从未出现过」与「还没加载完」区分开），其余会话全部由 spec 中途写入。
5. **「先无名」的落地。** 从磁盘发现的 Claude 转录一定会有名字（首条 prompt 或 `UNTITLED_CLAUDE_SESSION` 占位），空名根本不可达 —— 所以 e2e 把这一形态落成「到达时无可读名字（`isMeta` 记录 → 占位名）随后被命名进规则」，字面的空 `summary` 形态留在单测里（先断言它以占位标题被插入）。

**DoD 说明：**本任务不重新构建、不重启用户正在使用的 3001 服务；AC-279 的红→绿翻转由 goal-driver 在合入后按判据命令机械取得。
