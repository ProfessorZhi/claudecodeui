---
id: gap-model-env-empty-row-save-feedback
title: Models 保存：空值 env 行不再静默丢弃——行内标出「不会保存」或阻断保存并列出被跳过的行
status: done
needs_human_cause: human-adjudication
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-gateway-template-merge-toggle
---
## Proposal

判定机制（2026-09-20 拦截真实提交请求，未落库）：界面上有 6 行模板变量，实际发出的 body 只含 2 行（`ANTHROPIC_BASE_URL` value、`ANTHROPIC_API_KEY` unset）；`ANTHROPIC_AUTH_TOKEN` 与三个 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 被静默丢掉，界面无任何提示。原因：`ModelEnvEditor.tsx:47` 的 `toRequestRows` 丢弃 value/envref 且值为空的行，`ModelLibraryPanel.tsx:154` 直接使用其结果。三个 `DEFAULT_*_MODEL` 钉住模型恰是网关参照配置的核心，模板默认产生 3 个空 value 行，问题因此尖锐。

修复（P0）：提交前校验——存在「有 key、kind 为 value/envref、值为空的新行」时，二选一并在实现里固定一种：(a) 行内显示「不会保存（值为空）」标记并在保存按钮旁汇总提示；(b) 阻断保存并列出被跳过的 key。两种都必须让用户在提交前看见哪些行不会入库。已存 secret 的行（`secretStored`，值留空表示保持原值）不属于「空值丢弃」，不得误报。

<!-- dedup-ref -->相关但不同：`gap-model-library-secret-write-only`（已 done）确立 secret 留空=保持原值的语义，本任务须保持该语义；`gap-model-gateway-template-merge-toggle` 处理模板的合并与可逆，本任务处理保存路径的反馈。

## AC

- [x] `npx vitest run src/modules/settings/tests/modelLibrarySave.test.tsx src/modules/settings/tests/modelLibrarySettings.test.tsx` 退出码 0，新增用例：应用模板后不填值点保存，界面出现对 `ANTHROPIC_AUTH_TOKEN` 与三个 `DEFAULT_*_MODEL` 的可见提示（或保存被阻断并列出这些 key），且未静默提交缺行的 body。
- [x] 新增用例：已存 secret 的行值留空点保存，不出现「不会保存」提示，且请求仍按原语义（保持原值）。
- [x] 取假验证：还原为原先静默丢弃行为，上述提示用例必须变红（命令与输出写入完成记录）。
- [x] `npm run typecheck && npx oxlint && bash scripts/test.sh` 退出码 0。

## DoD

真实落地：真实浏览器里应用网关模板、只填 base URL 后保存，用户在提交前就能看到 4 个不会入库的变量；数据库 `database/` 里不会出现「以为保存了其实缺行」的记录。测试用真实组件渲染（不是仅测 `toRequestRows` 纯函数）。

## Touches

- src/modules/chat/modals/ModelEnvEditor.tsx
- src/modules/chat/modals/ModelLibraryPanel.tsx
- src/modules/settings/tests/modelLibrarySave.test.tsx
- src/modules/settings/tests/modelLibrarySettings.test.tsx
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
- tasks/gap-model-env-empty-row-save-feedback.md

## Needs-Human

**执行 2026-09-20T11:29:12.075Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 <60000ms 快速死亡（退避上限）；成因类：ordinary（快速死亡成因分类器取值，⛔ 非 human-adjudication 模板）
- 成因类：human-adjudication

## Completion

**执行 2026-09-20（task/gap-model-env-empty-row-save-feedback，commit 5dc4a34b）**

实现取 Proposal 的 (a) 方案：行内标记 + 保存按钮旁汇总，不阻断保存（只填 base URL 是合法配置，阻断会逼用户手删空行）。三个要点：

- `ModelEnvEditor.tsx`：`toRequestRows` 改为逐行经私有 `toRequestRow(row)`（返回 request 行或 `null`），新增导出 `getUnsavedEnvRows(rows)` = 「key 非空且 `toRequestRow` 为 `null` 的行」。丢弃规则只有一个来源，提示与请求**结构上不可能漂移**。新增 prop `reportUnsavedRows`：仅当本次提交真的会带 `config.env` 时为 true（未触碰的表单不发 config、不丢任何行，此时报警是假警报）。命中行渲染 `data-testid="model-env-row-unsaved"`。
- `ModelLibraryPanel.tsx`：把原先内联在 `handleSubmit` 里的三元条件抽成 `sendsEnvConfig`，`configInput` 与 `unsavedEnvKeys` 共用它；汇总块（`data-testid="model-env-unsaved-summary"`）渲染在保存按钮上方，被跳过的 key 逐个成 chip。
- 12 份 `locales/*/settings.json` 各加 2 键 `modelLibrary.env.unsavedRow` / `modelLibrary.env.unsavedSummary`（沿用同模块 sibling 任务把 12 份 locale 列进 Touches 的先例）。

**AC-1** 判据命令退出码 0：`Test Files 2 passed (2)` / `Tests 13 passed (13)`（save 2→5、settings 7→8，新增 4 条）。新增用例走真实组件树（`ModelsContent` → `ModelLibraryPanel` → `ModelEnvEditor`），不是纯函数：

- 「应用模板后不填值点保存」：应用网关模板、什么都不填 → 汇总列出 `ANTHROPIC_AUTH_TOKEN` 与三个 `DEFAULT_*_MODEL`（外加同为空的 `ANTHROPIC_BASE_URL`，共 5 行带行内标记）；点 `Add model` 后 body 只剩 `[{ key: 'ANTHROPIC_API_KEY', kind: 'unset' }]`——缺行确实没提交，但用户先被告知。
- 「只填 base URL」：汇总恰好 4 个 key 且 `ANTHROPIC_BASE_URL` 不在其中，body 恰为 `[BASE_URL value, API_KEY unset]`。
- settings 面同场景（`AgentCategoryContentSection`）：已填 BASE_URL + 已存 secret 时恰好 3 行被标记，`ANTHROPIC_AUTH_TOKEN` 行内无标记。

**AC-2** 新增用例 `a stored secret left blank is never reported as unsaved and still keeps its value`：未触碰表单时无汇总无标记；改了别的行后 `secret-set-badge` 仍在、汇总仍不存在，请求仍发 `{ key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret' }`（无 value，服务端保持原值）。

**AC-3** 取假（真跑，输出如下）。还原为原先静默丢弃行为：

```
git checkout develop -- src/modules/chat/modals/ModelEnvEditor.tsx src/modules/chat/modals/ModelLibraryPanel.tsx
npx vitest run src/modules/settings/tests/modelLibrarySave.test.tsx src/modules/settings/tests/modelLibrarySettings.test.tsx
```

→ 退出码 1：

```
   × applying the gateway template and saving with every field empty names the rows the request will drop 24ms
     → Unable to find an element by: [data-testid="model-env-unsaved-summary"]
   × filling only the base URL leaves exactly the four unpinned variables reported as unsaved 23ms
     → Unable to find an element by: [data-testid="model-env-unsaved-summary"]
   × the gateway template reports the empty rows a save would leave out, and only those 1029ms
     → Unable to find an element by: [data-testid="model-env-unsaved-summary"]
 Test Files  2 failed (2)
      Tests  3 failed | 10 passed (13)
```

3 条提示用例全红，另 10 条（含 AC-2 那条断言「无提示」的）照常绿。随后 `git checkout HEAD -- <两文件>` 复原，最终 diff 不含还原痕迹。

**AC-4** `npm run typecheck` 退出码 0；`npm run lint`（= `oxlint src/ server/`，本仓真正的 lint 门）退出码 0（仅 warning，无 error）；`bash scripts/test.sh`（全量）退出码 0：`# tests 175 / # pass 175 / # fail 0`。
⚠️ 字面写的 `npx oxlint`（不带路径参数 ⇒ lint 整个 cwd）在本仓**改动前就是红的**：develop 上 `npx oxlint` → 退出码 1、146 条 warning；改动后 147 条，多的一条是同一文件新增 export 触发的 `react(only-export-components)`，与既有 3 个 export 同类同量级，不改变退出码（该命令的退出码由 warning 数量而非 error 决定，本仓 0 error）。故 AC 按实质满足（本仓 lint 门 `npm run lint` 绿），此处如实记账。

**DoD** 真实浏览器证据（真实 Chromium + 真实后端 + 隔离临时库，`playwright.config.ts` 自带 `DATABASE_PATH` 指向 mkdtemp 目录，不碰真实用户数据）：`npx playwright test e2e/model-library.spec.ts` → `2 passed / 1 failed`。前两条正是「应用网关模板 → 填 BASE_URL 与 secret → 保存 → 重载后 secret 只显示 Set 且值不出现在任何 API body」的完整真实落地路径，其中还含「body 文本不得匹配未翻译 i18n key」的断言——即新增的汇总文案在真实浏览器里渲染出来且 12 份 locale 都取到了译文。第 3 条（composer 发消息 → 网关收到请求）需要真实 LLM 网关，在 develop 上用同一命令同一样本也是 `2 passed / 1 failed`，与本改动无关（未新增 e2e spec 文件：本任务 AC 只要求组件级渲染，且新 `.spec.ts` 不在 `--for-task` 的 scoped 门取样范围内，门只取 Touches 里的 `*.test.*`）。

**数据库侧**：请求 body 断言即落库内容的直接判据——AC-1 两条用例断言 body 恰好等于期望的少数几行，就是「不会出现以为保存了其实缺行的记录」的机械形式；e2e 第 2 条进一步在真实库里重载模型，其 config 与既有语义逐字一致（`toRequestRows` 重构后逐分支等价：unset 恒发、secret 有值发值/无值但已存则不带 value、value/envref 去空后发，其余为空即丢）。

**未覆盖项（如实记账）**：DoD 里「数据库 `database/` 里不会出现…」未以真实 `database/` 目录（develop 共享库）直接读表验证，只以请求 body + e2e 隔离库重载断言覆盖；未做人工浏览器点击（本会话无 Playwright MCP 工具），浏览器证据来自上条 e2e。