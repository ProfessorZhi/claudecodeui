---
id: gap-model-env-editor-full-width-layout
title: Models 设置页：env 编辑器占满整行宽度，≥1024px 不再溢出/遮挡「Add variable」，标题行可换行
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

判定机制（2026-09-20 Playwright 实机复现，1920×1080，Settings → Agents → Claude → Models）：`ModelLibraryPanel.tsx:251` 的 `lg:grid-cols-[minmax(16rem,0.8fr)_minmax(20rem,1.2fr)]` 双列栅格配合 `:254` 的 `md:max-w-4xl`（弹窗锁死 896px），把左列压到 256px、`p-4` 后仅剩 222px 装环境变量表；`ModelEnvEditor.tsx:100` 标题行 `flex items-center justify-between gap-2` 无 `flex-wrap`，两个按钮带 `whitespace-nowrap` 拒绝收缩，按钮容器右缘 1108px 而卡片内容区右缘 992px（溢出 115px），右栏 BUILT-IN MODELS 卡片（不透明）盖住按钮：`elementFromPoint(Add variable 中心)` 命中内置模型行 DIV，Playwright 点击 30s 超时。同时 key 输入框 `flex-1 min-w-0`（`ModelEnvEditor.tsx:145`）塌缩到 65px，六个模板变量名全显示成 `ANTHRO`。响应式是反的：390px/900px 正常、≥1024px 崩坏。

修复（P0 结构 + P1 标题行）：
1. 表单区改为：上方 Model name / Model ID 横排；env 编辑器 `col-span-2` 独占整宽；内置模型列表另起一区，不再与 env 表并列挤压。弹窗 `md:max-w-4xl` 提升到 `md:max-w-6xl`。
2. 行内布局：第一行 `[变量名 flex-1 min-w-[16rem]] [类型] [删除]`，第二行 `[值]` 占满整行，使 `ANTHROPIC_DEFAULT_SONNET_MODEL` 在 1920px 下完整可见。
3. 标题行加 `flex-wrap`，标签 `shrink-0`；文案缩短（"LLM gateway template" → "Gateway template"，"Add variable" → "+ Add"，文案位于 12 个 locale 的 settings.json），同步既有测试与 e2e 里按旧文案定位按钮的选择器（`e2e/model-library.spec.ts` 用 `getByRole('button', { name: 'LLM gateway template' })`）。

<!-- dedup-ref -->相关但机制不同：`gap-model-library-settings-ui`（已 done）首次交付该页面与网关模板，本任务修其布局缺陷；`gap-model-library-browser-e2e`（已 done）的选择器需随文案同步。布局断言测试另立 `gap-model-settings-layout-overflow-assertions`。

## AC

- [x] `npx vitest run src/modules/settings/tests/modelLibrarySettings.test.tsx` 退出码 0（含按新文案 "Gateway template" / "+ Add" 定位按钮的断言）。
- [x] `grep -n "md:max-w-4xl" src/modules/chat/modals/ModelLibraryPanel.tsx` 无输出，且 `grep -nE "flex-wrap" src/modules/chat/modals/ModelEnvEditor.tsx` 至少命中标题行一处。
- [x] `grep -n "LLM gateway template" e2e/model-library.spec.ts src/modules/chat/modals/ModelEnvEditor.tsx` 无输出（旧文案已同步）。
- [x] `npm run typecheck && npx oxlint && bash scripts/test.sh` 退出码 0。

## DoD

真实落地：在真实浏览器 1920×1080 与 1440×900 打开 Settings → Agents → Claude → Models，编辑器 `scrollWidth === clientWidth`，`Add variable` 按钮中心点 `elementFromPoint` 命中按钮本身且可真实点击添加一行，变量名输入框宽度 ≥ 250px；390px 与 900px 不回归。完成记录写入所测视口的实测数值。仅改类名而未在浏览器实测不算完成。

## Touches

- src/modules/chat/modals/ModelLibraryPanel.tsx
- src/modules/chat/modals/ModelEnvEditor.tsx
- src/modules/settings/tests/modelLibrarySettings.test.tsx
- e2e/model-library.spec.ts
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
- tasks/gap-model-env-editor-full-width-layout.md
