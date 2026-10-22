---
id: AC-226
title: /api/agent 与明文 key 机制从生产代码里真正消失：模块目录、挂载、导出、建表语句都没有，且判据本身不会被注释或说明文字骗过
status: achieved
kind: criterion
goal: GOAL-018
criterion: for f in server/modules/oauth/tests/agent-retirement.test.ts; do [ -f
  "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/oauth/tests/agent-retirement.test.ts
expect: 读语法树而不是 grep 文本，以免命中注释与退役说明里的字样。读数：(a) 目录 `server/modules/agent` 不存在；(b)
  对 `server/index.ts` 解析：没有任何 import 的模块说明符含 `modules/agent`，也没有第一个实参为字面量
  `/api/agent` 的 `app.use` 调用；(c) 对 `server/**` 与 `src/**` 下全部非测试的 `.ts` 与
  `.tsx` 文件按标识符节点扫描，`apiKeysDb`、`createAgentModule`、`API_KEYS_TABLE_SCHEMA_SQL`
  各出现 0 次；(d) 同一次运行里的正例对照：同一个扫描器对一段合成源码能在代码位置找到标识符、却不被同一字样出现在注释或字符串里所骗，并且能在
  `server/modules/database/index.ts` 里找到已知存在的 `userDb`，证明零读数不是扫描器本身失灵；(e)
  `public/api-docs.html` 要么不存在，要么既不含 `/api/agent` 也不含 `ck_`；它不存在时，`src/**`
  的字符串字面量里不再有 `/api-docs.html`。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 重新引入对
  `createAgentModule` 的 import ⇒ (b) 必须红；(ii) 保留 `database/index.ts` 里
  `apiKeysDb` 的导出 ⇒ (c) 必须红；(iii) 保留带 `/api/agent` 的 `api-docs.html` ⇒ (e)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:19:27.081Z
statusLog:
  - at: 2026-10-04T17:19:27.081Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T18:41:07.901Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:19:27.081Z
---
