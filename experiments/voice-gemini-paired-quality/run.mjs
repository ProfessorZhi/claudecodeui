#!/usr/bin/env node
/**
 * 配对质量实验记录（第二份）：**Gemini** × whisper 基线 × 裁剪 × 上下文（一份读数，不是闸）。
 *
 * 现场。proposal `docs/proposals/voice-asr-provider-seam.md` 的 S3 要求一份
 * `docs/experiments/<date>-gemini.md`（同语料、`flat` 负对照、五轴读数），ADR-004 决策 6 把
 * 「每接入一个服务就重跑一次该服务的配对实验」写成持续义务，决策 8 把质量读数**排除在判据集
 * 之外** —— 于是这条义务只能靠「每接入一个服务写一份记录」的人工承诺履行，缺口不会被任何判据
 * 发现。上一份记录（`experiments/voice-provider-paired-quality`）建立协议与 runner 形状，本文件
 * **沿用那份协议**，换被测服务：它测的是出货 multimodal 适配器（`shared/asr/list/multimodal/
 * multimodal.asr-provider.ts`）在真实端点上的行为。
 *
 * 另一处诚实性缺口，也是本任务的一半：`shared/asr/asrRegistry.ts` 的
 * `PAUSE_CUES_EVIDENCE[multimodalId]` 曾指向那份 **whisper 家族**的配对记录，而那份记录一个字
 * 都没提 multimodal。判据（`scripts/asr-pause-cues-source-check.mjs`）只做 `existsSync`，所以
 * `pauseCues: 'useful'` 这条**非默认**声明此前只有 ADR-004 §二 的推断作依据。本记录是它终于指向
 * 的那个「实际测过该服务」的文件。
 *
 * 协议（沿用 `docs/experiments/README.md` 与上一份记录）：
 *
 *   第 1 条 配对比较不跨运行 —— 所有条件在**同一批片段**上跑，配对集合取交集，每条读数旁边打印
 *           `n`。缓存里的每条读数带 `run`，冻结前要求它们同一个 run。
 *   第 2 条 必须有能红的负对照 —— `flat`（同一个上下文，只去掉句末标点）。它必须**按预测方向
 *           相对 `punct` 下降**，否则「上下文的标点被镜像」这个解释不成立。三个变异
 *           （`--control=absent|zero|inverted`）各打一个洞，离线自检逐个要求它们**红**。
 *   第 3 条 被测实现必须是出货模块 —— Gemini 条件**只能**经 registry 解析出来的
 *           `multimodal.asr-provider.ts#transcribe` 发出，`fetchImpl` 就是全局 `fetch`（不包装、
 *           不改 body）；裁剪列的音**只能**由 `src/shared/voiceTrim.ts` 的 `trimVoiceAudio` 产生；
 *           标识符口径**只能**是 `src/shared/identifierFidelity.ts`。本文件在启动时打印三者的
 *           绝对路径与符号名（probe），并断言它们在出货树内、不在本工装内，且断言本工装源码里
 *           **没有第二份 Gemini 请求构造**（自扫两个字面量，拼接成串以免自扫命中自己）。
 *   第 7 条 串行执行 —— 真实请求一条一条发，不并发。
 *   第 8 条 结果落盘缓存 —— 真实读数落在 `out/quality-cache.json`，冻结快照落在
 *           `fixtures/gemini.json`，默认运行只读冻结快照，**不联网**。
 *
 * 语料**不复制**。音频与参考文本都从上一份实验的目录读（`../voice-provider-paired-quality/
 * fixtures/`）：`d01..d08-o65.wav` 是仓库外口述语料 o65 档的一个连续前缀，参考文本是喂给 TTS 的
 * 脚本原文（构造上的真值）。一份语料一个家，这个 runner 自己不再抄一份。
 *
 * 条件（6 个，同一批片段上全跑）：
 *
 *   provider/model   turbo（Groq `whisper-large-v3-turbo`，基线）/ g25lite（`gemini-2.5-flash-lite`
 *                    —— 出货默认模型）/ g35lite（`gemini-3.5-flash-lite` —— 模型轴）
 *   trim             raw（原音频）/ trim（出货 `trimVoiceAudio` 之后再送 —— `pauseCues` 轴）
 *   context          none（无上下文）/ punct（带句末标点）/ flat（**负对照**：同一个上下文去掉句末标点）
 *
 * 读数轴（都是**读数**，不是闸 —— 决策 8）：CER、句读、标识符存活、延迟、token 数、逐片段文本并列。
 *
 * 运行：
 *   node experiments/voice-gemini-paired-quality/run.mjs               # 离线：冻结快照 + 负对照 + 自检
 *   node experiments/voice-gemini-paired-quality/run.mjs --live        # 加跑真实服务（联网 + 凭据），串行，落盘
 *   node experiments/voice-gemini-paired-quality/run.mjs --live --fresh # 换新 run id 并忽略旧缓存
 *   node experiments/voice-gemini-paired-quality/run.mjs --freeze      # 把 out/quality-cache.json 冻成 fixtures/gemini.json
 *   node experiments/voice-gemini-paired-quality/run.mjs --probe       # 只打印所驱动的出货模块
 *
 * 自检用的变异（都应当**非零退出**）：
 *   --corpus=empty        语料为空（n=0）
 *   --drop=<条件键>        某个条件一条读数都没有（配对集合塌成 0）
 *   --control=absent      负对照被从条件表里拿掉
 *   --control=zero        负对照被置零（读数等于参照条件 ⇒ 位移为 0）
 *   --control=inverted    负对照朝预测的**反方向**移动
 *   --control=empty       负对照的读数被抽走（配对集合塌成 0）
 *   --runs=straddle       一条读数被挪到另一个 run id（配对跨运行）
 *
 * 真实服务按决策 8 **不进判据集**：它联网、需凭据、读数随服务与语料变化。它是**读数**。
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
const FROZEN_PATH = join(FIXTURE_DIR, 'gemini.json');
const OUT_DIR = join(HERE, 'out');
const CACHE_PATH = join(OUT_DIR, 'quality-cache.json');

/**
 * 语料的**唯一**来源：上一份实验的目录。音频、参考文本、以及「这条转录对应的音确实是出货模块
 * 现算的」那条对应关系，全部从那里读；本 runner 不复制音频，也不重抄参考文本。
 */
const CORPUS_DIR = resolve(HERE, '..', 'voice-provider-paired-quality');
const CORPUS_FIXTURES = join(CORPUS_DIR, 'fixtures');
const CORPUS_SNAPSHOT = join(CORPUS_FIXTURES, 'paired.json');

const REPO_ROOT = resolve(HERE, '..', '..');
const MODULE_PATHS = {
  multimodal: fileURLToPath(new URL('../../shared/asr/list/multimodal/multimodal.asr-provider.ts', import.meta.url)),
  trim: fileURLToPath(new URL('../../src/shared/voiceTrim.ts', import.meta.url)),
  fidelity: fileURLToPath(new URL('../../src/shared/identifierFidelity.ts', import.meta.url)),
};

/**
 * 出货适配器表 —— 经 **registry** 解析，而不是直接 import 适配器模块。
 *
 * 这个区别是承重的：直接 `import` 一个模块只能证明「这个文件存在且导出 `transcribe`」，证明不了
 * 它**是出货路径会给出的那一个**。registry 的 `resolve('multimodal')` 抛错就说明本记录测的是一个
 * 地址簿里没有的适配器 —— 那样的读数与产品无关。
 */
register();

const REGISTRY_SPECIFIER = new URL('../../shared/asr/asrRegistry.ts', import.meta.url).href;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// WAV 编解码。不是被测算法：出货模块收 Float32Array，字节与样本之间的转换由调用方负责，
// 这里就是那个调用方。冻结快照里的 sha256 是**经这两个函数**取的，所以两者都导出。
// 口径逐字沿用上一份记录的 runner —— 跨记录的数字要能并列，编解码必须是同一个。
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

/**
 * 裁剪那一轴：把出货模块的输出编回字节。`raw` 时不碰样本 —— 这一列的「没有裁剪」是它全部的
 * 意义，所以它走的是 `encodeWav(decodeWav(file))`，而不是把文件原字节当缓存键。
 */
function encodeColumn(samples, sampleRate, trim) {
  if (trim === 'raw') return { bytes: encodeWav(samples, sampleRate), stats: null };
  if (trim !== 'trimFrozen') throw new Error(`unknown trim column: ${trim}`);
  const result = trimVoiceAudio(samples, sampleRate, {});
  return { bytes: encodeWav(result.samples, sampleRate), stats: result.stats };
}

const TRIMS = ['raw', 'trimFrozen'];

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

/** 句读/片段 —— 蒙版后的 `[.!?。！？]` 计数。这是本记录的主轴。 */
export const sentenceMarks = (text) => (maskInternalDots(text).match(/[.!?。！？]/g) ?? []).length;

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

// ---------------------------------------------------------------------------
// S0 条件表。三根轴交叉，所有条件在**同一批片段**上跑（协议第 1 条）。
//
// `punct` 与 `flat` 是同一个上下文，只差句末标点，标识符的点两侧都保留 —— 所以这一对的差值
// 隔离出的就是「上下文的标点」这一个变量，负对照才因此有意义。
// ---------------------------------------------------------------------------

export const PROMPTS = {
  punct:
    '把 voice.service.ts 的超时改成三十秒。然后看一下 useVoiceInput 这个 hook，再更新 voice.routes.ts。',
  flat: '把 voice.service.ts 的超时改成三十秒 然后看一下 useVoiceInput 这个 hook 再更新 voice.routes.ts',
};

export const CONDITIONS = [
  {
    key: 'turbo|raw|none',
    providerId: 'openai-compatible',
    model: 'whisper-large-v3-turbo',
    trim: 'raw',
    context: 'none',
    note: '上一份记录的参照条件（不裁剪、无上下文）；本轮同样由出货适配器发出，供同批并列',
  },
  {
    key: 'g25lite|raw|none',
    providerId: 'multimodal',
    model: 'gemini-2.5-flash-lite',
    trim: 'raw',
    context: 'none',
    note: '出货默认模型 + 出货适配器，不裁剪、无上下文',
  },
  {
    key: 'g25lite|trim|none',
    providerId: 'multimodal',
    model: 'gemini-2.5-flash-lite',
    trim: 'trimFrozen',
    context: 'none',
    note: 'pauseCues 轴：出货 trimVoiceAudio 之后再送（裁掉停顿对 Gemini 是伤害还是帮助）',
  },
  {
    key: 'g35lite|raw|none',
    providerId: 'multimodal',
    model: 'gemini-3.5-flash-lite',
    trim: 'raw',
    context: 'none',
    note: '模型轴：同一条线上更大的那一个（`g25lite` 的上下文对齐）',
  },
  {
    key: 'g25lite|raw|punct',
    providerId: 'multimodal',
    model: 'gemini-2.5-flash-lite',
    trim: 'raw',
    context: 'punct',
    note: '带句末标点的上下文（`honors.context: true`，出货适配器会把它放上请求）',
  },
  {
    key: 'g25lite|raw|flat',
    providerId: 'multimodal',
    model: 'gemini-2.5-flash-lite',
    trim: 'raw',
    context: 'flat',
    note: '**负对照**：同一个上下文，只去掉句末标点',
    // 负对照的预测：相对 `punct`（只差上下文里那几个句末标点的条件）句读必须**下降**。
    // 对 `none` 下这个预测是不成立的 —— 「无上下文」与「有上下文」之间换的不止一个变量。
    control: { axis: 'marks', vs: 'g25lite|raw|punct', direction: 'down' },
  },
];

/** 取条件表里被声明为负对照的那一条；没有就是调用错误，不是静默退化。 */
export const controlCondition = (conditions = CONDITIONS) => conditions.find((c) => c.control) ?? null;

/** 条件表里出现的 provider id，按首次出现顺序 —— 凭据检查按它逐个点名。 */
export const PROVIDER_IDS = [...new Set(CONDITIONS.map((c) => c.providerId))];

// ---------------------------------------------------------------------------
// S0 语料。**读**上一份实验的快照，不复制：clip 与 reference 在那边有一份权威的原文，
// 这里再抄一份就是第二个家。`--corpus=empty` 是变异，不是用法。
// ---------------------------------------------------------------------------

export function loadCorpus() {
  if (!existsSync(CORPUS_SNAPSHOT)) {
    throw new Error(`${CORPUS_SNAPSHOT} is missing — this runner reuses the previous experiment's corpus rather than copying it`);
  }
  const parsed = JSON.parse(readFileSync(CORPUS_SNAPSHOT, 'utf8'));
  if (!Array.isArray(parsed.entries)) throw new Error(`${CORPUS_SNAPSHOT} carries no entries`);
  return parsed.entries.map((entry) => ({ clip: entry.clip, language: 'zh', reference: entry.reference }));
}

// ---------------------------------------------------------------------------
// probe —— AC4 的机检形态：打印所驱动的出货模块的绝对路径 + 符号名，断言三者都在出货树内、
// 都不在本工装内，断言 registry 真的把 multimodal 交得出来，并自扫本文件里没有第二份
// Gemini 请求构造。一个把请求抄了一份的工装会在这里红，因为那个字面量必然出现在源码里。
// ---------------------------------------------------------------------------

/**
 * 自扫用的两个串。**拼接**而不是直写，理由不是风格：本函数读的就是本文件自己的源码，
 * 直写会让「这条检查」自己成为命中它的证据 —— 一个永远红的自扫与没有自扫在退出码上一样。
 */
const FORBIDDEN_LITERALS = [`generate${'Content'}`, `inline${'Data'}`];

export function selfSourceFailures() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const failures = [];
  for (const literal of FORBIDDEN_LITERALS) {
    if (source.includes(literal)) {
      failures.push(
        `this harness builds a second Gemini request itself (its own source carries '${literal}') — ` +
          'the measured implementation must be the shipping adapter, not this runner',
      );
    }
  }
  return failures;
}

/**
 * @param {{ tryResolve: (id: string) => { id: string, capabilities: { pauseCues: string } } | null } | null} registry
 * @param {string | null} registryError
 */
export function assertShippingModules(registry, registryError) {
  const failures = [];
  const inside = (p) => p === REPO_ROOT || p.startsWith(`${REPO_ROOT}/`);
  const inHarness = (p) => p === HARNESS_DIR || p.startsWith(`${HARNESS_DIR}/`);

  for (const [label, path, symbol] of [
    ['multimodal', MODULE_PATHS.multimodal, 'transcribe'],
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

  // registry 那一半：文件存在还不够，「出货地址簿会给出它」才是被测实现的身份。
  if (registryError !== null) {
    failures.push(`the registry could not be loaded, so nothing here is known to be the shipping adapter: ${registryError}`);
  } else {
    const adapter = registry.tryResolve('multimodal');
    if (adapter === null) {
      failures.push("'multimodal' is not in the shipping registry — the readings would be about an adapter the product never hands out");
    } else if (adapter.capabilities.pauseCues !== 'useful') {
      failures.push(
        `the registry's multimodal adapter declares pauseCues='${adapter.capabilities.pauseCues}', not the 'useful' this record is the evidence for`,
      );
    }
  }

  for (const failure of selfSourceFailures()) failures.push(failure);
  return failures;
}

export function printProbe() {
  console.log('probe (the shipping modules this run drives — absolute paths, all inside the shipping tree):');
  console.log(`  tree        ${REPO_ROOT}`);
  console.log(`  multimodal  ${MODULE_PATHS.multimodal}#transcribe   (every Gemini condition goes through this shipping adapter, resolved from the registry)`);
  console.log(`  trim        ${MODULE_PATHS.trim}#trimVoiceAudio   (produces the trim column's audio)`);
  console.log(`  metric      ${MODULE_PATHS.fidelity}#identifierFidelity   (verbatim identifier survival)`);
  console.log(`  harness     ${HARNESS_DIR}   (declared: carries no second implementation of any of them, and no second Gemini request construction)`);
}

// ---------------------------------------------------------------------------
// S1 冻结快照：读、写、以及「快照里的音频确实是出货模块的输出」这条对应关系。
// ---------------------------------------------------------------------------

function loadFrozen() {
  const parsed = JSON.parse(readFileSync(FROZEN_PATH, 'utf8'));
  if (!Array.isArray(parsed.entries)) throw new Error(`${FROZEN_PATH} carries no entries`);
  return parsed;
}

/** 快照不存在时的起点。只有 `--live` / `--freeze` 用得上它。 */
function bootstrapFrozen() {
  return {
    provenance: { generatedAt: null, note: 'bootstrap from the sibling experiment\'s corpus — no readings taken yet' },
    entries: loadCorpus().map((c) => ({
      clip: c.clip,
      language: c.language,
      reference: c.reference,
      audio: {},
      transcripts: {},
      runs: {},
      latencyMs: {},
    })),
  };
}

function saveFrozen(frozen) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FROZEN_PATH, `${JSON.stringify(frozen, null, 2)}\n`);
}

/**
 * 对应关系检查：快照里每条转录所对应的音频，必须**就是**出货模块当前产出的字节。
 *
 * 快照为每条片段 × 每条裁剪列钉了 sha256；这里从上一份实验的 fixture wav 重解、经
 * `trimVoiceAudio` 重编、逐字节比对。一份「等价但不同」的裁剪、或一个陈旧的算法副本，会在
 * sha256 上红，而不是靠一个碰巧接近的时长蒙混过去。它还顺带钉住「语料没有被复制过」这条：
 * 音频只有上一份实验的那一份，路径写死在那儿。
 */
export function correspondenceFailures(entries) {
  const onDisk = readdirSync(CORPUS_FIXTURES).filter((f) => f.endsWith('.wav')).sort();
  const named = entries.map((e) => e.clip);
  const failures = [];
  let checked = 0;

  for (const clip of onDisk) if (!named.includes(clip)) failures.push(`corpus fixture ${clip} has no entry in the frozen snapshot`);
  for (const clip of named) if (!onDisk.includes(clip)) failures.push(`entry ${clip} names an audio file that is not in ${CORPUS_FIXTURES}`);

  for (const entry of entries) {
    if (!onDisk.includes(entry.clip)) continue;
    const { samples, sampleRate } = decodeWav(join(CORPUS_FIXTURES, entry.clip));
    for (const trim of TRIMS) {
      const { bytes, stats } = encodeColumn(samples, sampleRate, trim);
      checked += 1;
      const recorded = entry.audio?.[`${trim}Sha256`];
      if (recorded !== sha256(bytes)) {
        failures.push(
          `${entry.clip}/${trim}: the frozen transcript was not taken from this module's audio ` +
            `(sha256 ${recorded ?? 'missing'} != ${sha256(bytes)} re-derived here)`,
        );
      }
      if (stats && Math.abs(stats.savedRatio - entry.audio?.[`${trim}SavedRatio`]) > 1e-9) {
        failures.push(`${entry.clip}/${trim}: savedRatio ${entry.audio?.[`${trim}SavedRatio`]} != the module's ${stats.savedRatio}`);
      }
    }
  }
  return { failures, checked };
}

/** 上一条检查的**证伪器**：把一条片段的 sha 改坏，同一段代码路径必须报红。 */
function correspondenceCanary(entries) {
  const [entry] = entries;
  if (!entry) return { fired: false, reason: 'no entries to build a canary from' };
  const corrupted = { ...entry, audio: { ...entry.audio, rawSha256: '0'.repeat(64) } };
  const { failures } = correspondenceFailures([corrupted]);
  return { fired: failures.some((f) => f.includes('/raw:')), reason: failures[0] ?? 'no failure reported' };
}

// ---------------------------------------------------------------------------
// 读数与配对。
// ---------------------------------------------------------------------------

function readingOf(reference, text, latencyMs) {
  const fidelity = identifierFidelity(reference, text);
  return {
    marks: sentenceMarks(text),
    naive: naiveMarks(text),
    identifiers: fidelity.total,
    survived: fidelity.survived,
    missing: fidelity.missing,
    cer: cer(reference, text),
    latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
    // token 数这条轴**读不到**：出货适配器的 `meta` 只带 model，契约里的 `meta.usage` 两个适配器
    // 都没填。这里如实记 null，由报告与记录写明，而不是拿一个别处的数字冒充。
    tokens: null,
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
    if (drop && condition.key === drop) return null;
    if (control && condition.key === control.key && controlVariant !== 'real') {
      // 变异：负对照的读数被**替换**（或被清空），与快照里本来有没有它无关 —— 一个「只在缺失时
      // 才生效」的变异等于没有触发，而快照里它是有读数的。
      if (controlVariant === 'zero') {
        const base = entry.transcripts[control.control.vs];
        if (typeof base !== 'string') return null;
        return base;
      }
      // 反方向：拿参照条件的读数再加一个句末标点。合成的文本在**证伪器**里是合法的 —— 它测的是
      // checker 能不能看见反向位移，不是某次识别结果。
      if (controlVariant === 'inverted') {
        const base = entry.transcripts[control.control.vs];
        return typeof base === 'string' ? `${base}。` : null;
      }
      if (controlVariant === 'empty') return null;
    }
    const text = entry.transcripts?.[condition.key];
    return typeof text === 'string' ? text : null;
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
      survived: sum((r) => r.survived),
      identifiers: sum((r) => r.identifiers),
      cerMean: rows.length ? sum((r) => r.cer) / rows.length : null,
      latencyMean: latencies.length ? latencies.reduce((a, v) => a + v, 0) / latencies.length : null,
      tokens: null,
    });
  }

  return { conditions, control, paired, columns, readings: paired.length * conditions.length };
}

/**
 * 负对照的方向判定，与它的三种「不能红」形态。
 *
 * 返回 `{ status, detail }`：`moved` 是按预测方向动了；`flat` 是没动（位移 0）；`against` 是朝
 * 反方向动了；`absent` 是负对照根本不在条件表里；`empty` 是这一轴没有可读的位移。后四种都必须让
 * 运行红。**每一种 detail 都点名负对照的条件键**（`g25lite|raw|flat`）：一条只说「负对照不见了」
 * 的判词读不出红在哪一位。
 */
export function controlVerdict(result) {
  const control = result.control ?? controlCondition(CONDITIONS);
  if (!control) return { status: 'absent', detail: '条件表里没有声明负对照', delta: null, up: 0, same: 0, down: 0 };
  const axis = control.control.axis;
  const mine = result.columns.get(control.key);
  const theirs = result.columns.get(control.control.vs);
  if (!mine) {
    return {
      status: 'absent',
      detail: `${control.key} 不在本次条件表里 —— 「${control.control.axis} 相对 ${control.control.vs} ${control.control.direction}」这条预测没有被执行`,
      delta: null, up: 0, same: 0, down: 0,
    };
  }
  if (!theirs) {
    return {
      status: 'absent',
      detail: `${control.key} 的参照条件 ${control.control.vs} 不在本次条件表里 —— 没有可读的位移`,
      delta: null, up: 0, same: 0, down: 0,
    };
  }
  if (!theirs.n) {
    return { status: 'empty', detail: `${control.key} vs ${control.control.vs}：参照条件在配对集合里一条读数都没有`, delta: null, up: 0, same: 0, down: 0 };
  }

  let up = 0;
  let same = 0;
  let down = 0;
  for (const row of mine.rows) {
    const base = theirs.rows.find((r) => r.clip === row.clip);
    if (!base) continue;
    if (row[axis] > base[axis]) up += 1;
    else if (row[axis] < base[axis]) down += 1;
    else same += 1;
  }
  const delta = mine[axis] - theirs[axis];
  const perClip = `${up}↑ ${same}= ${down}↓`;
  const detail = `${control.key} ${axis}=${mine[axis]} vs ${control.control.vs} ${axis}=${theirs[axis]} (Δ=${delta}, ${perClip})`;

  if (theirs[axis] === 0 && mine[axis] === 0) {
    return { status: 'empty', detail: `${detail} —— 两个条件在这一轴上都是 0，没有可读的位移`, delta, up, same, down };
  }
  if (delta === 0) return { status: 'flat', detail: `${detail} —— 负对照没有移动`, delta, up, same, down };
  if (control.control.direction === 'down' ? delta < 0 : delta > 0) {
    return { status: 'moved', detail: `${detail} —— 按预测方向（${control.control.direction}）移动`, delta, up, same, down };
  }
  return { status: 'against', detail: `${detail} —— 朝预测的**反方向**移动`, delta, up, same, down };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const fmt = (v, n) => (v === null || v === undefined ? 'null' : Number(v).toFixed(n));

function printColumn(column) {
  const { condition, n } = column;
  console.log(
    `\n  ${pad(condition.key, 18)} n=${n}  marks ${column.marks} (mean ${fmt(column.marks / (n || 1), 2)})  ` +
      `naive ${column.naive}  identifiers ${column.survived}/${column.identifiers}  CER ${fmt(column.cerMean, 4)}  ` +
      `latency ${fmt(column.latencyMean, 0)}ms  tokens ${column.tokens === null ? 'n/a' : column.tokens}`,
  );
  for (const row of column.rows) {
    console.log(
      `      ${pad(row.clip, 14)} n=1  marks=${row.marks} naive=${row.naive}  ` +
        `id=${row.survived}/${row.identifiers}  cer=${fmt(row.cer, 4)}  latency=${row.latencyMs ?? 'null'}ms` +
        (row.missing.length ? `  lost=[${row.missing.join(', ')}]` : ''),
    );
  }
}

/** 每条条件的文本逐条列出 —— 位置是否合理只能人读，所以原文必须落在 stdout 上。 */
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

function printControl(result) {
  const verdict = controlVerdict(result);
  const ok = verdict.status === 'moved';
  console.log('\nnegative control (the `flat` shape — the report must say whether it moved, not that it ran):');
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${verdict.detail}`);
  return { verdict, ok };
}

// ---------------------------------------------------------------------------
// 自检：把「能红」做成机检，而不是文档里的一句话。
//
// 七条变异，每条都必须红；真实快照必须绿。缺了正面的一半，一个「永远返回红」的 checker 也能
// 通过全部变异 —— 所以真实快照的绿读数与变异红是同一个断言的两半。
// ---------------------------------------------------------------------------

export function assertFalsifiers(frozen, { conditions = CONDITIONS } = {}) {
  const failures = [];
  const summary = [];

  const real = measure(frozen, { conditions });
  const realVerdict = controlVerdict(real);
  if (realVerdict.status !== 'moved') {
    failures.push(`real snapshot: the negative control is ${realVerdict.status}, not moved (${realVerdict.detail})`);
  }
  summary.push(`real=${realVerdict.status}(${realVerdict.delta})`);
  if (!real.paired.length) failures.push('real snapshot: the paired set is empty');
  if (!real.readings) failures.push('real snapshot: zero readings');

  const variants = [
    ['control=absent', { conditions: conditions.filter((c) => !c.control) }, 'absent'],
    ['control=zero', { conditions, controlVariant: 'zero' }, 'flat'],
    ['control=inverted', { conditions, controlVariant: 'inverted' }, 'against'],
    ['control=empty', { conditions, controlVariant: 'empty' }, 'empty'],
    [`drop=${conditions[0].key}`, { conditions, drop: conditions[0].key }, 'empty'],
  ];
  for (const [label, opts, expected] of variants) {
    const result = measure(frozen, opts);
    const verdict = controlVerdict(result);
    const red = verdict.status !== 'moved';
    if (!red) failures.push(`${label}: expected the run to red, got "${verdict.status}" (${verdict.detail})`);
    if (red && verdict.status !== expected) {
      failures.push(`${label}: red for the wrong reason — expected "${expected}", got "${verdict.status}" (${verdict.detail})`);
    }
    summary.push(`${label}=${verdict.status}`);
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
  } else if (!straddle.some((f) => f.includes('1970-01-01T00:00:00.000Z'))) {
    failures.push(`runs=straddle: red for the wrong reason — ${straddle[0]}`);
  } else {
    summary.push('runs=straddle=red');
  }

  return { failures, summary, real };
}

// ---------------------------------------------------------------------------
// S1 真实读数（联网 + 凭据）。按协议第 7 条**串行**：一条一条发，不并发。
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

/**
 * 两个服务各自的凭据来源，都在**仓库外**（不在任何提交里，AC8）。
 *
 * Groq 在 `/data/home/yale/work/tc-verify/.env`（上一份记录用的同一个文件，mode 600），Gemini 在
 * 主检出根部被 git 忽略的 `.env.test`。文件名与变量名在这里写死而不是靠环境碰运气：一个读不到
 * 凭据的运行必须**指名**它找了哪里，而不是发一个匿名的请求过去收 401。
 */
const ENV_TEST = resolve(mainCheckoutRoot(), '.env.test');
const CREDENTIAL_SOURCES = {
  'openai-compatible': { envFile: '/data/home/yale/work/tc-verify/.env', vars: ['GROQ_BASE_URL', 'GROQ_API_KEY'], defaultBaseUrl: 'https://api.groq.com/openai/v1' },
  multimodal: { envFile: ENV_TEST, vars: ['GEMINI_BASE_URL', 'GEMINI_API_KEY'], defaultBaseUrl: 'https://generativelanguage.googleapis.com' },
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

/** 每个 provider 的 baseUrl / apiKey，以及它读了哪个文件（供错误信息点名）。 */
export function loadCredentials() {
  const targets = {};
  for (const [providerId, source] of Object.entries(CREDENTIAL_SOURCES)) {
    const fromFile = readEnvFile(source.envFile);
    const pick = (name) => process.env[name] ?? fromFile[name] ?? '';
    targets[providerId] = {
      envFile: source.envFile,
      baseUrl: pick(source.vars[0]) || source.defaultBaseUrl,
      apiKey: pick(source.vars[1]),
    };
  }
  return targets;
}

/** 与上一份记录一致的最小间隔：Groq on_demand 约 20 RPM，并发会把预算花在 429 上。 */
const MIN_INTERVAL_MS = Number(process.env.VOICE_PAIRED_MIN_INTERVAL_MS ?? 3200);
const TIMEOUT_MS = Number(process.env.VOICE_PAIRED_TIMEOUT_MS ?? 120000);
let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

const RETRYABLE = /RATE_LIMITED|TIMEOUT|UNREACHABLE|answered (?:429|500|502|503|504)/;

/**
 * 一个条件的**唯一**发出点：出货适配器 + 全局 `fetch`，`fetchImpl` 不包装、`AsrRequest` 的 body
 * 由适配器自己构造。任何一处「runner 自己拼请求」都会让读数量到 runner 的线协议而不是产品的，
 * 而这条错误在读数上是看不出来的 —— 它只会在源码里看得出来（见 `selfSourceFailures`）。
 *
 * 延迟在这里量：`transcribe` 调用前后各一个时钟，所以它是**适配器那一跳**的墙钟，不含节流等待。
 */
async function invokeCondition(condition, bytes, adapters, credentials, { retries = 3 } = {}) {
  const adapter = adapters.get(condition.providerId);
  const target = credentials[condition.providerId];
  if (!adapter) throw new Error(`no adapter resolved for provider '${condition.providerId}'`);
  if (!target?.apiKey) {
    throw new Error(
      `--live / --freeze need a credential for provider '${condition.providerId}' ` +
        `(looked for ${CREDENTIAL_SOURCES[condition.providerId].vars[1]} in ${target?.envFile ?? '(nowhere)'})`,
    );
  }
  const context = condition.context === 'none' ? undefined : PROMPTS[condition.context];

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const started = Date.now();
    const result = await adapter.transcribe(
      {
        audio: { bytes: new Uint8Array(bytes), mimeType: 'audio/wav', fileName: 'clip.wav' },
        hints: context === undefined ? undefined : { context },
      },
      {
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: condition.model,
        timeoutMs: TIMEOUT_MS,
        fetchImpl: fetch,
      },
    );
    const latencyMs = Date.now() - started;
    if (result.ok) {
      return {
        text: result.text,
        latencyMs,
        style: result.style,
        transformations: result.transformations,
        usage: result.meta?.usage ?? null,
      };
    }
    const message = `provider '${condition.providerId}' (${condition.model}) failed: ${result.code}: ${result.message}`;
    if (attempt < retries && RETRYABLE.test(message)) {
      await sleep((attempt + 1) * 4000);
      continue;
    }
    throw new Error(message);
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
 * `--fresh`。一个不做这个检查的 runner 会在第二次运行之后安静地产出一张跨运行的配对表。
 */
export function assertSingleRun(runIds) {
  const runs = [...new Set(runIds.filter(Boolean))];
  if (runs.length <= 1) return [];
  const perRun = runs.map((run) => `${run} (${runIds.filter((r) => r === run).length} reading(s))`);
  return [
    `the readings come from ${runs.length} different runs (${perRun.join('; ')}) — a paired comparison must not straddle runs. ` +
      'Re-take the whole set with --live --fresh.',
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
 * 跑一遍全部条件（串行）。
 *
 * 音频**只能**由出货模块产生（协议第 3 条）：`raw` 列是解码后的样本直接重编，裁剪列经
 * `trimVoiceAudio`。缓存键含条件键（内含模型 tag），所以「同一个条件」是可复用的，
 * 而「不同条件」永远不会互相冒充。
 */
export async function runLive(frozen, adapters, credentials, { conditions = CONDITIONS, log = console.log, fresh = false } = {}) {
  const run = fresh ? new Date().toISOString() : null;
  const cache = fresh ? { entries: {} } : loadCache();
  const activeRun = run ?? cache.entries[Object.keys(cache.entries)[0]]?.run ?? new Date().toISOString();
  const entries = frozen.entries.map((entry) => ({
    ...entry,
    audio: { ...entry.audio },
    transcripts: { ...entry.transcripts },
    runs: { ...entry.runs },
    latencyMs: { ...entry.latencyMs },
  }));
  let fetched = 0;

  for (const entry of entries) {
    const { samples, sampleRate } = decodeWav(join(CORPUS_FIXTURES, entry.clip));
    entry.audio.baselineSec = samples.length / sampleRate;
    const columns = new Map();
    for (const trim of TRIMS) {
      const { bytes, stats } = encodeColumn(samples, sampleRate, trim);
      columns.set(trim, bytes);
      entry.audio[`${trim}Sha256`] = sha256(bytes);
      if (stats) entry.audio[`${trim}SavedRatio`] = stats.savedRatio;
    }
    // 串行：条件 × 片段，一个一个 await，没有并发（协议第 7 条）。
    for (const condition of conditions) {
      const key = `${condition.key}|${entry.clip}`;
      const hit = cache.entries[key];
      if (hit && typeof hit.text === 'string') {
        entry.transcripts[condition.key] = hit.text;
        entry.runs[condition.key] = hit.run;
        entry.latencyMs[condition.key] = hit.latencyMs ?? null;
        continue;
      }
      const result = await invokeCondition(condition, columns.get(condition.trim), adapters, credentials);
      cache.entries[key] = { text: result.text, run: activeRun, takenAt: new Date().toISOString(), latencyMs: result.latencyMs, usage: result.usage };
      entry.transcripts[condition.key] = result.text;
      entry.runs[condition.key] = activeRun;
      entry.latencyMs[condition.key] = result.latencyMs;
      fetched += 1;
      log(`  fetched ${key} (${result.latencyMs} ms)`);
      saveCache(cache);
    }
  }
  return { entries, fetched, cached: Object.keys(cache.entries).length, run: activeRun };
}

function freeze(entries, credentials) {
  const runIds = [...new Set(runIdsOf(entries).filter(Boolean))];
  const frozen = {
    provenance: {
      generatedAt: new Date().toISOString().slice(0, 10),
      runIds,
      endpoints: Object.fromEntries(
        Object.entries(CREDENTIAL_SOURCES).map(([providerId, source]) => [
          providerId,
          `${(credentials[providerId]?.baseUrl ?? source.defaultBaseUrl).replace(/\/$/, '')} (via the shipping '${providerId}' adapter)`,
        ]),
      ),
      request:
        'Every condition goes through the adapter the shipping registry resolves for its provider id, with the global fetch and the request body the adapter builds. ' +
        'The multimodal conditions carry the reference-context conditions as `hints.context` (the adapter declares honors.context: true) and nothing else; ' +
        'its own verbatim transcription instruction is the adapter\'s, not this runner\'s.',
      throttle: `${MIN_INTERVAL_MS} ms minimum interval between calls, one call in flight (serial)`,
      recipe:
        "For every clip × condition: decode the sibling experiment's fixtures/<clip> with the runner's decodeWav, encode the column with the runner's encodeWav " +
        '(raw = encodeWav(decodeWav(file)); trimFrozen = trimVoiceAudio(samples, rate) — the shipping module), hand the buffer to the shipping adapter, keep the returned text verbatim. ' +
        '`--live` then `--freeze`; the cache is out/quality-cache.json.',
      corpus:
        "Reused, not copied: the eight Chinese clips at o65 occupancy (d01..d08-o65) live in ../voice-provider-paired-quality/fixtures/ — a contiguous prefix of the " +
        'out-of-tree dictation corpus, **TTS 合成** (tools/dictation-corpus.mjs SCRIPTS). Same eight clips as the previous record, so the two records\' numbers are on the same corpus.',
      referenceSource:
        'Read from ../voice-provider-paired-quality/fixtures/paired.json — the authored scripts from the out-of-tree corpus generator, verbatim, so the reference is ground truth by construction.',
      conditions: CONDITIONS.map((c) => ({ key: c.key, providerId: c.providerId, model: c.model, trim: c.trim, context: c.context, note: c.note })),
      prompts: PROMPTS,
      knownGaps:
        'Token usage is not readable through the shipping adapters: `AsrSuccess.meta.usage` exists in the contract but neither adapter populates it, so this record reports the axis as n/a rather than substituting a number from elsewhere.',
    },
    entries,
  };
  saveFrozen(frozen);
  return frozen;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** 记录与 runner 的自陈。**必须**是每次运行打印的末行（AC7：不判据化）。 */
export const DISCLAIMER = 'quality numbers are a reading and are NOT a criterion';

export async function main(argv = process.argv.slice(2)) {
  // 两种写法都算：`--live` 与 `--corpus=empty`。只认前者会让所有 `--k=v` 变异**静默失效**
  // —— 一个「没生效的变异」与「变异生效但没红」在退出码上完全一样。
  const flag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const value = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  // 末行自陈走**所有**出口，包括 `--probe` 与各种红的出口：一条只在happy path 上出现的自陈，
  // 在一个红的运行里读起来就像这个 runner 是个闸。
  const finish = (code) => {
    console.log(`\n${DISCLAIMER} (ADR-004 decision 8)`);
    return code;
  };

  const failures = [];
  console.log('voice-gemini-paired-quality — paired comparison across provider × trim × context, on the shipping adapters (a reading, not a gate)');
  printProbe();

  let registry = null;
  let registryError = null;
  try {
    registry = await import(REGISTRY_SPECIFIER);
  } catch (error) {
    registryError = error?.message ?? String(error);
  }

  const probeFailures = assertShippingModules(registry, registryError);
  for (const f of probeFailures) failures.push(`[probe] ${f}`);
  console.log(`  ${probeFailures.length ? 'FAIL' : 'ok  '} the shipping modules resolve, the registry hands out the multimodal adapter, and this harness builds no Gemini request of its own`);

  if (flag('probe')) {
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    return finish(failures.length ? 1 : 0);
  }

  const credentials = loadCredentials();

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
  const conditions = flag('control') && value('control') === 'absent' ? CONDITIONS.filter((c) => !c.control) : CONDITIONS;

  // 一次运行取全部条件（`--live` / `--freeze` 共用同一次 pass）。
  if (flag('live') || flag('freeze')) {
    const missing = PROVIDER_IDS.filter((id) => !credentials[id]?.apiKey);
    if (missing.length) {
      for (const id of missing) {
        process.stderr.write(
          `FAIL: --live / --freeze need a credential for provider '${id}' ` +
            `(looked for ${CREDENTIAL_SOURCES[id].vars[1]} in ${CREDENTIAL_SOURCES[id].envFile})\n`,
        );
      }
      return finish(2);
    }
    const adapters = new Map(PROVIDER_IDS.map((id) => [id, registry.resolve(id)]));
    const live = await runLive(frozen, adapters, credentials, { fresh: flag('fresh') });
    frozen = { ...frozen, entries: live.entries };
    console.log(`\nlive: run=${live.run} fetched=${live.fetched} cached=${live.cached} cache=${CACHE_PATH} (serial, ${MIN_INTERVAL_MS} ms apart)`);
    if (flag('freeze')) {
      const straddles = assertSingleRun(runIdsOf(live.entries));
      if (straddles.length) {
        for (const f of straddles) process.stderr.write(`FAIL: ${f}\n`);
        return finish(1);
      }
      frozen = freeze(live.entries, credentials);
      console.log(`frozen: ${FROZEN_PATH} (${live.entries.length} entries, run ${live.run})`);
    }
  }

  // `--runs=straddle` 是**变异**：把一条读数挪到另一个 run id 上，配对断言必须红。
  if (flag('runs') && value('runs') === 'straddle') frozen = straddleSnapshot(frozen);

  // AC1：配对集合与读数条数。空读数不是绿。
  const result = measure(frozen, { conditions, drop: value('drop'), controlVariant: value('control') ?? 'real' });
  console.log(`\ncorpus: ${frozen.entries.length} clip(s) in the snapshot, ${result.paired.length} in the paired set (every condition returned a reading)`);
  console.log(`readings: n=${result.paired.length} × ${conditions.length} condition(s) = ${result.readings} row(s), n = clips = ${result.paired.length}`);
  if (!result.paired.length) failures.push(`[n] the paired set is empty — n=0 is not a green reading (snapshot ${frozen.entries.length} clip(s), ${conditions.length} condition(s))`);
  if (!result.readings) failures.push('[n] zero reading rows — an empty reading is not a green reading');

  // AC3：配对集合内的读数必须来自**同一次运行**（协议第 1 条）。
  const runs = [...new Set(runIdsOf(frozen.entries).filter(Boolean))];
  const straddles = assertSingleRun(runIdsOf(frozen.entries));
  console.log(`\nrun: ${runs.length ? runs.join(', ') : '(no run id — snapshot taken before run ids were recorded)'} — ${runs.length <= 1 ? 'single run, so the pairing does not straddle runs' : 'MORE THAN ONE RUN'}`);
  for (const f of straddles) failures.push(`[pairing] ${f}`);

  // 冻结快照的音频必须就是出货模块的输出（含证伪器）。
  const canary = correspondenceCanary(frozen.entries);
  console.log(`\ncorrespondence (the frozen transcript must be this shipping module's audio, byte for byte):`);
  console.log(`  canary=${canary.fired ? 'RED' : 'GREEN'} ${canary.fired ? 'corrupted hash detected' : 'NOT detected — the check is blind'}`);
  if (!canary.fired) failures.push(`[correspondence] canary not detected (${canary.reason}) — a green snapshot reading would be worthless`);
  const correspondence = correspondenceFailures(frozen.entries);
  console.log(`  snapshot=${correspondence.failures.length ? 'RED' : 'GREEN'} checked ${correspondence.checked} encoded column(s)`);
  for (const f of correspondence.failures) {
    console.log(`    - ${f}`);
    failures.push(`[correspondence] ${f}`);
  }

  // 读数。
  for (const column of result.columns.values()) printColumn(column);

  // AC2：负对照是否按预测方向移动 —— 报告的是**方向**，不是「跑过了」。
  const { verdict, ok } = printControl(result);
  console.log(`  predicted: ${result.control ? result.control.control.axis : '(none)'} ${result.control ? result.control.control.direction : ''} vs ${result.control ? result.control.control.vs : '(none)'}`);
  console.log(`  punct − flat: ${result.columns.get('g25lite|raw|punct')?.marks ?? 'n/a'} − ${result.columns.get('g25lite|raw|flat')?.marks ?? 'n/a'} marks (isolates the context's sentence-final punctuation as the single variable)`);
  if (!ok) failures.push(`[control] ${verdict.detail}`);

  printPairedText(result);

  // 自检 —— 七条变异各自必须红，且红在预期的位置上。
  const selfTest = assertFalsifiers(frozen, { conditions });
  console.log('\nfalsifiers (each variant must red, and red for the stated reason):');
  console.log(`  ${selfTest.summary.join('  ')}`);
  for (const f of selfTest.failures) failures.push(`[falsifier] ${f}`);

  if (failures.length) {
    process.stderr.write(`\nvoice-gemini-paired-quality: ${failures.length} failure(s)\n`);
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    return finish(1);
  }

  console.log(
    `\nvoice-gemini-paired-quality: OK — n=${result.paired.length}, ${result.readings} paired reading(s), ` +
      `negative control moved ${verdict.delta} (${verdict.up}↑ ${verdict.same}= ${verdict.down}↓); ` +
      `${DISCLAIMER} (ADR-004 decision 8)`,
  );
  return finish(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`FAIL: ${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}
