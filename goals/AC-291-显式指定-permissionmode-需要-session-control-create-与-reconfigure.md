---
id: AC-291
title: 显式指定 permissionMode 需要 session:control：create 与 reconfigure 对此一致
status: draft
kind: criterion
goal: GOAL-025
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-permission-mode-gate.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-permission-mode-gate.test.ts
expect: 读数：(a) 不带 `permissionMode` 的 `session_create` 用 provider 默认，不需要额外
  scope；(b) 带 `permissionMode` 的 `session_create`，只有 create 与 send 的令牌返回
  `INSUFFICIENT_SCOPE` 并要求 `cloudcli:session:control`，会话不被创建；具备 control
  的令牌成功；(c) `session_reconfigure` 本就需要 control，两处的拒绝形状与 code 一致；(d) 不被 provider
  支持的模式仍返回 `UNSUPPORTED_PERMISSION_MODE`
  并列出支持的取值，且权限检查先于该判断，缺权限的调用拿不到「支持哪些模式」的信息；(e)
  描述与参数说明明写「选择更宽松的模式属于控制权限」。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 不对 create
  检查 control ⇒ (b) 必须红；(ii) 先判模式再判权限 ⇒ (d)
  必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
