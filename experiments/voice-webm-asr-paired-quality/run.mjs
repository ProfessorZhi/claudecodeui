#!/usr/bin/env node
/**
 * 配对质量实验记录（第三份）：**只用 webm/opus 上传的 ASR 候选** × 数字写法归一 × 上下文。
 * 一份**读数**，不是闸。
 *
 * 现场。前两份记录（`experiments/voice-provider-paired-quality`、`experiments/voice-gemini-paired-quality`）
 * 建立了协议与 runner 形状，两者的语料都是 **wav**，被测服务只有两家（whisper 家族、Gemini）。
 * 本记录换的是三件事：
 *
 *   1. **上传一律 webm/opus**。产品的录音容器就是 `audio/webm;codecs=opus`（ADR-004 §缺口①.3），
 *      而前两份记录一律上传 wav —— 于是「候选服务在产品的容器上表现如何」这个问题此前没有读数。
 *      本 runner 用主机 `ffmpeg` 把每条片段（及裁剪列的 PCM）编码成 webm，把 sha256 与
 *      `ffmpeg -version` 首行钉进冻结快照，离线重算时逐字节比对；缺 ffmpeg 就**非零退出**，
 *      不静默回退到 wav。
 *   2. **七个候选服务**（不是一家）：OpenRouter 的 Qwen3-ASR 1.7B / 0.6B / Flash、Nemotron、
 *      whisper-large-v3-turbo，Groq 的 whisper-large-v3-turbo（同一模型、另一个网关 ⇒ 网关轴），
 *      以及 DashScope 的 `qwen-audio-3.1-asr-flash`。前六个经出货 `openai-compatible` 适配器发出，
 *      DashScope 没有出货适配器，其请求由本 runner 本地构造 —— 记录如实写明这一列测的是**服务**
 *      而不是出货代码。
 *   3. **数字写法归一后的 CER**。探测里 DashScope 输出阿拉伯数字（`15秒`），参考文本是中文写法
 *      （`十五秒`），CER 把这一对记成了错误。不补这一轴，「输出阿拉伯数字的服务」会被系统性
 *      低估。`cer` 与 `cerNumNorm` **并列**打印，两个口径都能读。
 *
 * 协议（`docs/experiments/README.md`）：
 *
 *   第 1 条 配对比较不跨运行 —— 所有条件在**同一批片段**上跑，配对集合取交集，每条读数旁边打印
 *           `n`。缓存里的每条读数带 `run`，冻结前要求它们同一个 run（`assertSingleRun`）。
 *           本任务由 2026-09-23 人的裁定**只跑一次**：一个时段、一次采样，所以**没有噪声尺子**，
 *           延迟读数只代表该时段。
 *   第 2 条 必须有能红的负对照 —— 见下「负对照」。
 *   第 3 条 被测实现必须是出货模块 —— OpenRouter/Groq 条件**只能**经 registry 解析出来的
 *           `openai-compatible.asr-provider.ts#transcribe` 发出（`fetchImpl` 就是全局 `fetch`，
 *           不包装、不自己拼 body）；裁剪列的音**只能**由 `src/shared/voiceTrim.ts` 的
 *           `trimVoiceAudio` 产生；标识符口径**只能**是 `src/shared/identifierFidelity.ts`。
 *           本文件在启动时打印三者的绝对路径与符号名（probe），断言它们在出货树内、不在本工装内，
 *           并自扫本文件源码里**没有** transcription 端点字面量、**没有第二份**请求构造。
 *   第 4 条 指标自己先自测 —— `--selftest` 用已知答案的用例（含中文）钉住数字归一、蒙版句读、
 *           CER 四个口径；每个用例同时断言**归一前不相等、归一后相等**，否则一条恒等变换也能过。
 *   第 5 条 不能拿参考文本当标点真值 —— 参考文本不带句末标点，只做条件间配对比较，标点**位置**
 *           是否合理靠人读配对文本（本 runner 把每个片段的全部条件原文打到 stdout）。
 *   第 6 条 口径要写清楚是哪一个 —— 标识符两列并列打印：出货 `identifierFidelity`（逐字敏感）
 *           与「四个已知标识符的大小写不敏感子串命中」。
 *   第 7 条 串行执行 —— 真实请求一条一条发，不并发。
 *   第 8 条 结果落盘缓存 —— 真实读数落在 `out/quality-cache.json`，冻结快照落在
 *           `fixtures/snapshot.json`，默认运行只读冻结快照，**不联网**。
 *
 * 负对照（协议第 2 条）。参照条件按第 2 条的先例在取数**之前**声明：**被测服务不承认上下文**，
 * 所以参照是 `none`，`punct`/`flat` 的位移按采样噪声解读。于是本记录的负对照预测是**恒等**：
 * `ds-flash|flat` 相对 `ds-flash` 必须逐字相同 —— 一个不承认 system 消息的服务，换掉 system 消息
 * 的内容不应当移动任何一条读数。判据是**逐字相同**（`verbatim`），也就是 Proposal 说的
 * 「输出逐字相同即为未被承认的直接证据」。
 *
 * **这条预测被实测证伪了**（`ds-flash|flat` 与 `ds-flash` 逐字相同 5/8，位移 d02/d03/d08），而
 * 证伪之后本文件必须回答一个设计问题：预测错了，是**运行**错了还是**服务**不是那样？
 * 答案是后者 —— 于是把两件事分开：
 *
 *   1. 预测的**结果**是一条读数（`holds` / `against`），**不进退出码**。把「预测必须成立」写成运行
 *      前置条件，等于把「答案必须是这个」写进判据，与 ADR-004 决策 8 把质量读数排除在判据集之外
 *      同向。本记录的负对照因此**真的红了**（`against`）而运行是绿的 —— 这正是「负对照能红」的最强
 *      形态：不是工装造出来的红，是服务自己红出来的。
 *   2. 退出码管的是**这条读数能不能用**：`absent`（预测没被执行）、`empty`（一条读数都没有）、以及
 *      `--control=zero|inverted|empty`（读数是工装当场**造**出来的）都必须红。自检还断言每条变异
 *      **真的碰到了读数**（位移的符号 + 位移的片段数严格多于真实读数）—— 一个没生效的变异与一个
 *      生效的变异在退出码上完全一样，只有位移能把它们分开。
 *
 * 「能绿」的那一半由 `or-qwenflash` 的 punct/flat 担：经出货适配器发出的那一对**请求逐字节相同**
 * （适配器声明 `honors.context: false`），所以「输出逐字相同 8/8」是一条**硬**断言。一个「永远返回
 * against」的比较能通过全部变异，只有这条绿断言能把它挑出来；它也是本记录**唯一**的确定性尺子
 * （DashScope 没有重复调用）。
 *
 * 预测被证伪之后 `ds-flash` 这一臂的位移怎么读，由**形状**决定（`printContextArms`，记录第七节）：
 * 三个两两比较的位移片段集合呈嵌套（`punct|flat` 的 {d02, d03} ⊂ `none|flat` 的 {d02, d03, d08}，
 * 且 `none|flat` 与 `none|punct` 的集合完全相同），这是「system 消息的内容动得越多、动到的片段越多」
 * 的形状；「逐次调用各自翻硬币」不会给出嵌套。本服务没有重复调用尺子，所以形状是唯一可用的依据 ——
 * 它只能把结论推到这里为止，这一步写在记录第七节。
 *
 * 恒等预测下，第 2 条的三个变异与旧记录**语义不同**，这一点写在这里而不是留给读者：
 * `--control=zero` 在本文件里是「负对照的读数被**置零**（零长度）」，不是旧记录的「读数等于
 * 参照条件」—— 后者在恒等预测下**正是预测状态本身**，拿它当变异是拿绿当红。`--control=inverted`
 * 是「负对照的读数被推离参照条件一个句末标点」：恒等预测没有带符号的方向可以反，所以「被移动」
 * 本身就是反方向。两条变异的位移符号相反（`zero` ⇒ Δchars<0，`inverted` ⇒ Δchars>0），
 * 自检按状态**加符号**分别断言。
 *
 * 运行：
 *   node experiments/voice-webm-asr-paired-quality/run.mjs                # 离线：冻结快照 + 负对照 + 自检
 *   node experiments/voice-webm-asr-paired-quality/run.mjs --probe        # 只打印所驱动的出货模块 + 断言快照无 wav 上传
 *   node experiments/voice-webm-asr-paired-quality/run.mjs --selftest     # 只跑指标自检
 *   node experiments/voice-webm-asr-paired-quality/run.mjs --live --dry-run  # 编码 webm 并打印计划，不联网、不用凭据
 *   node experiments/voice-webm-asr-paired-quality/run.mjs --live         # 加跑真实服务（联网 + 凭据），串行，落盘
 *   node experiments/voice-webm-asr-paired-quality/run.mjs --freeze       # 把 out/quality-cache.json 冻成 fixtures/snapshot.json
 *
 * 自检用的变异（都应当**非零退出**）：
 *   --corpus=empty        语料为空（n=0）
 *   --drop=<条件键>        某个条件一条读数都没有（配对集合塌成 0）
 *   --control=absent      负对照被从条件表里拿掉
 *   --control=zero        负对照的读数被置零（零长度）
 *   --control=inverted    负对照的读数被推离参照条件一个句末标点
 *   --control=empty       负对照的读数被抽走（配对集合塌成 0）
 *   --runs=straddle       一条读数被挪到另一个 run id（配对跨运行）
 *
 * 真实服务按 ADR-004 决策 8 **不进判据集**：它联网、需凭据、读数随服务与语料变化。它是**读数**。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { register } from 'tsx/esm/api';

import { identifierFidelity } from '../../src/shared/identifierFidelity.ts';
import { trimVoiceAudio } from '../../src/shared/voiceTrim.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = HERE;
const FIXTURE_DIR = join(HERE, 'fixtures');
const FROZEN_PATH = join(FIXTURE_DIR, 'snapshot.json');
const OUT_DIR = join(HERE, 'out');
const CACHE_PATH = join(OUT_DIR, 'quality-cache.json');
const WAV_DIR = join(OUT_DIR, 'wav');
const WEBM_DIR = join(OUT_DIR, 'webm');

/**
 * 语料的**唯一**来源：第一份实验的目录。音频、参考文本、以及「这条转录对应的音确实是出货模块
 * 现算的」那条对应关系，全部从那里读；本 runner 不复制音频，也不重抄参考文本。
 *
 * 那批 fixture 是 **wav**（`d01..d08-o65.wav`）—— 它们是**读**的对象，不是上传的对象：本 runner
 * 把每条片段重新编码成 webm 之后才上传，wav 一个字节都不出网。这也是全文件唯一一处出现
 * `audio/wav` 的地方（AC2 的 `grep` 只命中这里）。
 */
const CORPUS_DIR = resolve(HERE, '..', 'voice-provider-paired-quality');
const CORPUS_FIXTURES = join(CORPUS_DIR, 'fixtures');
const CORPUS_SNAPSHOT = join(CORPUS_FIXTURES, 'paired.json');

const REPO_ROOT = resolve(HERE, '..', '..');
const MODULE_PATHS = {
  registry: fileURLToPath(new URL('../../shared/asr/asrRegistry.ts', import.meta.url)),
  openaiCompatible: fileURLToPath(new URL('../../shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts', import.meta.url)),
  trim: fileURLToPath(new URL('../../src/shared/voiceTrim.ts', import.meta.url)),
  fidelity: fileURLToPath(new URL('../../src/shared/identifierFidelity.ts', import.meta.url)),
};

/**
 * 出货适配器表 —— 经 **registry** 解析，而不是直接 import 适配器模块。
 *
 * 这个区别是承重的：直接 `import` 一个模块只能证明「这个文件存在且导出 `transcribe`」，证明不了
 * 它**是出货路径会给出的那一个**。registry 的 `resolve('openai-compatible')` 抛错就说明本记录
 * 测的是一个地址簿里没有的适配器 —— 那样的读数与产品无关。
 */
register();

const REGISTRY_SPECIFIER = new URL('../../shared/asr/asrRegistry.ts', import.meta.url).href;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// WAV 编解码。不是被测算法：出货模块收 Float32Array，字节与样本之间的转换由调用方负责，
// 这里就是那个调用方。口径逐字沿用前两份记录的 runner —— 跨记录的数字要能并列，编解码必须是同一个。
// 本 runner 用它把音频交给 ffmpeg（ffmpeg 的输入是一个文件），**不**用它上传。
// ---------------------------------------------------------------------------

export function decodeWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`not a RIFF file: ${path}`);
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`missing fmt or data chunk: ${path}`);
  if (fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) {
    throw new Error(`expected 16-bit PCM, got format=${fmt.format} bits=${fmt.bits}: ${path}`);
  }
  const frames = data.length / (fmt.channels * 2);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    samples[i] = acc / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples };
}

export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 上传容器：webm/opus，由主机 ffmpeg 编出。
// ---------------------------------------------------------------------------

/** 上传的容器 —— 全文件只有这一个常量决定发出去的是什么格式。 */
export const UPLOAD_MIME = 'audio/webm';

/** 裁剪两列。`raw` 是原音频（不碰样本），`trim` 是出货 `trimVoiceAudio` 之后再送。 */
export const COLUMNS = ['raw', 'trim'];

/**
 * 裁剪那一轴：把出货模块的输出编回字节。`raw` 时不碰样本 —— 这一列的「没有裁剪」是它全部的
 * 意义，所以它走的是 `encodeWav(decodeWav(file))`，而不是把文件原字节当缓存键。
 */
function encodeColumn(samples, sampleRate, column) {
  if (column === 'raw') return { wav: encodeWav(samples, sampleRate), savedRatio: null };
  if (column !== 'trim') throw new Error(`unknown trim column: ${column}`);
  const result = trimVoiceAudio(samples, sampleRate, {});
  return { wav: encodeWav(result.samples, sampleRate), savedRatio: result.stats.savedRatio };
}

/**
 * 主机 ffmpeg。返回 null 就是**缺**，调用方据此非零退出 —— 静默回退到 wav 会让本记录的前提
 * （上传只用 webm）变成一个谎，而这正是本任务要机械限定住的东西。
 */
export function findFfmpeg() {
  try {
    const version = execFileSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0].trim();
    const path = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
    return { path, version };
  } catch {
    return null;
  }
}

/**
 * 一条 wav ⇒ 一条 webm。参数逐字沿用探测里验证过的那一串，其中
 * `-fflags +bitexact -flags +bitexact` 是**字节确定性**的来源：没有它，matroska 每次写出随机的
 * `SegmentUID`/`DateUTC`，同一条音频两次编码会得到两个 sha256，「离线重算逐字节比对」这条
 * 对应关系检查就永远红（或者更糟：靠一次碰巧相同蒙过去）。
 */
function encodeWebm(wavBytes, outPath) {
  const wavPath = outPath.replace(/\.webm$/, '.wav');
  mkdirSync(dirname(wavPath), { recursive: true });
  writeFileSync(wavPath, wavBytes);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', wavPath,
    '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1',
    '-fflags', '+bitexact', '-flags', '+bitexact',
    outPath,
  ]);
  return readFileSync(outPath);
}

/** 每条片段 × 每条裁剪列的 webm 产物，带它的 sha256。一次运行内只编一次。 */
export function prepareUploads(clips, { log = () => {} } = {}) {
  const uploads = new Map();
  for (const clip of clips) {
    const { samples, sampleRate } = decodeWav(join(CORPUS_FIXTURES, clip));
    const per = {};
    for (const column of COLUMNS) {
      const { wav, savedRatio } = encodeColumn(samples, sampleRate, column);
      const webm = encodeWebm(wav, join(WEBM_DIR, `${clip}.${column}.webm`));
      per[column] = { webm, wavSha256: sha256(wav), savedRatio, webmSha256: sha256(webm), webmBytes: webm.length };
      log(`  encoded ${clip}/${column} → ${UPLOAD_MIME} ${per[column].webmBytes} B (${savedRatio === null ? 'raw' : `savedRatio ${savedRatio.toFixed(4)}`})`);
    }
    uploads.set(clip, { samples, sampleRate, columns: per });
  }
  return uploads;
}

/** 快照里那条音频记录的形状（每个数字都能离线重算）。 */
const audioRecord = (per) => ({
  mimeType: UPLOAD_MIME,
  wavSha256: per.wavSha256,
  webmSha256: per.webmSha256,
  webmBytes: per.webmBytes,
  ...(per.savedRatio === null ? {} : { savedRatio: per.savedRatio }),
});

// ---------------------------------------------------------------------------
// 质量轴。都是「围绕出货算法的量具」，与上一份记录同一口径；被测算法本身一律 import。
// ---------------------------------------------------------------------------

/**
 * 蒙掉标识符内部的点 —— 口径逐字沿用标点实验的 `maskInternalDots`。
 *
 * **没有 `\S*` 前缀**，那是一个已付过代价的 bug：`\S*\.(?=[\p{L}\p{N}])` 贪婪且只被空白界定，
 * 而中文没有空白，一次匹配会从句首吃到最后一个标识符点、把整句删空 —— 只测英文会得到一个干净
 * 且完全错误的中文结论（README 第 4 条的由来）。
 */
export const maskInternalDots = (text) => String(text).replace(/\.(?=[\p{L}\p{N}])/gu, '');

/** 句读/片段 —— 蒙版后的 `[.!?。！？]` 计数。 */
export const sentenceMarks = (text) => (maskInternalDots(text).match(/[.!?。！？]/g) ?? []).length;

/** 逗号数 —— 参考文本的边界只有逗号，所以这一列单独报。 */
export const commas = (text) => (String(text).match(/[,，、]/g) ?? []).length;

/** 未蒙版的计数，只作口径分歧的可见读数（README「已知的口径分歧」）。 */
export const naiveMarks = (text) => (String(text).match(/[.!?。！？]/g) ?? []).length;

function normalizeText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const cersOf = (text) => [...normalizeText(text).replace(/\s/g, '')];

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function cer(reference, hypothesis) {
  const want = cersOf(reference);
  return want.length ? levenshtein(want, cersOf(hypothesis)) / want.length : 0;
}

// ── 数字写法归一 ────────────────────────────────────────────────────────────

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

/** 一段中文数字（0–9999）⇒ 阿拉伯数字；不认识的一律返回 null，交给调用方原样保留。 */
function cnToArabic(run) {
  let section = 0;
  let digit = null;
  for (const ch of run) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      section += (digit === null ? 1 : digit) * CN_UNITS[ch];
      digit = null;
    } else {
      return null;
    }
  }
  const total = section + (digit ?? 0);
  return total > 9999 ? null : String(total);
}

/**
 * 双向归一：中文数字写成阿拉伯数字。这是**一个规范形**，所以「十五秒 → 15秒」与
 * 「15秒 → 15秒」都收敛到同一边 —— 双向不是两次变换，是同一个终点的两个起点。
 *
 * 口诀 `十`＝10、`十五`＝15、`一百二十三`＝123、`一千零五`＝1005（`零` 只占位，后被个位覆盖）。
 * `万`/`亿` 不进这一轴（任务把范围钉在 0–9999），紧跟其后的数字段**不转换**，以免把「一万」
 * 归一成「1万」这种半截结果。归一过度在本口径下是安全的：两侧同一段文字被同一规则改写，
 * CER 只看得见**两侧写法不同**的那部分，而「一般 → 1般」在两侧是一致的。
 */
export function normalizeNumerals(text) {
  return String(text).replace(/[零〇一二两三四五六七八九十百千]+/g, (run, offset, whole) => {
    // `'万亿'.includes('')` 是 **true** —— 串尾（或数字段后直接跟标点）时 `whole[offset+run.length]`
    // 是 `undefined`，写成 `?? ''` 会让每一个「后面什么都没有」的数字段原样返回，而中文句子常常
    // 以数字收尾（`三十`、`一千零五`）。所以这里是显式的 undefined 判定，不是空串兜底。
    const next = whole[offset + run.length];
    if (next !== undefined && '万亿'.includes(next)) return run;
    const arabic = cnToArabic(run);
    return arabic === null ? run : arabic;
  });
}

/** 数字归一之后再算的 CER —— 与 `cer` 并列打印，两个口径都能读。 */
function cerNumNorm(reference, hypothesis) {
  const want = cersOf(normalizeNumerals(reference));
  return want.length ? levenshtein(want, cersOf(normalizeNumerals(hypothesis))) / want.length : 0;
}

// ── 标识符两列 ──────────────────────────────────────────────────────────────

/** 参考文本里点名要活的四个标识符（大小写不敏感子串口径的分子/分母）。 */
export const TRACKED_IDENTIFIERS = ['voice.service.ts', 'voice.routes.ts', 'voice.module.ts', 'useVoiceInput'];

/** 大小写不敏感子串命中数 —— 与出货 `identifierFidelity`（逐字敏感）并列，口径写在 README 里。 */
function identifierHits(reference, hypothesis) {
  const want = TRACKED_IDENTIFIERS.filter((id) => reference.includes(id));
  const haystack = String(hypothesis).toLowerCase();
  return { total: want.length, hit: want.filter((id) => haystack.includes(id.toLowerCase())).length };
}

// ---------------------------------------------------------------------------
// 条件表。所有条件在**同一批片段**上跑（协议第 1 条）。
//
// `punct` 与 `flat` 是同一个上下文，只差句末标点，标识符的点两侧都保留 —— 所以这一对的差值
// 隔离出的就是「上下文的标点」这一个变量。
// ---------------------------------------------------------------------------

export const PROMPTS = {
  punct:
    '把 voice.service.ts 的超时改成三十秒。然后看一下 useVoiceInput 这个 hook，再更新 voice.routes.ts。',
  flat: '把 voice.service.ts 的超时改成三十秒 然后看一下 useVoiceInput 这个 hook 再更新 voice.routes.ts',
};

/** 条件键里被声明为负对照的那一条（`flat` 形态）。恒等预测要说得出红在哪一位，所以它是个常量。 */
export const CONTROL_KEY = 'ds-flash|flat';

export const CONDITIONS = [
  {
    key: 'or-turbo', gateway: 'openrouter', model: 'openai/whisper-large-v3-turbo', column: 'raw', context: 'none',
    note: '网关轴的一半：whisper-large-v3-turbo 经 OpenRouter（前两份记录的基线模型，换网关）',
  },
  {
    key: 'groq-turbo', gateway: 'groq', model: 'whisper-large-v3-turbo', column: 'raw', context: 'none',
    note: '网关轴的另一半：同一族模型经 Groq —— 与 `or-turbo` 只差网关这一个变量',
  },
  {
    key: 'or-qwen17', gateway: 'openrouter', model: 'qwen/qwen3-asr-1.7b', column: 'raw', context: 'none',
    note: 'Qwen3-ASR 1.7B（探测里 CER 最低的两个之一）',
  },
  {
    key: 'or-qwen06', gateway: 'openrouter', model: 'qwen/qwen3-asr-0.6b', column: 'raw', context: 'none',
    note: 'Qwen3-ASR 0.6B（同一条线上更小的那一个）',
  },
  {
    key: 'or-qwenflash', gateway: 'openrouter', model: 'qwen/qwen3-asr-flash-2026-02-10', column: 'raw', context: 'none',
    note: 'Qwen3-ASR Flash —— 上下文臂在这一列上做（`prompt` 表单字段）',
  },
  {
    key: 'or-nemotron', gateway: 'openrouter', model: 'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b', column: 'raw', context: 'none',
    note: 'Nemotron 多语种 0.6B（探测里 CER 最高、唯一漏句的那一个，作为下限参照）',
  },
  {
    key: 'ds-flash', gateway: 'dashscope', model: 'qwen-audio-3.1-asr-flash', column: 'raw', context: 'none',
    note: 'DashScope `qwen-audio-3.1-asr-flash`，**没有出货适配器**（runner-local wire）；上下文臂的参照条件，也是负对照的参照',
  },
  {
    key: 'or-qwen17|trim', gateway: 'openrouter', model: 'qwen/qwen3-asr-1.7b', column: 'trim', context: 'none',
    note: '裁剪轴：出货 `trimVoiceAudio` 之后再编码为 webm',
  },
  {
    key: 'ds-flash|trim', gateway: 'dashscope', model: 'qwen-audio-3.1-asr-flash', column: 'trim', context: 'none',
    note: '裁剪轴的另一家：裁掉停顿对 DashScope 是伤害还是帮助',
  },
  {
    key: 'ds-flash|punct', gateway: 'dashscope', model: 'qwen-audio-3.1-asr-flash', column: 'raw', context: 'punct',
    note: '带句末标点的 system 消息（runner-local wire 真的把它放上线）',
  },
  {
    key: CONTROL_KEY, gateway: 'dashscope', model: 'qwen-audio-3.1-asr-flash', column: 'raw', context: 'flat',
    note: '**负对照**：同一个 system 消息，只去掉句末标点',
    // 恒等预测：不承认 system 消息的服务，换掉它的内容不应当移动任何一条读数。
    control: { axis: 'verbatim', vs: 'ds-flash', direction: 'same' },
  },
  {
    key: 'or-qwenflash|punct', gateway: 'openrouter', model: 'qwen/qwen3-asr-flash-2026-02-10', column: 'raw', context: 'punct',
    note: '上下文臂的另一家：`prompt` 表单字段（出货适配器声明 `honors.context: false` ⇒ 这一条不上线）',
  },
  {
    key: 'or-qwenflash|flat', gateway: 'openrouter', model: 'qwen/qwen3-asr-flash-2026-02-10', column: 'raw', context: 'flat',
    note: '同上，去句末标点 —— 与 `or-qwenflash|punct` 的请求逐字节相同',
  },
];

/** 取条件表里被声明为负对照的那一条；没有就是调用错误，不是静默退化。 */
export const controlCondition = (conditions = CONDITIONS) => conditions.find((c) => c.control) ?? null;

/** 条件表里出现的网关，按首次出现顺序 —— 凭据检查按它逐个点名。 */
export const GATEWAYS = [...new Set(CONDITIONS.map((c) => c.gateway))];

/**
 * 两个上下文臂。每个臂的结论（`context honored` / `context not honored`）与**依据**都要打印：
 * 「逐字相同」是「未被承认」的直接证据（Proposal），而「请求逐字节相同」是另一条更硬的依据。
 */
export const CONTEXT_ARMS = [
  {
    label: 'ds-flash',
    none: 'ds-flash',
    punct: 'ds-flash|punct',
    flat: CONTROL_KEY,
    // 这一臂的请求**不是**逐字节相同的（runner-local wire 真的把 system 消息放上线），所以它测的
    // 确实是上下文；也因此它不能兼任「请求逐字节相同 ⇒ 输出必须逐字相同」那条硬断言。
    requestsIdentical: false,
    evidence:
      'DashScope 的 system 消息由 runner-local wire 真的放上了线（本 runner 自己构造请求），所以 punct/flat 之间换的确实是那一段上下文的标点；' +
      '输出逐字相同 ⇒ 服务没有读它。',
  },
  {
    label: 'or-qwenflash',
    none: 'or-qwenflash',
    punct: 'or-qwenflash|punct',
    flat: 'or-qwenflash|flat',
    // `${CONDITIONS}` 里这一对的两个条件经出货适配器发出，声明 `honors.context: false` ⇒ multipart
    // 请求逐字节相同 ⇒ 「输出必须逐字相同」是**硬**断言（`assertFalsifiers` 的绿半）。
    requestsIdentical: true,
    evidence:
      '出货 `openai-compatible` 适配器声明 `honors.context: false`，把 hint 丢在本地，所以 punct/flat 的 multipart 请求**逐字节相同**；' +
      '逐字相同在这里既证明了该声明，也说明这一臂没有在测上下文。',
  },
];

// ---------------------------------------------------------------------------
// 语料。**读**第一份实验的快照，不复制：clip 与 reference 在那边有一份权威的原文，
// 这里再抄一份就是第二个家。`--corpus=empty` 是变异，不是用法。
// ---------------------------------------------------------------------------

export function loadCorpus() {
  if (!existsSync(CORPUS_SNAPSHOT)) {
    throw new Error(`${CORPUS_SNAPSHOT} is missing — this runner reuses the sibling experiment's corpus rather than copying it`);
  }
  const parsed = JSON.parse(readFileSync(CORPUS_SNAPSHOT, 'utf8'));
  if (!Array.isArray(parsed.entries)) throw new Error(`${CORPUS_SNAPSHOT} carries no entries`);
  return parsed.entries.map((entry) => ({ clip: entry.clip, language: 'zh', reference: entry.reference }));
}

// ---------------------------------------------------------------------------
// probe —— AC2/AC4 的机检形态：打印所驱动的出货模块的绝对路径 + 符号名，断言它们都在出货树内、
// 都不在本工装内，断言 registry 真的把 `openai-compatible` 交得出来且它声明的正是本记录依据的那两条，
// 断言快照里**没有** wav 上传记录，并自扫本文件里没有第二份请求构造。
// ---------------------------------------------------------------------------

/**
 * 自扫用的两个字面量串。**拼接**而不是直写，理由不是风格：本函数读的就是本文件自己的源码，
 * 直写会让「这条检查」自己成为命中它的证据 —— 一个永远红的自扫与没有自扫在退出码上一样。
 */
const FORBIDDEN_LITERALS = [`/audio${'/transcriptions'}`];

export function selfSourceFailures() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const failures = [];
  for (const literal of FORBIDDEN_LITERALS) {
    if (source.includes(literal)) {
      failures.push(
        `this harness builds an OpenAI-compatible request itself (its own source carries '${literal}') — ` +
          'the measured implementation must be the shipping adapter, not this runner',
      );
    }
  }
  return failures;
}

export function assertShippingModules(registry, registryError) {
  const failures = [];
  const inside = (p) => p === REPO_ROOT || p.startsWith(`${REPO_ROOT}/`);
  const inHarness = (p) => p === HARNESS_DIR || p.startsWith(`${HARNESS_DIR}/`);

  for (const [label, path, symbol] of [
    ['openai-compatible', MODULE_PATHS.openaiCompatible, 'transcribe'],
    ['trim', MODULE_PATHS.trim, 'trimVoiceAudio'],
    ['fidelity', MODULE_PATHS.fidelity, 'identifierFidelity'],
  ]) {
    if (!existsSync(path)) failures.push(`${label}: ${path} does not exist`);
    if (!inside(path)) failures.push(`${label}: ${path} is outside the shipping tree (${REPO_ROOT})`);
    if (inHarness(path)) failures.push(`${label}: ${path} is inside this harness — a second implementation, not the shipping module`);
    if (existsSync(path) && !new RegExp(`export\\s+(?:async\\s+)?function\\s+${symbol}\\b`).test(readFileSync(path, 'utf8'))) {
      failures.push(`${label}: ${path} does not export ${symbol}`);
    }
  }

  // registry 那一半：文件存在还不够，「出货地址簿会给出它」才是被测实现的身份。顺带断言本记录
  // 依据的两条能力声明 —— 它们变了，本记录的上下文结论就要重写。
  if (registryError !== null) {
    failures.push(`the registry could not be loaded, so nothing here is known to be the shipping adapter: ${registryError}`);
  } else {
    const adapter = registry.tryResolve('openai-compatible');
    if (adapter === null) {
      failures.push("'openai-compatible' is not in the shipping registry — the readings would be about an adapter the product never hands out");
    } else {
      if (adapter.capabilities.honors.context !== false) {
        failures.push(
          `the registry's openai-compatible adapter declares honors.context='${adapter.capabilities.honors.context}', ` +
            'not the false the context-arm conclusion rests on',
        );
      }
      if (!adapter.capabilities.acceptsMime.includes(UPLOAD_MIME)) {
        failures.push(
          `the registry's openai-compatible adapter does not declare ${UPLOAD_MIME} acceptable (acceptsMime=${JSON.stringify(adapter.capabilities.acceptsMime)}) — its own wire would refuse every upload this record takes`,
        );
      }
    }
  }

  for (const failure of selfSourceFailures()) failures.push(failure);
  return failures;
}

/**
 * 快照里**没有** wav 上传记录（AC2）。
 *
 * 读的是快照自己记的 `mimeType`，不是本文件的常量 —— 一个「检查自己刚写下的常量」的断言什么都
 * 没测。证伪器跟着跑：把一条上传记录的 mime 换成非 webm，同一段代码必须报红，否则这条检查是瞎的。
 * 那两个字面量同样是**拼接**的：本文件的其它地方一个 mime 字面量都不该有。
 */
export function uploadMimesOf(frozen) {
  return frozen.entries.flatMap((entry) =>
    Object.entries(entry.audio ?? {})
      .filter(([, record]) => record && typeof record === 'object' && typeof record.mimeType === 'string')
      .map(([column, record]) => ({ clip: entry.clip, column, mimeType: record.mimeType })),
  );
}

export function assertNoWavUploads(frozen) {
  const failures = [];
  const uploads = uploadMimesOf(frozen);
  for (const upload of uploads) {
    if (upload.mimeType !== UPLOAD_MIME) {
      failures.push(`${upload.clip}/${upload.column}: the snapshot records an upload as '${upload.mimeType}', not '${UPLOAD_MIME}'`);
    }
  }
  if (!uploads.length) failures.push('the snapshot carries no upload record at all, so "only webm" is not a reading here');

  // 证伪器。
  const other = ['audio', 'wav'].join('/');
  const [first] = frozen.entries;
  const canary = first
    ? uploadMimesOf({ entries: [{ ...first, audio: { ...first.audio, raw: { ...(first.audio?.raw ?? {}), mimeType: other } } }] })
    : [];
  if (!canary.length || canary.every((u) => u.mimeType === UPLOAD_MIME)) {
    failures.push('the no-wav check is blind: a snapshot mutated to carry a non-webm upload was not detected');
  }
  return { failures, count: uploads.length };
}

export function printProbe() {
  console.log('probe (the shipping modules this run drives — absolute paths, all inside the shipping tree):');
  console.log(`  tree              ${REPO_ROOT}`);
  console.log(`  registry          ${MODULE_PATHS.registry}   (resolve('openai-compatible') hands out the adapter below)`);
  console.log(`  adapter           ${MODULE_PATHS.openaiCompatible}#transcribe   (every OpenRouter/Groq condition goes through this shipping adapter)`);
  console.log(`  trim              ${MODULE_PATHS.trim}#trimVoiceAudio   (produces the trim column's audio)`);
  console.log(`  metric            ${MODULE_PATHS.fidelity}#identifierFidelity   (verbatim identifier survival)`);
  console.log(`  harness           ${HARNESS_DIR}   (declared: no second request construction, no transcription-endpoint literal, no wav upload)`);
}

// ---------------------------------------------------------------------------
// 冻结快照：读、写、以及「快照里的上传确实是这些字节」这条对应关系。
// ---------------------------------------------------------------------------

function loadFrozen() {
  const parsed = JSON.parse(readFileSync(FROZEN_PATH, 'utf8'));
  if (!Array.isArray(parsed.entries)) throw new Error(`${FROZEN_PATH} carries no entries`);
  return parsed;
}

/** 快照不存在时的起点。只有 `--live` / `--freeze` 用得上它。 */
function bootstrapFrozen() {
  return {
    provenance: { generatedAt: null, note: "bootstrap from the sibling experiment's corpus — no readings taken yet" },
    entries: loadCorpus().map((c) => ({
      clip: c.clip,
      language: c.language,
      reference: c.reference,
      audio: {},
      transcripts: {},
      runs: {},
      latencyMs: {},
      usage: {},
    })),
  };
}

function saveFrozen(frozen) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FROZEN_PATH, `${JSON.stringify(frozen, null, 2)}\n`);
}

/**
 * 对应关系检查：快照里每条转录所对应的**上传字节**，必须就是现在重新编出来的那一条。
 *
 * 快照为每条片段 × 每条裁剪列钉了 wav 与 webm 两个 sha256；这里从第一份实验的 fixture wav 重解、
 * 经 `trimVoiceAudio` 重编、经 ffmpeg 重编码，逐字节比对。这同时钉住三件事：裁剪是出货模块现算的、
 * 编码参数没有被改动过、语料没有被复制过。顺带把每条上传的 mime 与 sha256 打出来（AC2）。
 */
export function correspondenceFailures(entries, uploads) {
  const onDisk = readdirSync(CORPUS_FIXTURES).filter((f) => f.endsWith('.wav')).sort();
  const named = entries.map((e) => e.clip);
  const failures = [];
  const printed = [];
  let checked = 0;

  for (const clip of onDisk) if (!named.includes(clip)) failures.push(`corpus fixture ${clip} has no entry in the frozen snapshot`);
  for (const clip of named) if (!onDisk.includes(clip)) failures.push(`entry ${clip} names an audio file that is not in ${CORPUS_FIXTURES}`);

  for (const entry of entries) {
    if (!onDisk.includes(entry.clip)) continue;
    const live = uploads.get(entry.clip);
    if (!live) continue;
    for (const column of COLUMNS) {
      const per = live.columns[column];
      checked += 1;
      printed.push(`${entry.clip}/${column} mime=${UPLOAD_MIME} sha256=${per.webmSha256}`);
      const recorded = entry.audio?.[column];
      if (recorded?.mimeType !== UPLOAD_MIME) {
        failures.push(`${entry.clip}/${column}: the snapshot's upload mime is '${recorded?.mimeType ?? 'missing'}', not '${UPLOAD_MIME}'`);
      }
      if (recorded?.webmSha256 !== per.webmSha256) {
        failures.push(
          `${entry.clip}/${column}: the frozen transcript was not taken from these bytes ` +
            `(webm sha256 ${recorded?.webmSha256 ?? 'missing'} != ${per.webmSha256} re-encoded here)`,
        );
      }
      if (recorded?.wavSha256 !== per.wavSha256) {
        failures.push(`${entry.clip}/${column}: the wav handed to ffmpeg differs (sha256 ${recorded?.wavSha256 ?? 'missing'} != ${per.wavSha256}) — the trim column is not this shipping module's output`);
      }
      if (per.savedRatio !== null && Math.abs(per.savedRatio - (recorded?.savedRatio ?? NaN)) > 1e-9) {
        failures.push(`${entry.clip}/${column}: savedRatio ${recorded?.savedRatio} != the module's ${per.savedRatio}`);
      }
    }
  }
  return { failures, checked, printed };
}

/** 上一条检查的**证伪器**：把一条片段的 webm 哈希改坏，同一段代码路径必须报红。 */
function correspondenceCanary(entries, uploads) {
  const [entry] = entries;
  if (!entry) return { fired: false, reason: 'no entries to build a canary from' };
  const corrupted = { ...entry, audio: { ...entry.audio, raw: { ...(entry.audio?.raw ?? {}), webmSha256: '0'.repeat(64) } } };
  const { failures } = correspondenceFailures([corrupted], uploads);
  return { fired: failures.some((f) => f.includes('/raw:')), reason: failures[0] ?? 'no failure reported' };
}

// ---------------------------------------------------------------------------
// 读数与配对。
// ---------------------------------------------------------------------------

function readingOf(reference, text, latencyMs) {
  const fidelity = identifierFidelity(reference, text);
  const loose = identifierHits(reference, text);
  const wantLen = cersOf(reference).length;
  return {
    marks: sentenceMarks(text),
    naive: naiveMarks(text),
    commas: commas(text),
    identifiers: fidelity.total,
    survived: fidelity.survived,
    missing: fidelity.missing,
    looseTotal: loose.total,
    looseHit: loose.hit,
    cer: cer(reference, text),
    cerNumNorm: cerNumNorm(reference, text),
    // 漏句：归一后长度不到参考的 60%。归一用同一口径，否则阿拉伯数字那条会被记成整句丢失。
    leaked: wantLen > 0 && cersOf(normalizeNumerals(text)).length < 0.6 * wantLen,
    latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
  };
}

/**
 * 把快照折成配对读数。
 *
 * `conditions` / `controlVariant` / `drop` 是三个可变异点（自检用）。配对（协议第 1 条）：配对集合
 * 是**所有条件都有读数**的那些片段。`n` 就是它的大小。
 */
export function measure(frozen, { conditions = CONDITIONS, controlVariant = 'real', drop = null } = {}) {
  const control = controlCondition(conditions);
  const entries = frozen.entries;

  const textFor = (entry, condition) => {
    const raw = entry.transcripts?.[condition.key];
    const base = typeof raw === 'string' ? raw : null;
    if (drop && condition.key === drop) return null;
    if (control && condition.key === control.key && controlVariant !== 'real') {
      // 变异：负对照的读数被**替换**（或被清空），与快照里本来有没有它无关 —— 一个「只在缺失时
      // 才生效」的变异等于没有触发，而快照里它是有读数的。
      //
      // `zero` 是**置零（零长度）**：恒等预测下「等于参照条件」正是预测状态本身（见文件头），
      // 拿它当变异是拿绿当红。`inverted` 是推离一个句末标点：恒等预测没有带符号的方向可以反。
      if (controlVariant === 'zero') return base === null ? null : '';
      if (controlVariant === 'inverted') return base === null ? null : `${base}。`;
      if (controlVariant === 'empty') return null;
    }
    return base;
  };

  const paired = entries.filter((entry) => conditions.every((c) => textFor(entry, c) !== null));

  const columns = new Map();
  for (const condition of conditions) {
    const rows = paired.map((entry) => ({
      clip: entry.clip,
      reference: entry.reference,
      text: textFor(entry, condition),
      ...readingOf(entry.reference, textFor(entry, condition), entry.latencyMs?.[condition.key]),
    }));
    const sum = (pick) => rows.reduce((a, r) => a + pick(r), 0);
    const latencies = rows.map((r) => r.latencyMs).filter((v) => typeof v === 'number');
    columns.set(condition.key, {
      condition,
      rows,
      n: rows.length,
      marks: sum((r) => r.marks),
      naive: sum((r) => r.naive),
      commas: sum((r) => r.commas),
      survived: sum((r) => r.survived),
      identifiers: sum((r) => r.identifiers),
      looseHit: sum((r) => r.looseHit),
      looseTotal: sum((r) => r.looseTotal),
      leaked: sum((r) => (r.leaked ? 1 : 0)),
      cerMean: rows.length ? sum((r) => r.cer) / rows.length : null,
      cerNumNormMean: rows.length ? sum((r) => r.cerNumNorm) / rows.length : null,
      latencyMean: latencies.length ? latencies.reduce((a, v) => a + v, 0) / latencies.length : null,
      latencyMax: latencies.length ? Math.max(...latencies) : null,
    });
  }

  // 恒等预测的原料：负对照与它的参照条件逐字相同的条数，以及位移的**带符号**字符数。
  if (control) {
    const mine = columns.get(control.key);
    const theirs = columns.get(control.control.vs);
    if (mine && theirs) {
      let agree = 0;
      let deltaChars = 0;
      const moved = [];
      for (const row of mine.rows) {
        const base = theirs.rows.find((r) => r.clip === row.clip);
        const same = base ? row.text.trim() === base.text.trim() : false;
        row.vsEqual = same;
        row.vsDeltaChars = base ? row.text.length - base.text.length : 0;
        deltaChars += row.vsDeltaChars;
        if (same) agree += 1;
        else moved.push(row.clip);
      }
      mine.verbatim = agree;
      mine.deltaChars = deltaChars;
      mine.moved = moved;
    }
  }

  // `controlVariant` 随结果一起返回：负对照的读数是**快照里的**还是**工装当场造出来的**，是
  // 「这条读数能不能用」的分界（见 `reportControl`）。只按状态词判断的话，`--control=zero` 造出来
  // 的 `against` 与快照自己的 `against` 长得一模一样。
  return { conditions, control, paired, columns, readings: paired.length * conditions.length, controlVariant };
}

/**
 * 负对照的判定，与它的四种形态。
 *
 * 预测是**恒等**（`direction: 'same'`）：`ds-flash|flat` 与 `ds-flash` 必须逐字相同，因为一个不承认
 * system 消息的服务换掉它的内容不应当移动任何一条读数（见文件头「负对照」）。这条预测在取数**之前**
 * 写下，它的**结果**是一条读数 —— 不是运行成败。
 *
 * 返回 `{ status, detail, moved }`，四种形态：
 *
 *   · `holds`   —— 恒等成立（0 条被移动）。预测的**绿**。
 *   · `against` —— 有读数被移动了。预测被**证伪**，而证伪是一条读数：它说的是「这个服务换掉 system
 *     消息的内容之后输出动了」。运行**不因此红** —— 红在「预测没有被执行」（`absent`）与「一条读数
 *     都没有」（`empty`）上，以及工装自造的读数上（见 `reportControl`）。把一条科学预测的结果当作
 *     运行前置条件，等于把「答案必须是这个」写进判据，这与 ADR-004 决策 8 把质量读数排除在判据集
 *     之外是同一件事。
 *   · `absent`  —— 负对照或它的参照条件不在条件表里：那条预测**没有被执行**。必须红。
 *   · `empty`   —— 配对集合里一条读数都没有。必须红。
 *
 * **每一种 detail 都点名负对照的条件键**（`ds-flash|flat`）：一条只说「负对照不见了」的判词读不出
 * 红在哪一位。`moved` 是被移动的片段名 —— 预测被证伪时，动的**是哪几条**决定了这条读数怎么读
 * （见 `reportControl` 里的嵌套形状）。
 */
export function controlVerdict(result) {
  const control = result.control ?? controlCondition(CONDITIONS);
  if (!control) {
    return { status: 'absent', detail: `条件表里没有声明负对照（本记录声明的是 ${CONTROL_KEY}）`, delta: null, deltaChars: null, agree: null, n: null, moved: [] };
  }
  const axis = control.control.axis;
  const mine = result.columns.get(control.key);
  const theirs = result.columns.get(control.control.vs);
  if (!mine) {
    return {
      status: 'absent',
      detail: `${control.key} 不在本次条件表里 —— 「${axis} 相对 ${control.control.vs} 恒等」这条预测没有被执行`,
      delta: null, deltaChars: null, agree: null, n: null, moved: [],
    };
  }
  if (!theirs) {
    return {
      status: 'absent',
      detail: `${control.key} 的参照条件 ${control.control.vs} 不在本次条件表里 —— 没有可读的位移`,
      delta: null, deltaChars: null, agree: null, n: null, moved: [],
    };
  }
  if (!mine.n) {
    return { status: 'empty', detail: `${control.key} vs ${control.control.vs}：配对集合里一条读数都没有`, delta: null, deltaChars: null, agree: null, n: 0, moved: [] };
  }

  const agree = mine.verbatim ?? 0;
  const deltaChars = mine.deltaChars ?? 0;
  const moved = mine.moved ?? [];
  const detail = `${control.key} 与 ${control.control.vs} 逐字相同 ${agree}/${mine.n} 条 (Δchars=${deltaChars})`;
  if (agree === mine.n) {
    return { status: 'holds', detail: `${detail} —— 恒等预测成立：换掉 system 消息的内容没有移动任何一条读数`, delta: 0, deltaChars, agree, n: mine.n, moved };
  }
  return {
    status: 'against',
    detail: `${detail} —— 恒等预测不成立：${mine.n - agree} 条读数被移动了 [${moved.join(', ')}]`,
    delta: mine.n - agree, deltaChars, agree, n: mine.n, moved,
  };
}

/**
 * 每个上下文臂的结论与依据（AC6）。`punct` 与 `flat` 的输出逐字相同 ⇒ **未被承认**；否则**被承认**，
 * 并报出移动了几条。参照条件（`none`）一并报出，因为「参照是 `none`」这条声明本身就是结论的一半。
 *
 * 位移的**形状**也报出来：把三个两两比较（`none|punct`、`none|flat`、`punct|flat`）的位移片段集合
 * 并排看，它们应当呈嵌套（`punct|flat` ⊆ `none|flat`）—— 那是「system 消息的内容越动、动到的片段
 * 越多」的形状；三个集合互不嵌套才是「每次调用各自翻硬币」的形状。本记录没有重复调用尺子，所以
 * 形状是这条读数唯一可用的依据（记录第七节），它必须落在 stdout 上而不是只写在 md 里。
 *
 * `requestsIdentical`（条件表里声明）另有一条硬断言：请求逐字节相同的臂**必须**逐字相同（8/8），
 * 否则这条臂根本没在测上下文 —— 这是 `assertFalsifiers` 里「比较能绿」的那一半。
 */
export function contextArmVerdicts(result) {
  return CONTEXT_ARMS.map((arm) => {
    const punct = result.columns.get(arm.punct);
    const flat = result.columns.get(arm.flat);
    const none = result.columns.get(arm.none);
    if (!punct || !flat || !none) {
      return { arm, honored: null, detail: `${arm.label}: 条件缺席（${[arm.none, arm.punct, arm.flat].filter((k) => !result.columns.get(k)).join(', ')}）`, agree: null, n: null, flatMoved: [], noneMoved: [], nested: null };
    }
    const differs = (a, b) => {
      const moved = [];
      for (const row of a.rows) {
        const other = b.rows.find((r) => r.clip === row.clip);
        if (!(other && row.text.trim() === other.text.trim())) moved.push(row.clip);
      }
      return moved;
    };
    const flatMoved = differs(punct, flat);
    const noneMoved = differs(none, flat);
    const nonePunctMoved = differs(none, punct);
    const nested = flatMoved.every((clip) => noneMoved.includes(clip));
    const agree = punct.n - flatMoved.length;
    const nonePunct = punct.n - nonePunctMoved.length;
    const honored = agree !== punct.n;
    return {
      arm,
      honored,
      agree,
      n: punct.n,
      nonePunct,
      flatMoved,
      noneMoved,
      nonePunctMoved,
      nested,
      detail:
        `${arm.label}: punct vs flat 逐字相同 ${agree}/${punct.n} 条；none vs punct 逐字相同 ${nonePunct}/${punct.n} 条 ⇒ ` +
        `${honored ? 'context honored' : 'context not honored'}`,
    };
  });
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const fmt = (v, n) => (v === null || v === undefined ? 'null' : Number(v).toFixed(n));

function printColumn(column) {
  const { condition, n } = column;
  console.log(
    `\n  ${pad(condition.key, 18)} n=${n}  marks ${column.marks} (mean ${fmt(column.marks / (n || 1), 2)})  naive ${column.naive}  commas ${column.commas}  ` +
      `id ${column.survived}/${column.identifiers} (出货逐字敏感) / ${column.looseHit}/${column.looseTotal} (大小写不敏感)  ` +
      `cer ${fmt(column.cerMean, 4)}  cerNumNorm ${fmt(column.cerNumNormMean, 4)}  leaked ${column.leaked}/${n}  ` +
      `latency ${fmt(column.latencyMean, 0)}ms (max ${column.latencyMax ?? 'null'})`,
  );
  for (const row of column.rows) {
    console.log(
      `      ${pad(row.clip, 14)} n=1  marks=${row.marks} naive=${row.naive} commas=${row.commas}  ` +
        `id=${row.survived}/${row.identifiers}|${row.looseHit}/${row.looseTotal}  ` +
        `cer=${fmt(row.cer, 4)}  cerNumNorm=${fmt(row.cerNumNorm, 4)}  latency=${row.latencyMs ?? 'null'}ms` +
        (row.leaked ? '  LEAKED' : '') +
        (row.missing.length ? `  lost=[${row.missing.join(', ')}]` : ''),
    );
  }
}

/** 每条条件的文本逐条列出 —— 位置是否合理只能人读，所以原文必须落在 stdout 上（协议第 5 条）。 */
function printPairedText(result) {
  console.log('\npaired transcripts (one block per clip; the human-read half of this record):');
  for (const entry of result.paired) {
    console.log(`  [${entry.clip}] reference: ${entry.reference}`);
    for (const condition of result.conditions) {
      const row = result.columns.get(condition.key).rows.find((r) => r.clip === entry.clip);
      console.log(`      ${pad(condition.key, 18)} ${row.text}`);
    }
  }
}

/**
 * 负对照的现场报告。**两件事分开**，因为它们的成败方向不同：
 *
 *   1. 预注册预测的**结果** —— `holds` 与 `against` **都是读数**，都不是运行成败。`against` 要显眼地
 *      印出来（它是本记录的发现：换掉 system 消息的内容，输出动了），并说清它是读数而不是红。
 *   2. **这条读数能不能用** —— 只有快照自己的读数能用。`absent`（预测没被执行）与 `empty`（一条读数
 *      都没有）根本不成读数；`--control=zero|inverted|empty` 则是工装当场把读数**造**出来的。两类都红。
 *
 * 红与绿的分界线因此落在「预测被执行了吗、读数是快照的吗」上，而不是「预测猜对了吗」——
 * 后者会把「答案必须是这个」写进判据，与 ADR-004 决策 8 同向。
 */
function reportControl(result, { probe = 'real' } = {}) {
  const verdict = controlVerdict(result);
  const executed = verdict.status === 'holds' || verdict.status === 'against';
  const fabricated = executed && probe !== 'real';
  const ok = executed && !fabricated;
  console.log('\nnegative control (the `flat` shape — the report says whether the identity held, not that it ran):');
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${verdict.detail}`);
  console.log(`  predicted: ${result.control ? result.control.control.axis : '(none)'} ${result.control ? result.control.control.direction : ''} vs ${result.control ? result.control.control.vs : '(none)'}`);
  if (verdict.status === 'against') {
    console.log('  outcome: 预注册预测**被证伪** —— 这是一条读数（该服务换掉 system 消息的内容之后输出动了），不是运行失败；');
    console.log('           运行红在「预测没有被执行」与「读数由工装造出」上，不在「预测猜错了」上');
  }
  if (fabricated) {
    console.log(`  FAIL: --control=${probe} 的读数是工装当场造出来的，不是快照里那条读数 —— 自造的读数不能当读数用`);
  }
  return { verdict, ok, fabricated, executed };
}

function printContextArms(result) {
  console.log('\ncontext arms (each arm gets a conclusion and its evidence — AC6):');
  const verdicts = contextArmVerdicts(result);
  for (const verdict of verdicts) {
    console.log(`  ${verdict.honored === null ? 'FAIL' : 'ok  '} ${verdict.detail}`);
    console.log(`      evidence: ${verdict.arm.evidence}`);
    // 形状只在**真的有位移**时打印：三个集合都空时它是空话（「空集 ⊆ 空集」谈不上嵌套），而那一臂的
    // 结论已经由 `hard:` 那一行（请求逐字节相同 ⇒ 输出逐字相同）说完了。
    if (verdict.nested !== null && (verdict.flatMoved.length || verdict.noneMoved.length || verdict.nonePunctMoved.length)) {
      const list = (clips) => (clips.length ? clips.join(', ') : '（空集）');
      console.log(
        `      shape: punct|flat 位移 [${list(verdict.flatMoved)}] ⊆ none|flat 位移 [${list(verdict.noneMoved)}]，` +
          `none|punct 位移 [${list(verdict.nonePunctMoved)}] ⇒ ${verdict.nested ? '嵌套' : '不嵌套'}` +
          `（${verdict.nested ? '「消息内容动得越多、动到的片段越多」的形状' : '「逐次调用各自翻硬币」的形状'}；本服务没有重复调用尺子，形状是这条读数唯一可用的依据）`,
      );
    }
    if (verdict.arm.requestsIdentical) {
      console.log(`      hard: 请求逐字节相同 ⇒ 输出必须逐字相同；实测 ${verdict.agree}/${verdict.n}（这也是本记录唯一的确定性尺子）`);
    }
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// 自检：把「能红」做成机检，而不是文档里的一句话。
//
// **「能红」与「能绿」是同一个断言的两半**，缺哪一半都不成立：
//
//   · 红半 —— 每一条变异都必须**真的碰到读数**（`absent` / `empty` 是预测没被执行或没有读数；
//     `zero` / `inverted` 是位移的符号与幅度各自被断言）。一个没生效的变异与一个生效的变异在退出码
//     上完全一样，只有「位移真的变了」能把它们分开。
//   · 绿半 —— 请求逐字节相同的臂（`or-qwenflash` 的 punct/flat）**必须**逐字相同 8/8。一个「永远
//     返回 against」的比较能通过全部红半，只有绿半能把它挑出来 —— 它同时也是本记录唯一的确定性尺子。
//
// **预注册预测的结果不是这两半的一部分**：`holds` 与 `against` 都过。预测被证伪是一条读数
// （`controlVerdict` 的 `against`），把「预测必须成立」写进自检等于把答案写进判据。
// ---------------------------------------------------------------------------

export function assertFalsifiers(frozen, { conditions = CONDITIONS } = {}) {
  const failures = [];
  const summary = [];

  const real = measure(frozen, { conditions });
  const realVerdict = controlVerdict(real);
  const realExecuted = realVerdict.status === 'holds' || realVerdict.status === 'against';
  if (!realExecuted) {
    // `absent` / `empty`：那条预测根本没被执行 —— 这才是红，不是「预测猜错了」。
    failures.push(`real snapshot: the negative control did not run (${realVerdict.detail})`);
  }
  summary.push(`real=${realVerdict.status}(Δchars ${realVerdict.deltaChars})`);
  if (!real.paired.length) failures.push('real snapshot: the paired set is empty');
  if (!real.readings) failures.push('real snapshot: zero readings');

  const variants = [
    ['control=absent', { conditions: conditions.filter((c) => !c.control) }, 'absent', null],
    // 两条变异位移的**符号相反**，所以按符号分别断言 —— 只看状态词的话，两条变异红的是同一个理由，
    // 自检就分不出它们各自打了哪个洞。加上「位移的片段数必须严格多于真实读数」：变异若没生效，
    // `deltaChars` 与 `agree` 都会原样不动。
    ['control=zero', { conditions, controlVariant: 'zero' }, 'against', 'neg'],
    ['control=inverted', { conditions, controlVariant: 'inverted' }, 'against', 'pos'],
    ['control=empty', { conditions, controlVariant: 'empty' }, 'empty', null],
    [`drop=${CONTROL_KEY}`, { conditions, drop: CONTROL_KEY }, 'empty', null],
  ];
  for (const [label, opts, expected, sign] of variants) {
    const result = measure(frozen, opts);
    const verdict = controlVerdict(result);
    if (verdict.status !== expected) {
      failures.push(`${label}: expected "${expected}", got "${verdict.status}" (${verdict.detail})`);
    }
    if (sign === 'neg' && !(verdict.deltaChars < 0)) {
      failures.push(`${label}: the deformation did not reach the readings — expected a negative displacement, got Δchars=${verdict.deltaChars} (${verdict.detail})`);
    }
    if (sign === 'pos' && !(verdict.deltaChars > 0)) {
      failures.push(`${label}: the deformation did not reach the readings — expected a positive displacement, got Δchars=${verdict.deltaChars} (${verdict.detail})`);
    }
    if (sign && realExecuted && !(verdict.agree < realVerdict.agree)) {
      failures.push(
        `${label}: the deformation must displace strictly more clips than the real reading ` +
          `(real ${realVerdict.agree}/${realVerdict.n} verbatim, mutated ${verdict.agree}/${verdict.n})`,
      );
    }
    summary.push(`${label}=${verdict.status}`);
  }

  // 绿半：请求逐字节相同的臂必须逐字相同 8/8。
  for (const arm of contextArmVerdicts(real)) {
    if (!arm.arm.requestsIdentical) continue;
    if (arm.honored !== false || arm.agree !== arm.n) {
      failures.push(
        `real snapshot: ${arm.arm.label} 的 punct/flat 请求逐字节相同，输出必须逐字相同 ${arm.n}/${arm.n} 条 —— ` +
          `实测 ${arm.agree}/${arm.n}（${arm.detail}）`,
      );
    } else {
      summary.push(`${arm.arm.label}=绿 ${arm.agree}/${arm.n}`);
    }
  }

  // n = 0：语料为空。它必须红在「没有语料」上，而不是碰巧红在别处。
  const empty = measure({ entries: [] }, { conditions });
  if (empty.paired.length !== 0 || empty.readings !== 0) {
    failures.push(`--corpus=empty: expected n=0 and 0 readings, got n=${empty.paired.length} readings=${empty.readings}`);
  } else {
    summary.push('corpus=empty=n0/0readings');
  }

  // 配对不跨运行：把一条读数挪到另一个 run id 上，配对断言必须红。
  const straddle = assertSingleRun(runIdsOf(straddleSnapshot(frozen).entries));
  if (!straddle.length) {
    failures.push('runs=straddle: expected the pairing check to red, got no failure — the pairing assertion is blind');
  } else if (!straddle.some((f) => f.includes('different runs'))) {
    failures.push(`runs=straddle: red for the wrong reason — ${straddle[0]}`);
  } else {
    summary.push('runs=straddle=red');
  }

  return { failures, summary, real };
}

// ---------------------------------------------------------------------------
// 指标自检（协议第 4 条）。每个用例**同时**断言归一前不相等、归一后相等 —— 只断言后者的话，
// 一条恒等变换（什么都不做）也能通过全部用例。
// ---------------------------------------------------------------------------

export function selfTestCases() {
  const cases = [];
  const eq = (label, actual, expected) => cases.push({ label, ok: Object.is(actual, expected), detail: `${JSON.stringify(actual)} ${Object.is(actual, expected) ? '==' : '!='} ${JSON.stringify(expected)}` });

  // 数字归一：中文写法 ↔ 阿拉伯数字。三对来自 AC7。
  for (const [chinese, arabic] of [['十五秒', '15秒'], ['三十', '30'], ['五十秒，不是五秒', '50秒，不是5秒']]) {
    // 正面控制：两个写法**本来**就是不同的串。少了这一半，「归一后相等」可以由一条恒等变换满足。
    eq(`numerals: ${chinese} 与 ${arabic} 归一前是不同串`, chinese !== arabic, true);
    eq(`numerals: ${chinese} 归一后等于 ${arabic}`, normalizeNumerals(chinese), normalizeNumerals(arabic));
    eq(`cerNumNorm: ${chinese} vs ${arabic}`, cerNumNorm(chinese, arabic), 0);
    eq(`cer: ${chinese} vs ${arabic}`, cer(chinese, arabic) > 0, true);
  }
  // 归一不能把「万」这种超范围的写法截半。
  eq('numerals: 一万 不动', normalizeNumerals('一万'), '一万');
  eq('numerals: 一百二十三 → 123', normalizeNumerals('一百二十三'), '123');
  eq('numerals: 一千零五 → 1005', normalizeNumerals('一千零五'), '1005');

  // 蒙版句读的**中文**用例（README 第 4 条：只测英文会得到一个干净且完全错误的中文结论）。
  eq('marks: 标识符内部的点被蒙掉', maskInternalDots('voice.service.ts 的超时'), 'voiceservicets 的超时');
  eq('marks: 中文句末标点计数', sentenceMarks('把 voice.service.ts 的超时改成三十秒。然后看一眼。'), 2);
  eq('naive: 不蒙点会多数出两个', naiveMarks('把 voice.service.ts 的超时改成三十秒。'), 3);
  eq('commas: 只数逗号', commas('把超时改成三十秒，然后看一眼、再更新'), 2);

  // CER 中文用例。
  eq('cer: 完全相同为 0', cer('把超时改成三十秒', '把超时改成三十秒'), 0);
  // `把超时改成三十秒` 归一后是 8 个字符，所以错一个字是 1/8。
  eq('cer: 八个字里错一个 = 1/8', cer('把超时改成三十秒', '把超时改成四十秒'), 1 / 8);

  // 标识符两列口径分歧要可见（README「已知的口径分歧」）。
  eq('identifier: 逐字敏感不认大小写差', identifierFidelity('voice.service.ts', 'Voice.service.ts').survived, 0);
  eq('identifier: 大小写不敏感口径认它', identifierHits('voice.service.ts', 'Voice.service.ts').hit, 1);

  return cases;
}

export function runSelfTest() {
  const cases = selfTestCases();
  console.log('metric self-test (protocol rule 4 — every count has known-answer cases, including Chinese):');
  for (const testCase of cases) console.log(`  ${testCase.ok ? 'ok  ' : 'FAIL'} ${testCase.label}  → ${testCase.detail}`);
  const failed = cases.filter((c) => !c.ok);
  console.log(`  ${failed.length ? 'FAIL' : 'ok  '} ${cases.length - failed.length}/${cases.length} case(s) hold`);
  return failed;
}

// ---------------------------------------------------------------------------
// 真实读数（联网 + 凭据）。按协议第 7 条**串行**：一条一条发，不并发。
// 凭据只从仓库外读，且永不打印。
// ---------------------------------------------------------------------------

/**
 * 仓库被 git 忽略的 `.env.test` 所在的**主检出根**。
 *
 * 这个 runner 从 worktree 里跑（实现必须在 worktree 里），而 `.env.test` 是被忽略的文件 ——
 * 它**不会**出现在 worktree 里。写死绝对路径能跑，但那会把「主检出在哪」变成一条只在这台机器上
 * 成立的暗知识；从 git 自己的 common dir 反推则跟着仓库走。读不到就是主检出根部。
 */
function mainCheckoutRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    return resolve(common, '..');
  } catch {
    return REPO_ROOT;
  }
}

/** DashScope 的默认端点（探测过的那一个；`DASHSCOPE_BASE_URL` 可覆盖）。 */
const DASHSCOPE_ENDPOINT =
  'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/**
 * 三个网关各自的凭据来源，都在**仓库外**（不在任何提交里，AC9）。
 *
 * Groq 在 `/data/home/yale/work/tc-verify/.env`（前两份记录用的同一个文件，mode 600），
 * OpenRouter 与 DashScope 在主检出根部被 git 忽略的 `.env.test`。文件名与变量名在这里写死而不是
 * 靠环境碰运气：一个读不到凭据的运行必须**指名**它找了哪里，而不是发一个匿名的请求过去收 401。
 * baseUrl 允许被环境覆盖，但默认值写死 —— OpenRouter 那一条的转录路径由出货适配器自己拼到这个
 * base 上（这正是「本 runner 不构造请求」的意思：连路径都不该由它拼），DashScope 的默认值则是
 * 探测过的那一个完整端点。
 *
 * 本段刻意不写那条路径的字面量：`selfSourceFailures` 读的就是本文件自己的源码，而**注释也是源码**
 * —— 一处散文里的字面量会让自扫永远红，而永远红的自扫与没有自扫在退出码上一样。
 */
const ENV_TEST = resolve(mainCheckoutRoot(), '.env.test');
const CREDENTIAL_SOURCES = {
  openrouter: { envFile: ENV_TEST, vars: ['OPENROUTER_BASE_URL', 'OPENROUTER_API_KEY'], defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  groq: { envFile: '/data/home/yale/work/tc-verify/.env', vars: ['GROQ_BASE_URL', 'GROQ_API_KEY'], defaultBaseUrl: 'https://api.groq.com/openai/v1' },
  dashscope: { envFile: ENV_TEST, vars: ['DASHSCOPE_BASE_URL', 'DASHSCOPE_API_KEY'], defaultBaseUrl: DASHSCOPE_ENDPOINT },
};

function readEnvFile(file) {
  const fromFile = {};
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) fromFile[m[1]] = m[2];
    }
  }
  return fromFile;
}

/** 每个网关的 baseUrl / apiKey，以及它读了哪个文件（供错误信息点名）。 */
export function loadCredentials() {
  const targets = {};
  for (const [gateway, source] of Object.entries(CREDENTIAL_SOURCES)) {
    const fromFile = readEnvFile(source.envFile);
    const pick = (name) => process.env[name] ?? fromFile[name] ?? '';
    targets[gateway] = {
      envFile: source.envFile,
      baseUrl: pick(source.vars[0]) || source.defaultBaseUrl,
      apiKey: pick(source.vars[1]),
    };
  }
  return targets;
}

/**
 * 调用之间的最小间隔。它是**节流**，不是读数：不进任何表格，也不影响任何质量数字。
 *
 * 默认 6000 ms 而前两份记录是 3200 ms，理由是实测而不是保守：2026-09-23 那次取数在第 **3** 个
 * 请求上就吃了 OpenRouter 的 429，说明这个账号当时的窗口比 18 RPM 更窄。间隔调宽只是把墙钟换成
 * 更少的重试；`VOICE_PAIRED_MIN_INTERVAL_MS` 可覆盖，实际用的值记在快照的 `provenance.throttle` 里。
 */
const MIN_INTERVAL_MS = Number(process.env.VOICE_PAIRED_MIN_INTERVAL_MS ?? 6000);
const TIMEOUT_MS = Number(process.env.VOICE_PAIRED_TIMEOUT_MS ?? 120000);
let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

const RETRYABLE = /RATE_LIMITED|TIMEOUT|UNREACHABLE|answered (?:429|500|502|503|504)/;

/** DashScope 的 `parameters.format`：容器基类型（`audio/webm` ⇒ `webm`）。 */
const dashscopeFormat = (mimeType) => mimeType.split('/')[1];

/**
 * DashScope 的请求 —— **runner-local wire**，不是出货代码。
 *
 * 这一列测的是**服务**：仓库里没有 DashScope 适配器（本任务明确不写），所以请求由本 runner 自己
 * 构造。这个事实在快照的 `provenance.wireByCondition` 里逐条标着，记录里也要写明 —— 读表的人
 * 必须知道这一列的读数不能归给任何出货代码。
 *
 * 形状由探测钉住：JSON、音频是 `data:<mime>;base64,…` 的 `input.messages[].content[].audio`、
 * `parameters.format` **必须**给（缺 ⇒ 400 `format is empty`），文本在 `output.text`。
 */
async function transcribeDashscopeLocal({ bytes, mimeType, context, model, baseUrl, apiKey }) {
  const messages = [];
  if (context !== undefined) messages.push({ role: 'system', content: [{ text: context }] });
  messages.push({ role: 'user', content: [{ audio: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}` }] });
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, input: { messages }, parameters: { format: dashscopeFormat(mimeType) } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`provider 'dashscope' (${model}) answered ${response.status}: ${body.slice(0, 200)}`);
  const parsed = JSON.parse(body);
  const text = parsed?.output?.text ?? parsed?.sentence?.text;
  if (typeof text !== 'string') throw new Error(`provider 'dashscope' (${model}) returned no output.text: ${body.slice(0, 200)}`);
  return { text, usage: parsed?.usage ?? null };
}

/**
 * 一个条件的**唯一**发出点。OpenRouter/Groq 走出货适配器 + 全局 `fetch`（`fetchImpl` 不包装、
 * `AsrRequest` 的 body 由适配器自己构造）；DashScope 走上面那条 runner-local wire。
 *
 * 任何一处「runner 自己拼 OpenAI 兼容请求」都会让读数量到 runner 的线协议而不是产品的，而这条错误
 * 在读数上是看不出来的 —— 它只会在源码里看得出来（见 `selfSourceFailures`）。
 *
 * 延迟在这里量：调用前后各一个时钟，所以它是**那一跳**的墙钟，不含节流等待。
 */
/**
 * 退避表（毫秒）。比前两份记录更长：这里的瓶颈是**服务端的窗口**而不是并发，而一次挂住的请求会
 * 一直挂到 `TIMEOUT_MS`（观察到过整条请求无响应），所以「多试几次、每次等更久」比「快速连试」更省墙钟。
 */
const BACKOFF_MS = [8000, 20000, 45000];

async function invokeCondition(condition, upload, adapters, credentials, { retries = BACKOFF_MS.length } = {}) {
  const target = credentials[condition.gateway];
  if (!target?.apiKey) {
    throw new Error(
      `--live / --freeze need a credential for gateway '${condition.gateway}' ` +
        `(looked for ${CREDENTIAL_SOURCES[condition.gateway].vars[1]} in ${target?.envFile ?? '(nowhere)'})`,
    );
  }
  const context = condition.context === 'none' ? undefined : PROMPTS[condition.context];

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const started = Date.now();
    try {
      if (condition.gateway === 'dashscope') {
        const result = await transcribeDashscopeLocal({
          bytes: upload.columns[condition.column].webm,
          mimeType: UPLOAD_MIME,
          context,
          model: condition.model,
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
        });
        return { text: result.text, latencyMs: Date.now() - started, usage: result.usage };
      }

      const adapter = adapters.get('openai-compatible');
      if (!adapter) throw new Error("no adapter resolved for provider 'openai-compatible'");
      const result = await adapter.transcribe(
        {
          audio: { bytes: new Uint8Array(upload.columns[condition.column].webm), mimeType: UPLOAD_MIME, fileName: 'clip.webm' },
          hints: context === undefined ? undefined : { context },
        },
        { baseUrl: target.baseUrl, apiKey: target.apiKey, model: condition.model, timeoutMs: TIMEOUT_MS, fetchImpl: fetch },
      );
      const latencyMs = Date.now() - started;
      if (result.ok) {
        return { text: result.text, latencyMs, usage: result.meta?.usage ?? null };
      }
      const message = `provider '${condition.gateway}' (${condition.model}) failed: ${result.code}: ${result.message}`;
      if (attempt < retries && RETRYABLE.test(message)) {
        await sleep(BACKOFF_MS[attempt] ?? 60000);
        continue;
      }
      throw new Error(message);
    } catch (error) {
      const message = error?.message ?? String(error);
      if (attempt < retries && RETRYABLE.test(message)) {
        await sleep(BACKOFF_MS[attempt] ?? 60000);
        continue;
      }
      throw error;
    }
  }
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    return parsed && typeof parsed.entries === 'object' ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function saveCache(cache) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
}

/**
 * 冻结快照的**单次运行**检查（协议第 1 条：配对比较不跨运行）。
 *
 * 缓存跨进程是它的用处，也正是配对比较的陷阱：一批读数里混进两次运行的取数，「同一批语料上的
 * 配对」就不成立了。所以每条缓存项都带 `run`，冻结前要求它们**同一个 run**；不同就红，并指路
 * 重跑。本任务由 2026-09-23 人的裁定只跑一次，所以这条检查比前两份记录更承重：它替掉了原本靠
 * 「跨时段采样」才能得到的噪声信息 —— 一个时段、一次采样，没有噪声尺子。
 */
export function assertSingleRun(runIds) {
  const runs = [...new Set(runIds.filter(Boolean))];
  if (runs.length <= 1) return [];
  const perRun = runs.map((run) => `${run} (${runIds.filter((r) => r === run).length} reading(s))`);
  return [
    `the readings come from ${runs.length} different runs (${perRun.join('; ')}) — a paired comparison must not straddle runs. ` +
      'Re-take the whole set in one pass.',
  ];
}

/** 快照里每条读数各自的 run id（离线路径与冻结路径共用）。 */
const runIdsOf = (entries) => entries.flatMap((e) => Object.values(e.runs ?? {}));

/**
 * `--runs=straddle` 的变异体：把第一条片段的一个条件挪到一个不同的 run id 上。
 * 「配对不跨运行」这条协议同样必须**能红**，否则它只是记录里的一句话。
 */
export function straddleSnapshot(frozen, key = CONDITIONS[1]?.key) {
  return {
    ...frozen,
    entries: frozen.entries.map((entry, i) =>
      i === 0 && entry.runs && key in entry.runs
        ? { ...entry, runs: { ...entry.runs, [key]: '1970-01-01T00:00:00.000Z' } }
        : entry,
    ),
  };
}

/**
 * 跑一遍全部条件（串行）。**一次运行**：`--live` 取一个新 run id（或用 `--run-id=` 续跑同一个），
 * 缓存命中只认**同一个 run** 的项 —— 否则第二次 `--live` 会把两次运行的读数拼成一张配对表。
 *
 * 音频**只能**由出货模块产生（协议第 3 条）：`raw` 列是解码后的样本直接重编，裁剪列经
 * `trimVoiceAudio`；两条列都由主机 ffmpeg 编成 webm。缓存键含条件键，所以「同一个条件」是可复用
 * 的，而「不同条件」永远不会互相冒充。
 */
export async function runLive(frozen, uploads, adapters, credentials, { conditions = CONDITIONS, runId, log = console.log } = {}) {
  const activeRun = runId ?? new Date().toISOString();
  const cache = loadCache();
  const entries = frozen.entries.map((entry) => ({
    ...entry,
    audio: { ...entry.audio },
    transcripts: { ...entry.transcripts },
    runs: { ...entry.runs },
    latencyMs: { ...entry.latencyMs },
    usage: { ...entry.usage },
  }));
  let fetched = 0;
  let cached = 0;
  // 一条条件 × 片段失败**不**掀翻整次运行。理由不是宽容：缓存本来就按请求落盘，一次 abort 只丢掉
  // 已经过去的那段墙钟，剩下的请求还得从头再来一遍（同一个 run id 会命中缓存，所以重跑是安全的，
  // 但代价白付）。改成记下来、继续跑，一轮就能把「服务当时答得出来」的那些全部拿到。
  //
  // 缺读数**不会**因此变成绿：`--freeze` 见到任何一条 error 就拒绝冻结，离线那一路也会因为
  // 配对集合塌掉（n < 8）而红。空读数不是绿这条没有被松动。
  const errors = [];

  for (const entry of entries) {
    const upload = uploads.get(entry.clip);
    if (!upload) throw new Error(`no prepared upload for clip ${entry.clip}`);
    entry.audio.baselineSec = upload.samples.length / upload.sampleRate;
    for (const column of COLUMNS) entry.audio[column] = audioRecord(upload.columns[column]);

    // 串行：条件 × 片段，一个一个 await，没有并发（协议第 7 条）。
    for (const condition of conditions) {
      const key = `${condition.key}|${entry.clip}`;
      const hit = cache.entries[key];
      if (hit && typeof hit.text === 'string' && hit.run === activeRun) {
        entry.transcripts[condition.key] = hit.text;
        entry.runs[condition.key] = hit.run;
        entry.latencyMs[condition.key] = hit.latencyMs ?? null;
        entry.usage[condition.key] = hit.usage ?? null;
        cached += 1;
        continue;
      }
      let result;
      try {
        result = await invokeCondition(condition, upload, adapters, credentials);
      } catch (error) {
        const message = error?.message ?? String(error);
        errors.push({ key, message });
        log(`  FAILED ${key}: ${message}`);
        continue;
      }
      cache.entries[key] = { text: result.text, run: activeRun, takenAt: new Date().toISOString(), latencyMs: result.latencyMs, usage: result.usage };
      entry.transcripts[condition.key] = result.text;
      entry.runs[condition.key] = activeRun;
      entry.latencyMs[condition.key] = result.latencyMs;
      entry.usage[condition.key] = result.usage;
      fetched += 1;
      log(`  fetched ${key} (${result.latencyMs} ms)  [${fetched + cached}/${entries.length * conditions.length}]`);
      saveCache(cache);
    }
  }
  return { entries, fetched, cached, run: activeRun, errors };
}

/**
 * 冻结。`provenance` 里逐条写下**这次读数是什么、不是什么**：run id（一个）、端点、ffmpeg 与其版本、
 * 每个条件的发出路径（`wireByCondition`，AC4 要求 DashScope 那几列标为 runner-local）、配方、语料来源、
 * 以及已知读不到的轴。
 */
function freeze(entries, credentials, ffmpegVersion) {
  const runIds = [...new Set(runIdsOf(entries).filter(Boolean))];
  const wireByCondition = Object.fromEntries(
    CONDITIONS.map((c) => [
      c.key,
      c.gateway === 'dashscope'
        ? 'runner-local wire (no shipped adapter)'
        : `shipped 'openai-compatible' adapter, resolved from shared/asr/asrRegistry.ts`,
    ]),
  );
  const frozen = {
    provenance: {
      generatedAt: new Date().toISOString().slice(0, 10),
      runIds,
      samples: 'ONE run, ONE time window — no cross-window sampling (2026-09-23 human ruling). There is no noise ruler here: a per-clip displacement that would be sampling noise in the sibling records has nowhere to show up, so latency readings describe this window only.',
      ffmpeg: ffmpegVersion,
      endpoints: Object.fromEntries(
        Object.entries(CREDENTIAL_SOURCES).map(([gateway, source]) => [
          gateway,
          `${(credentials[gateway]?.baseUrl ?? source.defaultBaseUrl).replace(/\/$/, '')}`,
        ]),
      ),
      wireByCondition,
      request:
        'Every OpenRouter/Groq condition goes through the adapter the shipping registry resolves for openai-compatible, with the global fetch and the request body the adapter builds; ' +
        'the adapter declares honors.context: false, so its context arms carry a byte-identical multipart body. ' +
        'The DashScope rows are NOT shipped code: there is no DashScope adapter, and this runner builds that request itself (see wireByCondition).',
      throttle: `${MIN_INTERVAL_MS} ms minimum interval between calls, one call in flight (serial)`,
      upload: `Every upload is ${UPLOAD_MIME} (libopus 64k, 48 kHz, mono) encoded from the shipping module's samples by the host ffmpeg with -fflags +bitexact -flags +bitexact. No condition uploads wav.`,
      recipe:
        "For every clip × column: decode the sibling experiment's fixtures/<clip> with the runner's decodeWav, encode the column with the runner's encodeWav " +
        '(raw = encodeWav(decodeWav(file)); trim = trimVoiceAudio(samples, rate) — the shipping module), hand the wav to ffmpeg, hand the webm bytes to the condition, keep the returned text verbatim. ' +
        'Arithmetic note: ffmpeg\'s opus output does not carry the same encoder parameters as Chrome MediaRecorder\'s, so "the product container" is the container, not the encoder.',
      corpus:
        "Reused, not copied: the eight Chinese clips at o65 occupancy (d01..d08-o65) live in ../voice-provider-paired-quality/fixtures/ — a contiguous prefix of the " +
        'out-of-tree dictation corpus, **TTS 合成** (tools/dictation-corpus.mjs SCRIPTS). Same eight clips as the previous two records, so the three records\' numbers are on the same corpus.',
      referenceSource:
        'Read from ../voice-provider-paired-quality/fixtures/paired.json — the authored scripts from the out-of-tree corpus generator, verbatim, so the reference is ground truth by construction.',
      conditions: CONDITIONS.map((c) => ({ key: c.key, gateway: c.gateway, model: c.model, column: c.column, context: c.context, note: c.note })),
      prompts: PROMPTS,
      knownGaps:
        'Usage is readable only on the DashScope rows (the service returns it); the shipping adapters do not populate `AsrSuccess.meta.usage`, so their usage column is null. ' +
        'CER is computed against the authored script, which carries no sentence-final punctuation, so no punctuation-accuracy number exists here (protocol rule 5).',
    },
    entries,
  };
  saveFrozen(frozen);
  return frozen;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** 记录与 runner 的自陈。**必须**是每次运行打印的末行（AC9：不判据化）。 */
export const DISCLAIMER = 'quality numbers are a reading and are NOT a criterion';

export async function main(argv = process.argv.slice(2)) {
  // 两种写法都算：`--live` 与 `--corpus=empty`。只认前者会让所有 `--k=v` 变异**静默失效**
  // —— 一个「没生效的变异」与「变异生效但没红」在退出码上完全一样。
  const flag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const value = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  // 末行自陈走**所有**出口，包括 `--probe` 与各种红的出口：一条只在 happy path 上出现的自陈，
  // 在一个红的运行里读起来就像这个 runner 是个闸。
  const finish = (code) => {
    console.log(`\n${DISCLAIMER} (ADR-004 decision 8)`);
    return code;
  };

  const failures = [];
  console.log('voice-webm-asr-paired-quality — paired comparison across webm-only ASR candidates × numeral-normalised CER × context (a reading, not a gate)');
  printProbe();

  if (flag('selftest')) {
    const failed = runSelfTest();
    for (const f of failed) failures.push(`[selftest] ${f.label}: ${f.detail}`);
    if (failures.length) {
      process.stderr.write(`\nvoice-webm-asr-paired-quality: ${failures.length} failure(s)\n`);
      for (const f of failures) process.stderr.write(`  ${f}\n`);
    }
    return finish(failures.length ? 1 : 0);
  }

  let registry = null;
  let registryError = null;
  try {
    registry = await import(REGISTRY_SPECIFIER);
  } catch (error) {
    registryError = error?.message ?? String(error);
  }

  const probeFailures = assertShippingModules(registry, registryError);
  for (const f of probeFailures) failures.push(`[probe] ${f}`);
  console.log(`  ${probeFailures.length ? 'FAIL' : 'ok  '} the shipping modules resolve, the registry hands out the openai-compatible adapter, and this harness builds no OpenAI-compatible request of its own`);

  // ffmpeg 是本记录的前提：上传只能是 webm，而 webm 由它编出。缺它 ⇒ 立刻非零退出并指名它，
  // 在**任何**网络动作与凭据检查之前 —— 否则一次「缺 ffmpeg」的运行会先死在凭据上，读起来像是
  // 「这个 runner 要联网」而不是「这台机器缺 ffmpeg」（AC3）。
  const ffmpeg = findFfmpeg();
  if (flag('live') || flag('dry-run')) {
    if (ffmpeg === null) {
      process.stderr.write('FAIL: ffmpeg is required to encode every upload as webm (looked for `ffmpeg` on PATH) — refusing to fall back to wav\n');
      return finish(1);
    }
    console.log(`  ok   ffmpeg ${ffmpeg.version} at ${ffmpeg.path}`);
  }

  // `--probe` 走所有静态断言，含「快照里没有 wav 上传记录」（AC2）与出货模块那组（AC4）。
  if (flag('probe')) {
    if (!existsSync(FROZEN_PATH)) {
      failures.push(`[probe] ${FROZEN_PATH} is missing — there is no snapshot to assert "no wav upload" against`);
    } else {
      const frozen = loadFrozen();
      const wav = assertNoWavUploads(frozen);
      for (const f of wav.failures) failures.push(`[probe] ${f}`);
      console.log(`  ${wav.failures.length ? 'FAIL' : 'ok  '} the snapshot records ${wav.count} upload(s), every one of them ${UPLOAD_MIME}`);
      const dashscope = CONDITIONS.filter((c) => c.gateway === 'dashscope');
      const marked = dashscope.filter((c) => String(frozen.provenance?.wireByCondition?.[c.key] ?? '').includes('runner-local wire (no shipped adapter)'));
      console.log(`  ${marked.length === dashscope.length ? 'ok  ' : 'FAIL'} ${marked.length}/${dashscope.length} DashScope condition(s) are marked 'runner-local wire (no shipped adapter)' in provenance.wireByCondition`);
      if (marked.length !== dashscope.length) {
        failures.push(`[probe] provenance.wireByCondition does not mark all DashScope rows as runner-local (${dashscope.map((c) => c.key).join(', ')})`);
      }
    }
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    return finish(failures.length ? 1 : 0);
  }

  const credentials = loadCredentials();

  // `--live --dry-run`：把 webm 真编出来（证明 ffmpeg 那一跳真的能跑），打印计划，**不联网、不用凭据**。
  if (flag('dry-run')) {
    const called = [PROMPTS.punct, PROMPTS.flat];
    const corpus = loadCorpus();
    const uploads = prepareUploads(corpus.map((c) => c.clip), { log: (line) => console.log(line) });
    console.log(`\ndry run: ${CONDITIONS.length} condition(s) × ${corpus.length} clip(s) = ${CONDITIONS.length * corpus.length} request(s); nothing was sent.`);
    for (const condition of CONDITIONS) {
      console.log(
        `  ${pad(condition.key, 18)} ${pad(condition.gateway, 11)} ${pad(condition.model, 46)} column=${pad(condition.column, 4)} ` +
          `context=${pad(condition.context, 5)} mime=${UPLOAD_MIME} sha256=${uploads.get(corpus[0].clip).columns[condition.column].webmSha256}`,
      );
    }
    console.log(`  system messages (the context arms): punct=${JSON.stringify(called[0])}`);
    console.log(`                                      flat =${JSON.stringify(called[1])}`);
    console.log(`  endpoints: ${GATEWAYS.map((g) => `${g}=${(credentials[g]?.baseUrl ?? CREDENTIAL_SOURCES[g].defaultBaseUrl).replace(/\/$/, '')}`).join('  ')}`);
    console.log(`  credentials were NOT read from anything but the env files' paths (nothing was sent, no key was used)`);
    return finish(0);
  }

  if (flag('live') || flag('freeze')) {
    const missing = GATEWAYS.filter((id) => !credentials[id]?.apiKey);
    if (missing.length) {
      for (const id of missing) {
        process.stderr.write(
          `FAIL: --live / --freeze need a credential for gateway '${id}' ` +
            `(looked for ${CREDENTIAL_SOURCES[id].vars[1]} in ${CREDENTIAL_SOURCES[id].envFile})\n`,
        );
      }
      return finish(2);
    }
  }

  // 语料为空是**变异**，不是用法：它必须红在「n=0 / 读数 0 条」上。
  const needsSnapshot = flag('live') || flag('freeze');
  let frozen =
    flag('corpus') && value('corpus') === 'empty'
      ? { entries: [] }
      : existsSync(FROZEN_PATH)
        ? loadFrozen()
        : needsSnapshot
          ? bootstrapFrozen()
          : (() => {
              throw new Error(`${FROZEN_PATH} is missing — take the readings with --live, then --freeze`);
            })();

  // 一次运行取全部条件（`--live` / `--freeze` 共用同一次 pass）。
  if (flag('live') || flag('freeze')) {
    const adapters = new Map([['openai-compatible', registry.resolve('openai-compatible')]]);
    const uploads = prepareUploads(frozen.entries.map((e) => e.clip), { log: (line) => console.log(line) });
    const live = await runLive(frozen, uploads, adapters, credentials, { runId: value('run-id') ?? undefined });
    frozen = { ...frozen, entries: live.entries };
    console.log(`\nlive: run=${live.run} fetched=${live.fetched} cached=${live.cached} cache=${CACHE_PATH} (serial, ${MIN_INTERVAL_MS} ms apart, ONE pass)`);
    console.log(`live coverage: ${live.fetched + live.cached}/${live.entries.length * CONDITIONS.length} condition×clip reading(s) present after this pass`);
    for (const e of live.errors) process.stderr.write(`FAIL: ${e.key}: ${e.message}\n`);
    if (live.errors.length) {
      for (const e of live.errors) failures.push(`[live] ${e.key}: ${e.message}`);
      // 拒绝冻结。缺一条读数就冻出一个 n<8 的快照，而 AC1 要的是 `n=8 × k`（k ≥ 13）—— 少一条就
      // 该留在红上，而不是靠「样本少一点」的快照蒙过去。重跑同一个 run id 只为补这些缺的。
      if (flag('freeze')) {
        process.stderr.write(
          `FAIL: refusing to freeze — ${live.errors.length} condition×clip reading(s) are missing; ` +
            `re-run with the same --run-id=${live.run} to fill only those (the cache covers the rest)\n`,
        );
        return finish(1);
      }
    }
    if (flag('freeze')) {
      const straddles = assertSingleRun(runIdsOf(live.entries));
      if (straddles.length) {
        for (const f of straddles) process.stderr.write(`FAIL: ${f}\n`);
        return finish(1);
      }
      frozen = freeze(live.entries, credentials, ffmpeg ? `${ffmpeg.version} (${ffmpeg.path})` : null);
      console.log(`frozen: ${FROZEN_PATH} (${live.entries.length} entries, run ${live.run})`);
    }
  }

  // `--runs=straddle` 是**变异**：把一条读数挪到另一个 run id 上，配对断言必须红。
  if (flag('runs') && value('runs') === 'straddle') frozen = straddleSnapshot(frozen);

  const conditions = flag('control') && value('control') === 'absent' ? CONDITIONS.filter((c) => !c.control) : CONDITIONS;

  // AC1：配对集合与读数条数。空读数不是绿。
  const result = measure(frozen, { conditions, drop: value('drop'), controlVariant: value('control') ?? 'real' });
  console.log(`\ncorpus: ${frozen.entries.length} clip(s) in the snapshot, ${result.paired.length} in the paired set (every condition returned a reading)`);
  console.log(`readings: n=${result.paired.length} × ${conditions.length} condition(s) = ${result.readings} row(s), n = clips = ${result.paired.length}`);
  if (!result.paired.length) failures.push(`[n] the paired set is empty — n=0 is not a green reading (snapshot ${frozen.entries.length} clip(s), ${conditions.length} condition(s))`);
  if (!result.readings) failures.push('[n] zero reading rows — an empty reading is not a green reading');

  // 条件 key 覆盖：Proposal 点名的每一条都必须在表里，而且都有读数。`--drop` 会在这里也红一次
  // —— 那是**对的**：一条「某个候选根本没跑」的读数不该安静地通过。
  const missingKeys = CONDITIONS.filter((c) => !result.columns.has(c.key)).map((c) => c.key);
  if (missingKeys.length) failures.push(`[coverage] condition(s) missing from the run: ${missingKeys.join(', ')}`);

  // AC5：配对集合内的读数必须来自**同一次运行**（协议第 1 条）。
  const runs = [...new Set(runIdsOf(frozen.entries).filter(Boolean))];
  const straddles = assertSingleRun(runIdsOf(frozen.entries));
  console.log(`\nrun: ${runs.length ? runs.join(', ') : '(no run id — snapshot taken before run ids were recorded)'} — ${runs.length <= 1 ? 'single run, so the pairing does not straddle runs' : 'MORE THAN ONE RUN'}`);
  for (const f of straddles) failures.push(`[pairing] ${f}`);

  // 冻结快照的上传必须就是这些字节（含证伪器），并且全部是 webm。
  if (frozen.entries.length) {
    const uploads = prepareUploads(frozen.entries.map((e) => e.clip));
    const canary = correspondenceCanary(frozen.entries, uploads);
    console.log(`\ncorrespondence (the frozen transcript must be these bytes, byte for byte):`);
    console.log(`  canary=${canary.fired ? 'RED' : 'GREEN'} ${canary.fired ? 'corrupted hash detected' : 'NOT detected — the check is blind'}`);
    if (!canary.fired) failures.push(`[correspondence] canary not detected (${canary.reason}) — a green snapshot reading would be worthless`);

    const correspondence = correspondenceFailures(frozen.entries, uploads);
    console.log(`  snapshot=${correspondence.failures.length ? 'RED' : 'GREEN'} checked ${correspondence.checked} upload(s); every upload (AC2):`);
    for (const line of correspondence.printed) console.log(`    ${line}`);
    for (const f of correspondence.failures) {
      console.log(`    - ${f}`);
      failures.push(`[correspondence] ${f}`);
    }

    const wav = assertNoWavUploads(frozen);
    console.log(`  ${wav.failures.length ? 'FAIL' : 'ok  '} ${wav.count} upload record(s), all ${UPLOAD_MIME} (the no-wav assertion has its own falsifier)`);
    for (const f of wav.failures) failures.push(`[mime] ${f}`);
  }

  // 读数。
  for (const column of result.columns.values()) printColumn(column);

  // AC6 前半：负对照的判定。`probe` 决定这次运行红不红 —— 见 `reportControl`。
  const { verdict, ok } = reportControl(result, { probe: value('control') ?? 'real' });
  if (!ok) failures.push(`[control] ${verdict.detail}`);

  // AC6 后半：每个上下文臂的结论与依据。
  const arms = printContextArms(result);
  for (const arm of arms) {
    if (arm.honored === null) failures.push(`[context] ${arm.detail}`);
  }

  printPairedText(result);

  // 自检 —— 七条变异各自必须红，且红在预期的位置上。
  const selfTest = assertFalsifiers(frozen, { conditions });
  console.log('\nfalsifiers (each variant must red, and red for the stated reason):');
  console.log(`  ${selfTest.summary.join('  ')}`);
  for (const f of selfTest.failures) failures.push(`[falsifier] ${f}`);

  if (failures.length) {
    process.stderr.write(`\nvoice-webm-asr-paired-quality: ${failures.length} failure(s)\n`);
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    return finish(1);
  }

  console.log(
    `\nvoice-webm-asr-paired-quality: OK — n=${result.paired.length}, ${result.readings} paired reading(s), ` +
      `negative control ${verdict.status} (${verdict.agree}/${verdict.n} verbatim, Δchars ${verdict.deltaChars}` +
      `${verdict.status === 'against' ? '；预注册的恒等预测被证伪，这是一条读数' : ''}); ` +
      `${DISCLAIMER} (ADR-004 decision 8)`,
  );
  return finish(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`FAIL: ${error?.message ?? error}\n`);
      console.log(`\n${DISCLAIMER} (ADR-004 decision 8)`);
      process.exit(1);
    },
  );
}

// quality numbers are a reading and are NOT a criterion (ADR-004 decision 8)
