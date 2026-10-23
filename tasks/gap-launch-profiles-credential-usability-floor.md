---
id: gap-launch-profiles-credential-usability-floor
title: launch-profiles：凭据可用性下限——变量状态可见、网关 profile 清除继承的 Anthropic key、会话锁定后回显
  profile（AC-021）
status: superseded
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-021
---
## Proposal

GOAL-001 的 AC-021（凭据可用性下限）三件事合取，今天均缺失。复现依据：2026-09-20 实机，FJD profile 填了 FJDAC_API_KEY_FILE（存放路径的变量）而服务进程只有 FJDAC_API_KEY，界面无任何提示。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-gateway-end-to-end-test 与 gap-launch-profiles-session-profile-lock-test 证明的是网关 env 注入与首次 send 锁定；本任务补的是凭据状态可见、继承 key 清除与锁定后 UI 回显，均未被任何现有任务认领 AC-021。

方案（最小切片）：
(a) 凭据可见：新增只读端点（`launch-profiles.routes.ts`，实现于 `launch-profiles.service.ts`），对 profile 的 authEnvVarName 返回 `{name, set: boolean}`，只报布尔、绝不回传值。`LaunchProfilesSettingsTab.tsx` 在凭据变量输入旁显示说明（读的是 CloudCLI 服务进程环境、修改后需重启服务）与实时状态“服务端已设置/未设置”；`resolveLaunchSpec` 产出的 warnings 经 REST 回带并在 Settings 可见。补全 locale 文案。
(b) 移除键：`ResolvedLaunchSpec`（`server/shared/types.ts`）增加 `unsetEnv: string[]`。`compileGatewayEnv` 中，设置了 baseUrl 且 authMode 不是继承（inherit）的 profile，默认把 ANTHROPIC_API_KEY 与 ANTHROPIC_AUTH_TOKEN 放入 unsetEnv，除非 profile 自己（typed auth 目标或 config.env）提供该键。SDK 路径（`claude-runtime.provider.js` 构造 sdkOptions.env 处）与终端路径（`shell-websocket.service.ts` 构造 pty env 处）都必须在合并 process.env 后真正删除这些键。passthrough 与认证方式为继承的 profile 行为不变。
(c) 会话锁定回显：服务端把 `profileLocked` 及会话实际 launchProfileId 回带客户端（chat websocket 会话创建/恢复消息，及会话读取接口）；`useChatComposerState.ts` 消费并设置 launchProfileId，`LaunchProfileSelect.tsx` 在会话锁定后禁用下拉并回显该会话实际 profile，重开会话也回显，不是组件本地 null。

取假形态：以上四处（状态端点/UI、unsetEnv 编译、SDK 与 shell 两路径删除、锁定回显）任一移除均须判红。

## AC

- [x] `node --experimental-strip-types --test server/modules/launch-profiles/tests/credential-status.test.ts` 退出码 0：端点对已设置/未设置变量分别返回 set=true/false，响应 JSON 序列化中不含变量的值（以哨兵值断言）。
- [x] `node --experimental-strip-types --test server/modules/launch-profiles/tests/gateway-unset-inherited-keys.test.ts` 退出码 0：宿主 env 含 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN，网关 profile 的 SDK sdkOptions.env 与 shell pty env 均不含二者；profile 自带该键时保留；passthrough 与 inherit 认证的 profile 仍含宿主值。
- [x] `npx vitest run src/modules/settings/tests/launchProfileCredentialStatus.test.tsx src/modules/chat/tests/launchProfileLockedEcho.test.tsx` 退出码 0：Settings 显示说明、“服务端已设置/未设置”与 warning；会话锁定后下拉 disabled 且回显该会话 profile，重开会话仍回显。
- [x] 取假验证：分别移除 unsetEnv 在 SDK 路径、shell 路径的应用，以及 UI 对 profileLocked 的消费，上述对应用例均转红（记录在 DoD 证据中）。
- [x] `npx tsc --noEmit -p server/tsconfig.json` 与前端 `npm run typecheck` 退出码 0。

## DoD

真实落地：用真实 FJD 形态 profile（authEnvVarName 指向服务进程未设置的变量）经真实 REST 端点与 Settings 界面操作，界面显示“服务端未设置”与 warning；对网关 profile 实际发起 SDK 会话与终端会话，捕获子进程 env 证明不含宿主 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN；在已锁定会话中重开，composer 下拉禁用并回显实际 profile。仅有 fixture 或单元断言不足以关闭。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/launch-profiles.routes.ts
- server/modules/launch-profiles/launch-spec.service.ts
- server/modules/launch-profiles/session-profile-lock.ts
- server/shared/types.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- src/shared/types.ts
- src/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab.tsx
- src/modules/settings/tabs/launch-profiles-settings/useLaunchProfiles.ts
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/composer/LaunchProfileSelect.tsx
- src/modules/chat/composer/ChatComposer.tsx
- server/modules/launch-profiles/tests/credential-status.test.ts
- server/modules/launch-profiles/tests/gateway-unset-inherited-keys.test.ts
- src/modules/settings/tests/launchProfileCredentialStatus.test.tsx
- src/modules/chat/tests/launchProfileLockedEcho.test.tsx
- tasks/gap-launch-profiles-credential-usability-floor.md

## Needs-Human

**执行 2026-09-20T09:02:55.661Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-launch-profiles-credential-usability-floor — 8 violation(s)
- run_id：wk-prod-anchor
- session_id：8350def1-c891-4be9-a10f-c4091ce1f9b5
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-credential-usability-floor-wk-prod-anchor.log


2026-09-20 撤回：改为 Model library 承载（ADR-002，B 方案），缺省 profile / profile 凭据可用性底线随 profile 独立实体一并被取代。该任务的 worktree 与分支保留未删，仅状态改为 superseded。