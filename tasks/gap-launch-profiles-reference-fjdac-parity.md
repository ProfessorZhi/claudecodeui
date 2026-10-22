---
id: gap-launch-profiles-reference-fjdac-parity
title: launch-profiles：参照 fjdac profile 与历史启动命令逐键等价（AC-017）
status: superseded
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-launch-profiles-config-env-compiled
  - gap-launch-profiles-context-fields-export-env
  - gap-launch-profiles-shell-uses-selected-profile
  - gap-launch-profiles-permission-mode-and-suggestions
goal_ac: AC-017
---
## Proposal

GOAL-001 的 AC-017 是对 AC-013/014/015/016 的合取验收：以用户历史上的 claude-fjdac 启动方式为参照 fixture，经真实 resolveLaunchSpec 编译后，spec.env 与 spec.argv 与历史命令逐键等价。单条 AC 各自为绿并不保证"这一整套真的能复现原命令"，本任务用一个具体对象把它们串起来。

参照 fixture（来自用户 bash history 与 wrapper 脚本）：baseUrl `http://127.0.0.1:26510/`；authEnvVarName `FJDAC_API_KEY`、authEnvVarTarget `ANTHROPIC_AUTH_TOKEN`；modelAliases opus/sonnet/haiku 均为 `v4.1flash`；defaultModel `deepseek-v4-pro-anthropic`；contextWindow 与 autoCompactWindow 均为 917000、autoCompactPct 80；permissionMode `bypassPermissions`；promptSuggestions false；config.env 含 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` 与 `CLAUDE_CODE_DISABLE_MOUSE=1`。

已知不等价点，须在测试注释与 proposal 附录里如实登记，**不得据此放宽断言**：wrapper 同时导出 ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_API_KEY，而 profile 只有单一 authEnvVarTarget。另外 wrapper 的 token 来自 `source` 一个 key 文件，profile 则读 CloudCLI 服务进程环境，因此启动 CloudCLI 时须先 `set -a; source <key文件>; set +a`。

方案（最小切片）：
1. 新增 `server/modules/launch-profiles/tests/reference-fjdac-profile.test.ts`：把上述 fixture 写入真实（临时）sqlite，设置测试进程的 FJDAC_API_KEY，调用真实 `resolveLaunchSpec`，用集合比较断言期望的 env 键值与 argv 项（凭据值只断言"存在且来自该变量"，不把值写进断言文本或日志）。
2. 在 `docs/proposals/launch-profiles.md` 追加「参考 profile：fjdac」附录，给出 fixture JSON、与历史命令的逐项对照表、启动 CloudCLI 时注入 FJDAC_API_KEY 的方法，以及上述已知不等价点。
3. 取假用例：去掉任一上游能力（config.env 并入、上下文导出、permissionMode、promptSuggestions）时该测试必须判红。

依据：ADR-001（全局作用域、密钥不入库、env 白名单、会话锁定、toolsSettings 不进 profile、contextWindow 取代全局）。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/reference-fjdac-profile.test.ts` 退出码 0（AC-017 的判据命令）。
- [ ] 测试以真实 profile 记录与真实 `resolveLaunchSpec` 驱动，断言 spec.env 含 BASE_URL、AUTH_TOKEN、三个 DEFAULT_*_MODEL、MAX_CONTEXT_TOKENS、AUTO_COMPACT_WINDOW、AUTOCOMPACT_PCT_OVERRIDE、DISABLE_ALTERNATE_SCREEN、DISABLE_MOUSE；spec.argv 含 `--model deepseek-v4-pro-anthropic`、`--permission-mode bypassPermissions`、`--prompt-suggestions false`。
- [ ] 已知不等价点在测试注释中登记，且 proposal 附录同步；不放宽任何断言。
- [ ] 取假变体（逐一去掉上游能力）使该测试判红，红灯输出记录在任务证据中；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有 fixture 文件存在。要求四个上游任务的能力经同一个真实 resolveLaunchSpec 合取生效，并把"如何用 profile 复现历史启动命令"写成可查阅的文档。AC-017 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-017` 能独立核验。

## Touches

- server/modules/launch-profiles/tests/reference-fjdac-profile.test.ts (new)
- docs/proposals/launch-profiles.md
- tasks/gap-launch-profiles-reference-fjdac-parity.md


2026-09-20 撤回：对应 AC-017 已被 AC-024 取代（参照 fjdac fixture 改为按模型条目编译）。