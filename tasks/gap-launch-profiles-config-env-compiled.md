---
id: gap-launch-profiles-config-env-compiled
title: launch-profiles：config.env 中通过白名单的键必须进入 spec.env（AC-013）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-013
---
## Proposal

GOAL-001 的 AC-013 要求：profile.config.env 中通过白名单的键必须出现在 resolveLaunchSpec 产出的 spec.env 里，越权键仍被丢弃并产出 warning。2026-09-20 对照用户历史启动命令复核发现：`assertConfigAllowed` 校验了 `config.env`，但 `compileGatewayEnv`（launch-profiles.service.ts 约第 23-53 行）只读取 baseUrl、authEnvVarName、modelAliases，**从不读 config.env**——全文 `config.env` 只出现在校验那一处。结果是 `CLAUDE_CODE_DISABLE_MOUSE` 这类合法键能存进库、验得过，却永远不传给 Claude；AC-004 与 AC-011 都只测拒绝，没有任何测试断言"合法键到达 spawn 环境"。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-write-path-env-allowlist-test（AC-011，已 done）补的是写入路径拒绝；本任务补的是编译路径的**正向传递**。二者是同一字段的两半，缺一则白名单只拒不放。

方案（最小切片）：
1. 在 launch-profiles.service.ts 的编译步骤读取 `config.env`（对象，值须为字符串），逐键经现有 `guards.isAllowedKey` 过滤后并入 env；被拒键沿用现有 warning 文案。值非字符串的键丢弃并产出 warning。
2. 合并优先级：类型化字段编出的键（baseUrl、认证目标、modelAliases）胜过同名 config.env 键，冲突时产出 warning；该优先级在代码注释里写明。
3. 新增 `server/modules/launch-profiles/tests/config-env-compiled.test.ts`：真实落库的 profile → `resolveLaunchSpec`，断言 `CLAUDE_CODE_DISABLE_MOUSE`、`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` 出现在 spec.env；`LD_PRELOAD` 经直写 DB 绕过写入路径后仍被编译路径丢弃并产出 warning；非字符串值被丢弃。含取假用例：把 config.env 的并入去掉，同一断言必须判红。

依据：ADR-001（全局作用域、密钥不入库、env 白名单、会话锁定、toolsSettings 不进 profile、contextWindow 取代全局）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/config-env-compiled.test.ts` 退出码 0（AC-013 的判据命令）。
- [x] 测试经真实 `resolveLaunchSpec` 与真实（临时）sqlite 证明合法 env 键到达 spec.env；越权键（绕过写入路径直写库）被编译路径丢弃且产出 warning。
- [x] 取假变体（不并入 config.env）使该测试判红，红灯输出记录在任务证据中。（证据：还原 service 改动后 4 个用例全部 ✖：allowlisted config.env keys reach spec.env / denied config.env key … dropped with a warning / non-string … dropped / typed fields win）
- [x] `env-injection-closed.test.ts`、`env-allowlist-write-path.test.ts`、`passthrough-parity.test.ts` 仍退出码 0；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求真实的 `resolveLaunchSpec` 把库里 profile 的 `config.env` 合法键并入 spec.env，且该 spec.env 已被 claude-runtime.provider.js 的 `sdkOptions.env` 使用（无需改动该文件，已消费 `launchSpec.env`）。AC-013 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-013` 能独立核验。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/tests/config-env-compiled.test.ts (new)
- tasks/gap-launch-profiles-config-env-compiled.md
