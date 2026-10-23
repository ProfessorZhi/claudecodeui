---
id: gap-voice-trim-node-alias-unresolved
title: 恢复 AC-117 省时长判据：纯 node 下解析不到 voiceTrim 的 @/shared 别名
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-117
---
## Proposal

<!-- dedup-ref --> 本任务恢复 GOAL-006 的 AC-117 判据。AC-117 的判据是固定命令 `node experiments/voice-trim/run-savings.mjs`，本轮在 develop 上现测 exit 1：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/shared' imported from
  /data/home/yale/work/claudecodeui/src/shared/voiceTrim.ts
```

**机制（不是「判据过期」，是出货模块的导入方式变了）。** 2026-10-04 09:20 CST 合入 develop 的 `d809d5b0`（`voice-endpoint: extract the frame decision + streaming segmenter from voiceTrim`）把帧判决/流式分段从 `src/shared/voiceTrim.ts` 抽到新模块 `src/shared/voiceEndpoint.ts`，并把 `voiceTrim.ts` 改成经前端源码根别名导入：`import { ... } from '@/shared/voiceEndpoint'`。`@/` 由 tsconfig(tsc) / vite / vitest / oxlint 四处解析，**纯 `node` 进程不解析它** —— 于是 `node run-savings.mjs` 在其静态导入 `src/shared/voiceTrim.ts` 时直接 module-not-found，整条判据红。`d809d5b0` 之前 `voiceTrim.ts` 零导入（自包含），所以判据自 2026-09-22 起一直是绿的（最近三次 pass：gate-events 2026-10-03T17:36 / 20:45 / 23:50）。

**上一个修复为什么没顶住。** `gap-voice-trim-harness-savings`（done，goal_ac: AC-117）把 harness 建在「自包含的 voiceTrim.ts」之上；其后 `gap-voice-streaming-vad-endpointing`（done）做了这次抽取并改走别名，没有回头跑这条 node 判据。done 任务不是重复项，是「早先修复已失效」的证据。

**修（用仓库既有先例，不发明）。** 仓库里已经有两处纯 node 进程解析 `@/` 的同一手法：`experiments/voice-vad/run.mjs`（约 84–96 行：`registerHooks` + 动态 import）与 `scripts/voice-vad-harness.test.mjs`（约 40–51 行，注释写明这是「留给工具链够不到的那一处」的同一映射）。做法：

1. 在 `experiments/voice-trim/run-savings.mjs` 顶部 `import { registerHooks } from 'node:module'`，注册 `@/` → `<repo>/src/*.ts` 的 resolve hook。
2. ESM 在模块体执行前就完成该模块全部静态 specifier 的解析，所以 hook 必须早于**动态**导入才生效：把现有的 `import { PAUSE_CAPS, trimVoiceAudio } from '../../src/shared/voiceTrim.ts'` 改成 `const { PAUSE_CAPS, trimVoiceAudio } = await import('../../src/shared/voiceTrim.ts')`（顶层 await，`.mjs` 合法），置于 `registerHooks(...)` 之后。
3. `SRC_ROOT` 用 `new URL('../../src/', import.meta.url)`。注意 `experiments/voice-vad/run.mjs` 那里写成 `../src/`，解出的是不存在的 `experiments/src/`（在其通过的判据路径里没被走到，属潜伏 bug）；本任务别照抄这个深度。

**本轮已现测两点。** (a) 现测 `node experiments/voice-trim/run-savings.mjs` = exit 1，stderr 即上面的 ERR_MODULE_NOT_FOUND。(b) 用 `registerHooks` + 动态 import 真·出货模块 `src/shared/voiceTrim.ts` 的复现探针 = 成功（输出 `LOADED function true`），即修法可行。

**边界。** 判据命令文本固定（`node experiments/voice-trim/run-savings.mjs`），不得改判据绕；harness 仍必须 import 出货模块、不得自带算法副本 —— run-savings.mjs 末尾的 uniqueness 段必须继续零违规、三条 canary 继续触发。改动落在 harness 侧，出货模块 `src/shared/voiceTrim.ts` / `src/shared/voiceEndpoint.ts` 保持不动（只读）。同因的另一条判据 AC-118（`node experiments/voice-trim/run-quality.mjs`）导入同一模块、同样红；本任务只负责 AC-117。

## Touches

- experiments/voice-trim/run-savings.mjs
- scripts/voice-trim-harness.test.mjs (new)
- tasks/gap-voice-trim-node-alias-unresolved.md

## AC

- [x] 在 develop 上 `node experiments/voice-trim/run-savings.mjs` 退出码 0（不设 VOICE_TRIM_CORPUS，只压入库 fixture 的阈值）
- [x] 同命令 stderr 不含 `ERR_MODULE_NOT_FOUND` 与 `Cannot find package '@/shared'`（对 stderr grep 该串得 exit 1）
- [x] 该 runner stdout 仍打印每 clip 的 baselineSec/trimmedSec/savedRatio、aggregate savedRatio、speechKeptRatio、fallbacks，以及恒等实现正对照行（savedRatio = 0）
- [x] run-savings.mjs 末尾 uniqueness 段零违规且三条 canary 全部触发（exit 0 本身即要求 canary 触发；stdout 出现 `[uniqueness] ... file(s)` 统计行）
- [x] 回归守卫：`node --test scripts/voice-trim-harness.test.mjs` 退出码 0，该测试以子进程 `node experiments/voice-trim/run-savings.mjs` 断言 exit 0；移除 `@/` hook 后该守卫转红（负控制）

## DoD

真实落地，不是「测试存在」：修合入 develop 后，在 develop 工作树上直接现测 `node experiments/voice-trim/run-savings.mjs` 退出码 0 并打印完整读数（每 clip 行 + aggregate + 正对照行）；同时 `node --test scripts/voice-trim-harness.test.mjs` 绿，且其子进程在 hook 被移除的负控制下转红。出货模块 `src/shared/voiceTrim.ts` 保持经别名导入、不被本任务修改；harness 内无第二份算法（uniqueness 段绿即为机械证据）。
