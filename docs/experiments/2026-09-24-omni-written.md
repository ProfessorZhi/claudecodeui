# DashScope omni 的裁剪配对实验（`pauseCues: 'neutral'` 的证据记录）

**一句话**：把出货的 `dashscope-omni` 适配器与出货的 `trimVoiceAudio` 放在**同一次运行、同一批 8 条 TTS 合成片段**上跑真实 DashScope，用一个能红的负对照证明量具对「音变差了」这件事是敏感的，再回答一个问题 —— 这条服务的 `pauseCues` 该是 `neutral`（照原样上传）还是别的值。**读数支持 `neutral`。**

**这份记录为什么存在。** `node scripts/asr-trim-capability-check.mjs` 在本条之前退出 **1**，七条检查里只有一条红：

```
check discipline: FAIL dashscope-omni=neutral declares a non-destructive capability with no paired experiment to point at
```

同一份输出里 `declared provider=dashscope-omni pauseCues=neutral evidence=(none)`（另两行分别指 `docs/experiments/2026-09-22-voice-provider-paired-quality.md` 与 `docs/experiments/2026-09-23-gemini.md`）。红的是 ADR-004 决策 1 的**纪律那一半**：一个非默认的 `pauseCues` 声明要指向**该服务自己**的成对测量。这正是 `docs/proposals/voice-dashscope-omni-written-instruction.md:155` 写在案的那件事（`PAUSE_CUES_EVIDENCE['dashscope-omni']` 指向 T1 产出的记录，名字形状 `docs/experiments/<date>-omni-written.md`）。

**名字与日期。** 任务是按运行日命名（`docs/experiments/<YYYY-MM-DD>-omni-written.md`，立案时预计 `2026-09-25`）。实际取数运行发生在 **2026-09-24**（`run=2026-09-24T08:01:20.915Z`），所以文件按运行日叫 `2026-09-24-omni-written.md`，与 `## Touches` 里那一行的 `2026-09-25` 不同 —— 这一处偏差在任务的完成记录里同样登记。

## 装置

- **被测实现（协议第 3 条）**：omni 条件一律经 registry 解析出的出货适配器
  `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe` 发出，`fetchImpl` 就是全局 `fetch`
  —— 工装不包装 `fetch`、不改 body（这条服务的 `honors` 三项全 `false`，提示词与任务轮是适配器自己的冻结常量）。
  裁剪列的音**只能**由出货 `src/shared/voiceTrim.ts#trimVoiceAudio` 产生，标识符口径**只能**是出货
  `src/shared/identifierFidelity.ts`。三者的绝对路径与符号名由 `run.mjs --probe` 打印，并断言它们都在出货树内、
  都不在本工装内。探针输出（取数那次运行的前 9 行，逐字）：

  ```
  probe (the shipping modules this run drives — absolute paths, all inside the shipping tree):
    tree        <worktree>
    omni        <worktree>/shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe   (every omni condition goes through this shipping adapter, resolved from the registry)
    trim        <worktree>/src/shared/voiceTrim.ts#trimVoiceAudio   (produces the trim column's audio — the pauseCues axis)
    metric      <worktree>/src/shared/identifierFidelity.ts#identifierFidelity   (verbatim identifier survival)
    judge       <worktree>/experiments/voice-omni-written/raw/judge.mts#judge   (the semantic verdicts are this rubric's, imported — this harness carries no second one)
    harness     <worktree>/experiments/voice-dashscope-omni-paired-quality   (declared: carries no second implementation of any of them, and no second omni request construction)
    ok   the shipping modules resolve, the registry hands out the dashscope-omni adapter, and this harness builds no omni request of its own
    ok   the judge rubric is <worktree>/experiments/voice-omni-written/raw/judge.mts#judge (imported, not copied)
  ```

  （`<worktree>` 是取数时的工作树绝对路径；`git` 里那份 runner 打印的就是它所 import 的那棵树。）
- **语义判定**：`experiments/voice-omni-written/raw/judge.mts#judge` —— **import**，不是抄一份；工装里
  `grep -c "✅\|◐"` 为 0（判词字形以码点构造）。rubric 的 CLI-only 依赖（`judge.mts → written.mts → omni.mts`
  顶层读 8 个 webm）由 runner 在 import 前补上材料（主检出那份优先，否则用仓库自己的 ffmpeg 配方重编），
  rubric 本身一个字都不读它们。
- **语料**：`experiments/voice-provider-paired-quality/fixtures/d0*-o65.wav`（8 条，**TTS 合成**：
  `tools/dictation-corpus.mjs` 的 SCRIPTS，o65 档，16 kHz 单声道 WAV）与 `paired.json` 的参考文本 ——
  与前两份记录**同一批片段**，读原地不复制；冻结快照为每条片段 × 每条音频列记 sha256，离线重算时用出货模块
  重新编码并逐字节比对。
- **条件（4 臂，同一批片段上全跑，配对比较不跨运行）**：
  `turbo|raw|none`（出货 `openai-compatible` 上的 whisper 基线）、`omni|raw|none`、`omni|trim|none`
  （出货 `trimVoiceAudio` 之后再送 = `pauseCues` 那一轴）、`omni|head|none`（**负对照**：同一条音的前 2.0 秒）。
- **负对照（取数之前写下）**：对照条件 `omni|head|none`，参照条件 `omni|raw|none`，轴是语义判定的满分判词条数，
  预测方向 **down**。单变量：provider、模型、线协议、提示词、MIME 全部相同，唯一变的是喂进去的音。
  理由：`judge.mts` 的满分判词要求事实在位（d01 要 server 与 30、d05 要 15 与 50、d07 要 server/voice/call/测试），
  而这些事实分布在整句里（8 条音 10–20 秒），只剩开头 2 秒的音装不下句尾的文件名与数字，所以满分只可能少、不可能多。
  没按这个方向移动就是量具坏了（对音频损伤不敏感，或读数根本没走服务），那时这条运行必须红。
- **读数轴**：语义判定（满分/半分/落空计数）、标识符逐字保真（出货口径）、句读与逗号、返回的 style
  （`written` / 退化成 `verbatim`）、延迟、token 数、逐片段文本并列。**没有逐字 CER**：这条服务是
  `style: 'written'`，它的答案是一次改写而不是听写，逐字错误率对它不是一个有意义的量具。
- **`tokens` 读不到**：出货适配器的 `meta` 只带 `model`/`promptVersion`，契约里的 `meta.usage` 三个适配器都没填，
  所以本记录如实记 n/a，而不是从别处拿一个数字冒充。

## 读数

**n=8**（8 条片段 × 4 个条件 = 32 条读数，每个条件都返回了读数，配对集合没有缩小）。**单一运行**
（`run=2026-09-24T08:01:20.915Z`），所以配对不跨运行。串行执行，相邻请求间隔下限 3200 ms（两个服务都在
各自记录的节流之下；Groq on_demand 是 20 RPM，本轮的 8 次调用远在额度内）。冻结快照
`experiments/voice-dashscope-omni-paired-quality/fixtures/omni.json`（8 条 entry，每条 4 列）；
原始响应缓存 `out/quality-cache.json` 被 git 忽略。

对应关系检查（冻结的转写必须是这条音）：`canary=RED corrupted hash detected`（一个故意改坏哈希的假快照被抓到）、
`snapshot=GREEN checked 24 encoded column(s)`（8 条片段 × 3 条音频列，用出货模块重新编码后逐字节比对通过）。

| 条件 | 满分 | 半分 | 落空 | 标识符（出货口径） | 句读 | 逗号 | 退化 `verbatim` | 延迟均值 | tokens |
|---|---|---|---|---|---|---|---|---|---|
| `turbo|raw|none`（whisper 基线） | 1/8 | 6 | 1 | 0/6 | 10 | 3 | 8/8（它自己的风格） | 2835 ms | n/a |
| `omni|raw|none`（**参照条件**） | **7/8** | 1 | 0 | 3/6 | 8 | 1 | 0/8 | 21664 ms | n/a |
| `omni|trim|none`（`pauseCues` 轴） | **6/8** | 2 | 0 | 3/6 | 8 | 1 | 0/8 | 15035 ms | n/a |
| `omni|head|none`（**负对照**） | **0/8** | 6 | 2 | 0/6 | 4 | 3 | **1/8** | 4419 ms | n/a |

「退化 `verbatim`」= 返回的 `style` 是 `verbatim` 而 registry 对这条服务声明的是 `written`（即这一次它没有
书面化，退回了逐字抄）。`turbo` 那 8/8 是**它自己的**声明值，不是退化。

**基线怎么读。** whisper 基线在第一份记录里就是同一批片段上的参照条件，这里复现了它的形状：满分 1/8、
标识符 0/6、8 条全部逐字风格。omni 在**同一批片段**上满分 7/8、标识符 3/6，这就是这条服务被立案的那个差别。

## 逐片段并列文本（人读的那一半）

```
[d01] reference: 把 server 里的 voice.service.ts 的超时改成三十秒
    turbo|raw|none   ◐ 把Server里的voice.seluis.ts的超时改成30秒
    omni|raw|none    ✅ 把 `server` 里 `voice.services` 的超时改成 30 秒。
    omni|trim|none   ✅ 把 `server` 里 `voice.service.ts` 的超时改成 30 秒。
    omni|head|none   ❌ 把 `server`

[d02] reference: 改一下 voice.service.ts，嗯不对，应该是 voice.routes.ts
    turbo|raw|none   ◐ 改一下。voice.seLuis.ts嗯不对。应该是。voice.roUts.ts
    omni|raw|none    ✅ 修改 `voice.routes.ts`。
    omni|trim|none   ◐ 改一下 `voice.ro.u.ts`。
    omni|head|none   ◐ 改一下。

[d03] reference: 看一下 useVoiceInput 这个 hook 是怎么处理 recording 的
    turbo|raw|none   ◐ 看一下。Use voiceInput这个。Hook是怎么处理。RecordingG的。
    omni|raw|none    ✅ 看一下 `useVoiceInput` 这个 hook 是怎么处理 `recording` 的。
    omni|trim|none   ✅ 看一下 `useVoiceInput` 这个 hook 是怎么处理 `recording` 的。
    omni|head|none   ◐ 看一下。

[d04] reference: 不要动 voice.service.ts，只改 voice.module.ts
    turbo|raw|none   ◐ 不要动voice.seLuis TS直改voicemodule TS
    omni|raw|none    ◐ 不要动 `voice.se.ts`，只改 `voice.module.ts`。
    omni|trim|none   ◐ 不要动 `voice.ts`，只改 `voice.module.ts`。
    omni|head|none   ◐ 不要动。

[d05] reference: 把超时从十五秒改成五十秒，不是五秒
    turbo|raw|none   ✅ 把超时从15秒改成。50秒?不是5秒。
    omni|raw|none    ✅ 把超时从 15 秒改成 50 秒。
    omni|trim|none   ✅ 把超时从 15 秒改成 50 秒。
    omni|head|none   ❌ 把超时从 15 秒改成……（录音未说完，缺少目标值）

[d06] reference: 嗯…那个…就是这个 composer 的按钮，嗯…再加个快捷键
    turbo|raw|none   ◐ 嗯,那个,就是这个Composer的按钮嗯,再加个快捷键
    omni|raw|none    ✅ 给 `composer` 的按钮加个快捷键。
    omni|trim|none   ✅ 给 `composer` 的按钮加个快捷键。
    omni|head|none   ◐ 嗯，那个，就是这个

[d07] reference: server 模块下的 voice 目录里加一个 call 的测试
    turbo|raw|none   ❌ Server模块下的Voice目录里加一个Code测试
    omni|raw|none    ✅ 在 `server` 模块下的 `voice` 目录里加一个 `call` 的测试。
    omni|trim|none   ✅ 在 `server` 模块下的 `voice` 目录里加一个 `call` 的测试。
    omni|head|none   ◐ `server`

[d08] reference: 把默认模型换成 whisper large，啊不，是 whisper turbo
    turbo|raw|none   ◐ 把默认模型换成WhisperLargeAbu是WhisperTurbo
    omni|raw|none    ✅ 把默认模型换成 `Whisper Turbo`。
    omni|trim|none   ✅ 把默认模型换成 `Whisper turbo`。
    omni|head|none   ◐ 把默认模型换成。
```

人读能看见的两件事：omni 的书面化确实在做它声称的事（d06 的「嗯…那个…」被整段删掉、d08 的自我更正
「啊不，是」被收敛成最终值）；而负对照那 8 行基本是**被截断的残句**，这正是下面那条预测要的方向。

## 负对照：按预测方向移动了吗

- 预测（取数前写在 runner 里，也是冻结快照 `provenance.control.prediction` 的原文）：
  `omni|head|none` 的满分条数相对 `omni|raw|none` **down**；理由是满分判词要求事实在位，而这些事实分布
  在整句里，只剩开头 2 秒的音装不下它们。
- 读数：**`omni|head|none` ok=0 vs `omni|raw|none` ok=7（Δ=-7，0↑ 1= 7↓）—— 按预测方向（down）移动。**

同向的还有另外两条轴（都朝「更差」走，与预测一致）：标识符 0/6 vs 3/6；落空 2 vs 0。反向的一小格是
句读 4 vs 8、逗号 3 vs 1 —— 残句更短，标点计数本来就不该跟着满分走（协议第 5 条：标点位置靠人读，
不拿参考文本当标点真值）。

所以量具是敏感的：**真的把音删掉**能被这份读数看见，而且看见的方向与事先写下的方向一致。这排除了
「对音频损伤不敏感」与「读数根本没走服务」两种失败，前面的 `omni|raw` 那一列才有资格被当读数读。

七个取假变体也都在，且都红在各自该红的原因上（`--control=absent` → `absent`、`--control=zero` → `flat`、
`--control=inverted` → `against`、`--control=empty` → `empty`、`--drop=<条件>` → `empty`、
`--corpus=empty` → `n0/0readings`、`--runs=straddle` → 报 `different runs`）。反假变体里
`--control=inverted` 读成 `against`（把削掉的音当对照）也是这条读数的一面：方向不是恒等式。

## pauseCues 那一轴：结论

**结论：支持 `neutral`（照原样上传，不裁剪），声明保持 `neutral` 不变。**

把这一轴单拿出来看（`omni|trim` vs 参照 `omni|raw`，只有「上传前是否裁掉停顿」这一个变量不同）：

1. **满分：7 → 6，一条下降，零条上升。** d02 从 `修改 voice.routes.ts。`（满分）变成
   `改一下 voice.ro.u.ts。`（半分）—— 裁剪把这条里唯一还在的目标标识符改坏了。
2. **标识符：3/6 → 3/6，净额为零，但两条片段方向相反。** d01 被裁剪**修好**
   （`voice.services` → `voice.service.ts`，正是参考文本里的那个），d02 被裁剪**弄坏**
   （`voice.routes.ts` → `voice.ro.u.ts`）。两条相抵。
3. **没有一条片段在裁剪臂上变得更好。** 逐片段比对（上面那张并列表）：`omni|trim` 相对 `omni|raw`
   在 d01 与 d02 各动一次、方向相反，其余 6 条逐字相同。
4. **延迟：均值 15035 ms vs 21664 ms。** 裁剪臂看起来更快，但这条读数**不作数**：参照臂上出现了两个
   离群读数（d02 25165 ms、d06 41623 ms），同一片段在裁剪臂上是 14600/23895 ms —— 服务端排队不可控，
   n=8、单次运行区分不开「音更短所以更快」与「那两次正好排到了队尾」。

**为什么是「支持 `neutral`」而不是别的两个选项。**

- 不是 `destructive`（裁掉不亏）。`destructive` 的定义是「停顿反正被丢掉，移除它们不花任何精度还省了账单」
  （见 `src/shared/voiceTrim.ts` 的词汇表注释）。本轮里裁剪**花了精度**：d02 那一条满分被裁没了。
  一个花了精度的值不能靠这份读数立起来。
- 不是 `useful`（停顿被当作标点读）。`useful` 需要「裁剪毁掉了一个只有音里才有的线索」**稳定地**出现：
  它在 d02 上出现了一次，又在 d01 上被反向抵掉一次。n=8、单次运行区分不出「这条服务真的读停顿」
  与「两次采样各偏一边」。
- `neutral` 说「停顿既不携带线索也不花钱」，本轮读数与它对**动作**的答案是同一个：没有证据支持裁剪带来
  任何改善，所以不上传裁剪后的音。d02 那一格让它带上了一个尾巴（「不花钱」在这批上并不严格成立），
  如实记在下面的「未解释」里，而不是拿它去换一个证据更弱的声明。

按 ADR-004 决策 1，声明是**跟着该服务自己的实测走的**：这条读数没有支持任何非 `neutral` 的值，
所以 `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 的 `capabilities.pauseCues`
**保持 `'neutral'`**，模块注释里「trimming was never measured against this service」那一句
按本记录重写并点名这份路径（这正是 AC8 的两半）。

## 未解释 / 未验证

- **d01 与 d02 为什么方向相反 —— 未解释。** 同一批 TTS 合成音、同一个模型、同一个提示词，裁剪在一条上
  把标识符从错修成对、在另一条上从对弄成错。本记录能说的是现象与净额（零），不能说的是机制。
  任何「裁剪对标识符保真是 X」的因果句都会超出这份读数。
- **延迟差异不作数 —— 未解释。** 见上面第 4 点：两个离群读数无法归因到「输入更短」还是「服务端排队」。
  本记录不把它当结论，也不拿它去支持 `destructive`（省 token 那一侧）。
- **d06 在负对照臂上退化成 `verbatim` —— 未解释。** 那是唯一一格 `style=verbatim`（`omni|head` 的
  d06，输出 `嗯，那个，就是这个`）。它同时是「音损伤能被量具看见」的第二个信号（风格层也动了），
  但为什么损伤会让它放弃书面化，本记录不知道。
- **`tokens` 轴未测，不是 0。** 出货适配器的 `meta` 不带 `usage`（契约里有这个字段、三个适配器都没填），
  所以这条轴如实记 n/a。本条**没有**为了让表格好看而从别处塞一个数字进来。
- **样本局限（只界定方向，不界定幅度）**：n=8、**TTS 合成**语料、单次运行。真人语音、更长片段、
  带背景噪的录音都没测；效应方向可以被这批 TTS 音界定，幅度不可以。
- **别名漂移未验证。** `qwen3.8-omni-flash` 是 DashScope 的**别名**（适配器的 `DEFAULT_MODEL` 注释里
  写着这一条），服务端可以随时重指。将来的读数作废了不代表本记录错了，反之亦然。
- **标点不可当准确率。** 语料脚本本身不带句末标点（协议第 5 条），所以表里的「句读」「逗号」两列只是
  条件间的并列计数，不是准确率；标点位置是否合理靠人读上面那张并列表。
- **未验证的推广**：本读数是否在别的语料、别的时长档上复现，没测。

## 怎么复算这份记录

```bash
# 离线：从冻结快照重算全部读数、负对照方向、七个取假变体（不联网、不用凭据）
node experiments/voice-dashscope-omni-paired-quality/run.mjs

# 只打印所驱动的出货模块的绝对路径与符号名，并断言 runner 里没有第二份请求构造或第二份 rubric
node experiments/voice-dashscope-omni-paired-quality/run.mjs --probe

# 重新取数（联网 + 凭据；串行，写 out/quality-cache.json，再 --freeze 落快照）
node experiments/voice-dashscope-omni-paired-quality/run.mjs --live --freeze
```

离线那一条会重算本文件里的每个数字，并逐字节比对 24 条音频列；它绿了，这张表就是可机检的，
而不是靠人记得。**质量数字是读数、不是判据**（ADR-004 决策 8）—— 它不进 CI，回归靠人工义务。
