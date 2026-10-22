---
id: AC-261
title: 授权页的密码提交有限速：每个来源每 15 分钟 10 次，来源取自受信任的代理头或 socket，未配置代理时伪造的头无效
status: achieved
kind: criterion
goal: GOAL-021
criterion: for f in server/modules/oauth/tests/oauth-consent-ratelimit.test.ts;
  do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/oauth/tests/oauth-consent-ratelimit.test.ts
expect: 时钟可注入。读数：(a) 同一来源连续 10 次错误密码后，第 11 次返回 429，即使这一次密码正确；(b) 窗口过后恢复；(c) 配置了
  `TRUST_PROXY` 时来源取 `CF-Connecting-IP`，不同来源各自独立计数；(d) 未配置 `TRUST_PROXY` 时伪造的
  `CF-Connecting-IP`、`X-Forwarded-For` 不改变来源，所有请求共享同一个桶；(e)
  成功登录不重置失败计数之外的任何其他来源的桶。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 无条件信任
  `CF-Connecting-IP` ⇒ (d) 必须红；(ii) 按成功与否清零全部桶 ⇒ (e) 必须红；(iii) 窗口永不过期 ⇒ (b)
  必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:20:02.597Z
statusLog:
  - at: 2026-10-05T02:20:02.597Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T23:24:44.416Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:20:02.597Z
---
