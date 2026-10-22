---
id: AC-024
title: a model entry compiles to the real spawn env, including unset
status: achieved
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/model-launch-spec.test.ts
  server/modules/providers/tests/model-spawn-env.test.ts
expect: 按 (provider, model_id) 查到自定义模型后，resolveLaunchSpec 产出：value 行原样并入；secret
  行取库中值；envref 行读服务进程环境（变量不存在时产出 warning，且不静默回退到继承环境）；unset 行使该键从最终 spawn
  环境中被移除——⛔ 必须在 SDK 路径（sdkOptions.env）与终端路径（pty env）的【最终环境对象】上断言键不存在，而不是只断言 spec
  里有一个标记。内置模型与无配置的自定义模型编译结果与今日 passthrough 逐字一致。以历史 claude-fjdac 启动为参照
  fixture（BASE_URL、AUTH_TOKEN、三个
  DEFAULT_*_MODEL、MAX_CONTEXT_TOKENS、AUTO_COMPACT_WINDOW、AUTOCOMPACT_PCT_OVERRIDE、DISABLE_ALTERNATE_SCREEN、DISABLE_MOUSE、unset
  ANTHROPIC_API_KEY），如实登记与 wrapper
  的已知不等价点。编译路径对每一行重新校验白名单：绕过写入路径直写库的越权键（LD_PRELOAD 等）也不得进入最终 spawn 环境，并产出
  warning——这是纵深防御，写入路径校验（AC-023）不能替代它（接过 AC-004 的编译路径半边）。取代
  AC-004（编译路径半边）、AC-009、AC-013、AC-017。取假形态：今天不存在按模型编译的入口，必红。
origin: ADR-002（配置挂在 Model library 上，取代独立 launch profile
  实体）；docs/proposals/launch-profiles.md 待随之修订；criterion 路径随
  gap-launch-profiles-teardown-entity 的搬迁修正：launch-profiles 目录已按 GOAL-001
  拆除，测试现居 providers，断言对象一个不减
activatedAt: 2026-09-20T09:16:11.900Z
statusLog:
  - at: 2026-09-20T09:45:31.537Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
supersedes:
  - AC-017
---
