---
id: AC-019
title: saving a profile never drops fields it did not submit
status: superseded
kind: criterion
goal: GOAL-001
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/launch-profiles/tests/profile-partial-update.test.ts && npx
  vitest run src/modules/settings/tests/launchProfileSavePreserves.test.tsx
expect: PUT /api/launch-profiles/:id 只更新请求里出现的字段：未提交的
  isDefault、description、sortOrder、deployment 以及 config 内未编辑的键必须原样保留。数据丢失缺陷：UI 的
  PUT 不带这些字段，路由把缺失当作 false/null/0，而 UPDATE 又整体覆盖，于是用 API 把 profile 设为默认后，经 UI
  点一次 Save 该标记即被清掉，deployment 也被硬编码为 gateway。两段命令缺一不可：服务端部分更新语义 +
  前端保存请求不携带未编辑字段（以 fetch 桩断言请求体）。取假形态：现实现下 isDefault 经一次保存即变 false，今天必红。
origin: docs/proposals/launch-profiles.md + ADR-001；补立于 2026-09-20：用户在
  Settings-Profiles 实机使用中提出三个问题（变量在哪设 / 是否要为原生 claude 建 profile /
  能否设缺省），playwright + 代码复核后发现的可用性缺口
activatedAt: 2026-09-20T08:49:25.975Z
statusLog:
  - at: 2026-09-20T09:08:55.882Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-09-20T09:17:07.652Z
    from: achieved
    to: superseded
    actor: yale
    reason: ADR-002 重排：由 AC-026 取代
superseded-by:
  - AC-026
---
