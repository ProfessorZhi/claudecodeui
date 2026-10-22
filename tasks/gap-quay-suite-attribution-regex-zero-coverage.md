---
id: gap-quay-suite-attribution-regex-zero-coverage
title: quay driver 的 suite 失败归因正则对本项目零覆盖：可一行修的真缺陷被误判「归因不出」park 成 needs-human
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

判定机制（上游缺陷，位于 quay 插件，不在本仓库）：`worker-driver.ts` 的 `failingTestFilesFromSuiteLog`（约 1927 行）用下面这条正则从 suite 日志提取失败测试文件：

```js
/(?:^|\s|\/)((?:packages|plugin|experiments)\/[^\s]+\.test\.mjs)\s+passed=false\b/
```

前缀集合 `packages|plugin|experiments` 与后缀 `.test.mjs` 是 **quay 插件自己仓库**的测试布局。本仓库的测试是 `server/**/*.test.ts` 与 `src/**/*.test.tsx`（`scripts/test.sh` 按 `gap-quay-tests-page-perfile-wrapper` 的 AC 输出 `<相对仓库根路径> passed=<true|false>`），因此该正则对本项目**匹配恒为零**：函数返回 `[]` ⇒ 调用方（约 2306 行）判 `insufficient-data-fallback: "no failing test file extracted from the suite log"` ⇒ 至多一次重试后 park `needs-human`，判词包含「the suite log names nothing a worker could fix」这一错误断言。它同时完全不认 `not ok - lint: <rel>:<line>:<col>` 与 `not ok - <rel>: ...` 这两类**指名了文件**的失败行。

实证（2026-09-20，`.quay/fan-in-suite-gap-model-env-row-single-source-context-window~wk-prod-anchor~1789898719986-2acd7b.log`）：`grep -c "passed=false"` = 1，按上述正则匹配数 = **0**。该日志中两类关键行（fixture 可据此重建，原日志会被 driver 的 cleanup 步骤 prune）：

```
__PERFILE__ duration_ms=8170 lint passed=false end_ms=1789898748016
not ok - lint: server/modules/launch-profiles/tests/model-context-window.test.ts:10:49: error boundaries(dependencies): Cross-module imports must go through that module's barrel file (server/modules/<module>/index.ts or index.js).
```

注意第一类行里的 `lint` 是**无路径的伪文件**名（`gap-quay-tests-page-perfile-wrapper` 的 AC 规定的 typecheck/lint 伪文件记录），第二类行才是真正指名文件的行。真凶正是一条可一行修的 barrel 导入缺陷（同日在 sidebar 任务上同类）。

危害（已观测，非推测）：同一误判造成 **4 个任务、5 次 park**，每次 park 前上限 2 次重试，单次重试即一个完整 worker 会话；判词还主动告诉操作者「没有 worker 能修的东西」，属方向性误导（每次都错）。受害者：`gap-model-env-row-single-source-context-window`、`gap-project-session-name-filter-sidebar-ui`、`gap-launch-profiles-passthrough-env-parity-test`、`gap-launch-profiles-session-profile-lock-test`（后两者现已 done，其 Needs-Human 段留有同一判词）。

<!-- dedup-ref -->邻近但机制不同的既有任务：`gap-quay-tests-page-perfile-wrapper`（已 done）是**产出侧** —— 它在 `scripts/test.sh` 建立 `__PERFILE__ duration_ms=… <相对仓库根路径> passed=<true|false> end_ms=…` 的输出契约；本任务是**解析侧**，即插件如何消费这些行。二者机制不同，不重复。

本仓库侧可交付的落地物（上游修复不在本仓库：插件由 `.quay/config.yml` 的 provider `path` 指向 plugin cache，未 lay down 进项目）：一个独立探针，自动读插件实际使用的正则与真实 fan-in 日志，量化「日志指名的失败文件数」与「解析器提取数」的差值，使这类误判在下次发生时**可被机械发现**，而不是靠人读日志。

1. `scripts/quay-attribution-probe.mjs`：从 `.quay/config.yml` 的 provider `path` 推导插件 dist，取出 `failingTestFilesFromSuiteLog` 实际使用的正则；对给定 suite 日志（默认取 `.quay/fan-in-suite-*.log` 中最新一份）统计：`not ok -` 行指名的相对路径数 vs 正则匹配的 `passed=false` 行数，打印两者，并以非零退出码表示「存在未被归因的失败」。
2. `scripts/__fixtures__/fan-in-suite-lint-failure.log`：真实日志节选（含上面两类行），供探针自测，使判定不依赖「当前恰好哪份日志最新」（原日志会被 prune）。
3. ⛔ 探针**不得**并入 `scripts/test.sh`：让上游缺陷把本仓库 suite 弄红，只是把误判搬到另一处。

## AC

- [x] `node scripts/quay-attribution-probe.mjs --log scripts/__fixtures__/fan-in-suite-lint-failure.log` 在**未修**的插件上退出码非零，并打印「日志指名失败文件数 ≥1、解析器提取数 0」的差值（复现上游缺陷）。
- [x] `node --test scripts/quay-attribution-probe.test.mjs` 退出码 0：fixture 驱动，断言探针计数逻辑能区分「指名了文件的失败」与「未指名」，且不把无路径的 `lint` 伪文件行计为测试文件。
- [x] 真实日志实测：`node scripts/quay-attribution-probe.mjs`（默认取最新 `.quay/fan-in-suite-*.log`）对一份含失败的日志同样给出非零退出码与差值；所用命令与实测输出写入完成记录。
- [x] `bash scripts/test.sh` 退出码 0：探针未并入 suite，本仓库既有测试不回归。

## DoD

真实落地判据：不是仅有一个脚本文件存在。要求探针在**真实**（非合成）fan-in 日志上实际跑通并给出差值结论，结论可重复、由退出码承载（不依赖人工读日志）；fixture 自测覆盖其计数逻辑，且两者在同一次运行中给出一致判定。上游把该正则改为覆盖本仓库布局（或改为同时解析 `not ok -` 行使指名文件可归因）之后，同一探针命令退出码转 0 —— 即本任务的完成状态由探针机械核验，而非由人声称；届时探针可转为常驻回归断言。

## 完成记录

实测命令：`node scripts/quay-attribution-probe.mjs`（默认取最新 `.quay/fan-in-suite-*.log`）→ 输出 `named failing files (not ok -): 1 [server/modules/launch-profiles/tests/model-context-window.test.ts]` / `parser-extracted files (passed=false): 0` / `unattributed: 1`，退出码 1。fixture 同命令加 `--log` 结果一致；`node --test scripts/quay-attribution-probe.test.mjs` 4/4 通过；`bash scripts/test.sh` 退出码 0（174 pass / 0 fail）。

## Touches

- scripts/quay-attribution-probe.mjs (new)
- scripts/quay-attribution-probe.test.mjs (new)
- scripts/__fixtures__/fan-in-suite-lint-failure.log (new)
- tasks/gap-quay-suite-attribution-regex-zero-coverage.md
