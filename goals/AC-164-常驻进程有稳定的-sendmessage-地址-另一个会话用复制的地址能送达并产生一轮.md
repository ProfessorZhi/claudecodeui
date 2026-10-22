---
id: AC-164
title: 常驻进程有可读的 SendMessage 地址（读自 Claude Code 的进程派生名，非 App 自造），另一个会话用该地址能送达并产生一轮
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-addressable.test.ts
expect: 两个常驻会话，真实 claude 二进制 + mock 端点：App 不传 --name（人 yale 2026-09-30 裁定，见
  tasks/gap-cloudcli-self-assigned-names-outrank-ai-titles.md），常驻进程在
  ~/.claude/sessions/<pid>.json 的 nameSource 为 derived；宿主快照的 peerName
  逐字等于该注册表记录里的 name（读来的，不是 App 算出来的），不承诺跨重启不变；mock 按脚本让会话甲以这个 derived 名调用
  SendMessage ⇒ 会话乙产生一个来源为 unattended、触发类型为跨会话消息的 run。取假形态：让投影回落到 App 自造的
  <slug>-<id6> ⇒ 必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令 ⟪2026-09-30 修订⟫ 人 yale
  裁定「CloudCLI 不要自己加戏，不要干扰 Claude Code 的行为」⇒ 出路 (a)，本 AC 原承诺的「按 proposal §12
  规则（标题 slug-会话 ID 前 6 位）自造稳定地址」作废，改为读 Claude Code 自己的进程派生名。判据文件
  server/modules/providers/tests/claude-resident-addressable.test.ts 仍逐字重述旧规则，须由
  tasks/gap-cloudcli-self-assigned-names-outrank-ai-titles 一并修订；在修订落地前，本 AC 的
  achieved 是对已作废承诺的认证。
activatedAt: 2026-09-27T04:57:24.557Z
statusLog:
  - at: 2026-09-27T04:57:24.557Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 2026-09-27 指令：判据已按 E1–E9 结论修订，转 active
  - at: 2026-09-27T11:48:59.734Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T04:57:24.557Z
---
