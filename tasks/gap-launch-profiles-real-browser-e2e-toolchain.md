---
id: gap-launch-profiles-real-browser-e2e-toolchain
title: "Launch profiles: real-browser e2e (Playwright toolchain + profile
  create→select→send spec)"
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-012
---
## Proposal

GOAL-001 AC-012 要求真实浏览器驱动真实服务，组件级 vitest 不满足（AC-010 即组件测试绿而实机三处坏的反例）。当前仓库没有 e2e 工具链：无 @playwright/test 依赖、无 playwright.config、无 test:e2e 脚本，故 `npm run test:e2e` 今天为红（预期的第一形态）。本任务：(1) 加 @playwright/test devDependency、playwright.config.ts（webServer 启动真实后端+前端，使用隔离的临时数据目录/DB，不碰用户真实数据）、package.json 的 test:e2e 脚本；(2) 写 e2e/launch-profiles.spec.ts：登录 → 打开 Settings 的 Profiles 页 → 从 UI 新建 profile（录入 name/model/baseUrl/认证方式/上下文窗口）→ 在会话创建入口（LaunchProfileSelect）选中它 → 发送会话。断言：(a) 页面全文不含未翻译 i18n 字面量（正则匹配形如 mainTabs.profiles 的 key，如 /\b[a-z][A-Za-z]+\.[a-z][A-Za-z]+\b/ 针对已知 key 命名空间）；(b) 编辑器存在并可填写 baseUrl / 认证方式 / 上下文窗口控件，不只 name+model；(c) 选中的 profile 随会话发出（拦截真实请求/WebSocket 帧或读取服务端收到的 launch 参数，断言含该 profile 的 id/name）。若实机暴露 AC-010 所述缺陷（i18n key 缺失、编辑器字段缺失、profile 未随会话发出），在本任务内一并修复相应 src/ 与 locales 文件，使 e2e 转绿。

## AC

- [x] `grep -q '"test:e2e"' package.json && grep -q '@playwright/test' package.json && test -f playwright.config.ts && grep -q webServer playwright.config.ts` 退出码 0
- [x] `npm run test:e2e` 退出码 0，且输出显示 e2e/launch-profiles.spec.ts 的用例全部 passed（真实 Chromium + 真实启动的服务，非 jsdom/vitest）
- [x] 断言 (a)：spec 中有用例遍历 Profiles 页与会话创建入口的可见文本，断言不含形如 mainTabs.profiles 的未翻译 i18n key 字面量，且用例通过
- [x] 断言 (b)：spec 中有用例在 UI 上填写 baseUrl、认证方式、上下文窗口并保存，重新打开后值回显，且用例通过
- [x] 断言 (c)：spec 中有用例在会话创建入口选中新建的 profile 并发送，断言实际发出的请求/帧携带该 profile 标识，且用例通过
- [x] `grep -rn "page.route\|vi.mock" e2e/ | grep -v "^$" ` 不出现对 profile 相关后端接口的 mock（服务必须是真实的）

## DoD

真实落地：在一个真实 Chromium 中，对真实启动的服务（playwright webServer，隔离数据目录），通过 UI 完成 登录→Settings Profiles 页新建 profile→会话入口选中→发送，并实测 (a)(b)(c) 三项断言通过；`npm run test:e2e` 绿并把输出附到任务证据。仅有组件测试或 mock 后端的 spec 不算完成（DIR-026 Reading A）。

## Touches

- package.json
- package-lock.json
- playwright.config.ts
- e2e/launch-profiles.spec.ts
- .gitignore
- src/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab.tsx
- src/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles.ts
- src/modules/settings/tests/launchProfileSettings.test.tsx
- src/shared/types.ts
- src/modules/chat/composer/LaunchProfileSelect.tsx
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- tasks/gap-launch-profiles-real-browser-e2e-toolchain.md
