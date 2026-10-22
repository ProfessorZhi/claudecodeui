---
id: AC-022
title: model secrets are write-only and the db file is private
status: achieved
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/model-secret-write-only.test.ts
  server/modules/database/tests/db-file-permissions.test.ts
expect: ADR-002 决策 2：secret 行的值允许存于 provider_models.config_json，但只写。断言：(a)
  模型列表接口、单个模型接口、以及校验失败/404 等错误响应中都检索不到 secret 值（只回 isSet:true）；(b) PATCH 时
  secret 行不带 value 表示保持原值，带空串表示清除；(c) auth.db 在打开时权限收紧为 0600（实机测得当前为 0644）。取代
  AC-003（“密钥不入库”）：该断言的前提已被 ADR-002 明确推翻，不得悄悄改测试。取假形态：模型表今天没有 config_json，列表接口也无
  isSet，且 auth.db 权限为 644，必红。
origin: ADR-002（配置挂在 Model library 上，取代独立 launch profile
  实体）；docs/proposals/launch-profiles.md 待随之修订
activatedAt: 2026-09-20T09:16:11.882Z
statusLog:
  - at: 2026-09-20T09:35:57.486Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
supersedes:
  - AC-003
---
