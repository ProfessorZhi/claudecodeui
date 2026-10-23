---
id: gap-model-settings-layout-overflow-assertions
title: Models 设置页布局回归断言：≥1024px 编辑器不溢出、按钮不被遮挡（e2e，补 AC-026 只验证「机制存在」的缺口）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-env-editor-full-width-layout
---
## Proposal

判定机制：全仓库没有任何布局/溢出断言。`modelLibrarySettings.test.tsx:110` 的模板测试只断言预填的 key 与 kind；jsdom 不做布局，无法在单测里测溢出与遮挡，只能在真实浏览器测。AC-026「Settings → Agents → Models 是可用的一等页面」因此只被验证到「机制存在」，正是 GOAL-001 修订记录 2026-09-20（二）已记过的失败模式。

本任务在 `e2e/model-library-layout.spec.ts`（沿用 `e2e/model-library.spec.ts` 的登录与夹具方式）新增两条机械判据，视口覆盖 390、900、1440、1920：
(a) 打开 Models 弹窗、点开模板后，`editor.scrollWidth === editor.clientWidth`（≥1024px 尤其必须成立）；
(b) 对「+ Add」按钮中心调用 `document.elementFromPoint`，返回的元素必须是该按钮本身或其后代，并真实点击后行数 +1；
外加 (c) 变量名输入框在 ≥1024px 宽度 ≥ 250px。所有写请求须在网络层 abort，避免落库。

<!-- dedup-ref -->相关但不同：`gap-model-library-browser-e2e`（已 done）验证功能流（建模型/选中/发送），不含布局；本任务只加布局断言。被断言的布局由 `gap-model-env-editor-full-width-layout` 提供。

## AC

- [x] `npm run test:e2e -- e2e/model-library-layout.spec.ts` 退出码 0，四个视口全部通过。
- [x] 取假验证：在未修布局的提交上（或临时还原 `flex-wrap`/`lg:grid-cols` 改动）该 spec 在 1440 与 1920 视口必须变红，失败信息含 `scrollWidth`/`elementFromPoint` 之一（命令与输出写入完成记录）。
- [x] `git status --short database/` 无变化：spec 运行后没有 `zz-`/测试模型记录落库。
- [x] `npm run typecheck && npx oxlint && bash scripts/test.sh` 退出码 0（新 e2e 文件不得并入 vitest suite）。

## DoD

真实落地：断言在真实浏览器对真实页面跑通，且取假验证证明它能抓住本次实测的 115px 溢出与按钮被遮挡；不是只有 spec 文件存在。完成记录列出四个视口的实测 scrollWidth/clientWidth 与输入框宽度。

## 完成记录

环境说明：worktree 的共享 node_modules 未安装 `@playwright/test`，故用 `/tmp/pw` 中的 @playwright/test 1.63 与 playwright.config.ts 副本（仅给 webServer 加 `cwd` 指向 worktree）运行同一份 spec，命令 `/tmp/pw/node_modules/.bin/playwright test`；结果为 `4 passed`。

修好布局后的实测（scrollWidth/clientWidth；变量名输入框宽度）：
- 390px：326/326；308px
- 900px：572/572；417px
- 1440px：600/600；445px
- 1920px：600/600；445px

取假验证：临时 `git checkout 0cc1f9ff~1 -- ModelEnvEditor.tsx ModelLibraryPanel.tsx`（还原 flex-wrap / lg:grid-cols 改动）后重跑：1440 与 1920 变红，失败信息 `Error: scrollWidth 283 vs clientWidth 222`（390/900 仍绿）；随后已 `git checkout HEAD --` 恢复，工作树仅新增 spec。

落库检查：所有写请求在网络层 abort，`/api/providers/*/models` 的写请求数断言为 0；`git status --short database/` 无输出。`npm run typecheck` 通过，`npx oxlint` 仅既有 warning；scoped 门（thin）通过；全量 suite 由 driver fan-in 运行。

## Touches

- e2e/model-library-layout.spec.ts (new)
- tasks/gap-model-settings-layout-overflow-assertions.md
