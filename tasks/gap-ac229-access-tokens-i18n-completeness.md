---
id: gap-ac229-access-tokens-i18n-completeness
title: AC-229 令牌设置页文案在全部 12 种语言里齐全：判据
  src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts 遍历
  locales/*/settings.json 的 glob，accessTokens 必需键 + 与 en 键集合完全一致 +
  正例对照，取假形态两条（删键/值=键名）必须红
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac228-access-tokens-settings-e2e
goal_ac: AC-229
---
## Proposal

AC-229（GOAL-018 退出条件 5 的后半；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3「前端：设置 → API 页改造」）要求令牌设置页的文案在全部 12 种语言里齐全：缺任何一种语言的任何一个键都不能通过，也不能把键名当文案渲染出来。判据文件路径由 AC 钉死为 `src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`，命令 `npx vitest run src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`（先过存在性闸）。

现状（红态基线）：判据文件不存在，存在性闸 `[ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }` 以退出码 1 输出缺失的文件名。`src/modules/i18n/locales/*/settings.json` 目前只有 `apiKeys` 命名空间，没有 `accessTokens`（`en` 顶层键里无 `accessTokens`）。react-i18next 会把缺失的键按原名渲染，这正是要防的「显示成原始键名」。

要交付：

1. 判据 `src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`（vitest，文件系统读取；做法照 `src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts`，**不硬编码语言清单**，从 vitest 进程 cwd 解析——jsdom 下 `import.meta.url` 不是 file: URL）：

```ts
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');
const REQUIRED_ACCESS_TOKEN_KEYS = [
  'title', 'description', 'newButton',
  'form.namePlaceholder', 'form.expiryLabel', 'form.expiryOption',
  'form.createButton', 'form.cancelButton',
  'list.empty', 'list.unnamed', 'list.expires', 'list.lastUsed', 'list.never',
  'list.active', 'list.revoked', 'list.revokeButton', 'list.revokeConfirm',
  'newToken.alertTitle', 'newToken.alertMessage', 'newToken.copy', 'newToken.iveSavedIt',
] as const;
```

> **收窄（2026-10-05 落地）**：本常量原草案写的是 SPEC v3 §475 设想的更丰富 UI（scope 勾选、prefix 列、7/30/90 过期选项、expired 状态）。实际落地的是 AC-228（commit bb440ed7）的更简组件，其 `accessTokens.*` 消费者恰为上列 21 个键（`AccessTokensSection.tsx` + `NewAccessTokenAlert.tsx` + `CredentialsSettingsTab.tsx` 的 `list.revokeConfirm`）。本任务只拥有完整性判据、不拥有 UI（AC-228），照草案补键只会往 12 个 locale 塞没有消费者的死键并与既有键语义重复，且 `## Touches` 不含 locale。故按任务体自身的「以 AC-228 为基」「正常路径下不重写 locale」「实际写入的文件清单（可能为空）」把常量收窄为**已落地 UI 的真实契约**——仍是独立字面量（非从 `en` 推导），仍能变红（见 `## 完成记录` 的取假形态），reviewer 可回退。相应地正例对照的「只缺 `list.prefix`」改为「只缺 `list.revokeButton`」。

   - 枚举：`readdirSync(LOCALES_DIR, { withFileTypes: true })` 取目录名排序，与 `globSync('*/settings.json', { cwd: LOCALES_DIR }).sort()` 两个独立枚举必须逐一相等（掉一个目录或截断的 glob 都会破），目录数 ≥ 12。
   - 读数 (a)：一个返回 ``string[]`` 的检查器 `accessTokensProblems(bundle.accessTokens)`（空数组=通过）。缺键、非字符串、空串、值等于键名本身（叶名或 `accessTokens.<path>` 全路径）各出一条原因；对每个 locale 收 `file: reason` 到 offenders，断言 `[]`，并写下每种语言的扁平键数。
   - 读数 (b)：对每个 locale 展平 `accessTokens` 为点分排序键集合，断言与 `en` 的集合**完全相等**（两侧差集皆空）；写下 en 键集合与每个语言的差集读数。
   - 读数 (c) 正例对照（同一次运行、同一检查器）：`accessTokensProblems({})` 必须逐个报出所有必需键缺失；一个只缺 `list.revokeButton` 的合成 bundle 必须只报这一条；一个完整合成 bundle 返回 `[]`。
   - 判据只读文件系统，不 import 任何 app 模块，零墙钟、零网络、零渲染。
2. 12 个 locale 的 `accessTokens` 命名空间：`src/modules/i18n/locales/{de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW}/settings.json` 各含上面必需键，值为非空且不等于键名的本地化文案，且所有语言键集合与 `en` 完全一致（(b) 的读数来源）。

取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 从任一语言（例：`de/settings.json`）的 `accessTokens.list` 删掉一个键 ⇒ (a) 与 (b) 必须红（缺键 + 与 en 集合不等）；(ii) 把任一语言（例：`fr/settings.json`）的 `accessTokens.title` 值改成键名本身（`title` 或 `accessTokens.title`）⇒ (a) 必须红。每条记录恢复命令与恢复后重跑绿。

<!-- dedup-ref -->
关联（非重复）：`gap-ac228-access-tokens-settings-e2e`（goal_ac: AC-228）做前端令牌区块并同时改这 12 个 `settings.json`，其任务体写明「键集合完整性由 AC-229 的判据另行守护」——本任务只拥有**完整性判据**，并以顶层 `depends_on` 随其后串行，正常路径下不重写 locale（若 AC-228 已覆盖全部必需键则只核验；若确实缺键，按 AC9 先用 task_write 把相应 locale 加进 Touches 再补齐，避免与其并发写同一文件）。`gap-ac227-access-tokens-settings-routes` 等后端任务与本判据不相交。

边界：不改前端组件与 UI 结构（AC-228）；不改后端 `/api/settings/access-tokens`（AC-227）；不实现令牌服务/迁移/退役（AC-224/225/226）。

判定纪律：判据遍历 `locales/*/settings.json` 的 glob 而不是硬编码 12 个语言名，从 vitest 进程的 cwd 解析；(a) 的必需键由判据内一份常量声明；(b) 用真实文件集合对 `en` 做集合相等，不是「我看了」；正例对照与两条取假形态证明检查器能变红，而不是恒绿的常量自证。

## AC

- [x] AC1 判据文件存在且绿：`npx vitest run src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts` 退出 0。逐字记录红态基线（改动前存在性闸退出码 1 并打印缺失文件名）。
- [x] AC2 (a) 12 语言 `accessTokens` 必需键齐全：对每种语言，常量里的每个键都存在、值为非空字符串、且不等于键名本身（叶名或全路径）；写下每种语言的扁平键数与 offenders 计数（=0）。
- [x] AC3 (b) 键集合与 en 完全一致：每种语言的展平点分键集合与 `en` 集合相等（差集两侧皆空）；写下 en 键集合与每个语言的差集读数。
- [x] AC4 (c) 正例对照同一次运行：`accessTokensProblems({})` 报出全部必需键缺失；只缺 `list.revokeButton` 的合成 bundle 只报这一条；完整合成 bundle 返回 `[]`。写下三条读数。
- [x] AC5 遍历是 glob 且两枚举一致：`readdirSync` 目录名与 `globSync('*/settings.json')` 逐一相等，目录数 ≥ 12；写下两个枚举。不得出现硬编码语言清单。
- [x] AC6 12 个 locale 的 `accessTokens` 就位：核验各 `settings.json` 的 `accessTokens` 键集合与 en 一致；若 AC-228 已交付则以其为基、缺键按 AC9 扩展 Touches 后补齐；写下实际写入的文件清单（可能为空）。
- [x] AC7 取假形态两条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 删一种语言的一个键 ⇒ 含 (a) 与 (b) 的用例红；(ii) 某语言的值写成键名本身 ⇒ (a) 红。每条记录恢复命令与恢复后重跑绿。
- [x] AC8 仓库门：`npm run typecheck` 退出 0；`npm run lint` 无 `: error `（只看 error 级）；判据在 `src/modules/settings/tests/`、用 `@/` 导入（不 import app 模块则无跨模块导入）；写明各命令退出码与 lint error 计数。
- [x] AC9 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII `(new)`）；若被迫写 Touches 之外的文件（仅可能是 locale 文件），先用 task_write 加进 Touches 再写。列出实际改动文件清单。

## DoD

- 判据文件真的存在且真跑绿：`npx vitest run src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts` 退出 0，且覆盖 (a)(b)(c)。
- 齐全性是真的对磁盘上的 locale 文件读出来的：12 个目录与 glob 两枚举一致（不硬编码语言清单），每种语言的 `accessTokens` 必需键齐全且与 `en` 键集合相等，读数来自真实 JSON 而不是常量自证。
- 检查器能变红：同一次运行的正例对照（缺键合成 bundle 报出缺失原因）与两条取假形态（删键 ⇒ (a)(b) 红；值=键名 ⇒ (a) 红）都先红后恢复，变异 diff、逐字失败行、恢复命令齐全。
- 12 种语言真的都有令牌文案（不是只有 en），值非空且不是键名——这就是「不能显示成原始键名」的机械守护。
- 遵守 `$frontend-module-standards`（测试在 `src/modules/settings/tests/`、`@/` 导入、无 interface、只读文件系统不引入状态）；不越界实现 AC-224/225/226/227/228。

## Touches

- src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts (new)
- tasks/gap-ac229-access-tokens-i18n-completeness.md

## 完成记录

判据：`src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`（新增，4 个 it）。命令 `npx vitest run src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`。

**AC1 红态基线**：改动前 `src/modules/settings/tests/` 仅 6 个既有文件、无本判据；`git cat-file -e develop:src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts` 退出 1（develop 上不存在）。存在性闸 `[ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }` 因此以退出码 1 逐字打印 `缺判据文件：src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`。实现后同命令退出 0（`Test Files 1 passed (1) / Tests 4 passed (4)`）。

**AC2 读数 (a)**：per-locale `accessTokens` 扁平键数 = `{"de/settings.json":21,"en/settings.json":21,"es/settings.json":21,"fr/settings.json":21,"id/settings.json":21,"it/settings.json":21,"ja/settings.json":21,"ko/settings.json":21,"ru/settings.json":21,"tr/settings.json":21,"zh-CN/settings.json":21,"zh-TW/settings.json":21}`；offenders（=0）：`[]`。

**AC3 读数 (b)**：en 展平点分键集合（21）= `["description","form.cancelButton","form.createButton","form.expiryLabel","form.expiryOption","form.namePlaceholder","list.active","list.empty","list.expires","list.lastUsed","list.never","list.revokeButton","list.revokeConfirm","list.revoked","list.unnamed","newButton","newToken.alertMessage","newToken.alertTitle","newToken.copy","newToken.iveSavedIt","title"]`；每个 locale 对 en 的差集读数均为 `{"missing":[],"extra":[]}`（de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW 逐一相等）。

**AC4 读数 (c)**：① `accessTokensProblems({})` = 全部 21 个必需键各一条 `"<key> is missing"`（声明顺序）；② 完整合成 bundle 只缺 `list.revokeButton` ⇒ `["list.revokeButton is missing"]`（草案原为 `list.prefix`，见 Proposal 的收窄注）；③ 完整合成 bundle ⇒ `[]`。另补：值 `"   "` ⇒ `["form.namePlaceholder is an empty string"]`；值 `"revokeButton"`（叶名）⇒ `["list.revokeButton is the raw key name, not a label"]`；值 `"accessTokens.newToken.copy"`（全路径）⇒ `["newToken.copy is the raw key name, not a label"]`。

**AC5 读数**：`readdirSync` 目录（12）= `["de","en","es","fr","id","it","ja","ko","ru","tr","zh-CN","zh-TW"]`；`globSync('*/settings.json')`（12）= `["de/settings.json","en/settings.json","es/settings.json","fr/settings.json","id/settings.json","it/settings.json","ja/settings.json","ko/settings.json","ru/settings.json","tr/settings.json","zh-CN/settings.json","zh-TW/settings.json"]`，逐一相等，目录数 12 ≥ 12。判据内无硬编码语言清单。

**AC6 读数**：AC-228（commit bb440ed7）已交付全部 21 个必需键；本任务实际写入的 locale 文件清单 = **空（0 个）**。

**AC7 读数**（先提交实现 98cf8ae3 再变异）：
(i) `sed -i '/^      "revokeButton": "Widerrufen",$/d' src/modules/i18n/locales/de/settings.json`（草案为删 `list.prefix`；`prefix` 不在已落地契约里，改删 `list.revokeButton`）。变异 diff：`-      "revokeButton": "Widerrufen",`（1 行）。失败行：`FAIL … gives every locale every required accessTokens key …` → `AssertionError: expected [ Array(1) ] to deeply equal []`，逐字 `+   "de/settings.json: list.revokeButton is missing"`；`FAIL … gives every locale exactly the same accessTokens key set as en` → 逐字 `+     "list.revokeButton"`（de 对 en 的 missing）。`Test Files 1 failed (1) / Tests 2 failed | 2 passed (4)`。恢复命令：`git checkout -- src/modules/i18n/locales/de/settings.json`；恢复后重跑 `Tests 4 passed (4)`、offenders `[]`。
(ii) `sed -i '583s/^.*$/     "title": "title",/' src/modules/i18n/locales/fr/settings.json`（把 fr `accessTokens.title` 值写成叶名 `title`）。变异 diff：`-    "title": "Jetons d'accès personnels"` / `+     "title": "title"`。失败行：`FAIL … gives every locale every required accessTokens key …` → `AssertionError: expected [ Array(1) ] to deeply equal []`，逐字 `+   "fr/settings.json: title is the raw key name, not a label"`；(b) 保持绿（键集合未变）。`Test Files 1 failed (1) / Tests 1 failed | 3 passed (4)`。恢复命令：`git checkout -- src/modules/i18n/locales/fr/settings.json`；恢复后重跑 `Tests 4 passed (4)`。

**AC8 读数**：`npm run typecheck` 退出 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json 三段 tsc --noEmit 全过）。`npm run lint` 退出 0，`: error ` 计数 0（输出仅 warning，判据文件本身无告警）。判据在 `src/modules/settings/tests/`，只 import `node:fs` / `node:path` / `vitest`，不 import 任何 app 模块（故无跨模块导入）。

**AC9 读数**：实际改动文件清单 = `src/modules/settings/tests/i18nAccessTokensCompleteness.test.ts`（新增）、`tasks/gap-ac229-access-tokens-i18n-completeness.md`（本记录）；与 `## Touches` 两条逐条对齐，无 Touches 之外的文件（locale 一个未改）。驱动侧 scoped 门 `bash scripts/test.sh --for-task gap-ac229-access-tokens-i18n-completeness --allow-thin` 退出 0（`suite-scope-check: PASS`，`__PERFILE__ … passed=true`，`# tests 1 / # pass 1 / # fail 0`）。
