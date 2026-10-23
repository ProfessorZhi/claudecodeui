---
id: gap-launch-profiles-config-env-reaches-spawn-test
title: launch-profiles：compileGatewayEnv 读取
  config.env，白名单内的键（CLAUDE_CODE_DISABLE_MOUSE 等）进入 spec.env，越权键仍丢弃并告警（AC-013）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-013
---
## Proposal

GOAL-001 的 AC-013 要求：profile.config.env 中通过白名单的键（如 CLAUDE_CODE_DISABLE_MOUSE、CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN）必须出现在 resolveLaunchSpec 产出的 spec.env 中；越权键（LD_PRELOAD 等）仍被丢弃并产出 warning。缺口（结构性 + 真缺陷）：`server/modules/launch-profiles/launch-profiles.service.ts` 的 `assertConfigAllowed` 校验了 `config.env`，但 `compileGatewayEnv` 只读 baseUrl / authEnvVarName / modelAliases，从不读取 `config.env`——键能存进库、验得过、却从不传给 Claude，AC-004/AC-011 都测不出。`tasks/` 中没有任何任务以 `goal_ac: AC-013` 推进该判据。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-env-injection-closed-test（AC-004）只证明违规键被拒，不证明合法键被传递；gap-launch-profiles-write-path-env-allowlist-test 只覆盖写入路径校验。

方案（最小切片）：
1. 在 `compileGatewayEnv` 末尾（或独立的 `compileConfigEnv`）读取 `config.env`：仅当其为非数组对象时，把值为 string 的键值对合并进 env；合并顺序上 config.env 先于网关派生键（baseUrl、认证、模型别名）写入，使显式网关字段优先。非 string 值忽略。
2. 保持 `resolveLaunchSpec` 现有的编译路径 `guards.isAllowedKey` 二次过滤不变：白名单内键保留，越权键（LD_PRELOAD、NODE_OPTIONS 等）丢弃并 push 现有 warning「... is not allowed in a launch profile and was dropped」。
3. 新增 `server/modules/launch-profiles/tests/config-env-compiled.test.ts`：经真实 `launchProfilesDb` 落库（含绕过写入服务直接落库的越权键）后调用 `resolveLaunchSpec`，断言合法键出现在 spec.env 且值相等，越权键不在 spec.env 且 warnings 含对应键名。取假用例：注入宽松 guards 时越权键出现（证明过滤承重），并以还原前实现（不读 config.env）验证合法键断言为红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/config-env-compiled.test.ts` 退出码 0（AC-013 的判据命令）。
- [x] 测试断言 profile.config.env 含 CLAUDE_CODE_DISABLE_MOUSE 与 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN 时，`resolveLaunchSpec(...).env` 逐键包含它们且值相等（`assert.equal(spec.env.CLAUDE_CODE_DISABLE_MOUSE, '1')` 一类）。
- [x] 测试断言直接落库的 LD_PRELOAD 不在 spec.env 中，且 `spec.warnings` 含提及 LD_PRELOAD 的 dropped 警告。
- [x] 取假用例：撤销 compileGatewayEnv 对 config.env 的读取，或注入宽松 guards，同一断言函数判红。
- [x] `npm run typecheck` 与 `npm test` 退出码 0（AC-001/004/011 等既有 launch-profiles 测试不回归）。

## DoD

真实落地判据：不是仅有测试文件存在。要求真实的 `compileGatewayEnv`/`resolveLaunchSpec` 读取并传递 `config.env`，测试通过真实 `launchProfilesDb` 落库的 profile 行经 `resolveLaunchSpec` 入口证明合法键到达 spec.env（即 Claude spawn 所用 env 的来源）；取假变体证明「不读取 config.env」与「过滤放宽」两处各自敏感。AC-013 判据命令在 quay 的 fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-013` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/tests/config-env-compiled.test.ts (new)
- tasks/gap-launch-profiles-config-env-reaches-spawn-test.md
