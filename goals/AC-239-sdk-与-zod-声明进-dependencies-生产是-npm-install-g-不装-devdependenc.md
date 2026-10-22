---
id: AC-239
title: SDK 与 zod 声明进 dependencies：生产是 npm install -g，不装 devDependencies，不再依赖传递安装的副本
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in
  server/modules/mcp-gateway/tests/dependency-declaration.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/dependency-declaration.test.ts
expect: 读 package.json 与 package-lock.json 的 JSON，不做文本匹配。读数：(a) `dependencies`
  同时含 `@modelcontextprotocol/sdk` 与 `zod`，且二者都不只出现在 `devDependencies` 或
  `peerDependencies`；(b) SDK 的范围锁在当前小版本线（波浪号范围，1.29 线），`zod` 的范围允许已安装的 4.x；(c)
  node_modules 里实际安装的版本满足各自的范围；(d) package-lock.json 根包条目的 dependencies 与
  package.json 一致，二者在 lock 里没有被标成 dev。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i)
  把 SDK 挪到 devDependencies ⇒ (a) 必须红；(ii) 范围改成 `*` 或 `^2` ⇒ (b) 必须红；(iii) lock
  未同步 ⇒ (d) 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:06:27.983Z
statusLog:
  - at: 2026-10-05T02:06:27.983Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T03:33:37.821Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:06:27.983Z
---
