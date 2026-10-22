---
id: gap-asr-omni-prompt-frozen-snapshot
title: dashscope-omni 提示词冻结：适配器四段提示词、reasoning_effort 与默认模型与冻结实验快照 E 组逐字一致，快照
  C/E 各 8 条片段 × 每条 10 次读数同一 run 且可离线重算
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-137
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`tasks/` 全文检索 `dashscope-omni` / `prompt-frozen` / `提示词冻结` / `冻结快照` 无一命中本机制的未决任务；`grep -rn "^goal_ac:" tasks/*.md` 中 AC-137 零命中（相邻的 `tasks/gap-asr-webm-candidates-paired-quality-record.md` 是 AC-129..136 家族里已经完成的 webm 候选记录，它建立了冻结快照 + runner 离线的形状，本任务沿用其形状但换被测对象）。这一段只是可追溯性说明，不含任何任务 id 作为要求。

**现状（本任务立案时实测）**：GOAL-009 的证据来源已经入库（提交 `a298761e`，`experiments/voice-omni-written/raw/`），但**只到原始读数**，其 `raw/README.md` 明写「整理成冻结快照与 `docs/experiments/` 下的实验记录是后续任务的事（AC-137 读的是那份快照，不是这里）」。三个东西都还不存在：

| 缺什么 | 实测 |
|---|---|
| 适配器 `dashscope-omni` | `git ls-files shared/asr/list/` 只有 `multimodal/` 与 `openai-compatible/` |
| 冻结快照 | `experiments/voice-omni-written/` 下只有 `raw/`（`results.jsonl`、`written-ds.jsonl`、`written.jsonl`、`qwen-audio-bias/results.jsonl` 与生成脚本） |
| 判据脚本 | `ls scripts/ | grep omni` 为空 |

**冻结点上的三个数字（从 `raw/written-ds.jsonl` 数出来的，不是引用）**：`C-fewshot` 8 条片段 × 10 次 = 80 条，`E-twostep-low` 8 条片段 × 10 次 = 80 条，两组全部 `status: 200`（零失败）。E 组的提示词正文以 `raw/written.mts` 为准（该 README 的原话：**E 组提示词以这里为准**），即 `const ROLE` / `const RULES` / `const EXAMPLES` / `const JSON_TASK` 四个字面量，E 组 = `` `${ROLE}\n\n${RULES}\n\n${EXAMPLES}` `` + `user: JSON_TASK` + `effort: 'low'` + `model: 'qwen3.8-omni-flash'`。

**本任务做三件事（只做提示词冻结这一轴）：**

1. **冻结快照 + 离线重算**：新增 `experiments/voice-omni-written/freeze.mjs`，从**仓内** raw 读数（不联网、不计费）确定性地产出 `experiments/voice-omni-written/fixtures/snapshot.json`：
   - `groups.C` / `groups.E`：各 8 条片段，每条 10 条读数（原文 + 判定 + 延迟）；
   - `prompts`：E 组的 `ROLE` / `RULES` / `EXAMPLES` / `JSON_TASK` 全文，外加 `reasoning_effort: 'low'` 与 `model: 'qwen3.8-omni-flash'`；
   - `provenance`：**单一** `runId`（冻结这一次）挂在每一条读数上；`source.promptFile`（`experiments/voice-omni-written/raw/written.mts`）与 `source.readingsFile` 各自的 sha256；以及**如实登记**的 `sourceBatches`——C 与 E 的 10 次读数实际由两次 API 批次组成（reps 0–2 与 reps 3–9），冻结把它们记在 provenance 里而不是抹平。
   - `node experiments/voice-omni-written/freeze.mjs --check` 从 raw 重算并与已入库的快照逐字节比对 ⇒ 快照不是手写常量，是 raw 的确定性函数。
2. **出货侧的提示词常量**：新增 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`，导出 `ROLE`、`RULES`、`EXAMPLES`、`JSON_TASK`、`REASONING_EFFORT = 'low'`、`DEFAULT_MODEL = 'qwen3.8-omni-flash'`（以及 proposal §2 的 `PROMPT_VERSION = 'written-e-2026-09-24'`）。**本任务不实现 `transcribe`、不实现 `capabilities`、不注册进 `asrRegistry`** —— 线协议与解析降级是 AC-138 的范围，路由分派是 AC-139 的范围。
3. **判据脚本** `scripts/asr-omni-prompt-frozen-check.mjs` + `scripts/asr-omni-prompt-frozen-check.test.mjs`：
   - 用 `tsx/esm/api` 的 `register()` 让裸 `node` 能 import 树里的 `.ts`（`scripts/asr-second-adapter-check.mjs` 已建立的先例），**从出货模块**取六项，不复制正文进工装；
   - 六项各自逐字比较并打印两侧 sha256（`ROLE` / `RULES` / `EXAMPLES` / `JSON_TASK` / `REASONING_EFFORT` / `DEFAULT_MODEL`），不一致时打印 `MISMATCH <SEGMENT>` **指名是哪一段**；
   - 校验快照形状：C 与 E 各 8 条片段、每条 ≥10 次读数、全部读数同一个 `runId`；
   - `--root <dir>`：取假形态把工装指向一个由出货文件临时拼出的目录，所以三条「必须红」是**可执行的用例**而不是一段声明；
   - 空读数（未解析到适配器 / 快照无读数）打印 `EMPTY_READING` 并非零退出 —— 「没看」与「看了没问题」不得同形。

**为什么这样切**：AC-137 的全部内容就是「提示词与读数被冻结且任何改动会被机械发现」。所以被测对象是**出货模块导出的常量**（`docs/experiments/README.md` 协议第 3 条：不得在工装里放第二份实现），证据是**产生过 160 条读数的那个 E 组**，而冻结的来源 `raw/written.mts` 被 sha256 钉住 —— 三段链条（适配器 ≡ 快照 ≡ raw 源）各自有独立读数。

**边界（不做）**：不实现 chat-audio 线协议、JSON 解析与降级、错误映射（AC-138）；不改 `voice.service.ts` 的分派（AC-139）；不做 SSRF 白名单与用户配置（AC-140/141）；不做前端与浏览器端到端（AC-142）；不重新联网取数（冻结只从仓内 raw 重算）；不写 `docs/experiments/` 下的人读记录（GOAL-009 明示其文字质量不进判据）；不改 `package.json`（判据由 goal 直接 `node scripts/asr-omni-prompt-frozen-check.mjs` 调用）；不动 `raw/` 下的既有文件（它们是冻结的输入，只能读）。

## AC

- [x] AC1 判据入口与「空读数不是绿」：`node scripts/asr-omni-prompt-frozen-check.mjs` 退出 0，并打印六项（`ROLE`、`RULES`、`EXAMPLES`、`JSON_TASK`、`REASONING_EFFORT`、`DEFAULT_MODEL`）每项各自的 `ok` 与适配器/快照两侧 sha256；`node scripts/asr-omni-prompt-frozen-check.mjs --root <临时空目录>` 非零退出且输出含 `EMPTY_READING`（不得静默跳过）。
- [x] AC2 快照形状被机械校验：判据输出含 `C 8 clips x 10 readings`、`E 8 clips x 10 readings` 与唯一的 `runId=`；取假形态各非零退出并指名——`--control=low-rep`（E 组某片段只剩 9 条）报该片段 id，`--control=straddle`（把一条读数改成另一个 runId）报 `different runs`。
- [x] AC3 逐字比较会指名，且六段各有单段用例：`--control=prompt-mutated:ROLE`、`:=RULES`、`:=EXAMPLES`、`:=JSON_TASK`、`:=REASONING_EFFORT`、`:=DEFAULT_MODEL` 六个用例各非零退出并打印 `MISMATCH <SEGMENT>`（改 `reasoning_effort` 必须指名 `REASONING_EFFORT`，不得只报「提示词不一致」）；正向控制：未改动的树退出 0（否则「改一个字符必红」与「恒红」不可区分）。
- [x] AC4 快照缺失 ⇒ 红而不是跳过：`--control=no-snapshot`（快照文件不存在）与 `--control=empty-snapshot`（快照为 `{}`）各非零退出，且输出指名缺失的文件或缺哪几项；两者的退出码都不得是 0。
- [x] AC5 冻结可离线重算：`node experiments/voice-omni-written/freeze.mjs --check` 退出 0，打印 C/E 各 `8 x 10`、`runId`、`source.promptFile` 与 `source.readingsFile` 的 sha256，且不产生任何网络请求；`--root <staged 副本：snapshot.json 的 RULES 改一个字符>` 非零退出并指名 `RULES`；`--root <staged 副本：raw/written-ds.jsonl 少一条 C 组读数>` 非零退出并报该片段读数不足 10。
- [x] AC6 提示词来源被 sha256 钉住：`fixtures/snapshot.json` 的 `provenance.source.promptFile` 指向 `experiments/voice-omni-written/raw/written.mts` 并记录其 sha256；`freeze.mjs --check` 校验该 sha256 与文件当前内容一致；`--root <staged 副本：written.mts 里 E 组提示词改一个字符>` 非零退出并报 sha256 不符。
- [x] AC7 被测实现是出货模块且工装无第二副本：`--probe` 打印适配器绝对路径，断言它位于 `shared/asr/list/dashscope-omni/` 且文件存在；`grep -n "你是编码 agent 的语音指令整理器\|规则：" scripts/asr-omni-prompt-frozen-check.mjs scripts/asr-omni-prompt-frozen-check.test.mjs` 零命中（工装里没有提示词正文的第二份拷贝），而判据确实打印出了六项正文的 sha256（阳性对照：不是靠「什么都没比」过的）。
- [x] AC8 静态门：`npm run typecheck` 退出 0（`scripts/tsconfig.json` 以 `checkJs: true` 覆盖 `scripts/**/*.mjs`，新脚本要带 JSDoc 类型）且 `npm run lint` 退出 0。

## DoD

真实落地判据：不是「多了两份 json 与一个 md」，而是**出货适配器里那四段提示词、`reasoning_effort` 与默认模型，确确实实就是产生过 160 条冻结读数的那一份 E 组**，并且这件事由**执行**证明——六项各有一个能红的单段用例、快照的 ≥10/8 条/单一 run 形状各有一个能红的用例、三条「必须红」都是可执行的用例而不是段落文字。承重性由三件读数证明：

(a) **「没看」与「看了没问题」不同形**（AC1、AC4）：判据在空树、缺快照、空快照三种情况下都非零，且未改动时绿——一个恒定红或恒定绿的判据都过不了它自己的正向控制；
(b) **不一致会指名是哪一段**（AC3、AC7）：`MISMATCH <SEGMENT>` 与两侧 sha256 是判据自己的输出，读者不必再去 diff 文件；
(c) **快照不是手写常量**（AC5、AC6）：`freeze.mjs --check` 从仓内 raw 重算并逐字节比对，且 raw 侧的提示词源 `written.mts` 被 sha256 钉住——三段链条（适配器 ≡ 快照 ≡ raw 源）任一处改动都会红。

**必须如实登记**（写进 `snapshot.json` 的 `provenance` 与判据打印）：C 与 E 的 10 次读数由**两次 API 批次**组成（reps 0–2 与 reps 3–9），冻结把批次记在 provenance 里、`runId` 是冻结这一次，不假装成一次连续采样；8 条 TTS 合成中文片段；读数**不重跑**（联网且计费，按 ADR-004 决策 8 归人工），冻结只从仓内 raw 重算；质量数字不进判据集（ADR-004 决策 8），本任务只判「逐字一致 + 读数形状」；`qwen3.8-omni-flash` 是别名，服务端升级后效果可能漂移。

L_D 该轴仍暗，理由：本任务只冻结实验读数与提示词常量，不新增领域数据能力（无新的用户数据通路或数据结构）。
L_G 该轴仍暗，理由：目标层判据（口述经服务端代理产出书面指令并写入 composer）需要适配器线协议与 S4 路由分派，本任务不实现二者。

## Touches

- shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts (new)
- experiments/voice-omni-written/freeze.mjs (new)
- experiments/voice-omni-written/fixtures/snapshot.json (new)
- scripts/asr-omni-prompt-frozen-check.mjs (new)
- scripts/asr-omni-prompt-frozen-check.test.mjs (new)
- tasks/gap-asr-omni-prompt-frozen-snapshot.md
