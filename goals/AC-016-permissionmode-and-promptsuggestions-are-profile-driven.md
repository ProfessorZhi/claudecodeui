---
id: AC-016
title: permissionMode and promptSuggestions are profile-driven
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/profile-session-flags.test.ts
expect: config.permissionMode 必须被两条路径消费：SDK 路径在 composer 未显式选择时采用它（显式选择胜出；plan
  模式不被覆盖），终端路径编为 --permission-mode <mode>；写入时对照 provider-capabilities 的
  permissionModes 校验，非法值 400。config.promptSuggestions 布尔值：终端编为
  --prompt-suggestions <true|false>，SDK 经 extraArgs['prompt-suggestions']
  传递。对应用户每次都写的 --permission-mode bypassPermissions --prompt-suggestions
  false。取假形态：这两个字段目前无人消费，今天必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于
  2026-09-20：对照用户历史启动命令（claude-fjdac + 917k 上下文三件套 + --permission-mode
  bypassPermissions + --prompt-suggestions false）复核 profile 机制所得缺口
activatedAt: 2026-09-20T08:17:01.371Z
statusLog:
  - at: 2026-09-20T09:17:09.845Z
    from: active
    to: superseded
    actor: yale
    reason: 类型化 permissionMode/promptSuggestions 字段：ADR-002 第一版不做；permission mode 仍由
      composer 权限菜单承担
---
