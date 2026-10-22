---
id: gap-suite-server-dispatch-longest-first-and-parallel-static-stages
title: 套件提速：全量服务端阶段按历史耗时「长任务先跑」派发（缺基线回退字母序），typecheck 与 lint 两个静态阶段并行
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象（台账实测，`.quay/verification-round.jsonl` 第 636 轮，2026-10-05T23:24Z，绿，总 238s）**：全量套件四个阶段完全串行——typecheck 14.9s → lint 9.0s → server 181s（232 文件，峰值并发 16，平均并发仅 7.4）→ client 32s。其中 server 阶段的理论下界是 `max(最长单文件 129s, 总和/16 = 84s) = 129s`，实际却是 181s，差 52s：`scripts/test.sh` 用 `find server … | sort` 按字母序收文件，最长的 `voice-error-classification.false-forms.test.ts`（129s）排在第 52 秒才起跑，之后约 129 秒基本是它一个人在撑。

**机制一（A）：服务端文件按历史耗时降序派发。** 用排队模拟读同一轮的真实逐文件耗时（耗时与派发顺序基本无关，A/B 实测同一文件 N=4 对 N=16 相差 ±6% 以内）：字母序 181s（与实测一致）→ 最长优先 129s。这是**模拟值，不是实测**。做法：全量收集路径（`FILES` 为空）在 `find | sort` 之后，按已提交的基线文件 `scripts/suite-duration-baseline.tsv`（每行 `<duration_ms><TAB><path>`，`#` 开头为注释）重排：基线里出现且文件仍存在的按耗时降序在前，基线里没有的保持字母序排在其后；基线里已不存在的文件忽略。**fail-open**：基线缺失、为空、不可读、有无法解析的行 ⇒ 与今天逐字节一致的字母序，退出码不变。生效的顺序与来源在 stderr 打一行（stdout 是 `__PERFILE__` 与 dry-run 行的既有契约面，不得掺别的）。位置参数 / `--for-task` 的文件按调用方给的顺序，**不重排**。基线是数据文件而不是新脚本，刻意不新增 `scripts/*.mjs`（见「陷阱」）；其再生成命令（读 `<主检出>/.quay/verification-round.jsonl` 最近一轮绿的 `perFile`，只取 `server/` 项）写在文件头注释里。

**机制二（C1）：typecheck 与 lint 并行。** 二者互不依赖（`tsc --noEmit` 不写文件，oxlint 只读），都在 server 阶段之前。现在 `run_stage typecheck …; run_stage lint …` 串行，约 24s；并行后应约等于较长者（约 15s，推算值，未实测）。做法：两个后台子 shell 各自写 `$TMP/stage-<label>.out` 与结果文件（rc / 耗时 / 结束时刻，形同 server 阶段的 `.res`），`wait` 之后在**父 shell**按固定顺序（typecheck、lint）调用 `record`（`record` 改的是父 shell 的计数器，不能在子 shell 里调），再 `progress`。`__PERFILE__` 行标签、`__PERFILE_KIND__` 语义、「每个阶段都跑、任一红则退出码非零」均不变。

**测试接缝（仅测试用，未设置时行为与今天完全一致）**：`QUAY_SUITE_DURATION_BASELINE=<path>` 覆盖基线路径；`QUAY_TEST_STOP_AFTER=order|stages`：`order` 在收集与排序之后把服务端文件逐行打到 stdout 并以 0 退出；`stages` 在两个静态阶段记账之后按正常判词收尾，跳过 server 与 client 阶段。三者都要写进 `test.sh` 头部的环境变量清单。

**不做**：不抬高 `QUAY_TEST_CONCURRENCY_CEILING`（下界是 129s 与 84s，不是并发数卡住，平均并发才 7.4）；不改 `package.json` 的 `typecheck` 脚本（voice 的 false-forms 把它当冻结面断言）；不改看门狗阈值；不缩短 129s 那个文件本身（另开任务，涉及判据的判据）；client 阶段不动。

**陷阱（来自本仓记忆，已核对）**：新增 `scripts/*.mjs` 会因 `scripts/tsconfig.json`（allowJs+checkJs+strict）被 `npm run typecheck` 扫到并让整套件红 ⇒ 本任务不新增 `.mjs`。`test.sh --for-task` 只选 `## Touches` 里的 `*.test.*` ⇒ 受影响的测试文件必须列在 Touches。`server/shared/tests/quay-test-script.test.ts` 在 `server/` 下，改动它须按 `AGENTS.md` 加载并遵循 `$backend-module-standards`。

<!-- dedup-ref -->相关但机制不同：`gap-tsc-sees-transient-probe-file`（已完成：并发 typecheck 扫到 voice 判据的瞬时探针）；C1 的两个阶段都在 server 阶段之前，不新增与测试进程的重叠。`gap-voice-sensevoice-server-adapter`（ready）正文提到了 `find … | sort` 这一行，但它的 Touches 不含 `scripts/test.sh`，二者无文件重叠。

## AC

- [x] AC1 自测（`suite-scope-check.sh` 要求 Touches 含 `*.test.*` 的任务必须带 `--for-task`）：`bash scripts/test.sh --for-task gap-suite-server-dispatch-longest-first-and-parallel-static-stages` → 退出码 0，输出含 `# fail 0`；`quay-test-script.test.ts` 内新增的用例名都以 `AC2:`…`AC7:` 为前缀，且直接 `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts` 运行时 `fail 0`、六个前缀都出现在输出里（套件把逐文件子进程输出收进 `$TMP` 不回显，故用例名不在套件 stdout 上）。
- [x] AC2 降序派发：用例构造一个基线夹具（含 3 个已存在的服务端文件，耗时互不相同，另有 1 个不存在的路径），执行 `QUAY_TEST_STOP_AFTER=order QUAY_SUITE_DURATION_BASELINE=<夹具> bash scripts/test.sh` → 退出码 0；stdout 的前 3 行恰为这 3 个文件按耗时降序，其后为基线未列出的文件按字母序；不存在的那条路径不出现。
- [x] AC3 fail-open 与可观测：基线 ①不存在 ②为空 ③含无法解析的行（非数字耗时 / 缺路径）④不可读，各一例，`QUAY_TEST_STOP_AFTER=order …` 的 stdout 均与 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort` 逐字节相同、退出码 0，且 stderr 恰有一行 `test.sh: server dispatch order=alphabetical reason=<原因>`；有效基线时 stderr 恰有一行 `test.sh: server dispatch order=longest-first source=<路径> known=<n> unknown=<m>`。
- [x] AC4 集合不变：任一基线下，`QUAY_TEST_STOP_AFTER=order` 的 stdout 排序后与 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort` 的输出 `diff` 为空（既不丢也不重）；位置参数调用（`QUAY_TEST_STOP_AFTER=order bash scripts/test.sh` 后接两个真实存在的 server 测试文件，且先给的那个按字母序靠后）按给定顺序打印这两个文件，不重排。
- [x] AC5 C1 并行（结构判定，不依赖墙钟）：用例在 `PATH` 前置一个桩 `npm`，`npm run typecheck` 与 `npm run lint` 各自先创建自己的标记文件，再最多等 10 秒直到对方的标记文件出现，见到则退出 0、否则退出 7；`QUAY_TEST_STOP_AFTER=stages bash scripts/test.sh` → 退出码 0。若两个阶段串行，先起的桩等不到对方标记，必然以 7 退出而变红。
- [x] AC6 阶段契约不变：同一桩让 typecheck 退出 1 且让 lint 先于 typecheck 结束，`QUAY_TEST_STOP_AFTER=stages bash scripts/test.sh` → 退出码非 0；stdout 含 `typecheck passed=false`、`__PERFILE_KIND__ file=typecheck kind=assert`、以及 `lint passed=true`；`__PERFILE__` 行里 `typecheck` 出现在 `lint` 之前（无论谁先结束）。
- [x] AC7 基线数据真实：`scripts/suite-duration-baseline.tsv` 存在；所有非注释行匹配 `^[0-9]+\tserver/\S+\.test\.(ts|js)$`；覆盖当前 `find` 列表的至少 90%；按耗时降序前 8 行含 `voice-error-classification.false-forms.test.ts`；文件头注释含再生成命令与数据来源轮次号。
- [x] AC8 头部文档：`grep -c 'QUAY_TEST_STOP_AFTER\|QUAY_SUITE_DURATION_BASELINE' scripts/test.sh` 的结果 ≥ 4（头部清单与使用处各至少一次）。
- [x] AC9 既有契约守卫不退化：`bash scripts/suite-scope-check.sh` → 0；`bash scripts/server-phase-concurrency-check.sh` → 0（默认 / `--test-concurrency=4` 两条 dry-run 输出行逐字不变）。动手前先各读一次基线读数；若某守卫在 develop 上本就红，在完成记录里写明并只证明「改动前后读数相同」。
- [x] AC10 `npm run typecheck` → 退出码 0，`npm run lint` → 退出码 0；`git diff --name-only $(git merge-base HEAD develop) HEAD` 的文件集合 ⊆ `## Touches` 所列。

## DoD

真实落地的标准是「一次真实 fan-in 的台账读数」，而不是夹具通过。本任务落地后的**第一轮**真实 fan-in 的 `.quay/verification-round.jsonl` 记录（`runner=inner`）里要读出并贴进完成记录：①server 阶段跨度（`perFile` 里 `server/` 项的最早开始到最晚结束）；②typecheck 与 lint 的 `startedAtMs`/`endedAtMs` 区间确实重叠；③`perFile` 条目数与改动前同一量级（约 399，行集合不变，仅顺序不同）。对照基准：改动前 server 181s、静态阶段 24s、总 238s；推算预期 server 约 129–140s、静态阶段约 15s、总约 176s（均为推算，非实测）。若 server 跨度仍 ≥ 170s，说明排序没有生效，须先查明再收口。同时要真实操作一遍基线再生成命令（从台账重新生成并与已提交版本 `diff`），证明它不是一次性产物。未验证项：quay 的 /tests 页是否依赖 `__PERFILE__` 行序——本仓内无法断言，落地后看该页该轮的 server 行数与内容是否正常。

## Touches

- scripts/test.sh
- scripts/suite-duration-baseline.tsv (new)
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-suite-server-dispatch-longest-first-and-parallel-static-stages.md