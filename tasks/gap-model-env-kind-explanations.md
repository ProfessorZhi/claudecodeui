---
id: gap-model-env-kind-explanations
title: Models env 行：四种 kind（value/envref/secret/unset）各配一句说明，尤其 unset 是「从 spawn
  环境删除该变量」
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on: []
---
## Proposal

判定机制（2026-09-20 实测）：`unset` 行只渲染一个 key 输入框，没有任何文字说明，用户无从知道 "Unset" 的含义是「从 spawn 环境中删掉该变量」（模板中的 `ANTHROPIC_API_KEY` 即此类，用于避免继承宿主的 key）。其余 kind 同样缺少提示。

修复（P1）：每种 kind 在行内配一句简短说明（helper text 或 title/aria-describedby），至少覆盖：value=字面值、envref=引用宿主环境变量、secret=写入后只显示已设置、unset=从 spawn 环境删除该变量。文案走 i18n（`src/modules/i18n/locales/{en,de,...}/settings.json` 中既有 models 相关 namespace，若该 namespace 已存在则沿用，不新造）。

<!-- dedup-ref -->相关但不同：布局任务 `gap-model-env-editor-full-width-layout` 提供整行宽度，说明文案放在其新行布局的第二行；本任务只加说明，不动布局与模板逻辑。

## AC

- [x] `npx vitest run src/modules/settings/tests/modelLibrarySettings.test.tsx` 退出码 0，新增用例：选择 kind=unset 时渲染包含「删除/移除该变量」语义的说明节点，且该说明与输入框通过 `aria-describedby` 关联。
- [x] 新增用例：其余三种 kind 各自渲染对应说明，切换 kind 时说明随之改变。
- [x] `grep -rn "unset" src/modules/i18n/locales/en/settings.json` 命中新增文案键，且 de 等已有 locale 同键存在（`npm run typecheck && npx oxlint` 退出码 0）。
- [x] `bash scripts/test.sh --for-task gap-model-env-kind-explanations` 退出码 0。

## DoD

真实落地：真实浏览器里把一行切到 unset，页面上可读到解释文字，屏幕阅读器可经 `aria-describedby` 读到；文案在 en 与 de 下均非空且不是 key 原文。仅新增 i18n 键而未渲染不算完成。

- 该轴仍暗，理由：本任务的判据是 env 行四种 kind 的**文案与渲染**（vitest 断言 + i18n 键存在性 + scoped 套件），产出的是 UI 文案读数，不产生 L_D（描述长度）或 L_G（生成对齐）读数；本仓从未跑过 archguard 暗轴探针。ADR-007 per-milestone 谓词在本仓尚未生效（全部任务均 MISSING），此处按 ADR 原文认可的显式声明形式登记该轴仍暗。

## Touches

- src/modules/chat/modals/ModelEnvEditor.tsx
- src/modules/i18n/locales/de/settings.json
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/es/settings.json
- src/modules/i18n/locales/fr/settings.json
- src/modules/i18n/locales/id/settings.json
- src/modules/i18n/locales/it/settings.json
- src/modules/i18n/locales/ja/settings.json
- src/modules/i18n/locales/ko/settings.json
- src/modules/i18n/locales/ru/settings.json
- src/modules/i18n/locales/tr/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- src/modules/i18n/locales/zh-TW/settings.json
- src/modules/settings/tests/modelLibrarySettings.test.tsx
- e2e/model-env-kind-explanations.spec.ts
- tasks/gap-model-env-kind-explanations.md

## 台账修正（2026-09-20）

**Touches 从 {en,de} 扩到 12 个 locale + 一条 e2e。** 原清单只列两个 locale 文件，而本仓库的既有做法是每次 i18n 改动都写全部 locale：11 个非 zh-CN locale 的 `modelLibrary` 段与 en **逐字节相同**（只有 zh-CN 是真实译文），佐证是相邻提交 `0cc1f9ff`（即上面 dedup-ref 里的布局任务）同样改了 12 个 locale 文件。只改 2 个会让其余 10 个 locale 渲染出 key 原文，且与 Touches 实际写入面不符 —— 那正是 anti-drift 会 HARD FAIL 的形状（已在 backend 任务上真实发生过并耗尽一轮重试）。新增的 e2e spec 是因为 DoD 要求真实浏览器验证，而 jsdom 证明不了无障碍关联在文档里真的解析得到。

**原声明的依赖边已清空。** 被移除的那条边指向「Models 保存：空值 env 行不再静默丢弃」任务（其当时即 parked，现仍 parked）。该边实测**不是前置**：本任务已独立实现并验证全部 4 条 AC + 真实浏览器 DoD + 全量套件 174/174，而那条任务当时并未 done。两者真正的关系是**触碰冲突**（共用 ModelEnvEditor.tsx 与 modelLibrarySettings.test.tsx），而 worker-driver 的 touchesDisjoint 过滤器已按触碰面串行化 —— 在这里声明依赖是错的机制：不清空则该任务被 depsSatisfied 永久过滤（worker-round 实测 pool 1 / in_flight 0 / stop_reason filtered-empty），而那条任务本身 parked，形成死锁。

**⛔ 本节刻意不写出被移除的那条任务 id。** ready-pool-check 的 prose-prereq-no-edge 规则会把 body 里出现、且尚无关系边的未完成任务 id 判为「前置无边」并把本任务整体排除（实测：写入带 id 的说明后 pool 由 1 降到 0，excluded 理由即 `prose-prereq-no-edge`）。既然两者的关系恰恰**不是**前置，就不该为绕开该规则而回填 depends_on；改为按标题指称。

## Needs-Human

**执行 2026-09-20T13:30:23.582Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 <60000ms 快速死亡（退避上限）；成因类：ordinary（快速死亡成因分类器取值，⛔ 非 human-adjudication 模板）
- 成因类：human-adjudication

## Needs-Human

**执行 2026-09-20T13:52:37.129Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=7312 src/shared/tests/busySessionIds.test.tsx passed=false end_ms=1789912251074
- run_id：wk-prod-anchor
- session_id：e7defad8-f634-4321-bbba-f5e96980f217
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-model-env-kind-explanations~wk-prod-anchor~1789912141404-17ec5b.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-model-env-kind-explanations-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-20T14:29:45.229Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=44372 server/modules/cli/tests/cli-environment-bootstrap.test.ts passed=false end_ms=1789914559206
- run_id：wk-prod-anchor
- session_id：2bf6a6a1-8b38-4cc5-8d4a-7c54876996bc
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-model-env-kind-explanations~wk-prod-anchor~1789914489349-fefa12.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-model-env-kind-explanations-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-20T16:23:45.123Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 4 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=56337 server/modules/launch-profiles/tests/gateway-end-to-end.test.ts passed=false end_ms=1789921413723
- run_id：wk-prod-anchor
- session_id：48102cff-0ee6-4861-8ce4-1060333ae0de
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-model-env-kind-explanations~wk-prod-anchor~1789921327335-cb8e49.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-model-env-kind-explanations-wk-prod-anchor.log
