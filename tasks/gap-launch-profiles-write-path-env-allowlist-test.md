---
id: gap-launch-profiles-write-path-env-allowlist-test
title: launch-profiles：POST /api/launch-profiles 的 config.env 白名单在写入路径拒绝
  LD_PRELOAD/PATH/NODE_OPTIONS 且不落库（AC-011）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-011
---
## Proposal

GOAL-001 的 AC-011 要求：POST /api/launch-profiles 携带 `config.env.LD_PRELOAD`（或 PATH / NODE_OPTIONS）时必须被拒绝（4xx），且该键不得出现在任何已落库的记录里。ADR-001 决策 3 与 AC-004 的 expect 都要求【写入路径与编译路径各自拒绝】；2026-09-20 实机验证发现写入这一半未实现：带 LD_PRELOAD 的 payload 返回 201 并被持久化，而 AC-004 仍为绿——它的测试只覆盖了编译路径。`tasks/` 中没有任何任务以 `goal_ac: AC-011` 推进该判据，这是结构性缺口。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-env-injection-closed-test（AC-004，已 done）落地了白名单函数 `isAllowedLaunchEnvKey` 与编译路径过滤；本任务只补写入路径对 `config.env` 键的校验，并让测试经真实 REST 入口证明。

现状（今日必红）：`server/modules/launch-profiles/launch-profiles.service.ts` 的 `assertConfigAllowed`（约第 131 行）只检查内联凭据字段与 `authEnvVarTarget`，从不遍历 `config.env` 的键；createProfile/updateProfile 因此接受并持久化 `config.env.LD_PRELOAD`。

方案（最小切片）：
1. 在 `assertConfigAllowed` 中，若 `config.env` 为对象，则对其每个键调用 `guards.isAllowedKey`，任一不允许即抛 `AppError`（code `LAUNCH_PROFILE_ENV_KEY_DENIED`，statusCode 400）；`config.env` 存在但不是对象时同样 400。createProfile 与 updateProfile 共用该函数，故 POST 与 PUT 均被覆盖；在抛错之前不得写库。
2. 新增 `server/modules/launch-profiles/tests/env-allowlist-write-path.test.ts`：临时 sqlite + 真实 router 挂内存 Express（参照 profile-rest-api.test.ts），对 LD_PRELOAD、PATH、NODE_OPTIONS 各 POST 一次，断言返回 4xx；断言 GET 列表与直接查询 `launch_profiles` 全表全列均检索不到该键名；PUT 携带违规键同样 4xx 且原记录不变；合法键（如 `ANTHROPIC_BASE_URL`）仍 201。
3. 取假用例：把写入校验换成放行变体（或仅保留编译路径过滤）时，同一断言函数必须判红。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/env-allowlist-write-path.test.ts` 退出码 0（AC-011 的判据命令）。
- [x] 测试对 LD_PRELOAD、PATH、NODE_OPTIONS 各自经真实 HTTP POST 断言状态码为 4xx，且事后 `SELECT` 遍历 `launch_profiles` 各列（含 config_json）检索不到这些键名（命中数 `assert.strictEqual(hits, 0)`）；PUT 违规键同样 4xx 且原记录字节不变。
- [x] 合法键 POST 仍返回 201（避免过度拒绝）；取假变体（写入路径放行）使该测试判红，在任务证据中记录红灯输出。（证据：把 `if (!guards.isAllowedKey(key))` 改为 `if (false)` 后，POST/PUT 两个用例 ✖，pass 3 / fail 2；另有内置 falsification 用例以放行 guards 落库后断言函数抛错。）
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/env-injection-closed.test.ts` 与 `profile-rest-api.test.ts` 退出码 0；`npm run typecheck` 与 `npm test` 退出码 0。（前三项本地验证通过；`npm test` 全量由 fan-in suite 阶段执行。）

## DoD

真实落地判据：不是仅有测试文件存在。要求 `launch-profiles.service.ts` 的真实 createProfile/updateProfile 写入路径校验 `config.env` 键并在落库前抛 400，测试经真实 Express router + 真实（临时）sqlite 证明违规 payload 被拒且全库无该键；取假变体证明写入路径放行时会判红。AC-011 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-011` 能独立核验该任务。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/tests/env-allowlist-write-path.test.ts (new)
- tasks/gap-launch-profiles-write-path-env-allowlist-test.md
