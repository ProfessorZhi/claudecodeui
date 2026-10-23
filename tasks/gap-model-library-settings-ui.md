---
id: gap-model-library-settings-ui
title: model-library：Settings > Agents > Models 一等分类，含掩码、状态、网关模板（AC-026）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-library-secret-write-only
goal_ac: AC-026
---
## Proposal

GOAL-001 的 AC-026：把 Model library 从聊天弹窗提升为 Settings → Agents → 各 provider 下的一等分类。现状：`AgentCategory` 只有 account/permissions/mcp/skills（src/shared/types.ts:1173），Model library 只能从空状态页或 /model 结果弹窗打开，Settings 里找不到。实机使用中用户的三个提问（变量在哪设、要不要为原生 claude 建 profile、能否设缺省）都源于界面没有说明。

方案（最小切片）：
1. `AgentCategory` 增加 `models`；`AgentCategoryTabsSection` 与 `AgentCategoryContentSection` 分发到新的 Models 内容组件，复用 `ModelLibraryPanel` 的模型列表与增删逻辑，不复制；内置模型（只读）与自定义模型分区列出。
2. 编辑器扩展：在现有 (名称, id) 表单上增加 env 行编辑，四种行类型 value/secret/envref/unset；secret 行掩码显示“已设置”，可替换或清除，从不回显值；envref 行旁显示该变量在服务端“已设置/未设置”的实时状态（后端提供只回布尔的状态接口），并用一句话说明它读的是 CloudCLI 服务进程环境、改后需重启；编译 warning 在界面可见。
3. “LLM 网关”模板（ADR-002 决策 4）：纯前端常量，一键预填 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`(secret)、`ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL`、`unset ANTHROPIC_API_KEY`。
4. 保存请求体：不携带用户未编辑的 secret 值，也不覆盖未提交的字段（重述 AC-019 的数据丢失防线，对象换为模型）。
5. 前端标准：`@/` 别名、不引入 interface、新状态注释；类型放 `src/shared/types.ts`；端点放 `src/shared/api.ts`；文案补 `src/modules/i18n/locales/en/settings.json` 与其余已有 settings 文案的语言，页面上不得出现未翻译 key。
6. 新增 `src/modules/settings/tests/modelLibrarySettings.test.tsx` 与 `modelLibrarySave.test.tsx`。⛔ 组件测试不能替代 AC-027 的浏览器验收。

依据：ADR-002（配置挂在 Model library 上；密钥允许存于 config_json 但只写；unset 为显式行类型；同 model id 不跨端点；第一版含 LLM 网关模板）。

## AC

- [x] `npx vitest run src/modules/settings/tests/modelLibrarySettings.test.tsx src/modules/settings/tests/modelLibrarySave.test.tsx` 退出码 0（AC-026 的判据命令）。
- [x] 测试证明：models 分类存在；内置只读/自定义分区；四种行类型；secret 掩码且不回显；envref 状态与说明；warning 可见；网关模板预填内容；保存请求体不含未编辑的 secret 值。
- [x] 取假变体（去掉 models 分类或回显 secret）使该测试判红，红灯输出记录在任务证据中；`npm run typecheck`、`npm run lint` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求 Settings 页面里真的能看到并操作 Models 分类。AC-026 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-026` 能独立核验；浏览器级验收由 AC-027 单独承担。

## Evidence

- 假变体 1（secret 回显：保留的 secret 行被替换成带值行）→ `modelLibrarySave.test.tsx > editing another row keeps the stored secret without a value...` FAIL（AssertionError: Expected values to be strictly deep-equal），Tests 1 failed | 5 passed。
- 假变体 2（去掉 models 分类 tab 标签）→ `modelLibrarySettings.test.tsx > the models category exists as a tab` FAIL，Tests 1 failed | 5 passed。
- 还原后 6 tests 全绿；`npm run typecheck` 通过；`npm run lint` 退出码 0（仅既有 warning）；scoped 门 `--for-task ... --allow-thin` 绿。
- 已知缺口：后端尚无 env 状态接口，前端调用 `GET /api/providers/model-env-status?names=A,B`（期望 `{data:{status:{NAME:boolean}}}`），接口缺失时 envref 状态徽标与 warning 不显示（静默降级）。其余非 en/zh 语言的 modelLibrary 文案暂用英文。
- Touches 扩展：实现拆出 `ModelEnvEditor.tsx`、`ModelsContent.tsx`、`chat/index.ts` 导出，并为全部已有 settings 语言补文案（方案第 5 点），据此把这些文件补入 Touches（anti-drift out-of-declared 14 项）。

## Touches

- src/shared/types.ts
- src/shared/api.ts
- src/modules/settings/tabs/agents-settings/AgentsSettingsTab.tsx
- src/modules/settings/tabs/agents-settings/sections/AgentCategoryTabsSection.tsx
- src/modules/settings/tabs/agents-settings/sections/AgentCategoryContentSection.tsx
- src/modules/settings/tabs/agents-settings/sections/content/ModelsContent.tsx
- src/modules/chat/index.ts
- src/modules/chat/modals/ModelLibraryPanel.tsx
- src/modules/chat/modals/ModelEnvEditor.tsx
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/de/settings.json
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
- src/modules/settings/tests/modelLibrarySettings.test.tsx (new)
- src/modules/settings/tests/modelLibrarySave.test.tsx (new)
- tasks/gap-model-library-settings-ui.md
