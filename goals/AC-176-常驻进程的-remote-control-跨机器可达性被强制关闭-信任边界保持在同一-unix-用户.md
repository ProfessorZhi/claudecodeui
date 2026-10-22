---
id: AC-176
title: 常驻进程的 Remote Control 跨机器可达性被强制关闭，信任边界保持在同一 Unix 用户
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/providers/tests/claude-resident-remote-control-isolation.test.ts
expect: E9 9.7 没读到 flag settings 能否压过用户 settings（get_settings 无响应，本机也没有 Remote
  Control 后端可比对），所以本条走 proposal §9 的最保守分支，不依赖那条读数，也不把 flag settings
  当作已生效的证据。在一个临时配置目录里（CLAUDE_CONFIG_DIR 指向临时目录并读 /proc environ 核对，不得读写真实的
  ~/.claude/settings.json）：(1) 用户 settings 为
  remoteControlAtStartup=true、isolatePeerMachines=false，以常驻模式启动 ⇒
  启动被拒绝，错误码可辨，界面文案说明原因（Remote Control 已开启，以 bypass 运行的常驻进程会被跨机器驱动），mock
  端点与进程表都读到没有 claude 进程被拉起，宿主快照里没有以 bypass 运行的常驻宿主；(2) 用户 settings 不含
  remoteControlAtStartup 或为 false ⇒ 启动成功，传给 SDK 的 flag settings 含
  remoteControlAtStartup=false 与
  isolatePeerMachines=true（纵深防御，仍传），宿主快照记录的是请求值与检测到的用户 settings 值，字段不叫生效值，因为 E9
  读不到生效值。本条只检测用户级 settings，项目级、本地级与托管级 settings 未读数，作为已知缺口留给后续判据。取假形态：(a)
  检测到开启仍照常启动 ⇒ (1) 必须红；(b) 启动时不传两项 flag settings ⇒ (2) 必须红；(c) 把请求值当作生效值写进快照 ⇒
  (2) 必须红。命令逐字含文件路径，不用 glob。
origin: 2026-09-25 人 yale 裁定：按对 claude 2.1.282 二进制的静态分析与 sdk.d.ts 核对修订方案。用户
  settings 若开了 remoteControlAtStartup，常驻且 bypass 的进程会被桥接到 Anthropic 后端，其他机器上的
  peer 也能驱动它，信任边界超出 proposal §9 写的同一 Unix 用户 ｜2026-09-27 人 yale 指令：按 proposal 阶段
  0 结论（E1–E9，记录文件 docs/proposals/claude-resident-sessions-experiments.md）修订判据；E9
  未读到 flag settings 的覆盖读数，判据改为检测到即拒绝启动，快照只记请求值与检测值
activatedAt: 2026-09-27T05:12:07.055Z
statusLog:
  - at: 2026-09-27T05:12:07.055Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 2026-09-27 指令：判据已按 E1–E9 结论修订，转 active
  - at: 2026-09-27T12:54:54.572Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T05:12:07.055Z
---
