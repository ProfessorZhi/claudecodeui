---
id: gap-debug-agent-no-second-vocabulary-guard
title: 调试 Agent 的禁止第二套词表静态守卫：源码内无帧/事件字面量且确 import 归一化入口，守卫须可判真伪
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-debug-agent-engine-and-scenario-ops
goal_ac: AC-126
---
## Proposal

**交付物：一条静态守卫测试，把「调试模块只构造方言行、帧只能来自真实归一化」这件事锁住。** 据 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md` 决策 7（评审通过）实现。

**为什么这是一条判据而不是一句约定。** 决策 4 要求调试 Agent 写真实形态的 transcript、且行→帧的转换交给真实归一化；**决策 7 是它的静态守卫**——因为调试模块只被允许**构造方言行**，它不需要、也不允许知道任何帧字段名。一旦调试模块里出现事件字面量，就意味着有人在那里手搓帧，那一刻"调试 Agent 走的是同一条链路"这句话就不再成立，而用调试 Agent 观察到的行为也就不再是关于产品的证据。

**守卫的两半，锁在同一份耦合表里。**

1. **源码范围内不存在帧/事件字面量**——至少覆盖 `stream_delta`、`stream_end`、`complete`、`session_upserted`、`permission_request`、`permission_resolved`、`permission_cancelled`、`session_created`、`history_truncated`、`task_notification`、`tool_use`、`tool_result`、`thinking`，以及 `kind:` 的取值字面量。
2. **该模块确实 import 了归一化入口**——`normalizeMessage` 或 `createNormalizedMessage`。只断言第 1 半是不够的：一个什么都不产出的模块也能通过第 1 半。

这两半合起来才是耦合表：**调试模块 → 归一化入口 → runtime → 客户端**，任何一环被绕过，守卫就红。

**守卫必须可判真伪（本任务的承重约束）。** 一条永远绿的守卫不是判据。取假形态——在调试模块里手写一个 `stream_delta` 字面量——**必须让它红**。这一点已在现场实测过一次：真实实现路径零命中，而 frames-only 取假变体恰好因 `kind: 'text'` 字面量被抓住（即假实现触发守卫、真实现不触发），见 `adr/ADR-003-验证记录.md` 的决策 7 一行。

**第 2 半的判法要写对。** 「import 了归一化入口」不能退化成「文件里出现过 `normalizeMessage` 这个词」——注释里提到它也算命中。守卫必须对**真实的 import 语句**断言，否则它会因为一句注释而恒绿。

**本任务不做**：不实现引擎；不改归一化实现；不给调试模块增加任何能力。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「静态守卫 / 词表 / 源码扫描测试」检索无命中。相邻但机制不同的是 `gap-scripts-static-gates-and-mint-token`（脚本类静态门禁），它扫的是脚本目录的运行前提，与"模块不得持有帧词表"不是同一机制。

## Plan

1. 守卫扫描的范围是**调试模块目录**，不扫全仓（扫全仓会把归一化实现自己也算进去，那正是词表的合法持有者）。
2. 第 1 半用词表逐项匹配源码文本；命中时**逐条打印文件与行**，使红因可读。
3. 第 2 半解析 **import 语句**（而非全文出现），并断言被 import 的符号名在该模块内被使用过。
4. 守卫自己**不得**把这些字面量以会自我命中的方式写进被扫描的目录——词表放在守卫文件里，而守卫文件不在扫描范围内（或显式排除自身）。
5. 取假变体用 `git checkout --` 还原，不得留下痕迹。

## AC

- [x] AC1 守卫判据——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts` 退出码 0。该用例即 `goals/AC-126`：断言 (1) 调试模块源码范围内不出现 Proposal 列出的每一类字面量；(2) 该模块存在指向归一化入口的**真实 import 语句**且该符号被使用。命中时逐条打印文件与行号。
- [x] AC2 抗假变体（**真跑并留输出**）：在调试模块里手写一个 `stream_delta` 字面量 ⇒ `AC1` 的命令必须**退出码非 0**，且输出里能看到命中的文件与行。再用 `git checkout --` 还原，`git status` 干净，并贴两次输出。**这是本任务的核心**：守卫若在这个变体下仍绿，它测的就不是它声称要测的东西。
- [x] AC3 第 2 半可判真伪：删除调试模块对归一化入口的 import（或改成只在注释里提到）⇒ `AC1` 的命令必须**退出码非 0**。取假形态：若第 2 半写成"全文出现 `normalizeMessage` 即通过"，本 AC 必须红——它证明第 2 半没有退化成注释命中。
- [x] AC4 守卫不得自命中、也不得漏扫：命令打印被扫描的文件清单与词表长度，并断言守卫自身不在清单内。取假形态：把守卫文件放进被扫描目录时，本判据必须红（否则词表会被自己的词表命中而恒红，或被迫写歪词表从而恒绿）。
- [x] AC5 本任务未触及 Touches 之外的文件。命令：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到 Touches 内的一条；命中之外时逐行打印并以非 0 退出。

## DoD

真实落地判据（不是「有一个测试文件在扫字符串」）：**这条守卫星必须能抓住一次真实的手搓帧，也必须被一次真实的绕过抓住。** 承重性由三件事正面证明：

(a) **取假变体真跑过并变红**（AC2），即守卫对"手写一个帧字面量"有鉴别力；
(b) **第 2 半同样可判真伪**（AC3）——只断言"不出现词表"的守卫会被一个什么都不产出的模块通过，第 2 半是它的补集；
(c) **守卫自身不自命中也不漏扫**（AC4），否则它要么恒红要么恒绿。

另需如实登记：本守卫覆盖的是**字面量**层面的词表，它挡不住"用变量拼出帧名"这类刻意绕过——那是本判据的已知上界，不得声称它可以替代决策 4 的行为判据（产出是否落盘、实时与历史是否一致由引擎任务断言）。

**落地时如实登记的一处收窄（第 2 半的两种形态）。** 第 2 半实际实现接受两种**真实 import 语句**形态：(a) 直接绑定入口并在文件内被使用（`import { createNormalizedMessage } from '@/shared/utils.js'`）；(b) 经 shared 契约命名该入口（`import type { IProviderSessions } from '@/shared/interfaces.js'` + `IProviderSessions['normalizeMessage']`）。引擎采用 (b)：本仓不存在可导入的 `normalizeMessage` 值（该名字是 `IProviderSessions` 的方法签名，没有独立导出），而运行时直接使用 `createNormalizedMessage` 必然要写一个 `kind:` 字面量、与第 1 半相斥；因此把三处内联签名收敛为共享契约类型 `IProviderSessions['normalizeMessage']` 才是真实且承重的耦合边——入口签名一变，这些缝合点就不再编译。注释命中与未使用 import 在两种形态下都仍然红（AC3 已实测）。

**AC2 取假变体顺带查出的一处守卫缺陷（已修）**：(a) 取假运行时，守卫报出的行号是 13 而实际写入行是 35——守卫的行号计数器不跨块注释累加（`blank()` 保留了换行符，但计数器没跟着加），于是任何位于块注释之后的字面量都会报错行号。已改为从注释剥离后的同一份文本按偏移量求行号（`lineAt(code, literal.start)`），两处共用同一份数据，不再有第二套行号来源。这正是"取假变体必须真跑"的价值：只跑通过路径时，这个缺陷不可见。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制的一条静态守卫，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC2/AC3 两次真跑的变体承担。
L_G 本目标的判据是 `goals/AC-126`（调试模块源码内不存在帧/事件字面量，且该守卫可判真伪），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体。

## Touches

- server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts (new)
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/debug-agent.runtime.ts
- tasks/gap-debug-agent-no-second-vocabulary-guard.md