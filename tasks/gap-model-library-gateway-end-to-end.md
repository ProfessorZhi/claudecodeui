---
id: gap-model-library-gateway-end-to-end
title: model-library：网关请求带着模型条目里的凭据真实落地（AC-025）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-model-library-compile-spawn-env
goal_ac: AC-025
---
## Proposal

GOAL-001 的 AC-025：服务端级端到端。编译单测证明 env 对，但不证明“请求真的打到了目标端点、带着对的凭据”。测试内起 mock Anthropic 兼容服务，建一条自定义模型（base URL 指向 mock、token 为 secret 行、unset ANTHROPIC_API_KEY），经真实 chat.send 跑一轮，断言 mock 收到该请求。

<!-- dedup-ref -->相关但不同机制：原 AC-002 的 gateway-end-to-end.test.ts 以 profile 为入口，本任务是同一断言换成模型条目入口，并新增“宿主 ANTHROPIC_API_KEY 不出现在请求里”这一防泄漏断言。

方案（最小切片）：
1. 新增 `server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts`，复用现有 gateway-end-to-end 的 mock 服务与真实 WebSocket 派发的做法。
2. 用例：(a) 选自定义模型 → mock 收到请求，认证头来自 secret 行；(b) 把宿主环境设置一个哨兵 ANTHROPIC_API_KEY，且模型条目含 unset 行 → 该哨兵值不出现在 mock 收到的任何头里；(c) 对照组：选内置模型 → 请求不打到 mock；(d) `options.env` 伪造 → 被忽略。
3. 取假用例：去掉 unset 的移除动作时 (b) 必须判红。

依据：ADR-002（配置挂在 Model library 上；密钥允许存于 config_json 但只写；unset 为显式行类型；同 model id 不跨端点；第一版含 LLM 网关模板）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts` 退出码 0（AC-025 的判据命令）。
- [x] 四个用例全过，其中 (b) 明确证明宿主 Anthropic key 不外泄到网关。
- [x] 取假变体使 (b) 判红，红灯输出记录在任务证据中；`npm run typecheck` 通过。

证据：5 个测试全过（a/b/b-fake/c/d）；(b-fake) 去掉 unset 行后宿主哨兵 key 出现在 mock 收到的头里，防泄漏断言 `assert.throws` 判红（即 (b) 的断言在无 unset 时为红）；`npm run typecheck` 通过。

## DoD

真实落地判据：不是仅有测试文件存在。要求经真实 chat.send 派发、真实 SDK spawn 的请求带着模型条目里的凭据到达 mock。AC-025 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-025` 能独立核验。

## Touches

- server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts (new)
- tasks/gap-model-library-gateway-end-to-end.md
