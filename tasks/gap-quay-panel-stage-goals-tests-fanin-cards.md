---
id: gap-quay-panel-stage-goals-tests-fanin-cards
title: Quay 面板补齐 Stage goals/Task ledger/Tests/Fan-in 四张卡(镶同款数据源)
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

真实 `quay serve` dashboard(端口 3651)有五张卡:Loop pulse / Stage goals / Task ledger / Tests / Fan-in。本任务补齐其中四张(Stage goals、Task ledger、Tests、Fan-in);第五张 Loop pulse(5 道车道的在飞任务 Gantt)单独搁置——它需要的"当前在跑哪些任务"数据,quay 自己是扫 `/proc` 拿到的(`readLiveWorkerProcesses`,`packages/quay/src/observation.ts:962`),claudecodeui 这边不打算自己仿一套 `/proc` 扫描(已和维护 quay 的另一个会话核实:这类扫描的判别依据是 quay 内部的 cmdline 字符串约定,quay 一旦改,我们的扫描不报错只会静默退化成空白——"读不到"和"没有在跑"长一个样,没人会发现它坏了;是否由 quay 集中提供等价的只读接口,待其维护者裁决,不预排期)。

**四张卡的真实数据载体**(已经和另一个 quay 会话交叉核实、并在本仓库里实测验证存在,下表是本任务的权威依据,写错任何一格都要按这张表改回来,不要凭直觉重新归因):

| 卡片 | 读取方式 | 载体/命令 | 本仓库实测 |
|---|---|---|---|
| Stage goals | 子进程 CLI(已在白名单) | `quay goal list --json` | 返回 `{id,title,status,kind,goal,...}` 数组,152 条 |
| Task ledger | 复用已有任务统计 | `quay task list --json`(已在白名单,`getQuaySnapshot` 已经在拉) | 303 条,按 status 分布已有 |
| Tests · 当前态 | 直接读文件(无 CLI/MCP 等价命令) | `.quay/full-suite-state.json` | 376 字节,单个 JSON 对象:`{state,runner,scope,startedAt,finishedAt,durationMs,laneCount,commit,taskId,runId}` |
| Tests · 历史 | 直接读文件,**流式**(见下) | `.quay/verification-round.jsonl` | 470 行、16.5MB,每行一条历史轮次:`{round,startedAt,durationMs,pass,fail,tests,state,perFile:[...],...}` |
| Fan-in | 直接读文件 | `.quay/worker-outcome.jsonl` | 609 行、~900KB,每行一条任务跑:`{task,started_at,ended_at,final_state,mechanical_fan_in:{outcome,lockAcquireEpoch,lockReleaseEpoch,...}}` |

⚠️ 这是镶"卡"不是镶"/tests 页"——quay 自己的 `/tests` 页故意不读 `full-suite-state.json`(serve-tests.ts 有注释说明:worktree 的红不得翻转主信号,历史页不得显示一个无法从记录溯源的当前态),但 dashboard 的 Tests **卡**两个文件都读(`renderTestsCard(tests, suiteRun, …)` 吃两个入参)。本任务镶的是卡,所以 Tests 的"当前态"也要做,不能只做历史半。

⚠️ `verification-round.jsonl` 16.5MB,**禁止整文件读入内存再 `JSON.parse`/过滤**——按行流式读取(例如从文件尾部往前读固定字节窗口、按 `\n` 切行,只保留最近 N 轮),否则每次面板刷新都会在 Node 主线程上分配并扫一个 16MB+ 的字符串。

`.quay/worker-outcome.jsonl` 虽然当前只有 ~900KB,也要用同一套"按需读取最近 N 条"的读取器,不要假设它会一直这么小(这正是 Fan-in 卡历史半的数据源,逻辑上和 Tests 历史半是同一类"按行流式取最近 N 条"问题,建议抽一个共享的 reader 工具函数)。

## Plan

1. 后端 `server/modules/quay/quay.service.ts`:
   - 新增 `readCarrierFileTail(root, relativePath, maxLines)`:按行流式读取(从文件尾部读固定字节块、按换行切分、JSON.parse 每行,解析失败的行跳过而不是整体抛错),返回最近 `maxLines` 条记录。`.quay/verification-round.jsonl` 与 `.quay/worker-outcome.jsonl` 共用这个函数。
   - 新增 `readCurrentSuiteState(root)`:直接 `fs.readFile` + `JSON.parse` `.quay/full-suite-state.json`(376 字节级别,不需要流式);文件不存在或解析失败时返回 `null`,不抛错、不进 `warnings`(和 Loop pulse 搁置的理由一致:这本来就是"有没有正在跑"的正常状态之一)。
   - `getQuaySnapshot` 新增四个字段:
     - `goals.breakdown`:在现有 `goal list --json` 响应基础上,按 `status` 分组计数(active/achieved/needs-human/...),外加最近若干条(复用 `summarizeRecentItems` 的排序逻辑,按 goal 的某个时间字段或 id 排序,具体以 CLI 真实返回的字段为准)。
     - `tasks` 已有字段基础上,给 Task ledger 卡需要的"按 status 分桶的百分比"直接在前端用已有 `byStatus` 算,不需要后端新增字段。
     - `tests`:`{ current: SuiteStateSummary | null, recentRounds: TestRoundSummary[] }`,`current` 来自 `readCurrentSuiteState`,`recentRounds` 来自 `readCarrierFileTail(..., 'verification-round.jsonl', 10)` 投影出 `{round, startedAt, durationMs, pass, fail, tests, state}`(不携带 `perFile` 全量,太大)。
     - `fanIn`:`{ recent: FanInAttemptSummary[] }`,来自 `readCarrierFileTail(..., 'worker-outcome.jsonl', 10)`,过滤 `mechanical_fan_in != null` 后投影出 `{task, outcome, lockAcquireEpoch, lockReleaseEpoch}`(直接复用已有 Touches 里 `summarizeRecentItems` 旁边新加一个 `summarizeFanInAttempts`)。
2. 前端 `src/modules/quay/QuayPanel.tsx`:
   - 新增 "Stage goals" 区块:每个 goal 一行,标题 + 状态 + 一条 flat progress bar(`width:${pct}%`,仿 quay 自己 `renderGoalCard` 的朴素实现,不需要 SVG)。
   - "Task ledger" 区块:把现有的 Tasks 摘要卡 + "Tasks by status" 列表 + "Recent tasks" 列表,视觉上归并成一个标题为 "Task ledger" 的卡(这三块数据已经都有,本步骤主要是布局/标题调整,不是新数据管道)。
   - 新增共享的 `src/modules/quay/TimelineBar.tsx`:单车道时间线 SVG 组件(百分比窗口映射,仿 quay `renderTimelineBarSvg` 的坐标数学:`X(t) = plotLeft + ((t - windowStart) / windowSpan) * plotWidth`),每个历史记录画一个 `<rect>`,原生 `<title>` 做 tooltip。Tests 卡和 Fan-in 卡都用这个组件,只是喂的数据不同。
   - 新增 "Tests" 区块:当前态(`tests.current`,用文字+颜色点表示 `state`,没有当前态时显示"No suite running")+ `TimelineBar` 画 `tests.recentRounds`(每条 `[startedAt, startedAt+durationMs]`,颜色按 `state`)。
   - 新增 "Fan-in" 区块:`TimelineBar` 画 `fanIn.recent` 的 `[lockAcquireEpoch*1000, lockReleaseEpoch*1000]`(注意这两个是秒级 epoch,TimelineBar 内部统一按毫秒),外加文字列表显示最近 5 条的 `task`/`outcome`。
3. `src/shared/types.ts` 同步新增 `goals.breakdown`/`tests`/`fanIn` 的类型定义。

## AC

- [x] `npm run typecheck` 退出码 0。
- [x] 后端新增/更新的窄测试(`server/modules/quay/tests/`)退出码 0,覆盖:(a) `readCarrierFileTail` 对一个人工构造的多行 fixture 文件只返回最近 N 条,且不会把整个文件读入一次性字符串(用一个远大于 N 行的 fixture 验证,断言调用耗时/内存级别的代理指标,或直接检查实现确实是按块读取而不是 `fs.readFileSync` 全量——测试里可以 mock 底层读取接口断言调用方式);(b) `readCurrentSuiteState` 对文件存在/不存在两种情况返回正确结果,不存在时不抛错;(c) Tests/Fan-in 两个新字段在对应 fixture 下投影字段正确(不包含 `perFile` 全量)。
- [x] 前端新增/更新的窄测试(`src/modules/quay/tests/`)退出码 0,覆盖:(a) `TimelineBar` 组件对一组区间 fixture 渲染出对应数量的 `<rect>`,且每个 `<rect>` 的 x 位置随区间时间单调变化(不要求像素级精确匹配,只要求相对顺序正确);(b) `QuayPanel` 的 Stage goals/Tests/Fan-in 区块在对应 snapshot 字段为空/有值两种情况下分别渲染空态和内容。
- [x] 真实数据核对:在本机对 claudecodeui 自身跑 `quay goal list --json`,与面板 Stage goals 区块的计数手工核对一致;读 `.quay/full-suite-state.json`/`.quay/verification-round.jsonl` 最后几行/`.quay/worker-outcome.jsonl` 最后几行,与面板 Tests/Fan-in 区块展示的最近几条记录字段级核对一致(记录在 DoD)。

## DoD

- 真实跑通:启动 CloudCLI,打开 claudecodeui 自身项目,切到 Quay tab——Stage goals/Task ledger/Tests/Fan-in 四个区块都渲染出真实数据,不是占位符;Tests 区块的"当前态"与同一时刻 `.quay/full-suite-state.json` 的内容一致,Fan-in 区块最近 5 条与 `.quay/worker-outcome.jsonl` 尾部记录一致。
- 性能核对:打开面板后用浏览器开发者工具或后端日志确认一次 snapshot 请求没有把 16.5MB 的 `verification-round.jsonl`整体读入内存(例如临时加一行日志打印读取的字节数,确认远小于文件总大小,验证后移除)。
- 人工审查:确认 Tests/Fan-in 的文件读取路径是只读(`fs.readFile`/等效流式 API),没有任何写操作,且路径拼接基于受信的项目根(不接受前端直传路径字符串)。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/tests/quay.service.test.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/TimelineBar.tsx (new)
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/quay/tests/TimelineBar.test.tsx (new)
- src/shared/types.ts
- tasks/gap-quay-panel-stage-goals-tests-fanin-cards.md (self-touch)
