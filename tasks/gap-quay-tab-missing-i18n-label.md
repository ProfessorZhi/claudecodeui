---
id: gap-quay-tab-missing-i18n-label
title: Quay tab 缺 i18n 翻译键且标题用裸字符串字面量
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

在实现 `gap-quay-project-status-display`(status: done)时引入的 Quay tab 存在两个独立的展示缺陷,已经用 playwright MCP 浏览器在真实运行的 CloudCLI(`localhost:3001`,打开 claudecodeui 自身这个项目)上复现:

1. `src/modules/project-workspace/WorkspaceTabs.tsx:115-119` 把新增的 Quay tab 注册为 `{ id: 'quay', labelKey: 'tabs.quay', icon: Activity }`,但所有语言包的 `tabs` 对象(实测遍历了全部 12 个 `src/modules/i18n/locales/*/common.json`:de/en/es/fr/id/it/ja/ko/ru/tr/zh-CN/zh-TW,每个都只有 `chat/shell/files/git/tasks/browser/computer/shellResidentDisabled/shellResidentDisabledLabel` 九个键)都没有 `quay` 这个键。react-i18next 找不到译文时把 key 原样吐出来,于是浏览器里 Quay tab 上显示的文字字面是 `tabs.quay`,不是任何人类可读的标签——accessibility snapshot 实测:`tab "tabs.quay" [ref=e1083]`。
2. `src/modules/project-workspace/WorkspaceTitle.tsx:41-43` 的 `getTabTitle` 函数,对 `activeTab === 'quay'` 这一支写的是裸字符串字面量 `return 'quay';`——完全没有经过 `t()`。对比同函数里其它分支:`files` 走 `t('mainContent.projectFiles')`,`git` 走 `t('tabs.git')`,只有 `quay` 这一支漏调用,工作区头部标题栏因此显示小写 `"quay"` 而不是任何正式标签——accessibility snapshot 实测:`heading "quay" [level=2]`。

两个缺陷位置不同、成因不同(一个是语言资源没补全,一个是代码里漏调用 `t()`),但表现在同一个用户可见位置(Quay tab 的名字和打开后的标题),一起修一次到位。

## AC

- [x] `npm run typecheck` 退出码 0。
- [x] 新增一条前端窄测试,遍历 `src/modules/i18n/locales/*/common.json`(glob 覆盖全部 12 个语言目录),断言每个文件解析后的 `tabs.quay` 字段存在且是非空字符串——退出码 0。缺任何一个语言文件的键都要让这条测试失败,不能只检查 `en`。
- [x] `src/modules/project-workspace/WorkspaceTitle.tsx` 的 `getTabTitle` 对 `activeTab === 'quay' && shouldShowQuayTab` 分支改为返回 `t('tabs.quay')` 的结果,新增的窄测试断言:渲染 `WorkspaceTitle`(`activeTab='quay'`, `shouldShowQuayTab=true`)时,标题文本严格不等于裸字符串 `'quay'`,且等于 `i18n` 翻译表里 `tabs.quay` 对应的值——退出码 0。
- [x] 新增的窄测试断言:渲染 `WorkspaceTabs`(`shouldShowQuayTab=true`)时,Quay tab 的可见文本/`aria-label` 严格不等于裸字符串 `'tabs.quay'`——退出码 0。

## DoD

- 真实验证,不只是单测绿:在本机启动的 CloudCLI(`localhost:3001`)上,用 playwright MCP 浏览器打开一个配置了 quay 的项目(例如 claudecodeui 自身),切到 Quay tab——截一次 accessibility snapshot,确认 tab 名称与打开后的工作区标题栏都显示人类可读的标签(例如英文语境下是 "Quay"),不再出现 `tabs.quay` 或小写 `quay` 字面量。
- 英文(`en`)语言包给出语义正确的翻译值(如 "Quay");其余 11 个语言目录至少补一个非空值(允许先用英文占位或机器翻译水准,不强制要求母语级翻译,但禁止留空字符串或把 key 名本身当值)。

## Touches

- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- src/modules/project-workspace/WorkspaceTitle.tsx
- src/modules/project-workspace/tests/WorkspaceTitle.test.tsx (new)
- src/modules/project-workspace/tests/i18nQuayTabCompleteness.test.ts (new)
- src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx
- tasks/gap-quay-tab-missing-i18n-label.md (self-touch)