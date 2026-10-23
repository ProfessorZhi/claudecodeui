---
id: transcript-long-session-e2e-seed
title: e2e 种子：一个 ≥1000 用户轮次、含同毫秒轮次与工具行的长会话，供 GOAL-017 的四条真实浏览器判据共用
status: done
labels:
  - gap
parent: null
children: []
extra: {}
depends_on: []
---
## Proposal

GOAL-017 的 AC-213 至 AC-216 都要在真实浏览器里面对一个「远长于首屏窗口」的会话：首屏只加载尾部，目标轮次从未进过 DOM。现有 e2e 种子（playwright.config.ts 的 seedTranscriptFollowTranscript）只有 24 条且刻意落在 30 行初始挂载带内，不能当这个用途。四条判据各自造种子会让 playwright.config.ts 被四个任务同时改（touches 相撞），所以先立一个共用种子。

要做的事：在 playwright.config.ts 里新增一个种子函数，在服务启动前写入一份真实 Claude 转录（沿用 transcript-follow 种子的方式：写进隔离 HOME 的 .claude/projects，由后端自己的 synchronizer 在启动扫描时索引）。会话 id `e2e-transcript-jump`，显示名 `transcript-jump`，独立 workspace 目录，避免其他 spec 误取。内容：1200 个用户轮次，每轮后跟 1 条 assistant 文本、其中每 7 轮带一个 tool_use 与其 tool_result，每 50 轮带一个 thinking 块；第 600 与 601 个用户轮次使用同一毫秒的 timestamp（供同毫秒定位判据）；正文用短段落，不含代码块与图片，避免晚到的重排。总体积控制在 10MB 以内（e2e 的 dataDir 在根分区上，见仓库记录的磁盘告急教训）。

## Plan

1. 在 playwright.config.ts 中新增种子常量（workspace 目录、session id、名称、轮次数）与 `seedTranscriptJumpTranscript()`，在与其他种子相同的位置调用。
2. 新增 `e2e/transcript-long-session-seed.spec.ts`，只含一条冒烟用例「AC-seed」：经侧栏打开该会话，读 REST 历史接口的 total，断言 ≥ 4800；断言首屏 DOM 里的最早用户轮次序号 > 1000（即只加载了尾部）；断言第 600/601 轮的 timestamp 相同而 id 不同。
3. 把种子的常量以只读方式导出给后续 spec 引用的最小面：后续 spec 自己写字面量 `e2e-transcript-jump`，不 import playwright.config.ts（避免配置求值副作用）。

## AC

- [x] AC1 冒烟绿：`npx playwright test e2e/transcript-long-session-seed.spec.ts -g "AC-seed"` 退出 0。红态基线：spec 文件不存在，playwright 报 No tests found。
- [x] AC2 取假形态必须红：(a) 把轮次数降到 24 ⇒ total 断言红；(b) 把第 601 轮的 timestamp 改成不同毫秒 ⇒ 同毫秒断言红。逐条记录变异 diff 与逐字失败行，恢复后重新绿。
- [x] AC3 `npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）。
- [x] AC4 冷启动预算：加上该种子后，一次 `npx playwright test e2e/transcript-follow.spec.ts` 的配置求值加种子阶段耗时增量 ≤ 2s（读 playwright.config.ts 头注释里记录的静默基线，写下实测前后读数）。

## DoD

- 种子是真实 JSONL，由后端自己的启动扫描索引，不 stub 任何请求。
- 种子写在服务启动之前（与其他种子同一位置），不在 spec 运行中写入。
- 其他 spec 的种子与会话不受影响：`e2e/transcript-follow.spec.ts` 的判据仍为绿。
- 只动 `## Touches` 列出的文件。

## Touches

- playwright.config.ts
- e2e/transcript-long-session-seed.spec.ts (new)
- tasks/transcript-long-session-e2e-seed.md
