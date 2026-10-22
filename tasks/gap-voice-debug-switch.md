---
id: gap-voice-debug-switch
title: 裁剪链路的 console 读数开关（关=零输出、开=字段齐备）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-file-upload-input
goal_ac: AC-121
---
## Proposal

<!-- dedup-ref --> 本任务落地 AC-121：把裁剪链路的读数做成**开关控制的 console 输出**，使链路可观测、可验证，同时默认不打扰任何人。

### 现状与缺口

今天 `useVoiceInput.ts` 只有一条无条件打印的 `[voice] identifier fidelity` 读数（GOAL-005 / AC-114 的落地证据，人 yale 2026-09-21 定：**不纳入开关**）。裁剪链路（输入/输出时长、省下的秒数、VAD 段数、语音保留率、是否兜底）目前完全没有读数，无法在真实浏览器里观测与验证。

### 方案

1. `src/shared/voiceDebug.ts`：开关读取器 —— 启用条件为 URL 参数（`?voiceDebug=1`）**或** localStorage（`voice-debug=on`）；URL 命中时写回 localStorage，使刷新与 SPA 切换后仍生效。⛔ 不用 `import.meta.env.DEV` 单条件：构建产物里它为 false，而 e2e 需要可驱动。
2. `src/modules/chat/hooks/useVoiceInput.ts`：新增读数使用**独立前缀 `[voice:trim]`**，每次录音或上传**恰好一条**结构化对象，字段齐备：`source / inputSec / outputSec / savedSec / savedRatio / vadSegments / speechKeptRatio / fallback / identifiers.before.rate / identifiers.after.rate / repairHits`。既有的 `[voice] identifier fidelity` 保持无条件打印、原样不动。
3. `e2e/voice-trim.spec.ts`：抓 `page.on('console')`，断言 (a) 开关关闭时全程 0 条 `[voice:trim]`；(b) 开关打开时恰好一条且字段齐备。按**前缀**过滤判定，不按 `[voice]` 计数 —— 因为既有那条读数是有意无条件的。

### 边界（不做）

不改既有 `[voice] identifier fidelity` 读数的条件（GOAL-005 的 AC-114 证据链不动）；不把读数落盘/上报（只 console）；不做 UI 呈现；不改裁剪算法。

## AC

- [x] `npx playwright test e2e/voice-trim.spec.ts -g "AC-121"` 退出码 0
- [x] 开关关闭：一次完整录音→转写→填回全程 0 条 `[voice:trim]` 消息
- [x] 开关打开：每次录音或上传恰好一条 `[voice:trim]` 消息
- [x] 打开时字段齐备：source / inputSec / outputSec / savedSec / savedRatio / vadSegments / speechKeptRatio / fallback / identifiers.before.rate / identifiers.after.rate / repairHits
- [x] URL 参数命中后写回 localStorage（刷新或 SPA 切换后仍开）有断言
- [x] 既有 `[voice] identifier fidelity` 读数仍无条件打印
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是「设计上应该能观测」，而是 e2e 在同一次运行里同时证明**关=0 条**与**开=字段齐备**。承重性由取假形态证明：把读数改成无条件打印必须使「关=0 条」红；少写一个字段必须使「字段齐备」红。读数必须来自真实链路（真实录音或真实上传），不得由 spec 侧构造。

L_D 该轴仍暗，理由：本任务只加一组按开关输出的链路读数，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；读数里的 identifiers.* 是既有指标在裁剪前后的取值，不是新的生成质量轴读数。

## Touches

- src/shared/voiceDebug.ts
- src/modules/chat/hooks/useVoiceInput.ts
- e2e/voice-trim.spec.ts
- tasks/gap-voice-debug-switch.md


判据退役登记（2026-10-04，人 yale 授权，见 tasks/gap-voice-single-continuous-input-path.md 的 Resolution）：本任务全部判据（`npx playwright test e2e/voice-trim.spec.ts -g "AC-121"`，以及「关=0 条 [voice:trim] / 开=字段齐备」的逐项读数）随 AC-121 一同退役 —— [voice:trim] 读数已由 gap-voice-single-continuous-input-path 连同批处理裁剪路径一并移除（`grep -rn "voice:trim" src/` 计数 0），判据命令必然 No tests found，不得再把它的红读成本任务的回归。明示不再覆盖：连续路径不再打印逐段裁剪读数，观测改由 e2e/voice-continuous.spec.ts 的请求数与时长读数承担；链路的无条件读数仍由 [voice] identifier fidelity 提供，并被 e2e/voice-trim.spec.ts 的 AC-120 腿用作「文件走同一条转写链」的证据。