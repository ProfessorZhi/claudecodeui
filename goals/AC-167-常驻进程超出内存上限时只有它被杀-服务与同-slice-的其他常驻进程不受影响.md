---
id: AC-167
title: 常驻进程超出内存上限时只有它被杀，服务与同 slice 的其他常驻进程不受影响
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/session-hosts/tests/process-containment.test.ts
expect: E7 的真实模型观察窗只有 0.10 小时（峰值树 RSS 262532KB），远不到 24
  小时，所以本条不钉生产默认数值，只钉机制：单进程上限与 slice 总上限都来自配置、可被测试注入，生产默认值由另行的 24 小时浸泡确定，不在本条范围。经
  L3 包装（systemd-run --user --scope，--slice=cloudcli-resident.slice，-p
  MemoryMax=配置值，-p MemorySwapMax=0）在同一 slice 下起两个子进程，单进程上限注入一个测试用的小值：(1)
  包装命令行读到的 MemoryMax 等于注入的配置值，MemorySwapMax=0，slice 名符合预期；slice 总上限同样来自配置；(2)
  其一分配内存超过该上限 ⇒ 它被 OOM 杀死，宿主快照为 closeReason=exited、detail=oom；(3)
  另一个与测试进程本身存活；(4) 结束后无残留 scope，缺席读数带正对照（探针在 scope 存在时必须读到它），不以固定 sleep
  后的空读数当证据。没有 systemd user manager 时打印原因并 exit 3（未评估），不得读绿；本机有则必须真跑。L3 复用
  tasks/gap-claude-session-cgroup-scope 的 claude-session-scope 服务并推广为 provider
  中立，不另起一套。取假形态：(a) 包装退化为直接 spawn ⇒ 超限进程不被杀或殃及测试进程，(2)(3) 必须红；(b) 上限写死为常量而不读配置 ⇒
  (1) 必须红。命令逐字含文件路径，不用 glob。
origin: docs/proposals/claude-resident-sessions.md（e88175cf）。人 yale 2026-09-25
  裁定：拆成两个 goal，本 goal 为 GOAL-B「Claude 常驻」，暂不激活，等
  tasks/gap-claude-resident-phase0-experiments 把 E1–E8 结论写回 proposal 后再定 AC
  并激活；调试 agent 扩展出的常驻场景作 UI e2e 替身；不加 cloudcli 子命令 ｜2026-09-27 人 yale 指令：按
  proposal 阶段 0 结论（E1–E9，记录文件
  docs/proposals/claude-resident-sessions-experiments.md）修订判据；内存上限的生产数值待 24
  小时浸泡，本条只钉机制与配置可注入
activatedAt: 2026-09-27T05:00:22.827Z
statusLog:
  - at: 2026-09-27T05:00:22.827Z
    from: draft
    to: active
    actor: human:yale
    reason: 人 yale 2026-09-27 指令：判据已按 E1–E9 结论修订，转 active
  - at: 2026-09-27T16:01:28.467Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-09-27T05:00:22.827Z
---
