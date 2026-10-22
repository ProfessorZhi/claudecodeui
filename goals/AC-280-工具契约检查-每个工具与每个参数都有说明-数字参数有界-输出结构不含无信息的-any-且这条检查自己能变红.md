---
id: AC-280
title: 工具契约检查：每个工具与每个参数都有说明，数字参数有界，输出结构不含无信息的 any，且这条检查自己能变红
status: draft
kind: criterion
goal: GOAL-023
criterion: for f in server/modules/mcp-gateway/tests/mcp-contract-lint.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-contract-lint.test.ts
expect: 对生产挂载的全部工具（只读、写、常驻、审批）经真实 `tools/list` 检查，读数：(a) 每个工具的描述至少 80
  个字符，且含「何时使用」与「何时不要使用，改用某某工具」两层意思，后者点名的工具必须真实存在于 `tools/list`；(b) 每个输入参数都有非空
  `description`；(c) 每个数字参数有 `minimum`，有服务端上限的（如 `waitSeconds`）也有 `maximum` 与
  `default`；(d)
  取值有限的字符串参数（`provider`、`lifecycleMode`、`permissionMode`、`effort`）要么是枚举，要么描述里列全取值；(e)
  `session`、`project` 参数的描述明说「id 或唯一的标题子串，歧义时返回候选」；(f) 没有任何 outputSchema 的顶层属性是裸
  `any`（当前 `run_get` 的 `run?:any`、`session_send` 的 `run?:any` 都要有具体结构）；(g)
  同一次运行里的正例对照：对一个合成的、带裸参数与短描述的工具，同一个检查器必须逐条报出 (a) 到 (f)
  的违规，证明它能变红。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 删掉任一参数的描述 ⇒ (b) 必须红；(ii)
  把 `waitSeconds` 的 `maximum` 去掉 ⇒ (c) 必须红；(iii) 把描述缩成一句 ⇒ (a)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: 本会话（2026-10-06）对 ChatGPT 与 Gemini 接入真实经验的 MCP 接口契约审计，及人 yale
  同日指令：把审计清单落成 quay goal。
---
