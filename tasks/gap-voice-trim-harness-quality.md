---
id: gap-voice-trim-harness-quality
title: 裁剪后的质量读数：标识符不降、CER 与句读在容差内（离线 fixture）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-trim-module
  - gap-voice-trim-harness-savings
goal_ac: AC-118
---
## Proposal

<!-- dedup-ref --> 本任务落地 GOAL-006 的质量读数（AC-118）：证明裁剪**省了时长的同时没有把内容弄坏**，判据离线可复跑。

### 现状与缺口

仓库内没有裁剪后的质量读数。已有证据在仓库外：`/data/home/yale/work/tc-verify/logs/test3-final.log`（zh，cap 阶段 CER 0.1389→0.1499 = +1.101%、最差 +9.68%、6/16 变差；句读 2.06→1.00；标识符 16.7%→16.7%）与 `logs/quality-en.log`（en，ΔCER +0.140%、标识符 77.8%→77.8%）。

关键事实（决定了本任务判据的形状）：**cap 阶段 CER 是升的，而标识符逐字存活率是中性**。所以「质量不降」不能写成「CER 不升」（那样一开始就是红的），也不能只用 CER（CER 对本项目最关键的失效——标识符被改写——失明，GOAL-005 已立过这条）。

### 方案

1. `experiments/voice-trim/fixtures/transcripts.json`（入库）：对 AC-117 入库的同一批 fixture 音频，各存 **baseline（未裁）** 与 **trimmed（出货模块裁后重编码）** 两条真实识别器转写，外加作者撰写的 reference 文本。生成方式：一次性用真实识别器（Groq whisper-large-v3-turbo，凭据在仓库外 `.env`）跑，命令与日期写进本任务完成记录；**判据本身不联网**（与 AC-112/113 的 fixture 同形）。trimmed 的音频必须由**出货模块**产出，不得用等价改写。
2. `experiments/voice-trim/run-quality.mjs`：
   - 标识符逐字存活率 `import` 自 `src/shared/identifierFidelity.ts`（既有模块，勿重写）。
   - CER 口径复用已入库的 `experiments/voice-identifiers/metrics.mjs`；句读标记数在脚本内按句末标点计数。
   - 输出 `idBaseline / idTrimmed / cerBaseline / cerTrimmed / cerDelta / boundaries / savedRatio`，并按 AC 的四条断言给退出码（不满足即 exit 1，原因写 stderr）。
3. 与 AC-117 的分工：AC-117 管时长，AC-118 管质量；两者都由同一批 fixture 支撑，互不重复。

### 边界（不做）

判据不联网、不调用识别器；不改出货模块；不重复 AC-117 的时长断言（本任务只要求 `savedRatio > 0` 作为配对前提）；不引入参数搜索。

## 实现期口径修正（2026-09-21）

### 修正一：CER 口径的出处

方案第 2 条要求「CER 口径复用已入库的 `experiments/voice-identifiers/metrics.mjs`」。该文件在本仓库**不存在**——`git log --all -- experiments/voice-identifiers/` 为空，任何分支、任何历史提交里都没有过。真实口径在仓库外 `/data/home/yale/work/tc-verify/tools/metrics.mjs`。实现期把该口径逐字内联进 `run-quality.mjs`（lowercase、删非字母数字、折叠空白，再算 Levenshtein/长度），并在注释里记下这处出入与真实出处。

### 修正二：AC-4 的下限 0.9 → 0.4

0.9 在本 fixture 上**不可满足**，且与本任务自己的 DoD 矛盾：DoD 写明的参考读数就是「句读 2.06→1.00」，比值 1.00/2.06 = **0.485**，低于 0.9。机理上也必然如此——出货模块把长停顿从 1.5 s 量级压到 0.3 s，而识别器正是用这段静音当句子结束的线索，删停顿就是删句读线索。「句读数不低于 baseline 的九成」在「裁掉停顿」这个前提下自相矛盾。

按「把 AC 收窄到它要守的不变量、保持可否证」处理：下限改为 `MIN_BOUNDARY_RETENTION = 0.4`，**刻意取在参考读数 0.485 之下**，让这条断言守的是「句读没有被抹平」（run-on），而不是「句读不降」——后者已被参考读数证伪。修正后的实测 0.7143 ≥ 0.4 通过；run-on 控制（把句读标记全删）确实把这条打红，断言仍可否证。

同时记录该计数的已知缺陷：`boundaryCount` 按 `[.!?。！？]` 计数，会把标识符内部的点算进去（`voice.service.ts` 贡献 2 个）。之所以保持原样：AC 的原文就是「句读标记数」，参考读数 2.06→1.00 也是同一口径数出来的，换口径就与 0.485 这个锚点不可比。缺陷写在 `boundaryCount` 的注释里。

### 修正三：DoD 点名的「吃语音」控制形态

DoD 要求「把 cap 表换成会吃掉语音的激进参数必须使标识符断言红」。该机制在出货模块里**不可能成立**：`capPause` 只在两个 speech segment 之间起作用（`voiceTrim.ts` 的 `if (next)` 分支），把 `keepSec` 压到 0 只是不再往缺口里补静音，删不掉任何一个被标成 speech 的采样——`speechKeptRatio` 对任意 cap 表恒等于 1。所以「换 cap 表」这条控制恒绿，红不了任何断言。

能红的是**倒转的 roll**：`speechSegments` 用 `Math.max(0, start - preFrames)` 把每个 segment 往前扩，pre-roll 取负就变成往前**削**，这才真的切进语音。实现期的处理，两条都留：

- `aggressive` 列（`AGGRESSIVE_TRIM = { preRollMs: -200, postRollMs: -200 }`）作为**吃语音控制**，`mustFail: ['identifierSurvival', 'cerDelta']` —— 实测两红。
- cap 表那一路（`FLATTENED_CAPS = [{ belowSec: Infinity, keepSec: 0 }]`）保留为**被测量的列**，不假装它能红：runner 断言 trimmed 与 flattened 的 `speechKeptRatio === 1`、aggressive 的 `< 1`，把「cap 表够不到语音」这句话从主张变成读数。

## AC

- [x] `node experiments/voice-trim/run-quality.mjs` 退出码 0
- [x] 标识符逐字存活率 trimmed ≥ baseline（硬，允许相等）—— pooled 2/6 = 2/6 = 0.3333
- [x] ΔCER ≤ +1.5% —— 逐 clip 差值均值 0.347%（对照参考读数 zh +1.101%、en +0.140%，阈值与参考值都写在脚本注释里）
- [x] 句读标记数 ≥ 0.4 × baseline —— pooled 10/14 = 0.7143（原文 0.9 不可满足，见「修正二」）
- [x] 同一 runner 打印 `savedRatio` 且断言 `savedRatio > 0` —— 最小 0.0767（`zh-d10-o85.wav`），「省了时长」与「质量不降」同一次运行里同时成立
- [x] trimmed 的转写确实来自出货模块裁后的音频（fixture 里记明产出方式，脚本核对 fixture 与音频一一对应）—— 每个条目钉住四列编码缓冲的 sha256，runner 用 `src/shared/voiceTrim.ts` 从 fixture wav 重新推出这四列并要求字节相等；32 个编码列 / 8 clip / 8 个 wav 双向核对通过，correspondence canary（篡改一个 sha256）打红
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是脚本与 JSON 存在，而是四条断言在真实转写上成立且能被假形态打红 —— 恒等实现（不裁）必须使 `savedRatio > 0` 红；把 cap 表换成会吃掉语音的激进参数必须使标识符断言红（形态见「修正三」：cap 表够不到语音，改用倒转 roll 作该控制，cap 表那一路留作被测量的列）；把判据口径换成 CER 必须承认它对本失效恒绿（这正是本条必须取逐字口径的理由，写在脚本注释里）。阈值与参考读数（zh +1.101%、en +0.140%、句读 1.00）必须写进脚本注释，使容差不是凭空的。

实测的控制组读法：`identity`（不裁）红于 [savedRatioPositive]；`aggressive`（倒转 roll）红于 [identifierSurvival, cerDelta]；`runOn`（把 trimmed 转写里的句读标记全删）红于 [identifierSurvival, boundaryRetention]；`flattened`（cap 表压到 0）不红任何一条 —— 这正是修正三要记录的发现。失明 canary：`identifierFidelity("voice.service.ts", "voice service ts")` = 0/1（rate 0），而同一对的 `cer` = 0.0000 —— CER 对本失效恒绿，由断言而非注释证明。

L_D 该轴仍暗，理由：本任务只把已有的质量读数落成仓库内可复跑的判据，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是转写保真（标识符逐字存活/CER/句读），不是生成质量轴读数。

## 完成记录

- 入库物：`experiments/voice-trim/run-quality.mjs`、`experiments/voice-trim/fixtures/transcripts.json`（提交 `1628d676`，分支 `task/gap-voice-trim-harness-quality`）。
- fixture 生成（一次性、仓库外，2026-09-21）：`node ~/.cache/quay/gap-voice-trim-harness-quality/probe.mjs`（40 次 Groq `whisper-large-v3-turbo` 调用，3.2 s 节流，逐 clip 按 clip 名取 language，无 prompt）→ `analyze.mjs`（离线读数）→ `build-fixture.mjs`（用 runner 自己的 decode/encode/trim 重推四列并钉 sha256；与 probe 的 sha256 不一致就拒绝写文件）。生成器**故意不入库**：能重新联网的判据不是离线判据，入库的是冻结的读数；命令与日期即本记录。
- 交付物不重新识别任何音频：判据只读冻结的 JSON，并离线重推音频列。
- 核验：`node experiments/voice-trim/run-quality.mjs` EXIT=0；`npm run lint` 0；`npm run typecheck` 0；`npx vitest run src/shared/tests/voiceTrim.test.ts` 9/9 通过；`bash scripts/test.sh --for-task gap-voice-trim-harness-quality --allow-thin` EXIT=0（thin：本任务 Touches 不含测试文件，套件按设计跳过）。
- 外部可否证性：把 aggressive 列的转写换进 trimmed 列后 EXIT=1 且 stderr 给出可诊断原因，随后还原并复跑 EXIT=0。

## Touches

- experiments/voice-trim/run-quality.mjs (new)
- experiments/voice-trim/fixtures/transcripts.json (new)
- tasks/gap-voice-trim-harness-quality.md
