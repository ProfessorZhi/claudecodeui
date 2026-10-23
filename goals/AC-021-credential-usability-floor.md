---
id: AC-021
title: credential usability floor
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/profile-credential-hygiene.test.ts
  server/modules/launch-profiles/tests/profile-credential-status.test.ts && npx
  vitest run src/modules/settings/tests/launchProfileCredentialStatus.test.tsx
  src/modules/chat/tests/launchProfileLocked.test.tsx
expect: 三件事合取。(a) 凭据可见：Settings 对凭据变量给出说明（读的是 CloudCLI
  服务进程环境、改后需重启）与实时状态“服务端已设置/未设置”，只报布尔、绝不回传值；编译产出的 warning 在界面可见。(b) 网关类
  profile（设置了 baseUrl 且认证方式不是继承）默认清除继承来的 ANTHROPIC_API_KEY /
  ANTHROPIC_AUTH_TOKEN，除非 profile 自己提供；spec 必须能表达“移除某键”并在 SDK
  路径与终端路径都真的生效——否则发往第三方网关的请求会带上宿主环境里可能属于 Anthropic 的 key。passthrough 与认证方式为继承的
  profile 不受影响。(c) 会话锁定后 composer 的 profile 下拉禁用，并回显该会话实际使用的
  profile（重开会话也回显，不是组件本地 null）；消费服务端回带的 profileLocked。复现依据：2026-09-20 实机，FJD
  profile 填了 FJDAC_API_KEY_FILE（存放路径的变量）而服务进程只有
  FJDAC_API_KEY，界面无任何提示。取假形态：以上四处今天均缺失，必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于 2026-09-20：用户在
  Settings-Profiles 实机使用中提出三个问题（变量在哪设 / 是否要为原生 claude 建 profile /
  能否设缺省），playwright + 代码复核后发现的可用性缺口
activatedAt: 2026-09-20T08:49:25.990Z
statusLog:
  - at: 2026-09-20T09:17:08.378Z
    from: active
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-026 取代
superseded-by:
  - AC-026
---
