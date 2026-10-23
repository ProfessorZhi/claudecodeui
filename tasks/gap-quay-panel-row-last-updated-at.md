---
id: gap-quay-panel-row-last-updated-at
title: Quay 面板的 Recent tasks 与 Stage goals 每行不显示最后更新时间：两个列表本就按 updatedAt 降序，排序依据却看不见
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象**：Quay 面板的 "Recent tasks" 与 "Stage goals" 两个列表，每行只显示 id / title / status，不显示该行对象的最后更新时间。而这两个列表**恰恰是按 `updatedAt` 降序排的** —— 排序依据看不见，读者无法判断"最近"到底是多久以前。

**根因（已核对，非推测）**：数据一路都在，是在投影那一步被丢掉的。

- `quay task list --json` 的每条记录都带 `updatedAt`（epoch 毫秒，浮点，实测 `1786439928515.85`）；`quay goal list --json` 同样带 `updatedAt`（实测 `1788773746346.9514`）。
- `server/modules/quay/quay.service.ts` 的 `summarizeRecentItems()` 用 `readCount(record.updatedAt)` 做降序排序（id 升序决胜），然后只投影出 `{id, title, status}` 三个字段 —— 函数注释自己写着"只保留面板渲染的这三个字段"。
- 服务端 `QuayListItem`（`quay.service.ts`）与前端 `QuayListItem`（`src/shared/types.ts`）都只有这三个字段。
- `QuayPanel.tsx` 的 `DetailList`（Recent tasks 行）与 `StageGoals` 行因此无值可渲染。

**改法（两步，都在本仓库）**：

1. `QuayListItem` 增加 `updatedAt: string | null`，服务端把 CLI 的 epoch 毫秒换算成 ISO-8601 字符串；CLI 记录缺该字段或值非有限时给 `null`（不是 0，不是空串，也不是 `Invalid Date`）。
2. `QuayPanel.tsx` 的 `DetailList` 行与 `StageGoals` 行渲染该时间，并把原始 ISO 放进一个机器可读属性，使判据不受 locale 与时区影响。值为 `null` 的行显示 `—`（沿用本文件 `formatDuration` 已有的缺失占位约定），不显示 `never` —— "从未更新"是另一个语义，与"读不到"不同。

**范围外**：不新增 quay CLI 读取命令、不改只读命令白名单（`updatedAt` 已随现有 `task list --json` / `goal list --json` 返回）；不改 `quay` 仓库（那是另一个 store，本任务只动 CloudCLI）。ADR 列表与 tasks/goals 共用 `QuayListItem` 与 `DetailList`，字段落地后它会一并显示；本任务的 AC 只对 **task 行**与 **goal 行**提要求。

## AC

- [x] AC1 **投影带上时间且可判**：`GET /api/quay/:projectId/snapshot` 的 `tasks.recent[]` 与 `goals.breakdown.recent[]` 每项都含 `updatedAt`，为 ISO-8601 字符串，由 CLI 的 epoch 毫秒换算而来（抽一条与 CLI 原值逐位比对：`new Date(<CLI 原值>).toISOString()` 必须相等）；CLI 记录缺 `updatedAt` 或值非有限时该项为 `null`。判据：`server/modules/quay/tests/quay.service.test.ts` 新增用例，用两份 `updatedAt` 不同的 fixture 断言 ISO 值与降序，再插一条无 `updatedAt` 的记录断言 `null` 且排在末尾。**在改造前的树上该用例必须红**，逐字记录失败行。
- [x] AC2 **两处列表每行都标了最后更新时间**：QuayPanel 渲染出的 "Recent tasks" 每一行与 "Stage goals" 每一行都带该行对象的最后更新时间 —— 行内可见文本包含按快照值格式化出的时间，且该行带 `data-updated-at` 属性，取值逐字为该行的 ISO 值；`updatedAt` 为 `null` 的行显示 `—`，不是空白、不是 `never`、不是 `Invalid Date`。判据：`src/modules/quay/tests/QuayPanel.test.tsx` 新增用例，按 `data-updated-at` 取值断言（fixture 给定 ISO），并断言 null 行的可见文本为 `—`。**在改造前的树上必须红**。
- [x] AC3 **排序依据与显示值一致**：`tasks.recent` 与 `goals.breakdown.recent` 的降序就是所显示的那个 `updatedAt`（id 升序为并列决胜）。判据：AC1 的用例里 fixture 的 updatedAt 顺序与 id 字母序**故意相反**，断言输出顺序随 updatedAt 而非随 id；若实现改成按 id 排或按数组原序返回，该用例必须红。

## DoD

**真实对象上操作过，不是仅判据绿**：在真实运行的 CloudCLI（本机 3001）上，用真实项目 `/data/home/yale/work/quay`（2531 个任务）打开 Quay tab，"Recent tasks" 与 "Stage goals" 每一行都显示出最后更新时间；抽 **2 行**（两个列表各一行）与该对象在 store 里的真实 `updatedAt` 逐字比对一致 —— 从 `quay task list --json` / `quay goal list --json` 读出该 id 的原值，换算后与页面读到的属性值相等。读数必须由**浏览器里的真实 DOM** 取得，只看到 API 响应不算。

负控制：把某一行在投影里强制置 `null` 后，该行必须显示 `—`，既不显示别行的时间也不显示空白。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/tests/quay.service.test.ts
- src/shared/types.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- tasks/gap-quay-panel-row-last-updated-at.md

## Evidence

### AC1 / AC2 改造前红（逐字失败行）

`server/modules/quay/tests/quay.service.test.ts` 的 `recent rows carry updatedAt as an ISO-8601 string, and the ranking is that same value`：

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected

  [
+   undefined,
+   undefined,
+   undefined,
+   undefined,
+   undefined,
+   undefined
-   '2026-10-04T03:49:56.647Z',
-   '2026-09-07T09:35:46.346Z',
-   '2026-08-11T09:18:48.515Z',
-   '1970-01-01T00:00:00.000Z',
-   null,
-   null
  ]

    at TestContext.<anonymous> (server/modules/quay/tests/quay.service.test.ts:393:10)
```

`src/modules/quay/tests/QuayPanel.test.tsx` 的 `QuayPanel stamps every Recent tasks and Stage goals row with its own last-updated reading`：

```
AssertionError: Expected values to be strictly equal:
+ actual - expected

+ null
- '2026-10-01T12:34:56.000Z'

 ❯ src/modules/quay/tests/QuayPanel.test.tsx:191:10
```

### AC3 变异复演

把 `summarizeRecentItems` 的比较器换成按 id 升序（其余不动），判据红：

```
actual:   [ 'a-epoch-zero', 'b-old', 'c-mid', 'd-new', 'e-missing', 'f-unreadable' ]
expected: [ 'd-new', 'c-mid', 'b-old', 'a-epoch-zero', 'e-missing', 'f-unreadable' ]
```

fixture 的有限值块 id 字母序与 updatedAt 降序**故意相反**，且数组原序就是 id 序 —— 按 id 排与按原序返回会得到同一条错序，两者都被这条断言红掉。

### DoD 真实对象读数

真实项目 `/data/home/yale/work/quay`（2531 tasks / 222 goals / 36 adrs），真实 CloudCLI 从本 worktree 启动，真实 Chromium 里的真实 DOM。10 行 Recent tasks + 10 行 Stage goals 的 `data-updated-at` 与 `new Date(<该 id 在 store 里的 updatedAt 原值>).toISOString()` 全部逐字相等，0 处不符；抽出比对的两行：

| 列表 | id | CLI 原值 | `data-updated-at` | 行内可见文本 |
| --- | --- | --- | --- | --- |
| Recent tasks | gap-dist-rewrite-injects-live-interpolation-into-workflow-js | 1791073715954.8057 | 2026-10-04T00:28:35.954Z | 10/4/2026, 8:28:35 AM |
| Stage goals | AC-161 | 1791081089152.3965 | 2026-10-04T02:31:29.152Z | 10/4/2026, 10:31:29 AM |

负控制：把快照响应里第一行 task 与第一行 goal 的 `updatedAt` 强制置 `null` 后，那两行渲染 `—`、不带 `data-updated-at`，相邻行仍保留各自的时间（不是整体丢列，也不是显示别行的时间）。

读数的宿主说明：面板所在的 CloudCLI 由本 worktree 的代码启动（Playwright harness 自选空闲端口），不是 :3001 —— :3001 提供的是主 checkout 的冻结代码，按构造不含本次改动，因此那里的读数不是本改动的读数。
