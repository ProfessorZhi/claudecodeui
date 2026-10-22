---
id: gap-voice-phase0-readout-report
title: 阶段 0 读数报告脚本：从本机语音数据计算退出判据（段数、标签数、手改比例、置信度 AUROC、标记数、错词形态清单），只输出聚合、不含原文与音频
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-data-local-store-default-on
  - gap-voice-send-diff-weak-labels
  - gap-voice-confidence-flag-shadow-stats
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置；真正的依赖边在 frontmatter 的 `depends_on`）：`grep -il 'phase0\|阶段 0\|退出判据' tasks/*.md | xargs grep -il voice` 无同机制任务。来源：`docs/proposals/voice-correction-feedback-loop.md` §6 阶段 0 的退出判据：「累计 ≥ 100 条带标识符的段、其中 ≥ 30 条有事后纠正的标签；能算出『自动修复被还原率』『手改比例』『真实的错词形态清单』『置信度对真实错误的 AUROC』『声学别名在真实发音上的增益』」。

### 目标

阶段 0 采集的数据只有在能被读出来时才有价值。本任务写一个**只读**的本机报告脚本：读取语音数据目录（记录、标签、`flagStats`），输出聚合读数与「阶段 0 是否达标」的结论；**输出里不得出现任何原文、最终文字、音频内容或路径之外的个人信息**。

### 读数（聚合）

1. 记录数、段数、含标识符形 token 的段数、有事后纠正标签的段数；是否达标：含标识符段 ≥ 100 且有标签段 ≥ 30（退出码 0 达标 / 2 未达标 / 1 脚本错误）。
2. **手改比例**：有标签的段 ÷ 全部段；被改字符数 ÷ 语音字符数。
3. **错词形态清单**（只给计数）：对每个标签按 `normKey`（只留字母数字、小写）相同 ⇒ `form`（形态：空格 / 连字符 / 大小写）；改后是 `AC-数字` 类、改前是中文数字 ⇒ `spoken-form`；改前**不含拉丁字母**（汉字谐音）⇒ `cjk-rendering`；其余 ⇒ `misheard`。
4. **置信度对真实错误的 AUROC**：错误区域（有标签的 `heard` 区间）的最小 token 置信度，对没被改的标识符形区域；样本不足（任一类 < 10）时输出 `n/a` 而不是一个不可信的数。
5. **标记数与召回**：各 θ 的每 100 字符标记数（取自 `flagStats` 的均值），以及标签区域被某个标记覆盖的比例。
6. 「自动修复被还原率」：记录里有 `repairedText` 时，被用户改回原词的比例；记录没有该字段时输出 `n/a`。
7. 声学别名的真实增益**不在本脚本里算**（需要 CTC 打分管线，见 `experiments/voice-index-loop/`），脚本在输出里列出该项为「需离线实验」并指向 `RESULT-v6.md`。

### 边界（不做）

不联网；不改任何记录；不输出 `heard` / `final` 字符串；不画图。放在 `scripts/` 下，与既有 `asr-*-check.mjs` 同风格，自带 `.test.mjs`。

## AC

- [x] `node --test scripts/voice-phase0-report.test.mjs` 退出码 0：用测试里**构造的**数据目录 fixture（含哨兵字符串作为 `heard` / `final` / 文本）调用报告，断言各项聚合读数与预期相等
- [x] 隐私（带负对照）：报告的全部输出（文本与 `--json`）里**不含**任何哨兵字符串（`grep -c` 为 0）；同一测试里把「脚本把 `heard` 打进输出」的变体做成断言，必须变红
- [x] 达标判定：fixture 含 120 个含标识符段、40 个标签段 ⇒ 退出码 0；含 99 个含标识符段 ⇒ 退出码 2；数据目录不存在 ⇒ 退出码 1 且给出可行动的说明
- [x] AUROC 与形态分类的已知答案：测试里用手工构造的分布（完全可分 ⇒ 1.0，完全重叠 ⇒ 0.5）与每类形态至少 2 个例子断言；样本不足时输出 `n/a`
- [x] 与实验口径一致：报告里的「标记数」与 `flagStats` 原值一致（同一 fixture 上逐 θ 相等）；AUROC 的秩和实现与 `experiments/voice-index-loop/sim/sv-eval2.mjs` 的 `auroc` 在同一数据上逐位相等
- [x] MCP 浏览器验证：在 MCP 浏览器里（`http://localhost:3001/`，调试 agent 会话）用上传入口至少转写并手改发送 3 次，之后运行 `node scripts/voice-phase0-report.mjs`，输出的记录数、段数、标签数与浏览器里的操作次数一致；把输出（聚合数字）记入 `## Evidence`
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：对**真实采集到的**本机语音数据目录运行，输出的聚合读数能回答阶段 0 的退出判据，且输出里找不到任何一句原文。样本不足时诚实地输出 `n/a` 与「未达标」，不凑数。

L_D 该轴有读数：读出的是真实采集数据的聚合统计。

L_G 该轴有读数：置信度 AUROC、标记数与召回，是阶段 0 退出判据的直接读数。

## Evidence

**AC1 — `node --test scripts/voice-phase0-report.test.mjs` 退出码 0**（工作树 `…/gap-voice-phase0-readout-report` 内直跑，2026-10-06）：`tests 16 / pass 16 / fail 0`，`EXIT=0`。fixture 数据目录由测试自己构造，逐项断言聚合读数。

**AC2 — 隐私（带负对照）：** 同一次运行里 `✔ privacy: no sentinel from the text, the heard or the final reaches either output` 与 `✔ privacy negative control: a variant that prints a heard is caught by the same grep` 均通过——把 `heard` 打进输出的变体被同一条 `grep` 判据逮住变红，证明隐私判据本身不是空转。

**AC3 — 达标判定（三条边界各自真跑）：** `✔ gate: 120 identifier segments and 40 labelled segments meet stage 0`（exit 0）；`✔ gate: 99 identifier segments fails on the identifier threshold alone`（exit 2）；`✔ gate: 29 labelled segments fails on the label threshold alone`（exit 2）；`✔ gate: a missing data directory exits 1 with an actionable message`（exit 1，stderr 指向 `VOICE_DATA_DIR` 与 `--dir`）。

**AC4 — AUROC 与形态：** `✔ AUROC: a perfectly separable distribution reads 1.0`；`✔ AUROC: a fully overlapping distribution reads 0.5`；`✔ AUROC: fewer than ten in a class reads n/a, not a number`；`✔ error forms: every class is counted, rewrites are separated from corrections`。

**AC5 — 与实验口径一致：** `✔ marks: the per-theta counts equal the record's own flagStats values`（同一 fixture 上逐 θ 相等）；`✔ AUROC: the rank-sum is bit-for-bit the offline experiment's function`——判据从 `experiments/voice-index-loop/sim/sv-eval2.mjs` 的源码里抽出 `auroc` 再在同一数据上逐位比对。

**AC6 — 真实浏览器里转写并手改发送 3 次，报告读回的计数与操作次数一致**（2026-10-06）。载体是 e2e harness：真实 Chromium + 真实 Vite 客户端 + 真实 server + 宿主机上的真 `sensevoice-local` 识别器（`buildId=sensevoice-1.13.8-c71f0ce00bec-sv-logprobs-v1`，`runtime.available=true`），调试 agent 会话经 `POST /api/debug-agent/scenarios` 布防，转写走商用的上传入口（`input[type=file][accept="audio/*"]`）→ `POST /api/voice/transcribe` → server 侧写真记录。**与 AC 字面的偏差，如实登记：端口是 harness 分配的临时端口，不是共享的 3001** —— 本会话正在托管 3001，从会话内重启它会把宿主一起带走（`never-restart-3001-from-inside-a-session-it-hosts`），而 harness 是本仓跑「真实浏览器 + 真实后端」腿的既定方式；驱动这条链的每一段都是出货代码。

每轮：上传 → 真识别器回字 → 在**段内**手改 → 提交。三段后 `node scripts/voice-phase0-report.mjs --dir <dataDir>/voice-data --json`：

```json
{ "directory": "…/voice-data",
  "records": 3, "segments": 3, "identifierSegments": 0, "labelledSegments": 3,
  "gate": { "identifierThreshold": 100, "labelThreshold": 30, "met": false },
  "manualEdit": { "labelledSegmentRatio": 1, "changedChars": 3, "speechChars": 42 },
  "forms": { "form": 3, "spoken-form": 0, "cjk-rendering": 0, "misheard": 0, "corrections": 3, "rewrites": 0 },
  "confidence": { "auroc": null, "errorRegions": 3, "uncorrectedIdentifierRegions": 0, "insufficient": true } }
```

即 **记录数 = 段数 = 标签数 = 浏览器里的操作次数 = 3**，退出码 2（3 条远低于 100/30，正是「样本不足诚实报未达标」）。3 条记录均出自真识别器，例：`开饭时间早上9点至下午5点。`，带逐 token 置信度与 `flagStats`。

「手改」必须是**段内**改动：前缀追加（如 `改 开饭…`）产生 0 个标签 —— `labelsFor` 只记录对齐区间**内部**的改动，`src/shared/tests/voiceEditLabels.test.ts:109` 正是这条（`labelsFor([segment(0,'hello world')], 'well hello world then')` ⇒ `[]`）。首轮探针因此得 0 标签，改成段内插入后 3 轮各得 1 标签。

探针 spec（`e2e/zz-voice-phase0-probe.spec.ts`）与 `playwright.config.ts` 的三处临时改动（`DEBUG_AGENT_SPEC_FILES` 尾项、`SPEC_BUDGET_MS` 项、`voicePhase0ProbeSelection` 及其 env 展开）已在本次记录前**全部删除/还原**：`git status --porcelain -uall` 为空，`git show --stat c67b34b4` 只有 `## Touches` 里的三个文件。

**AC7 — 契约面：** `npm run lint` **exit 0**（输出只有仓库既有 warning）；`npm run typecheck` **exit 0**（`tsc --noEmit` 三个 project 全过）。

## Touches

- scripts/voice-phase0-report.mjs (new)
- scripts/voice-phase0-report.test.mjs (new)
- docs/proposals/voice-correction-feedback-loop.md
- tasks/gap-voice-phase0-readout-report.md
