---
id: AC-285
title: 错误 code 词表只有一个来源，每个工具声明自己可能返回的 code，观察到的 code 必须属于声明
status: achieved
kind: criterion
goal: GOAL-024
criterion: for f in
  server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-error-vocabulary.test.ts
expect: 读数：(a) 网关导出一份 `MCP_ERROR_CODES` 常量作为唯一词表，每个 code 有一句英文含义与是否可重试；(b)
  每个工具的描述或结构化元数据列出它可能返回的 code；(c) 上一条的全部探针中观察到的 code 都在对应工具声明的集合内，且都在词表内；(d)
  词表里没有任何 code 是没有一个探针能触发的死 code（豁免项必须显式列出理由）；(e) 源码里面向调用方的 `code:`
  字面量都来自词表，不再各处自写字符串（用语法树扫描，带正例对照）。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i)
  某工具返回词表外的 code ⇒ (c) 必须红；(ii) 往词表加一个无人触发的 code ⇒ (d) 必须红；(iii) 在某处直接写字符串 code
  ⇒ (e) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
activatedAt: 2026-10-06T12:17:04.246Z
statusLog:
  - at: 2026-10-06T12:17:04.246Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-06T15:31:16.716Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-06T12:17:04.245Z
---
