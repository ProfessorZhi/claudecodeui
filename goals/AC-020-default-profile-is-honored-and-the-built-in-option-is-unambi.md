---
id: AC-020
title: default profile is honored and the built-in option is unambiguous
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/default-profile-resolution.test.ts && npx
  vitest run src/modules/settings/tests/launchProfileDefault.test.tsx
  src/modules/chat/tests/launchProfileDefaultOption.test.tsx
expect: 不带 launchProfileId 的会话必须使用该 provider 下 is_default 的 profile，首次 send
  时把解析结果写入会话并锁定（此后改默认不追溯已有会话）；无默认时走内置 passthrough；同一 provider
  至多一条默认，设新默认原子地清除旧默认；删除默认 profile 后回退到 passthrough 而不报错。UI：Settings
  能设置与取消默认；composer 与空状态入口把内置选项明确标为“继承服务器环境”（取代易与模型 Default 混淆的 “Default
  profile”），并标出哪一条是默认。缺口：is_default 现只存在于数据库层与路由解析，服务端解析无任何消费点，UI
  亦无控件，今天设了也不生效，必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于 2026-09-20：用户在
  Settings-Profiles 实机使用中提出三个问题（变量在哪设 / 是否要为原生 claude 建 profile /
  能否设缺省），playwright + 代码复核后发现的可用性缺口
activatedAt: 2026-09-20T08:49:25.985Z
statusLog:
  - at: 2026-09-20T09:17:08.011Z
    from: active
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-026 取代
superseded-by:
  - AC-026
---
