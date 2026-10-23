---
id: gap-model-library-duplicate-custom-model
title: model-library：复制 custom model —— 表单预填 + 服务端从源行补齐 secret（Scope A）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**背景与判定**（2026-09-21 代码复核）：Model library 目前只有 create/update/delete 三个动作（`provider-models.service.ts` 的 `createCustomModel`/`updateCustomModel`/`deleteCustomModel`，路由 `provider.routes.ts:557-586`）。要建一个"和现有条目几乎一样、只差一两处"的模型，用户必须把 base URL、token、三行端点别名、unset 行全部重敲一遍。本任务加"复制"。

**唯一硬约束（它决定方案形状）**：ADR-002 决策 2 规定 secret 值只写、任何读接口不回传（`toPublicConfig`，`provider-models.service.ts:51`）。因此**纯前端预填无法复制 secret**：`toEditorRows` 对 secret 行只能得到空值 + `secretStored`，而 `toRequestRow` 对"空值且非已存"的行返回 null（`ModelEnvEditor.tsx:47-62`）⇒ 该行被静默丢弃。要真的复制 secret，复制必须发生在服务端。

**方案（最小切片）**：

1. 服务端新增 `duplicateCustomModel(provider, recordId, input)`：读源行（内置 id 天然 404，因为只查 `provider_models` 表），把**源行的 config 当作 `resolveSecretRows` 的 `stored`**，复用 create 的落库路径。为此给 `createCustomModel` 增加一个内部可选参数 `stored = null`（对外签名不变）：
   - `input.config === undefined` ⇒ 用 `source.config` 整表照抄（此时 secret 行自带值，走 `resolveSecretRows` 的非空分支）；
   - `input.config` 存在 ⇒ 表单里**留空**的 secret 行（`{key, kind:'secret'}`，无 value）从**源行**取值；输入了新值则新值生效；表单里没有的行一律不复制。
   - ⛔ 关键：这里必须是 `stored = source.config`，**不能照抄 update 的 `stored = existing.config`**（目标行还不存在）。写成后者会让留空 secret 行直接 400 `has no stored secret to keep`，而"复制"就退化成"什么都抄不到"。
2. 新路由 `POST /api/providers/:provider/models/:recordId/duplicate`，body 与 create 同形 `{id, model, config?}`，成功 201 + 同一信封 `{provider, model, models}`（客户端 `readModelMutationResponse` / `applyProviderCatalog` 零改动）。用独立路由而非给 create 加字段，是为了让 `CustomProviderModelInput` 保持干净、路由/服务/测试各自聚焦。
3. 前端 `ModelLibraryPanel` 加复制入口：自定义行动作组（`ModelLibraryPanel.tsx:398` 的 `!confirming &&` 分支）加一个 `Copy` 图标按钮；点击后进入**复制态**（新 state `duplicatingFrom`，`editing` 保持 `null`，即走 create 语义），预填 `model = "<label> (copy)"`、`modelId = suggestCopyId(...)`、`envRows = toEditorRows(option.config)`；表单标题、主按钮、notice 切换文案；提交走 `actions.duplicate(...)`。
   - 复制态下 `sendsEnvConfig = envDirty || (!editing && envRows.length > 0)`（`:142`）**自动为真**，不要去伪造 `envDirty`；留空的已存 secret 行 `toRequestRow` 返回非 null（`ModelEnvEditor.tsx:59`），所以"未保存行"警告不会误报。
   - `resetForm()` 里清 `duplicatingFrom`（`selectProvider` 已调 resetForm，切 provider 自动清）。
   - 新模型**不自动选中**（与 create 现有行为一致，且复制品通常还要改 id）；notice 带源名，例如"X 已作为 Y 的副本创建"。
   - 提交前用面板手里的 id 集合（内置 + 自定义）做本地预检，给出比服务端 409 更直接的提示。
4. `suggestCopyId(base, taken)` 建议放 `ModelLibraryPanel.tsx` 内（单一消费者，不导出）：产出 `-copy`、`-copy-2`…；`taken` 必须同时含内置与自定义 id（`assertModelIdAvailable` 对内置 id 也 409）；并按服务端 200 字符上限截断（`provider.routes.ts:528`）。
5. 前端接线：`ProviderModelActions` 加 `duplicate`（`src/shared/types.ts:63`），两份实现（`useChatProviderState.ts:868`、`settings/.../ModelsContent.tsx:64`）各加一条 + `api.providers.duplicateModel`（`src/shared/api.ts:378` 附近）。
6. i18n：新增键写**全部 12 个 locale** 的 `settings.json`（本仓既有做法；非 zh-CN 可照现状保留英文，zh-CN 出真实译文）。

**已知陷阱（本次只出提示文案，不做自动修复）**：模型 id 与端点别名在代码之外耦合——`--model` 取的就是行的 model_id（`claude-runtime.provider.js:281`），而 `ANTHROPIC_DEFAULT_*_MODEL` 在后端无任何特殊处理（只出现在前端模板常量 `ModelEnvEditor.tsx:25-27`），必须与网关侧别名一致，否则**保存成功、到 spawn 才 `unrecognized_model`**。所以复制出来的条目仍需手改 id 与别名行：预填保住的是 base URL、secret、unset 三样。复制态下 id 输入框旁要有显式提示——占位 id 不是可用的模型 id。

**明确不做（范围外，已与人确认）**：

- "值等于被复制模型 id 的行"提示 + 显式改写按钮（等值规则版）。复制后忘改别名的风险由提示文案 + 上面这条已知风险登记承担。
- Scope B：放开 `UNIQUE(provider, model_id)`（`schema.ts:197`）以支持"同模型两网关 / 同模型不同参数"。ADR-002 决策 5 记了该限制，其最小形状是把会话对模型的引用从 model id 字符串改为记录 id（`sessions` 加列 → composer 携带 `recordId` → `resolveModelLaunchSpec` 优先按 recordId 解析、否则回退 id），属独立任务。

依据：ADR-002（决策 1 配置挂 model library、决策 2 secret 只写、决策 5 UNIQUE 限制）。

<!-- dedup-ref -->去重：本 store 无"复制 custom model"任务（按机制词 duplicate/clone/复制 检索 66 个任务）。相邻但机制不同的是 `gap-model-env-kind-explanations`（kind 说明文案）与 `gap-model-env-empty-row-save-feedback`（空值行保存反馈）；三者共用 `ModelLibraryPanel.tsx` / `ModelEnvEditor.tsx` 触碰面，由 worker-driver 的 touchesDisjoint 串行化，故本任务不声明依赖边。

**纪律提醒**：新测试文件（`src/modules/settings/tests/modelLibraryDuplicate.test.tsx`）跨模块引用 `ModelLibraryPanel` 时必须走 barrel `@/modules/chat`，不要照抄既有测试里的 `vi.importActual('@/modules/chat/modals/...')` 深引用——`boundaries/dependencies` 会拦新增的深引用。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-models.service.test.ts` 退出码 0，新增用例覆盖：①复制出的行真的带上源行 secret——用服务端内部读 `getCustomModelConfigForRuntime(provider, 新id)` 断言；用例必须能区分"取自源行"与"取自目标行"：造两个同 key 不同 secret 值的模型（S1/S2），断言复制出来的是 S1；②源有 A/B 两行、提交只含 A ⇒ 新行只有 A；③源 recordId 不存在 ⇒ 404 `MODEL_NOT_FOUND`；④目标 id 与内置或既有自定义 id 相同 ⇒ 409 `MODEL_ID_ALREADY_EXISTS`。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-secret-write-only.test.ts` 退出码 0，新增用例：duplicate 的响应体与随后的模型列表里 `JSON.stringify(...).includes(SENTINEL)` 为假，**同时**该模型经服务端内部编译确实含该 sentinel——"真复制"与"不泄漏"两条断言同时成立，缺一即判据不完整。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider.routes.test.ts` 退出码 0，新增用例：`POST /api/providers/claude/models/:recordId/duplicate` 返回 201 且信封为 `{provider, model, models}`；坏 recordId 400 `INVALID_MODEL_RECORD_ID`；未知 source 404；重复 id 409。
- [x] `npx vitest run src/modules/settings/tests/modelLibraryDuplicate.test.tsx` 退出码 0（新文件），新增用例：①点 Duplicate 后表单被预填——name 为 `<源名> (copy)`、id 为 `-copy` 变体、env 行数与源一致且 secret 行呈"已设置"态；②提交的请求体只含表单里存在的行，且留空的已存 secret 行不带 value；③点 X 取消后复制态与预填全部清空，回到普通"新增"表单；④`-copy` 已被占用时预填为 `-copy-2`，且预填 id 长度始终 ≤200。
- [x] `npm run test:e2e -- e2e/model-library-duplicate.spec.ts` 退出码 0（新 spec，真实 Chromium + 真实后端，复用既有 e2e 夹具与 mock 网关）：经 UI 建一个带 secret 的模型 → 复制 → 只改 id 与名称 → 创建 → 刷新后新条目在列表且 secret 显示"已设置"、其值不出现在页面文本与任何网络响应 → 新模型可在 composer 选中并发送，mock 网关收到带该 token 的请求。
- [x] 取假变体使判据转红（至少一条），红灯原始输出记入证据。可取假例：把 `duplicateCustomModel` 传给 create 的 `stored` 改成 `null`（预期留空 secret 行 400）；或让预填不带 env 行（预期 e2e 的"已设置"断言红）。
- [x] `npm run typecheck`、`npm run lint` 退出码 0；`bash scripts/test.sh --for-task gap-model-library-duplicate-custom-model` 退出码 0（scoped 自测；**全量套件是 fan-in 的合并闸，不是 worker 的自测**）。

### 判据读数（2026-09-21，worktree `model-library-duplicate-custom-model`）

| 判据 | 命令 | 读数 |
| --- | --- | --- |
| AC1 | `npx tsx --tsconfig server/tsconfig.json --test .../provider-models.service.test.ts` | exit 0，`tests 26 / pass 26 / fail 0` |
| AC2 | 同上 `model-secret-write-only.test.ts` | exit 0，`tests 4 / pass 4 / fail 0` |
| AC3 | 同上 `provider.routes.test.ts` | exit 0，`tests 6 / pass 6 / fail 0` |
| AC4 | `npx vitest run src/modules/settings/tests/modelLibraryDuplicate.test.tsx` | exit 0，`Tests 5 passed (5)` |
| AC5 | `npm run test:e2e -- e2e/model-library-duplicate.spec.ts` | exit 0，`5 passed (12.8s)` |
| AC7 | `npm run typecheck` / `npm run lint` / `bash scripts/test.sh --for-task …` | 全部 exit 0 |

**AC6 假变体原始红灯（`duplicateCustomModel` 的 `stored` 由 `source.config` 改成 `null`，即 Proposal 第 1 条标注的 ⛔ 关键点）**：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-models.service.test.ts
exit=1
✖ a duplicate keeps the SOURCE secret, even with a sibling holding the same key (0.465059ms)
ℹ tests 26
ℹ pass 25
ℹ fail 1

✖ a duplicate keeps the SOURCE secret, even with a sibling holding the same key (0.465059ms)
  Error [AppError]: Environment variable ANTHROPIC_AUTH_TOKEN has no stored secret to keep.
      at invalidConfig (…/services/provider-models.service.ts:90:54)
      at resolveSecretRows (…/services/provider-models.service.ts:119:13)
```

同一变体在 AC2 上也转红，且只红"真复制"那一半：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-secret-write-only.test.ts
exit=1
✔ list and create responses expose only isSet for secret rows
✔ PATCH: secret row without value keeps, empty string clears, non-empty replaces
✖ a duplicate really copies the secret and never echoes it
✔ error responses never echo a submitted secret value
ℹ tests 4 / pass 3 / fail 1
```

失败模式与预注册完全一致：留空 secret 行在 `resolveSecretRows` 抛 400，而不是静默抄不到值。变体已用 `cp` 还原并 `sha256sum -c` 校验（`provider-models.service.ts: OK`），红灯读数取自还原前的运行。

## DoD

真实落地判据：不是"路由存在 + 测试绿"，而是**真实对象经真实机制被操作过**——一条真实 custom model 经 `POST /api/providers/:provider/models/:recordId/duplicate` 在 SQLite 里生成新行，其经 `resolveModelLaunchSpec` 编译出的 spawn 环境**真的带着源条目的 secret 值**，而同一个值在复制响应、模型列表与页面文本里都不可见；并且真实浏览器里用户能"点复制 → 改 id → 创建"走完一次，复制品在 composer 中可选、能让 mock 网关收到带该 token 的请求。仅新增路由与测试文件不算完成。

- 该轴仍暗，理由：本任务的判据是复制路径的**数据不变量与 UI 预填**（服务端内部读 / 响应体检索 / vitest / playwright 断言），产出的是行为读数，不产生 L_D（描述长度）或 L_G（生成对齐）读数；本仓从未跑过 archguard 暗轴探针。ADR-007 per-milestone 谓词在本仓尚未生效（全部任务均 MISSING），此处按 ADR 原文认可的显式声明形式登记该轴仍暗。

## Touches

- server/modules/providers/services/provider-models.service.ts
- server/modules/providers/provider.routes.ts
- server/modules/providers/tests/provider-models.service.test.ts
- server/modules/providers/tests/model-secret-write-only.test.ts
- server/modules/providers/tests/provider.routes.test.ts
- src/shared/types.ts
- src/shared/api.ts
- src/modules/chat/modals/ModelLibraryPanel.tsx
- src/modules/chat/hooks/useChatProviderState.ts
- src/modules/settings/tabs/agents-settings/sections/content/ModelsContent.tsx
- src/modules/settings/tests/modelLibraryDuplicate.test.tsx (new)
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
- e2e/model-library-duplicate.spec.ts (new)
- tasks/gap-model-library-duplicate-custom-model.md
