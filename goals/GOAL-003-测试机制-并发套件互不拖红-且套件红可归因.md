---
id: GOAL-003
title: 测试机制：并发套件互不拖红，且套件红可归因
status: achieved
kind: goal
origin: 落地复核 2026-09-20：两条任务的 worker 均 exit 0 跑满 5-7 分钟，却连续在 fan-in 的 suite
  步判红，而判红用的是每次都不相同的失败文件集合——任务级 AC 与 DoD 全绿，属性却仍然是假的。与 GOAL-002
  同形：目标级判据才能抓住这类缺口（人 yale 授权立此目标）。
activatedAt: 2026-09-20T14:45:43.635Z
statusLog:
  - at: 2026-09-20T14:45:43.635Z
    from: draft
    to: active
    actor: yale
    reason: 两条 AC 已立并全部实测为红（红先行）：AC-103 gate exit 127（checker 不存在），AC-104 gate exit
      127（checker 不存在）；并发劣化为实测而非推断（安静 0.7s → 并发 41.3s，26 倍）。人已授权激活。
  - at: 2026-09-20T16:16:05.645Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

loop 里每个任务的 worker 自己就要跑一次全量套件（它的 AC 判据之一），fan-in 阶段再跑一次；而 client 侧的 worker 池没有上限——vitest 的默认值取 os.availableParallelism()，本机是 128。于是两个 worker 并发时就有两个约 128 路的池 + 两组各 4 个 server 测试进程同时抢机器。

实测（同一份代码）：安静时服务端逐文件中位耗时 0.7s、Σ 153.6s；两个 worker 并发时中位升到 22.6s 与 41.3s、Σ 升到 3991.8s（26 倍）。由此产生 STACK_TRACE_ERROR、[vitest-worker]: Timeout calling fetch、以及 spawnSync ETIMEDOUT，而它们与真实断言失败在套件报告层同形，且每次失败的文件集合都不同——fan-in 因此判红，任务不翻 done。

## 范围

一是并发治理（client 池上限、全量套件单飞、负载准入）；二是失败归因（基建性红与真失败分开、无法归因的条目单独成段）；三是活性（挂死的套件被有界终结）。判据以 AC 的 checker 读数表达，不以配置里出现了哪些行为标志。

## 非目标

不改任何业务测试的断言；不放宽任何既有闸——不删测试、不缩 canonical glob（把测试删掉不叫变快）；不引入跨项目「一次只跑一个重测试」令牌（quay 已由人裁定整体删除该机制）；不设早杀 kill-on-red（quay 实测它把杀死时刻的在飞集合混进失败集，会伪造出「每轮浮出不同名单」的假象）。

## 退出条件

AC-104（归因 checker）、AC-105（挂死看门狗 checker）两条均 achieved，即判据由红转绿；或由人裁定放宽 / 取消其中任一条。AC-103（并发 checker）已于 2026-09-25 由人 yale 裁定取消（superseded），不再计入：claudecodeui 当前没有并发过订阅需求，该能力由 quay 的并发测试承担（见修订单 2026-09-25）。

## 决定记录（2026-09-20，人授权按建议执行）

**本轮不补单飞锁、不补负载闸**，理由是实测已经把它们的必要性推到未定：

1. client 池上限落地后，一次真实的**三并发**实跑（worktree 根）墙钟 8s，而**单套件**是 7.5s —— 3 并发 ≈ 1 个套件，几乎没有劣化；修复前是 26 倍。按实测并发峰值 in_flight=3 算，现在是 client 24 + server 12 ≈ 36 进程，在 128 核上**是欠订阅而非过订阅**。
2. quay 的单飞锁有两次已归档的事故：hold 看门狗「释放了槽位却没同步 lane 配额」⇒ 序列化变双倍超订；以及 600s 超时与 fan-in 900s 覆盖两个值压在同一把锁上 ⇒ 一条**正在跑的活套件**被 fail-closed 成「不启动」。
3. quay 曾有过更彻底的版本（跨项目「一次只跑一个重测试」令牌 heavy-op-token.sh），**人裁定整体删除**——串行化这条路 quay 走过并被否。
4. 负载闸能**拒绝启动**（exit 1 整套件不跑），而 quay 的阈值是为它自己 402-896s 的套件调的，本项目安静 Σ 仅 153.6s，照抄会误挡。

**改为先做的一件事**：把乘法从源头去掉——worker 自测改跑 scoped（--for-task <自身 id>），全量套件归 fan-in。该机制早已存在于 scripts/test.sh 且已有 7 条任务在用，不需要任何新机件、不引入新的停机面。

**补锁 / 补闸的触发条件（不得提前；2026-09-25 起 AC-103 已取消，此条不再有 checker 可触发，仅保留作历史）**：AC-103 的 checker 在**真实并发**下测出脏读数（签名计数非 0，或并发中位耗时显著高于安静基线）时才补。补时的纪律：照 quay 的**资源锁**语义抄（槽位可让、**无超时**、scoped 路径不取锁），⛔ 不要把它那两个已知缺口一起抄过来；负载闸**先跑 report-only**（不带 --for 时它只报不拦），等阈值在本项目自己的数据上钉死后再决定要不要让它拒。这符合 quay SPEC-suite-speed 的 AC3：**在分布数据出来之前，不许设任何阈值**。

## 修订单（2026-09-20）

本条 body 初稿把退出条件写成行内段落（无小节标题），被充分性判定读成「缺 退出条件 小节」，并立了 gap-goal-003-exit-conditions-section。**内容从未有缺口，缺的只是结构**——现按 GOAL-001/GOAL-002 的正身形状改为真小节。⚠️ 成因值得记：为规避「body 解析器吃掉行内小节字面量」那条已知坑，初稿**过度回避**了任何小节写法；那条告诫针对的是**在散文里提及**小节名，不是**真的写小节**。

## 修订单（2026-09-25）

人 yale 裁定取消 AC-103（superseded），并删除 scripts/suite-concurrency-check.sh。理由：其一，claudecodeui 当前没有并发过订阅的需求，这是 quay 并发能力的验证，属 quay 的测试；其二，该判据默认路径同时起 2 份完整 client 池加 2 份服务端读数、直接 npx vitest，压满 128 核，且被 goal 环每天评估 24-61 次，2026-09-25 主机 OOM 事故中是最大嫌疑（未证实）。本目标保留 AC-104 与 AC-105。内存治理的落点见 docs/operations/process-isolation-and-memory-caps.md。