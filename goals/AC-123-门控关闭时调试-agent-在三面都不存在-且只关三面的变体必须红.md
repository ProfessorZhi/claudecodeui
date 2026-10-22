---
id: AC-123
title: 门控关闭时调试 Agent 在三面都不存在，且「只关掉其中一面」的变体必须红
status: achieved
kind: criterion
goal: GOAL-007
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/debug-agent/tests/debug-agent-gate.test.ts
expect: 门控在**进程启动时求值**，因此本判据必须在**两个独立子进程**里各取一次读数（同一进程内改 env 再 import 无效——ESM
  模块已被求值）。关闭态（`DEBUG_AGENT` 未设或取值不认识）逐一断言三面：(1) **registry 无键**——按 id
  解析失败，且失败**与拼错一个 id 逐字相同**（同 code、同 message 形态），即"调试 Agent"与"打字错误"无从区分；(2)
  **watcher 无根**——fixture 根不在观察路径集合里， 且该目录不被创建；(3)
  **路由未挂载**——控制面路径**不以控制面的应答作答**。第三条**不得写成状态码 404**：本仓库
  `static-assets.module.ts` 的 SPA catch-all 对**任何无扩展名的路径**渲染
  `dist/index.html`，未挂载的 `/api/...` 路径返回的是 `200 text/html`，写 404 的判据**在实现完全正确时
  也必红**（实测见 adr/ADR-003-验证记录.md 的 a）。开启态对照：三面都存在。fail-closed：变量取值不认识、 或开了但
  fixture 根为空，一律按关闭处理，且必须在输出里打印判定的原因。取假形态：**只关掉其中一面** （例如保留 registry
  键但摘掉路由）时本判据必须红——这是"三面各自独立读门控"这个代价的正面覆盖。 命令必须逐字含文件路径，**不得用 glob**：`node --test`
  在 glob 无命中时退出 0，会让本判据在模块不存在时 假绿。当前必红：该测试文件不存在（`Cannot find module`）。
origin: ADR-003 决策 3 与裁决 B。裁决 B 把"四面"降为三面：`PROVIDER_CAPABILITIES` 是闭集字面量、 不随
  registry 增长，所以"关闭态没有条目"恒真、不构成关闭的证据。
activatedAt: 2026-09-22T14:45:00.000Z
statusLog:
  - at: 2026-09-22T14:45:00.000Z
    from: draft
    to: active
    actor: yale
    reason: 随 GOAL-007 立；红先行（测试文件与模块均不存在）。
  - at: 2026-09-22T15:22:20.857Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
