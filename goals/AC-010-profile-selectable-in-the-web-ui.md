---
id: AC-010
title: profile selectable in the web UI
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx vitest run
  src/modules/settings/tests/launchProfileSettings.test.tsx
  src/modules/chat/tests/launchProfileSessionEntry.test.tsx
expect: Settings 的 Profiles 页能列出并编辑 profile；会话创建入口能选择 profile 并把 launchProfileId
  随 chat.send 发出，缺省走解析链。criterion 走 vitest（前端 runner），⛔ 不能依赖 loop.test_command 的
  npm test（只跑后端）；取假形态：src/ 下目前没有任何 profile 相关代码，今天必红。
origin: docs/proposals/launch-profiles.md (commit 7da6f45c) + ADR-001；补立于
  GOAL-001 首次 achieved 后的范围复核
activatedAt: 2026-09-20T06:35:03.251Z
statusLog:
  - at: 2026-09-20T06:54:19.006Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:17:06.941Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-026 取代
superseded-by:
  - AC-026
---
