---
id: gap-launch-profiles-default-profile-honored
title: launch-profiles：默认 profile 必须被服务端解析消费，UI 可设/取消默认，内置项标为“继承服务器环境”（AC-020）
status: superseded
needs_human_cause: human-adjudication
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-020
---
## Proposal

GOAL-001 的 AC-020 要求：不带 launchProfileId 的会话使用该 provider 下 is_default 的 profile，首次 send 时把解析结果写入会话并锁定；无默认走内置 passthrough。现状：`is_default` 只存在于 `server/modules/database/repositories/launch-profiles.db.ts` 与 `launch-profiles.routes.ts` 的入参，`session-profile-lock.ts` 的 `resolveSessionProfileLock(stored, client)` 在 client 为空时直接返回 undefined，没有任何消费点，所以设了默认也不生效；UI 无设置/取消默认的控件，且 `LaunchProfileSelect.tsx` 的内置选项文案 “Default profile” 易与模型 Default 混淆。

<!-- dedup-ref -->相关但不同机制：gap-launch-profiles-session-profile-lock-test（AC-007）证明的是首次 send 锁定与后续不覆盖；本任务补的是**client 未带 id 时 id 从默认 profile 来**，并复用同一锁定路径。

方案（最小切片）：
1. 服务端：在 `launch-profiles.service.ts` 增加 `resolveDefaultProfileId(provider)`；`chat-websocket.service.ts` 的 dispatchRun 在 stored 与 client 均为空时用它得到 id，再走 `resolveSessionProfileLock` 首次持久化。已锁定会话不受之后改默认影响。默认 profile 被删除或不存在时回退 passthrough，不抛错。
2. 原子性：`launch-profiles.db.ts` 的 create/update 在 isDefault=true 时于同一事务内清除同 provider 其它默认（同 provider 至多一条）。
3. Settings：`LaunchProfilesSettingsTab.tsx` 增加“设为默认/取消默认”控件，并显示当前默认标记。
4. composer 与空状态入口：`LaunchProfileSelect.tsx` 内置选项文案改为“继承服务器环境”（补全 en/zh-CN 等 locale），并在选项中标出哪条为默认。
5. 测试：新增 `server/modules/launch-profiles/tests/default-profile-resolution.test.ts`、`src/modules/settings/tests/launchProfileDefault.test.tsx`、`src/modules/chat/tests/launchProfileDefaultOption.test.tsx`。取假用例：移除默认消费点、非原子清除、删除默认后抛错，均须判红。

依据：ADR-001（会话锁定、全局作用域）与 docs/proposals/launch-profiles.md。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/default-profile-resolution.test.ts && npx vitest run src/modules/settings/tests/launchProfileDefault.test.tsx src/modules/chat/tests/launchProfileDefaultOption.test.tsx` 退出码 0（AC-020 判据命令，两段缺一不可）。
- [x] 服务端测试以真实落库的 profile 驱动：无 launchProfileId 的首次 send 写入默认 profile id 并锁定；之后改默认，已有会话不变；无默认走 passthrough；设新默认后同 provider 仅一条 is_default；删除默认后回退 passthrough 且不报错。
- [x] 前端测试断言 Settings 能设置与取消默认；composer 内置选项文案为“继承服务器环境”，不再出现 “Default profile”，且默认 profile 有明确标记。
- [x] 取假变体（去掉默认消费点）使服务端测试判红，红灯输出记录在任务证据中；`npm run typecheck` 通过；既有 session-profile-lock 与 launch-profiles 测试仍退出码 0。

## DoD

真实落地判据：不是仅有测试文件存在。要求真实的 chat 发送路径在客户端不带 id 时读取库中默认 profile 并写入会话锁，UI 控件确实调用 REST 更新 isDefault。AC-020 判据命令在 quay fan-in 中由红转绿，且下一轮 driver 通过 `goal_ac: AC-020` 能独立核验。

## Evidence

- 取假变体（dispatchRun 不再传入 resolveDefaultProfileId 结果）：`✖ first send without an id locks the default profile; a later default change does not affect it`，fail 1 / pass 5；还原后 6/6 绿。
- `npm run typecheck` 通过；launch-profiles/tests 全部 45 项通过；scripts/test.sh --for-task ... --allow-thin 3/3 通过。

## Touches

- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/session-profile-lock.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/database/repositories/launch-profiles.db.ts
- server/modules/launch-profiles/tests/default-profile-resolution.test.ts (new)
- src/modules/settings/tabs/launch-profiles-settings/LaunchProfilesSettingsTab.tsx
- src/modules/settings/tests/launchProfileDefault.test.tsx (new)
- src/modules/chat/composer/LaunchProfileSelect.tsx
- src/modules/chat/tests/launchProfileDefaultOption.test.tsx (new)
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- tasks/gap-launch-profiles-default-profile-honored.md

## Needs-Human

**执行 2026-09-20T09:09:35.535Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 成因类：human-adjudication
- 失败步/判词：step=anti-drift: ANTI-DRIFT HARD FAIL: task gap-launch-profiles-default-profile-honored — 2 violation(s)
- run_id：wk-prod-anchor
- session_id：5144dcff-b578-4037-8973-964d9d7a1aea
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-launch-profiles-default-profile-honored-wk-prod-anchor.log


2026-09-20 撤回：改为 Model library 承载（ADR-002，B 方案），缺省 profile / profile 凭据可用性底线随 profile 独立实体一并被取代。该任务的 worktree 与分支保留未删，仅状态改为 superseded。