---
id: gap-session-filter-editor-locator-unscoped
title: AC-101 判据转红：session-filter e2e 的「会话过滤…」入口未限定项目，第五个 e2e 夹具入场后点开的是
  mobile-send-key-workspace
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-101
---
## Proposal

AC-101 的判据 `npm run test:e2e -- e2e/session-filter.spec.ts` 当前为红。以下读数全部是本轮在 canonical checkout `/data/home/yale/work/claudecodeui` 上**直接复跑判据**测得，不是从账本尾部转录的。

### 现象：判据红在第 1 条用例，且失败文本点名了别的项目

`npm run test:e2e -- e2e/session-filter.spec.ts` → **EXIT=1，5.5s**，`1 failed / 4 did not run`：

```
e2e/session-filter.spec.ts:171:3 › the editor previews the rule, saving converges the list, and Show/Hide survive a reload
Error: expect(locator).toContainText(expected) failed
  Locator: getByTestId('session-filter-preview')
  Expected substring: "Hidden: 4"
  Received string:    "Hidden: 0Visible: 1mobile-send-key"
    at /data/home/yale/work/claudecodeui/e2e/session-filter.spec.ts:182:27
```

账本尾部与此一致：`.quay/gate-events.jsonl` 的 AC-101 goal gate 最后一次 pass 是 `2026-09-22T04:04:49Z`（goal-sweep），首次 fail 是 `2026-09-22T05:05:32Z`，随后 `05:07:03Z`（goal-cli）。注意账本记下的 reason 是 stderr 优先的，里面只有 `NO_COLOR` 警告——账本本身说不出坏在哪里，这正是要复跑的原因。

### 机制：缺陷只有一处，在 spec 的入口定位

失败文本里的 `mobile-send-key` 是关键：那正是 `mobile-send-key-workspace` 唯一一条夹具会话，而它**不是本 spec 要操作的被测项目**。预览只数到 1 条会话、且就是它，说明规则编辑器被打开在了另一个项目上。

- `openFilterEditor()`（`e2e/session-filter.spec.ts:112`）点的是 `page.getByTitle('Session filter…').first()`。侧边栏**每个项目各渲染一个**过滤按钮（`src/modules/sidebar/SidebarProjectItem.tsx:277` 与 `:420`，`title` 取 `sessionFilter.menuItem` = `"Session filter…"`，见 `src/modules/i18n/locales/en/sidebar.json:161`）。所以未限定的 `.first()` 命中的是「谁先渲染」而不是「被测项目」。
- 侧边栏默认排序按显示名：`sortProjects`（`src/modules/sidebar/utils/sidebarProjectFormatting.ts:121-148`），`projectSortOrder` 默认为 `'name'`，对 `displayName` 做 `localeCompare`。于是本轮起 `mobile-send-key-workspace` 排在 `session-filter-workspace` 之前。
- 编辑器会把自己的项目写进标题（`src/modules/sidebar/SessionFilterEditor.tsx:148` 渲染 `${t('sessionFilter.editorTitle')} · ${project.displayName}`）——这也正是"打开了别的项目"这件事在失败文本里看得见的原因。

### 触发：一个与本判据无关的提交新增了第 5 个 e2e 夹具

提交 `7d842d4c`（2026-09-22 12:33:26 +0800 / 04:33Z，`feat(chat): scope the composer send key to the device's input capabilities`）给 `playwright.config.ts` 加了 `seedMobileSendKeyWorkspace()`，使每次 e2e 运行隔离 HOME 里的夹具项目从 4 个变成 5 个。时间线吻合：最后一次 pass 在 04:04:49Z，该提交 04:33Z 落地，首次红在 05:05:32Z。

### 早先的修复为何没有守住

判据本身来自 `gap-session-filter-real-browser-e2e`（done）。它写下这个 spec 时，隔离数据目录里只有 4 个夹具项目，而 `session-filter-workspace` 在其中按字母序**恰好排第一**——于是 `.first()` 靠夹具集合的巧合命中了正确的那个按钮，spec 连绿约 15 小时，却**从未断言过自己打开的是哪个项目**。产品代码一行没变，是后来另一个无关任务加了第 5 个名字更靠前的夹具，未限定的定位器就静默跟着换了个目标。这不是"修复失效"，是判据从一开始就有一个未测的入口假设。

### 窄度：已实测，不是推断

只改一处——把 `openFilterEditor()` 限定为该项目的过滤控件（`projectRow().getByTitle('Session filter…')`，该控件是项目自身切换按钮的后代）——判据 **EXIT=0，`5 passed (16.5s)`**。随后 spec 已按 `git checkout --` 还原，`diff` 与还原前逐字节相同。所以整个缺口就是这一个定位器：产品代码与其余断言链都是健康的，**不需要改任何 `src/`**。

### 修复方向

1. 把打开编辑器的点击限定到被测项目（项目行切换按钮内部就带着同一个项目的过滤控件）。
2. 顺带把入口钉死：对话框会渲染项目显示名，spec 应断言该对话框属于 `session-filter-workspace`。这一次之所以能静默一天，正是因为没有这条断言，错项目只能靠下游计数不符才暴露。
3. 判据的可取假性必须原样保留：本次只动定位/限定，不得顺带放宽任何断言。

### 明确不做

- ⛔ 不改产品代码（`src/`、`server/` 一行不改）——单定位器复跑已证明无需改。
- ⛔ 不放宽或删除断言，不加 retry。
- ⛔ 不把 `.first()` 换成写死序号（如 `nth(1)`）：那只是把同一个脆弱性换个形式，下一个夹具还会再打破它；限定必须由项目身份承担。
- ⛔ 不动其他 e2e spec。全库扫描确认同类未限定入口只有这一处（`grep -rn "getByTitle(" e2e/*.spec.ts` 的另两处是 `model-library*.spec.ts` 的全局 `Create new project` 按钮，与项目无关）。

<!-- dedup-ref -->同区域不同机制，仅作溯源：`gap-session-filter-real-browser-e2e`（done）立的是这条判据本身；`gap-ac101-criterion-concurrency-determinism`（done）修的是并发下端口撞死与 60s 上限击杀；`gap-canonical-checkout-node-modules-missing-compression`（done）修的是主 checkout 缺依赖导致后端起不来。三者与本任务没有共享的写入面——本任务的写入面只有 `e2e/session-filter.spec.ts` 一个文件。

## AC

- [x] `npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0 且输出 `5 passed`；同时登记该次 wall time。**本轮登记**：四次全绿复跑均 EXIT=0 且 `5 passed (16.7s)` / `(17.0s)` / `(16.7s)` / `(17.0s)`，shell wall 均为 17.3s；本轮没有被测机制之外的红——唯一一次基线红就是本任务要修的缺陷本身。
- [x] 抗假变体（入口必须真的指向被测项目）：把 `openFilterEditor()` 改回未限定的 `page.getByTitle('Session filter…').first()` → 该命令退出码非 0，且失败文本指认被打开的是别的项目（`mobile-send-key`）；还原后再次退出码 0，`git diff` 只剩本任务改动。**本轮登记**：改回 `page.getByTitle('Session filter…').first()` 后 EXIT=1，失败文本为 `Expected substring: "Session filter · session-filter-workspace"` / `Received string: "Session filter · mobile-send-key-workspace…` —— 被打开的确是别的项目；`git checkout --` 还原后 EXIT=0，工作树与已提交的修复逐字节相同。
- [x] 入口在同一断言里被钉死：spec 断言编辑器对话框属于被测项目（对话框标题形如 `Session filter · session-filter-workspace`），使「点错项目」在入口处具名失败，而不是靠下游计数不符才暴露。该断言正是抗假变体红的落点（见上一条登记的失败文本），所以它不是纸面断言。
- [x] 取假性未被削弱：临时去掉过滤请求的 `keepSessionIds` → 该命令必须变红，且红在第 2 条用例的 keep-id 断言上；还原后退出码 0，`git diff` 无残留。**本轮登记**：去掉 `src/shared/api.ts` 中 projectSessions 的 `keepSessionIds` query 参数后 EXIT=1，红在第 2 条用例 `e2e/session-filter.spec.ts:263` 的 `expect(filtered.keepSessionIds).toContain(sessionIdOf(selected))`；`git checkout -- src/shared/api.ts` 还原后 EXIT=0，工作树干净。
- [x] 未复测的部分如实登记（不得冒充已覆盖）：AC-101 另两个取假形态——把「显示」实现成清空库内规则、把过滤搬到客户端（分页后再过滤）——本轮未复测，理由与边界写入正文；本任务不因未测它们而自称覆盖了它们。**边界与理由**：本任务的写入面只有 `e2e/session-filter.spec.ts` 一个文件（见 Touches），而这两种形态的复测都必须改产品代码——前者要动服务端应用规则之处，后者要动列表分页与过滤的归属之处——都在本任务范围之外，故本轮未复测。
- [x] 无未翻译 i18n 字面量这条断言仍在跑：退出码 0 的那次运行确实执行到 spec 末尾对 `body.innerText()` 的 `UNTRANSLATED_KEY` 匹配。**本轮登记**：在该匹配行的下一行插入一个必然失败的探针后 EXIT=1，失败行号正是探针所在行（spec:350），证明其上一行确实执行过；探针已还原。另测该正则本身不是惰性的：`sidebar.sessionFilter` 命中、`Session filter` 不命中——所以绿读作「没有未翻译字面量」，而不是「匹配器失效」。
- [x] `git diff develop --name-only` 的全部改动都落在 Touches 内；`src/`、`server/`、`playwright.config.ts` 一行未改。**本轮登记**：`git diff develop --name-only` 只列出 `e2e/session-filter.spec.ts`（修复提交后）；`npm run lint` EXIT=0，`npx tsc --noEmit -p tsconfig.json` EXIT=0。

## DoD

(a) **判据真绿**：在 canonical checkout 上 `npm run test:e2e -- e2e/session-filter.spec.ts` 退出码 0、`5 passed`，wall time 已登记（本轮测得修复后约 16.5s，远低于 goal gate 的 60s 硬顶）。

(b) **入口真的指向被测项目**：由抗假变体正面证明——还原未限定定位器即变红，且红在「打开了别的项目」这一点上；不是靠「文件里写了限定后的定位器」。

(c) **修复没有把脆弱性换个形式**：限定必须由项目身份（项目行／项目显示名）承担，不得退化为写死序号或依赖夹具字母序。正面读数是现状本身：第 5 个夹具已经入场，判据仍须绿。

(d) **缺陷只在 spec 入口**：`git diff develop` 显示 `src/`、`server/`、`playwright.config.ts` 零改动，证明修的是判据的入口而不是产品行为。

环境噪声须如实登记：本机是共享机器，fleet 常驻并发 e2e。若出现与被测机制无关的红（端口/加载类），须写明红因并给出单独跑为绿的对照读数；不得当作本任务已完成或未完成的证据，也不得靠加重试换绿。

L_D 该轴仍暗，理由：本任务只修一条既有 e2e 判据的入口定位，不新增产品领域能力。
L_G 该轴仍暗，理由：同上；本任务让 AC-101 的既有判据重新为真，不新增 goal 判据。

## Touches

- e2e/session-filter.spec.ts
- tasks/gap-session-filter-editor-locator-unscoped.md
