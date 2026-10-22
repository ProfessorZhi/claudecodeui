---
id: gap-launch-profiles-permission-mode-and-suggestions
title: launch-profiles：permissionMode 与 promptSuggestions 由 profile 驱动（AC-016）
status: superseded
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-shell-uses-selected-profile
goal_ac: AC-016
---
## Proposal

GOAL-001 的 AC-016 要求：config.permissionMode 与 config.promptSuggestions 被两条启动路径消费。现状：profile 里这两个字段无人读取（launch-profiles 模块中唯一被编成参数的只有 defaultModel/fallbackModel）。用户每次启动都写 `--permission-mode bypassPermissions --prompt-suggestions false`，是最高频的会话参数，目前无处表达；聊天路径靠 composer 权限菜单，终端路径靠独立的 bypassPermissions 布尔开关（`--dangerously-skip-permissions`），都不是 profile 驱动。

方案（最小切片）：
1. `permissionMode`：类型化字段。SDK 路径在 composer 未显式选择（缺省或 default）时采用 profile 值；显式选择胜出；plan 模式不被覆盖；与 toolsSettings.skipPermissions 并存时沿用现有逻辑（skipPermissions 已强制 bypassPermissions，profile 不得削弱它）。终端路径编为 `--permission-mode <mode>`。
2. 写入校验：对照 `provider-capabilities.service.ts` 的 `permissionModes`（claude：default/auto/acceptEdits/bypassPermissions/plan）校验，非法值 400，`LAUNCH_PROFILE_INVALID_PERMISSION_MODE`。
3. `promptSuggestions`：布尔。终端编为 `--prompt-suggestions <true|false>`；SDK 路径经 `sdkOptions.extraArgs['prompt-suggestions']` 传递（SDK 的 extraArgs 键不带 `--`，见 sdk.d.ts 1423）。
4. 新增 `server/modules/launch-profiles/tests/profile-session-flags.test.ts`：两字段在两条路径的编译结果；显式选择胜出；plan 不被覆盖；非法值 400；取假用例：无人消费时必须判红。

⚠️ 事实依据须如实登记：`--prompt-suggestions` 在本机 claude 2.1.278 的 --help 中存在；仓库 `.claude/launch.settings.json` 另用了环境变量 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`，该变量未在官方 env-vars 页查到，本任务不依赖它。SDK 路径下该参数的实际效果未经实测，验收以"参数被传递"为界，不宣称效果。

依据：ADR-001（全局作用域、密钥不入库、env 白名单、会话锁定、toolsSettings 不进 profile、contextWindow 取代全局）。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/profile-session-flags.test.ts` 退出码 0（AC-016 的判据命令）。
- [ ] 测试证明 SDK 路径采用 profile 的 permissionMode 且显式选择胜出、plan 不被覆盖、skipPermissions 不被削弱；终端路径编出 `--permission-mode` 与 `--prompt-suggestions`；SDK 路径 extraArgs 含 `prompt-suggestions`。
- [ ] 非法 permissionMode 写入返回 400 且不落库。
- [ ] 取假变体使该测试判红，红灯输出记录在任务证据中；`session-profile-lock.test.ts` 与 `shell-resume-launch-spec.test.ts` 仍退出码 0；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求 claude-runtime.provider.js 的 `mapCliOptionsToSDK` 与终端 `buildShellCommand` 真的消费这两个字段。AC-016 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-016` 能独立核验。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/launch-profiles/tests/profile-session-flags.test.ts (new)
- tasks/gap-launch-profiles-permission-mode-and-suggestions.md


2026-09-20 撤回：对应 AC-016 已置 superseded（ADR-002 第一版不做类型化 permissionMode/promptSuggestions；permission mode 仍由 composer 权限菜单承担）。