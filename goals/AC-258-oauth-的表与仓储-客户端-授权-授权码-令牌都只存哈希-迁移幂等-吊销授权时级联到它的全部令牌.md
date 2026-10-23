---
id: AC-258
title: OAuth 的表与仓储：客户端、授权、授权码、令牌都只存哈希，迁移幂等，吊销授权时级联到它的全部令牌
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in server/modules/oauth/tests/oauth-store.test.ts; do [ -f "$f"
  ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test server/modules/oauth/tests/oauth-store.test.ts
expect: 临时 DATABASE_PATH 加 runMigrations。读数：(a)
  `oauth_clients`、`oauth_grants`、`oauth_authorization_codes`
  三张表就位，`access_tokens` 的 OAuth 种类与 `grant_id` 外键可用；(b) 客户端密钥、授权码、OAuth 令牌在库里只有
  SHA-256 哈希，扫描整库字节找不到任何明文；(c) 吊销一个授权后，它名下的 access 与 refresh
  令牌下一次校验即被拒，其他授权的令牌不受影响；(d) 禁用一个客户端后，它名下全部授权的令牌被拒；(e)
  迁移在已有这些表的库上重跑不出错，在没有的库上建表。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 把授权码明文入库 ⇒
  (b) 必须红；(ii) 吊销只标记授权、不级联令牌 ⇒ (c) 必须红；(iii) 重跑迁移抛错 ⇒ (e)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:18:21.117Z
statusLog:
  - at: 2026-10-05T02:18:21.117Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:24:30.904Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:18:21.117Z
---
