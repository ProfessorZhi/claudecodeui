---
id: gap-asr-trim-capability-node-alias-unresolved
title: 恢复 AC-135 判据：纯 node 下解析不到 voiceTrim 的 @/shared 别名
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-135
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：本仓无在飞任务声明 `goal_ac: AC-135`（两条声明它的任务 `gap-asr-trim-capability-wiring`、`gap-asr-omni-paired-quality-record` 均已 `done`；done 不是重复项，是「早先修复已失效」的证据）。同一根因（`d809d5b0` 让出货模块经 `@/` 别名导入、纯 node 解析不到）另有两个姊妹任务，但机制落点不同：`gap-voice-trim-node-alias-unresolved`（AC-117，`ready`）修 `experiments/voice-trim/run-savings.mjs`，`gap-voice-trim-quality-node-alias-unresolved`（AC-118，`done`）修 `experiments/voice-trim/run-quality.mjs`；本任务修第三条判据工装 `scripts/asr-trim-capability-check.mjs`。三条工装各修各的、不共享文件、互不依赖。

**现场（本轮直接现测，非台账尾）。** 判据命令 `node scripts/asr-trim-capability-check.mjs` 在仓库上退出 **1**：

```
$ node scripts/asr-trim-capability-check.mjs
check probe: FAIL Cannot find package '@/shared' imported from /data/home/yale/work/claudecodeui/src/shared/voiceTrim.ts
$ echo $?
1
```

台账佐证：AC-135 最后一次 pass 是 2026-10-04T00:46:31Z（criterionHash `288c7dc1bc6b0d5d`），其后 2026-10-04T04:40:46Z 起转 fail，失败原因逐字就是上面这行。

**机制（不是「判据过期」，是出货模块的导入方式变了）。** 2026-10-04 09:20 CST 合入 develop 的 `d809d5b0`（`voice-endpoint: extract the frame decision + streaming segmenter from voiceTrim`）把帧判决/流式分段从 `src/shared/voiceTrim.ts` 抽到新模块 `src/shared/voiceEndpoint.ts`，并把 `voiceTrim.ts` 改成经前端源码根别名导入：`import { FRAME_MS, ... } from '@/shared/voiceEndpoint'`。`@/` 由 tsconfig(tsc) / vite / vitest / oxlint 四处解析，**纯 `node` 进程不解析它**。`d809d5b0` 之前 `voiceTrim.ts` 零导入（自包含），判据探针用 `await import(fileURL)` 直接吃下它；现在探针在该静态导入处直接 module-not-found，整个 `run()` 被 main 的 catch 吞成一行 `check probe: FAIL`，六条真检查一条都没跑到。

**上一个修复为什么没顶住。** `gap-asr-trim-capability-wiring`（done，goal_ac: AC-135）把判据建立在「自包含的 `voiceTrim.ts`」之上；其后 `gap-voice-streaming-vad-endpointing`（done）做了这次抽取并改走别名，没有回头跑这条**纯 node** 判据（现有的 `scripts/asr-trim-capability-check.test.mjs` 也不在它的 Touches 内）。

**修（用仓库既有先例，不发明）。** 仓库里纯 node 解析 `@/` 的既有手法有两处：`experiments/voice-vad/run.mjs`（`registerHooks`）与 `scripts/voice-vad-harness.test.mjs`（`registerHooks`，注释写明这是「留给工具链够不到的那一处」的同一映射）。对判据工装 `scripts/asr-trim-capability-check.mjs`：

1. `import { registerHooks } from 'node:module'`，注册 `@/X` → `<root>/src/X.ts` 的 resolve hook。**根必须用 `run(root)` 解析出的 `--root`**（探针按设计要读「不是本仓的」夹具树，见文件头），不能用脚本自身的仓库根。
2. ESM 在模块体执行前解析该模块的全部静态 specifier，所以 hook 必须早于**动态**导入才生效：`importModule()` 里的 `await import(url)` 本就是动态的，把 `registerHooks(...)` 注册在 `run()` 最前面（或 `importModule()` 首次调用前）即可，无需改导入方式。
3. `scripts/asr-trim-capability-check.test.mjs` 的 `SHIPPING_FILES` 增补 `src/shared/voiceEndpoint.ts`：夹具现在必须带上 `voiceTrim.ts` 新引入的传递依赖，否则夹具里 `@/shared/voiceEndpoint` 解析到不存在的文件、`greenFixture` 在 `check probe` 处以 ENOENT 红，所有变异用例的前提被击穿。

**本轮已现测可行性（三点）。** (a) 用一个解析 `@/` 的加载器跑真树：`node --import tsx scripts/asr-trim-capability-check.mjs` 退出 **0**，六条检查逐条 `ok`（declaration/read-point/single-source/decision/default/discipline）——即唯一缺陷就是别名解析。(b) 用一个 `registerHooks` 探针 shim（`SRC_ROOT` 指向真树 `src/`）跑同一条命令，同样退出 **0**。(c) 按 `SHIPPING_FILES` + `voiceEndpoint.ts` 搭夹具：带 `voiceEndpoint.ts` 退出 **0**；从中删掉 `voiceEndpoint.ts` 则退出 **1**、红在 `check probe: FAIL ENOENT .../src/shared/voiceEndpoint.ts`。故修法可行，且「加 hook」与「加夹具文件」两半都承重。

**边界（不做）。** 判据命令文本固定（`node scripts/asr-trim-capability-check.mjs`），不得改判据绕；出货模块 `src/shared/voiceTrim.ts` / `src/shared/voiceEndpoint.ts` 保持经 `@/` 别名导入、**只读不改**（`@/shared/*` 是本仓 `src/shared/` 内互相导入的既有约定，改相对导入是逆约定的孤例）；不改窄任何一条既有检查（尤其 `single-source` / `discipline` / `default`）；不碰 AC-117/AC-118 的两个 harness；不碰 `scripts/asr-pause-cues-source-check.*`（已核：它只文本读 `voiceTrim.ts`、不 import，7/7 仍绿）；不改路由与 UI。

## AC

- [x] AC1 判据转绿（纯 node，无加载器）：`node scripts/asr-trim-capability-check.mjs` 退出码 **0**，stdout 含六行 `check declaration: ok` / `check read-point: ok` / `check single-source: ok` / `check decision: ok` / `check default: ok` / `check discipline: ok`；stdout 不含 `check probe: FAIL`，且对 `Cannot find package '@/shared'` grep 无命中（grep exit 1）。
- [x] AC2 取假控制全绿：`node --test scripts/asr-trim-capability-check.test.mjs` 退出码 **0**，全部用例 `pass`、`fail 0`，其中 `green fixture` 与 `the shipped tree decides 裁不裁 ...` 均通过——夹具能解析 `voiceTrim.ts` 的新传递导入 `voiceEndpoint.ts`。
- [x] AC3 夹具增补承重（负控制）：删除夹具里的 `src/shared/voiceEndpoint.ts` 后，探针在 `check probe` 处以 `ENOENT` 红（退出 1），而不是红在别的检查——证明 `SHIPPING_FILES` 的增补是承重的、非装饰。（新增为 `scripts/asr-trim-capability-check.test.mjs` 内一条独立可红用例：先证带该文件的夹具为绿、再证删掉为红。）
- [x] AC4 两条 AC-135 取假形态未被改窄：(a) 把出货默认改成「不裁」⇒ `check default: FAIL`（既有用例 `changing the declared default to "do not trim" reds default` 与 `reordering the registry ... reds default` 仍通过）；(b) 消费方自行判断而不读能力 ⇒ `check single-source: FAIL`（既有用例 `a consumer that keeps deciding 裁不裁 for itself ...` 与 `... answers 裁不裁 by hand beside the read point ...` 仍通过）。以 `git diff` 证明这些既有检查的断言面一字未动。
- [x] AC5 出货模块与判据命令不变：本任务分支的 `git diff --name-only <merge-base>...HEAD` 只含 `scripts/asr-trim-capability-check.mjs`、`scripts/asr-trim-capability-check.test.mjs`（及本任务文件）；不含 `src/shared/voiceTrim.ts`、`src/shared/voiceEndpoint.ts`；读 `goals/AC-135-*.md` 确认 `criterion:` 行仍是 `node scripts/asr-trim-capability-check.mjs`。
- [x] AC6 相邻判据未被牵连：`node scripts/asr-pause-cues-source-check.mjs` 退出 0，且 `node --test scripts/asr-pause-cues-source-check.test.mjs` 退出 0（7/7），证明修法未改变它们的读数。

## DoD

真实落地判据：不是「加了一个 registerHooks 块」，而是**判据命令以驱动跑它的同一种方式（纯 `node`，无 tsx、无 NODE_OPTIONS 加载器）在出货树上退出 0，六条真检查逐条跑到并 `ok`**，且取假控制（`node --test`）与 AC-135 的两条取假形态都仍能红。承重性由三组读数证明：

(a) 真树 judge 转绿：AC1 的六行 `ok` + 退出 0，且 `Cannot find package '@/shared'` 在 stdout 零命中；
(b) 夹具面跟着活：AC2 的 `greenFixture`（带 `voiceEndpoint.ts`）绿、AC3 删掉它则红——两臂都现测，证明增补是承重的；
(c) 取假形态未变哑：AC4 的两条既有用例仍红（默认改「不裁」⇒ `default` 红；自行判断 ⇒ `single-source` 红）。

**本任务不证明**「裁不裁」的能力语义（`pauseCues`）本身正确——那由 AC-119 的浏览器配对判据与各 provider 的配对实验承担；本任务只恢复「以能力声明为唯一来源且默认不变」这条机检，使其在出货树的纯 node 进程下重新可测。

L_D 该轴仍暗，理由：本任务只恢复一条既有判据的解析路径，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上；目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担。

## Touches

- scripts/asr-trim-capability-check.mjs
- scripts/asr-trim-capability-check.test.mjs
- tasks/gap-asr-trim-capability-node-alias-unresolved.md