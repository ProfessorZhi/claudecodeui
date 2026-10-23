---
id: AC-013
title: config.env legal keys reach the spawn env
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/config-env-compiled.test.ts
expect: profile.config.env 中通过白名单的键（如
  CLAUDE_CODE_DISABLE_MOUSE、CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN）必须出现在
  resolveLaunchSpec 产出的 spec.env 中；越权键（LD_PRELOAD 等）仍被丢弃并产出
  warning。缺口：assertConfigAllowed 校验 config.env，但 compileGatewayEnv
  从不读取它——键能存进库、验得过、却从不传给 Claude，AC-004/AC-011 都测不出。取假形态：现实现下合法键不在 spec.env
  里，今天必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于
  2026-09-20：对照用户历史启动命令（claude-fjdac + 917k 上下文三件套 + --permission-mode
  bypassPermissions + --prompt-suggestions false）复核 profile 机制所得缺口
activatedAt: 2026-09-20T08:17:01.348Z
statusLog:
  - at: 2026-09-20T08:24:02.654Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:38:10.949Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 复核：对象是 profile.config.env（Record），B 方案下改为有序 env 行，由 AC-024 覆盖
superseded-by:
  - AC-024
---
