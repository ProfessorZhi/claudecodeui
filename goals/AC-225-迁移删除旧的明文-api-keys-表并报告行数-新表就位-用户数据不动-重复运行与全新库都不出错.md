---
id: AC-225
title: 迁移删除旧的明文 api_keys 表并报告行数，新表就位，用户数据不动，重复运行与全新库都不出错
status: achieved
kind: criterion
goal: GOAL-018
criterion: for f in
  server/modules/database/tests/api-keys-drop-migration.test.ts; do [ -f "$f" ]
  || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/database/tests/api-keys-drop-migration.test.ts
expect: 做法照 launch-profiles-drop-migration.test.ts：手工建一个含 `api_keys`（2 行）与
  `users`（1 行）的旧库，驱动 `runMigrations`。读数：(a) `sqlite_master` 中不再有 `api_keys` 表与
  `idx_api_keys_*` 三个索引；(b) `access_tokens` 表存在；(c) `users` 那一行原样保留；(d)
  迁移日志里报告删除了 2 行；(e) 同一个库再跑一次 `runMigrations` 不抛错且不再输出删除日志；(f) 全新库（从不存在
  `api_keys`）迁移不抛错、不输出删除日志。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 迁移不删表 ⇒ (a)
  必须红；(ii) 迁移顺手删了 `users` ⇒ (c) 必须红；(iii) 第二次运行抛错 ⇒ (e) 必须红；(iv) 删表但不输出行数 ⇒ (d)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3）。人 yale 2026-10-05 指令：创建并激活本 goal 及其 AC。
activatedAt: 2026-10-04T17:18:30.985Z
statusLog:
  - at: 2026-10-04T17:18:30.985Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-04T18:25:38.444Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-04T17:18:30.985Z
---
