---
id: AC-026
title: Settings > Agents > Models is a usable first-class page
status: achieved
kind: criterion
goal: GOAL-001
criterion: npx vitest run
  src/modules/settings/tests/modelLibrarySettings.test.tsx
  src/modules/settings/tests/modelLibrarySave.test.tsx
expect: Agents 页各 provider 下出现第五个分类 models：内置模型（只读）与自定义模型分区列出；编辑器支持四种 env
  行类型，secret 行掩码显示为“已设置”，可替换或清除，从不回显值；envref 行显示该变量在服务端“已设置/未设置”的实时状态，并说明它读的是
  CloudCLI 服务进程环境、改后需重启；编译 warning 在界面可见；“LLM 网关”模板一键预填
  BASE_URL、AUTH_TOKEN(secret)、三个 DEFAULT_*_MODEL、unset
  ANTHROPIC_API_KEY；保存请求体不携带用户未编辑的 secret 值，也不覆盖未提交的字段（重述 AC-019
  的数据丢失防线，对象换为模型）。取代 AC-010、AC-018、AC-019、AC-020、AC-021。⛔ 组件级测试不能替代 AC-027
  的浏览器验收。取假形态：AgentCategory 今天只有 account/permissions/mcp/skills，必红。
origin: ADR-002（配置挂在 Model library 上，取代独立 launch profile
  实体）；docs/proposals/launch-profiles.md 待随之修订
activatedAt: 2026-09-20T09:16:11.912Z
statusLog:
  - at: 2026-09-20T09:47:01.968Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
supersedes:
  - AC-021
---
