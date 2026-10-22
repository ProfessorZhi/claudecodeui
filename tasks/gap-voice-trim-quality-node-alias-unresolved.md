---
id: gap-voice-trim-quality-node-alias-unresolved
title: 恢复 AC-118 质量判据：纯 node 下解析不到 voiceTrim 的 @/shared 别名
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-118
---
## Proposal

<!-- dedup-ref --> 本任务恢复 GOAL-006 的 AC-118 判据。AC-118 的判据是固定命令 `node experiments/voice-trim/run-quality.mjs`，本轮在仓库上现测 exit 非 0：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/shared' imported from
  /data/home/yale/work/claudecodeui/src/shared/voiceTrim.ts
```

### 机制（不是「判据过期」，是出货模块的导入方式变了）

2026-10-04 合入的 `d809d5b0`（voice-endpoint: extract the frame decision + streaming segmenter from voiceTrim）把帧判决/流式分段从 `src/shared/voiceTrim.ts` 抽到新模块 `src/shared/voiceEndpoint.ts`，并把 `voiceTrim.ts` 改成经前端源码根别名导入：`import { ... } from '@/shared/voiceEndpoint'`。`@/` 由 tsconfig(tsc) / vite / vitest / oxlint 四处解析，**纯 `node` 进程不解析它** —— 于是 `node run-quality.mjs` 在其静态导入 `src/shared/voiceTrim.ts` 时直接 module-not-found，整条判据红。`d809d5b0` 之前 `voiceTrim.ts` 零导入（自包含），判据自 2026-09-21 起一直绿（gate-events 最近一次 pass：2026-10-03T23:50:57，criterionHash 3fe20050ca5bbc7f）。

<!-- dedup-ref --> ### 上一个修复为什么没顶住

`gap-voice-trim-harness-quality`（done，goal_ac: AC-118）把质量读数建在「自包含的 voiceTrim.ts」之上；其后 `gap-voice-streaming-vad-endpointing`（done）做了这次抽取并改走别名，没有回头跑这条 node 判据。done 任务不是重复项，是「早先修复已失效」的证据。同因的姊妹判据 AC-117（`node experiments/voice-trim/run-savings.mjs`）同样红，已由在飞任务 `gap-voice-trim-node-alias-unresolved`（todo，goal_ac: AC-117）认领——本任务只负责 AC-118，两个 runner 各修各的、互不依赖。

### 修（用仓库既有先例，不发明）

仓库里纯 node 解析 `@/` 的既有手法有两处：`experiments/voice-vad/run.mjs`（约 84–96 行，`registerHooks`）与 `scripts/voice-vad-harness.test.mjs`（约 40–51 行）。做法：

1. 在 `experiments/voice-trim/run-quality.mjs` 顶部 `import { registerHooks } from 'node:module'`，注册 `@/` → `<repo>/src/*.ts` 的 resolve hook。
2. ESM 在模块体执行前就完成该模块全部**静态** specifier 的解析，所以 hook 必须早于**动态**导入才生效：把现有的 `import { identifierFidelity } from '../../src/shared/identifierFidelity.ts'` 与 `import { trimVoiceAudio } from '../../src/shared/voiceTrim.ts'` 改成顶层 `const { identifierFidelity } = await import('../../src/shared/identifierFidelity.ts')` / `const { trimVoiceAudio } = await import('../../src/shared/voiceTrim.ts')`（顶层 await，`.mjs` 合法），置于 `registerHooks(...)` 之后。
3. `SRC_ROOT` 用 `new URL('../../src/', import.meta.url)`。**注意**：`experiments/voice-vad/run.mjs` 那里写成 `../src/`，解出的是不存在的 `experiments/src/`（在其判据路径里没被走到，属潜伏 bug），别照抄这个深度；`run-quality.mjs` 在 `experiments/voice-trim/`，需要两级 `../../src/`。

本轮已现测：用 `registerHooks` + 动态 import 真·出货模块的复现探针 = 成功（hook 把 `@/shared/voiceEndpoint` 正确解析，`LOADED run-quality OK`），即修法可行。

### 边界（不做）

判据命令文本固定（`node experiments/voice-trim/run-quality.mjs`），不得改判据绕。harness 仍必须 import 出货模块、不得自带算法副本；run-quality.mjs 现有的全部自检（identity/aggressive/runOn/flattened 四条控制列、correspondence sha256 canary、blindness canary、`moduleSrc`/`fidelitySrc` 已读断言）必须逐条保留且继续触发。出货模块 `src/shared/voiceTrim.ts` / `src/shared/voiceEndpoint.ts` 保持不动（只读）。不重跑识别器、不联网、不改 fixture。

## AC

- [x] 在仓库上 `node experiments/voice-trim/run-quality.mjs` 退出码 0
- [x] 同命令 stderr 不含 `ERR_MODULE_NOT_FOUND` 与 `Cannot find package '@/shared'`（对 stderr grep 该串得 exit 1）
- [x] stdout 仍打印 `idBaseline/idTrimmed/cerBaseline/cerTrimmed/cerDelta/boundaries/savedRatio` 与最终 OK 行；`savedRatio > 0` 断言仍在（恒等实现正对照仍红于 [savedRatioPositive]）
- [x] 控制列 canary 全部触发：aggressive 红于 [identifierSurvival, cerDelta]、runOn 红于 [identifierSurvival, boundaryRetention]；correspondence 与 blindness canary 仍生效（exit 0 本身即要求 canary 触发）
- [x] 回归守卫：`node --test scripts/voice-trim-quality-harness.test.mjs` 退出码 0，该测试以子进程 `node experiments/voice-trim/run-quality.mjs` 断言 exit 0；同一测试的负控制（把 run-quality.mjs 同目录副本里的 registerHooks 块剥掉后运行）断言 exit ≠0 且 stderr 含 `@/shared`（负控制必须真的红，否则守卫是哑的）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地，不是「测试存在」：修合入后，在仓库工作树上直接现测 `node experiments/voice-trim/run-quality.mjs` 退出码 0 并打印完整读数（每 clip 行 + aggregate + 四条控制行 + 两条 canary 行）；同时 `node --test scripts/voice-trim-quality-harness.test.mjs` 绿，且其负控制（剥掉 hook 的副本）转红。出货模块 `src/shared/voiceTrim.ts` 保持经别名导入、不被本任务修改；harness 内无第二份算法。AC-118 的判据不只是「能跑出数」，而是「质量不降 + 省了时长同时成立」——`savedRatio > 0` 与四条断言必须同一次运行里同时绿。

L_D 该轴仍暗，理由：本任务只是恢复既有的质量读数判据，不新增领域数据能力。

L_G 该轴仍暗，理由：同上；本任务的读数是转写保真（标识符逐字存活/CER/句读），不是生成质量轴读数。

## Touches

- experiments/voice-trim/run-quality.mjs
- scripts/voice-trim-quality-harness.test.mjs (new)
- tasks/gap-voice-trim-quality-node-alias-unresolved.md