---
id: gap-resident-enter-send-bypasses-intent-and-consent-gate
title: AC-180 Enter 键发送绕过常驻意图与知情门控：开关与勾选都开着按 Enter 落成 per-run，未勾选按 Enter 也能发出，让
  Enter 与发送按钮走同一入口
status: done
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-180
---
## Proposal

**现状读数（2026-09-29 真浏览器实测，读回的是库与进程，不是判据）。** 新建会话，打开常驻开关：
- 勾选「我了解」后按 Enter 发送，会话在库里 `lifecycle_mode` 为 `per-run`，没有 resident 宿主（会话 `00405f1d`）。改点发送按钮，同样的操作落成 `resident`，宿主 `resident` / `idle` 且有 pid（会话 `544a1447`）。
- 开关开着、未勾选，按 Enter 消息照样发出，会话为 `per-run`（会话 `095976b4`）。发送按钮此时是禁用的。

**根因。** `src/modules/chat/hooks/useChatComposerState.ts:1215` 与 `:1218` 的 Enter 处理直接调 `handleSubmit(event)`，而记录常驻意图并遵守知情门控的入口是 `src/modules/chat/composer/ChatComposer.tsx` 的 `handleComposerSubmit`（`setPendingResidentIntent` 在那里被调用）。该处注释声称「两个入口都经过这里」，与事实不符。`e2e/resident-enable-consent.spec.ts` 只按发送按钮读，所以 AC-171 读绿而这个洞一直在。

**要做的事。** 让 Enter 路径与按钮路径走同一个入口：意图在 Enter 发送时同样被记录，知情门控在 Enter 路径上同样生效（未勾选时不发送、不建会话）。修法由 worker 在读过两处代码后决定，要求是单一入口，不是把门控逻辑复制到第二处。

## Plan

1. 读 `ChatComposer.tsx` 的 `handleComposerSubmit` 与 `useChatComposerState.ts` 的 `handleKeyDown`，确定 Enter 路径接入同一入口的最小改法。
2. 写 `e2e/resident-enter-send.spec.ts`（真浏览器、真服务）：(a) 已勾选后 Enter 发送，读回 `lifecycle_mode` 为 `resident`；(b) 未勾选时 Enter，消息不发出、会话总数不变；(c) 正控制：开关关闭时 Enter 照常发送，会话为 `per-run`。红态先行：改代码前这个 spec 在 (a) 与 (b) 上必红。
3. 改代码，跑绿。
4. 取假形态：把 Enter 路径改回直接调 `handleSubmit`，(a) 必须红；去掉 Enter 路径的门控，(b) 必须红。逐字登记失败行，恢复。
5. `npm run lint` 绿；再跑 `npx playwright test e2e/resident-enable-consent.spec.ts` 确认 AC-171 不受影响。

## AC

- [x] AC1 判据绿：`npx playwright test e2e/resident-enter-send.spec.ts` 退出 0。红态基线：改代码前退出非 0，红落在 (a) 或 (b) 的读数上（该 spec 文件还不存在时的读数是 `Error: No tests found`）。
- [x] AC2 (a) 读数：勾选后 Enter 发送，会话 `lifecycle_mode` 逐字 `resident`，且宿主列表里该会话有 `mode` 为 `resident` 的宿主。
- [x] AC3 (b) 读数：未勾选时 Enter，会话总数发送前后不变，输入框内容保留。
- [x] AC4 (c) 正控制：开关关闭时 Enter 发送，会话为 `per-run`，证明读数不是恒 `resident`。
- [x] AC5 取假形态必须红（承重）：Enter 路径直接调 `handleSubmit` ⇒ AC2 的读数红；Enter 路径不看知情门控 ⇒ AC3 的读数红。每种变异先提交再变异，跑完用 `git checkout` 恢复，登记逐字失败行。
- [x] AC6 `npx playwright test e2e/resident-enable-consent.spec.ts` 仍退出 0；`npm run lint` 退出 0；`git diff --stat` 与 Touches 逐条对齐。

## DoD

- 判据在真浏览器里跑，读回的模式是服务端事实（库与宿主列表），不是前端本地状态。
- 只有一个提交入口：Enter 路径不复制门控逻辑。
- 假形态真的跑过、真的红过，红落在对应的承重断言上。
- 前端改动遵守 `.agents/skills/frontend-module-standards/SKILL.md`。
- 只动 Touches 列出的文件。

## Touches

- tasks/gap-resident-enter-send-bypasses-intent-and-consent-gate.md
- `src/modules/chat/hooks/useChatComposerState.ts`
- `src/modules/chat/composer/ChatComposer.tsx`
- `e2e/resident-enter-send.spec.ts` (new)

## Evidence

绿态与假形态在同一 worktree、同一 HEAD（实现提交 `75f16302`）上跑，各自跑前 `git status --porcelain` 为空。

- **绿基线。** `npx playwright test e2e/resident-enter-send.spec.ts` 退出 0（3 passed）。读数：`session.lifecycle_mode=resident` + `host.resident.bindsSession=true`（AC2）；`gate.closed=true`、`sessions.before=15`→`sessions.after=15`、`composer.value="enter key gate probe"`（AC3）；`control.lifecycle_mode=per-run`（AC4）。
- **AC5 假形态 (i)** —— Enter 路径改回直接调 `handleSubmit`：AC2 红。逐字失败行 `e2e/resident-enter-send.spec.ts:342:5  ).toBe('resident');`，读数 `Received: "per-run"`，报错 `the session a ticked Enter send is addressed to must read back as resident from the server — the key reached the send without recording the resident intent it was given`。
- **AC5 假形态 (ii)** —— 去掉 `handleComposerSubmit` 里的 `if (residentGateClosed) return;`：AC2 仍绿，AC3 红。逐字失败行 `e2e/resident-enter-send.spec.ts:390:5  ).toEqual({ pathname: pathBefore });`，读数 `sessions.before=15`→`sessions.after=16`、`composer.value=""`、pathname 变为 `/session/a53605e8-…`。
- **每轮变异后** `git checkout -- <file>` 恢复，恢复后 `git status --porcelain` 为空（工作树回到 HEAD）。
- **AC6。** `npx playwright test e2e/resident-enable-consent.spec.ts` 退出 0（3 passed，按钮路径与会话菜单转换均不受影响）；`npm run lint` 退出 0；`npm run typecheck` 退出 0；`git diff develop...HEAD --stat` 恰为 Touches 的三个文件（两个前端文件 + 新增 e2e spec）。
- **上一轮 suite not-landed 的三条红均非本 delta**（都不在 Touches 内）：`server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts`（develop 恒红）、`server/modules/providers/tests/model-gateway-end-to-end.test.ts`（tmp rmdir teardown 竞态）、`server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts`（其子面 `voice-dashscope-settings.test.ts` 在舰队并发下红；单独重跑 32/32 绿）。本轮未改任何后端或 voice 文件，故不重实现。

## 实现

- `useChatComposerState.ts` 的 `handleKeyDown`：Enter（含 Ctrl/Cmd+Enter）不再直接调 `handleSubmit`，改为 `event.currentTarget.form?.requestSubmit()`，把按键路由到表单的 `submit` 事件。
- `ChatComposer.tsx` 的 `handleComposerSubmit`：`event.preventDefault()` 后先过 `residentGateClosed` 门控（未勾选即拒绝），再 `setPendingResidentIntent(residentEnabled && residentAcknowledged)` 并 `onSubmit(event)`。按钮是 `type="submit"` 且其 `onClick` 已 `preventDefault()`，故按钮与 Enter 都只经此唯一入口。

## Needs-Human

**执行 2026-09-29T05:25:19.040Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=37090 server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts passed=false end_ms=1790659347066
- run_id：wk-prod-anchor
- session_id：0a335775-2974-4820-a21f-22924df45f97
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-resident-enter-send-bypasses-intent-and-consent-gate~wk-prod-anchor~1790659264484-3a56fa.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-resident-enter-send-bypasses-intent-and-consent-gate-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-29T06:30:32.631Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: not ok - server/modules/session-hosts/tests/resident-server-restart.test.ts:   AssertionError [ERR_ASSERTION]: the next boot swept nothing (swept=0); the orphan was not there to reap
- run_id：wk-prod-anchor
- session_id：3db02389-572e-4c24-b529-7c3dd022f9b3
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-resident-enter-send-bypasses-intent-and-consent-gate~wk-prod-anchor~1790663177790-83b985.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-resident-enter-send-bypasses-intent-and-consent-gate-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-29T07:12:25.654Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 4 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
- run_id：wk-prod-anchor
- session_id：ae6b1b1f-2edf-4c13-b0fa-5d8a7625f328
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-resident-enter-send-bypasses-intent-and-consent-gate~wk-prod-anchor~1790665431912-10eb21.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-resident-enter-send-bypasses-intent-and-consent-gate-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-29T07:30:07.642Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 5 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=19855 server/modules/providers/tests/model-gateway-end-to-end.test.ts passed=false end_ms=1790666853866
- run_id：wk-prod-anchor
- session_id：d1a451d3-aa1c-4f6a-b480-1bfa37f5675d
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-resident-enter-send-bypasses-intent-and-consent-gate~wk-prod-anchor~1790666770739-4655c8.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-resident-enter-send-bypasses-intent-and-consent-gate-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-29T07:40:47.626Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 6 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: __PERFILE__ duration_ms=20177 server/modules/voice/tests/voice-dashscope-settings.test.ts passed=false end_ms=1790667509156
- run_id：wk-prod-anchor
- session_id：f290484a-6ef0-4525-83a1-d188bcd70740
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-resident-enter-send-bypasses-intent-and-consent-gate~wk-prod-anchor~1790667415753-4cc212.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-resident-enter-send-bypasses-intent-and-consent-gate-wk-prod-anchor.log

## Needs-Human

**执行 2026-09-29T08:03:07.264Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 7 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-secrets.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
- run_id：wk-prod-anchor
- session_id：d972d2f3-419f-497e-876f-2c9a34295323
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-resident-enter-send-bypasses-intent-and-consent-gate~wk-prod-anchor~1790668750666-e79796.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-resident-enter-send-bypasses-intent-and-consent-gate-wk-prod-anchor.log
