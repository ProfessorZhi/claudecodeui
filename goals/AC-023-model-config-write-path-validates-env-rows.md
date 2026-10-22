---
id: AC-023
title: model config write path validates env rows
status: achieved
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/model-config-write-path.test.ts
expect: POST/PATCH /api/providers/:provider/models 接受 config.env 行，行类型限
  value/secret/envref/unset，键名过白名单：LD_PRELOAD、PATH、NODE_OPTIONS、CLAUDE_CLI_PATH、CLAUDE_CONFIG_DIR
  等返回 4xx 且不落库；unset 行允许对白名单内的键（如 ANTHROPIC_API_KEY）生效；envref 只存变量名。同一
  (provider, model_id) 重复返回 409（ADR-002 决策 5 接受的限制，须有用例登记）；内置模型不可挂配置。取代
  AC-008（profile CRUD 路由）与 AC-011（profile 写入路径白名单）。取假形态：现路由只接受 {id,
  model}，config.env 被忽略，今天必红。
origin: ADR-002（配置挂在 Model library 上，取代独立 launch profile
  实体）；docs/proposals/launch-profiles.md 待随之修订
activatedAt: 2026-09-20T09:16:11.892Z
statusLog:
  - at: 2026-09-20T09:29:19.259Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
supersedes:
  - AC-011
---
