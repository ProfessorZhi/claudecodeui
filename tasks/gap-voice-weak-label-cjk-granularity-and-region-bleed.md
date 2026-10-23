---
id: gap-voice-weak-label-cjk-granularity-and-region-bleed
title: 弱标注对齐粒度：汉字按字切词、段区间不吞掉段外文字、对发送前的任意编辑保持稳健（一句汉字不再整句算一个 replace）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：`gap-voice-send-diff-weak-labels`（已 done）引入了 `src/shared/voiceEditLabels.ts` 与发送钩子；本任务修的是它在**汉字**与**段区间**上的两个缺陷，不重做该机制。其余 `grep -il 'labelsFor\|voiceEditLabels' tasks/*.md` 命中的任务只是引用它。

### 现象（真实读数，2026-10-06 15:25，本机 `~/.cloudcli/voice-data/7e729db5…json`）

识别器（sensevoice-local）把「检查重启后是否有服务端的语音识别记录」听成 `检查了功启后，是否有服务端的语音识别？`（逐 token 置信度：`了` 0.56、`功` 0.35 正是错处）。用户把两次口述拼进同一个输入框，改完后发送，最终文本是 `语音输入测试。检查重启后是否有服务端的语音识别记录。`。写回的标签是：

```
heard = 检查了功启后，是否有服务端的语音识别？
final = 语音输入测试。检查重启后是否有服务端的语音识别记录。
op    = replace
```

应有的标签是「了功启 → 重启」这一处小修（外加句末漏掉的「记录」，见下面不做项）。实际得到的是整句对整句，并且 `final` 里混进了**另一次口述**的 `语音输入测试。`。阶段 0 读数报告据此得到 `changedChars=13`、`cjk-rendering=1`，把一次口述的微小修正算成了大改。

### 根因（读 `src/shared/voiceEditLabels.ts` 得出，两个独立缺陷）

1. **分词只按空白**：`tokenize` 是 `text.split(/\s+/)`。一句汉字没有空格，所以整句是 **1 个 token**。后果：①差异永远是「整句 ↔ 整句」，一处错字也变成整句 replace；②`MAX_CORRECTION_TOKENS = 3` 的预算对汉字永远不触发，**整句被改写成别的话也会标成 `replace` 而不是 `rewrite`**，把「用户说了别的」当成纠正喂给后面的学习。
2. **段区间向文本两端膨胀**：`alignRegion` 里「前后最近存活字符」在没有邻居时取哨兵值（`-1` / `textLength`），随后 `low = min(low, survivingBefore + 1)`、`high = max(high, survivingAfter - 1)` 会把区间一路拉到整段最终文本的开头或结尾。于是用户在口述前面/后面打的字、或同一输入框里另一次口述的文字，都被吞进这一段的 `final`。已有的「口述前后自己打字不产生标签」用例只在那段文字被空白隔开时成立，汉字紧挨着时不成立。

### 设计意图：编辑是常态，不是异常

用户提交前改文字是正常行为，最终文本与口述有差异不代表识别错了。标签必须据此保守：

- 只把**小而局部**的改动当作纠正（`replace`/`merge`/`split`/`delete`），超出预算的标成 `rewrite`（照常写出，但标明不是纠正，消费方必须跳过）。
- 用户**自己新打**的文字（口述之前、之后、两段之间）没有对应的口述词，不产生标签。
- 只差标点、全角半角、空白的差异不产生标签（`，`/`,`、`？`/`?`、句号有无）。
- 同一输入框里的**别的口述**不属于这一段，标签的 `final` 里不得出现它。

### 方案（执行者可在记录理由后调整，但不得放宽 AC）

- 分词：拉丁词与标识符沿用现有规则（空白、`-`、`_`、驼峰、`isIdentifierShaped`，与离线实验一致，已有用例不得变红）；**汉字（CJK 统一表意字等）每个字算一个 token**，汉字与拉丁交界处断开。`Intl.Segmenter('zh')` 实测会把「重启」切成 `重|启`、把听错的「功启」切成 `功|启`，对错字不稳定，不建议作为分词依据。
- **预算必须为汉字重新定义，不能照搬 3 个 token**：现有用例 `AC 零零二 → AC-002` 在汉字按字切之后是 4 个 token（`AC` + 三个汉字），照搬 `MAX_CORRECTION_TOKENS = 3` 会把这个既有的 `replace` 变成 `rewrite`。预算要分开算：拉丁词/标识符仍按 token 数（≤ 3）；汉字按字数，每侧不超过一个固定上限（建议 6 个汉字，取值以 AC 里钉死的用例为准：`AC 零零二 → AC-002` 与 `AC 一九零 → AC-190` 必须仍是纠正，`检查重启后是否有服务端的语音识别记录。 → 明天下午三点开会讨论发布计划安排。` 必须是 `rewrite`）。字符编辑比 `MAX_CORRECTION_EDIT_RATIO = 0.5` 照旧。
- 标签的可读性：一个 hunk 若只是单字对单字，可向两侧各带一个邻字作上下文，使 `heard → final` 读得懂（`了功启 → 重启` 而不是 `功 → 重`）；是否带上下文以 AC 里的长度上限为准。
- 区间：只取这一段自己被对齐到的字符范围；没有存活邻居时**不再**向文本端点膨胀。段内字符被用户删光的边缘情形仍须报 `delete`（现有行为）。

### 不做

不为「漏字」（识别器漏掉、用户补上的词，如本例的「记录」）产生标签：补上的词在现有规则里属于「没有口述词的新增」，与「用户自己新打的字」无法区分，需要额外信号（比如该处的低置信度或音频时间戳）才能判定，另立任务。不回算已写入 `voice-data` 的历史标签。不改写回接口、不改 `voice-data.ts`、不碰阶段 0 报告脚本（它读 `labels`，输入变准即可）。不引入新依赖。

## AC

- [x] `npx vitest run src/shared/tests/voiceEditLabels.test.ts` 退出码 0，且该文件新增下列用例（用例名含括号里的编号，便于假形态点名）。真实句子用上面「现象」里的原文：①（汉字小修）口述 `检查了功启后，是否有服务端的语音识别？`，最终文本只含该段修正后的 `检查重启后是否有服务端的语音识别记录。`，得到**恰好 1 条**标签，其 `heard` 含 `功`、`final` 含 `重`，且两边长度都 ≤ 6 个字符，`op` 不是 `rewrite`；②（不吞段外文字）同一口述，最终文本前面多了另一次口述 `语音输入测试。`、后面多了自己打的 `谢谢`，得到的任何标签的 `heard`/`final` 都不含 `语音输入测试` 与 `谢谢`；③（标点与全半角不算改）口述 `是否有服务端的语音识别？`，最终文本 `是否有服务端的语音识别?`（全角问号改半角）与 `是否有服务端的语音识别`（去掉问号），都得到 `[]`；④（汉字整句改写是 rewrite）口述 `检查重启后是否有服务端的语音识别记录。`，最终文本 `明天下午三点开会讨论发布计划安排。`，得到的标签 `op` 全是 `rewrite`，且没有任何 `replace`；同一用例内的对照：小修（①的输入）不是 `rewrite`；⑤（汉字拉丁混排）口述 `检查 key 的 AC 一九零`，最终文本 `检查 quay 的 AC-190`，得到 2 条标签（`key → quay`，`AC 一九零 → AC-190`，两条的 `op` 都不是 `rewrite`），任何标签的 `heard`/`final` 都不含 `检查` 或 `的`；⑥（两段只改第二段）两个口述段，最终文本只改第二段里的一个字，只产生 `segmentIndex` 为第二段的标签；两段之间用户自己插入的文字不产生标签；⑦（清空）最终文本为空，每个有字的段各得到 1 条 `delete`。
- [x] 既有用例不变红：同一文件里在本任务动手前已存在的全部用例（含 `key → quay`、`AC 零零二 → AC-002`（仍是 `replace`，不是 `rewrite`）、`quay fleet → quay-fleet`、口述前后自己打字不产生标签、整句改写是 `rewrite`、`isIdentifierShaped` 与离线实验的已知答案对照）在 `npx vitest run src/shared/tests/voiceEditLabels.test.ts` 里全部仍然通过；`git diff develop -- src/shared/tests/voiceEditLabels.test.ts` 里没有删除或放宽任何既有断言行（只允许新增行）。
- [x] 假形态（每条各自点名变红的用例，改回后恢复全绿，`git status --short` 干净）：把 `tokenize` 改回 `text.split(/\s+/).filter(...)`（汉字不再按字切）→ `npx vitest run src/shared/tests/voiceEditLabels.test.ts` 退出码非 0，变红的用例含①与④；把区间收缩改回「无邻居时取 `-1`/`textLength` 并向端点膨胀」→ 退出码非 0，变红的用例含②。两条读数（退出码与变红用例名）记入 `## Evidence`。
- [x] 真实应用（一次性 spec，读完即删、不入库）：用 e2e harness（真实 Chromium + 真实 server + 宿主机上的真 `sensevoice-local`，环境变量与 `SENSEVOICE_PYTHONPATH` 的写法沿用 `gap-voice-phase0-readout-report` 的 `## Evidence` AC6），在同一输入框里先口述一段、再口述一段，把第二段里**一处**字改对后发送，读 `voice-data` 里这次发送写回的记录：第二段的标签只含被改的那处词（`heard`/`final` 都 ≤ 6 个字符），任何标签都不含第一段的文字；把读数（两条记录的 `labels` 原文、操作次数）记入 `## Evidence`。
- [x] 阶段 0 读数报告不被带坏：`node --test scripts/voice-phase0-report.test.mjs` 退出码 0（本任务不改该脚本，这条证明新标签形状它仍能读，`forms.rewrites` 与 `forms.corrections` 的分流不变）。
- [x] `npm run typecheck`、`npm run lint` 退出码 0。

## DoD

真实落地判据：用户在真实应用里口述含错字的话、在输入框里改正后发送，`voice-data` 的标签只含被改的那几个字，不含同一输入框里别的口述或自己打的字；把整句改成别的话时标成 `rewrite` 而不是 `replace`。单元用例是必要但不充分——必须有上面的真实应用读数（真识别器、真浏览器）。

L_D 该轴仍暗，理由：不新增数据能力，只修标签的对齐精度。

L_G 该轴有读数：同一对（口述，最终文本）上，修前标签是整句对整句且混入段外文字，修后是单处小修；两者作为 `## Evidence` 的前后对照。

## Evidence

### AC1/AC2 —— 单元用例与「只加不删」

`npx vitest run src/shared/tests/voiceEditLabels.test.ts`（工作树，合并前）**退出码 0**，`Tests 23 passed (23)`。

新增的汉字用例 ①–⑦（用例名，摘录自 `--reporter=verbose`）：

```
① a one-character Han repair is one small label, not the whole sentence
② another dictation and the user's own typing stay out of the labels
③ a punctuation or full/half-width difference is not a change
④ a whole Han sentence rewritten is a rewrite, never a replace
⑤ a mixed Han/Latin sentence yields its two words and no surrounding Han context
⑥ two segments: only the second is labelled, and text typed between them is not
⑦ an emptied box deletes each segment that carried words
```

既有（本任务前就有的）拉丁用例 ①–⑦ 与标识符形状对照表同次全部通过；文件内还带两条自我证伪的变体用例（下）。

`git diff develop --numstat -- src/shared/tests/voiceEditLabels.test.ts` = `265	0` —— **0 删除**（`--numstat` 的第二列即删除行数），即只新增、未删除或放宽任何既有断言行。

### AC3 —— 两条假形态的读数

实验方式：先把 `src/shared/voiceEditLabels.ts` 备份到 `/tmp`，用 Edit 就地改坏，跑同一文件，记退出码与变红用例名，再从备份恢复（恢复后 `sha1sum` 与改前一致 `5775edf9…`，`git status --short` 为空，重跑 23/23 通过）。

**假形态 A —— `tokenize` 改回空白切分**（汉字不再按字切）：

```
MUT1_EXIT=1
Tests  3 failed | 20 passed (23)
× ① a one-character Han repair is one small label, not the whole sentence
× ④ a whole Han sentence rewritten is a rewrite, never a replace
× the Han tokenization is falsifiable: whitespace splitting reds cases ① and ④
```

**假形态 B —— 区间收缩改回「无邻居取 `-1`/`textLength` 并向端点膨胀」**：

```
MUT2_EXIT=1
Tests  6 failed | 17 passed (23)
× ⑤ text typed before or after the voice segment produces no labels
× ① a one-character Han repair is one small label, not the whole sentence
× ② another dictation and the user's own typing stay out of the labels
× ⑥ two segments: only the second is labelled, and text typed between them is not
× the Han tokenization is falsifiable: whitespace splitting reds cases ① and ④
× the region shrink is falsifiable: expanding to the text ends reds case ②
```

两条都点名了 AC 要求的用例（A 含①④，B 含②；B 是要求的超集）。

### AC4 —— 真实应用读数（真识别器 / 真浏览器 / 真落盘）

用一份**临时** playwright spec（`e2e/zz-voice-cjk-labels-probe.spec.ts`，读完即 `rm`；为它临时改的三处 `playwright.config.ts` 也已 `git checkout --` 还原，故工作树只剩实现本身）驱动真实 Chromium + 真实 Vite client + 真实 server，识别器是**宿主机上的真 `sensevoice-local`**（server 进程带 `SENSEVOICE_MODEL_DIR` / `SENSEVOICE_PYTHON`（venv）/ `SENSEVOICE_PYTHONPATH`（sherpa-onnx 构建产物）/ `VOICE_PROVIDER_ID=sensevoice-local`，写法沿用 `gap-voice-phase0-readout-report` 的 AC6）。会话是**调试 agent 会话**（ADR-003，不跑真实 CLI）：`POST /api/debug-agent/scenarios` → `POST /api/session-hosts/:id/start` → 进 `/session/<id>?voiceDebug=1&voiceVad=off`。在同一输入框里**两次**经 `Upload audio file` 口述宿主机上的真 WAV，然后把第二段里的**一处**字手改对，真实按 Enter 发送，读 `<dataDir>/voice-data/` 下写回的记录：

```
A transcribe={"text":"语音输入测试。", "recordId":"0e25ff29-f2e6-459d-9dc3-55dfe7b733cb"}
B transcribe={"text":"检查了功启后，是否有服务端的语音识别？", "recordId":"1403f119-fa7b-493e-92af-de865f993c3a"}
joined composer="语音输入测试。 检查了功启后，是否有服务端的语音识别？"
PATCH 200 {"recordId":"1403f119-fa7b-493e-92af-de865f993c3a"}
record 0e25ff29…  finalText=undefined labels=undefined          (第一段记录：未被改动，未被写标签)
record 1403f119…  finalText="语音输入测试。 检查了重启后，是否有服务端的语音识别？"
                  labels=[{"segmentIndex":0,"heard":"了功启","final":"了重启","op":"replace"}]
opCounts={"replace":1}
```

第二段的标签**恰好 1 条**，`heard="了功启"`/`final="了重启"` 各 3 个字符（≤ 6），`op` 是 `replace` 不是 `rewrite`；`final` 里**没有**第一段的 `语音输入测试。`（它只出现在被写回的 `finalText` 全量文本里，不进任何标签）。spec 打印 `PROBE OK` 并 7.8s 通过。

**修前对照（同一条命令、同一对（口述，最终文本），换成 pre-fix 的 `develop` 模块）**：

```
labels=[{"segmentIndex":0,
         "heard":"检查了功启后，是否有服务端的语音识别？",          (整句，19 字)
         "final":"语音输入测试。 检查了重启后，是否有服务端的语音识别？",  (混入第一段口述)
         "op":"replace"}]
```

即整句对整句，且 `final` 吞掉了另一次口述；同一 spec 在同一次运行里变红（`heard too long … 19`）。这就是 DoD 要求的前后对照：L_G 读数由同一对输入给出。

### AC5 —— 阶段 0 读数报告不被带坏

`node --test scripts/voice-phase0-report.test.mjs` **退出码 0**，`pass 16 / fail 0`（本任务未改该脚本）。

### AC6 —— 类型与 lint

`npm run typecheck` **退出码 0**；`npm run lint` **退出码 0**（仅有若干与本任务无关、且不在本次改动文件里的既有 warning）。

## Touches

- src/shared/voiceEditLabels.ts
- src/shared/tests/voiceEditLabels.test.ts
- tasks/gap-voice-weak-label-cjk-granularity-and-region-bleed.md
