---
id: AC-289
title: 面向调用方的服务端文案统一为英文：message、note、explanation、description 字段里不再有中文
status: achieved
kind: criterion
goal: GOAL-024
criterion: for f in server/modules/mcp-gateway/tests/mcp-english-only.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-english-only.test.ts
expect: 读数：(a)
  用全部探针与成功路径收集所有由服务端撰写的字符串字段（`message`、`note`、`explanation`、`hostNote`、工具与参数的
  `description`、`instructions`、授权页的错误文案），其中不含任何 CJK
  字符；会话标题、项目名、消息正文这类**用户数据**不在检查范围内，测试用含中文标题的夹具证明它们被原样返回而没有被误判；(b) 同一个 code
  在所有工具上的 message 语言一致；(c) 正例对照：检查器能在一段合成的中文 message 上变红。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 把某个 message 改回中文 ⇒ (a) 必须红；(ii) 把用户数据当成服务端文案去清洗 ⇒
  夹具里的中文标题断言必须红。既有判据中凡断言旧形状的，只许移植到新形状并保持断言强度，不许删除或放宽，移植要在任务记录里逐条列出。（红先行）当前必红：判据文件不存在，存在性闸以退出码
  1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
activatedAt: 2026-10-06T12:19:21.326Z
statusLog:
  - at: 2026-10-06T12:19:21.326Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-06T18:14:30.752Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-06T12:19:21.326Z
---
