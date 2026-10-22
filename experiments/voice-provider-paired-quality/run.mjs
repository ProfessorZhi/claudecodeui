#!/usr/bin/env node
/**
 * ADR-004 后续任务 10 —— **配对质量实验记录**（provider × 裁剪 × 上下文）。
 *
 * 现场：ADR-004 决策 6 把「每接入一个识别服务就重跑一次该服务的配对实验」写成一条持续的
 * 验证义务；决策 8 把质量读数**排除在判据集之外**（联网、按条件数计请求、且至少一轴只能
 * 靠人读），代价是质量回归不会被 CI 自动发现 —— 只能靠「每接入一个服务写一份记录」这条
 * 人工义务。本文件就是这份记录**可复算的那一半**：把配对比较的机械部分做成一个离线可跑、
 * 且能红的 runner，人读的那一半（配对文本本身）由记录文档承担。
 *
 * 协议按 `docs/experiments/README.md`：
 *
 *   第 1 条 配对比较不跨运行 —— 所有条件在**同一批片段**上跑，配对集合取交集，
 *           每条读数旁边打印 `n`。跨运行的数不并列。
 *   第 2 条 必须有能红的负对照 —— 这里沿用既有 `flat`（同一个 prompt 去掉句末标点）：
 *           它**必须相对 `none` 下降**，否则「prompt 的标点被镜像」这个解释不成立。
 *           负对照不是「写了就算」：`--control=absent|zero|inverted` 三个变体各打一个洞，
 *           本文件在离线自检里逐个要求它们**红**（见 assertFalsifiers）。
 *   第 3 条 被测实现必须是出货模块 —— 裁剪那一轴的音频**只能**由 `src/shared/voiceTrim.ts`
 *           的 `trimVoiceAudio` 产生，标识符口径**只能**是 `src/shared/identifierFidelity.ts`。
 *           本文件在启动时打印两者的绝对路径与符号名（probe），并断言它们在出货树内、
 *           不在本工装内。工装里没有第二份裁剪实现，也没有第二份标识符实现。
 *   第 7 条 串行执行 —— 真实请求一条一条发，不并发。
 *   第 8 条 结果落盘缓存 —— 真实读数落在 `out/quality-cache.json`，冻结快照落在
 *           `fixtures/paired.json`，默认运行只读冻结快照，**不联网**。
 *
 * 三个轴（条件）：
 *
 *   provider   whisper-large-v3-turbo / whisper-large-v3（同一端点，不同模型）
 *   trim       raw（原音频）/ trimFrozen（出货停顿表）
 *   context    none（无 prompt）/ punct（带标点的 prompt）/ flat（**负对照**：同一个 prompt
 *              去掉句末标点，标识符的点两侧都保留，所以这一对只差一个变量）
 *
 * 质量轴（都是**读数**，不是闸 —— 决策 8）：
 *
 *   marks       句读/片段 —— 先蒙掉标识符内部的点再数 `[.!?。！？]`。口径与标点实验一致
 *               （`tools/punct-lib.mjs` 的 `sentenceMarks`）；`naive` 是未蒙版的计数，只作
 *               与旧读数（2.06 → 1.00）连续性用。
 *   identifiers 标识符逐字存活 —— 出货模块，逐字敏感。
 *   cer         出货外的 Whisper 归一化 + Levenshtein，与 voice-trim 的 runner 同一口径。
 *
 * 运行：
 *   node experiments/voice-provider-paired-quality/run.mjs                # 离线：冻结快照 + 负对照 + 自检
 *   node experiments/voice-provider-paired-quality/run.mjs --live         # 加跑真实服务（联网 + 凭据），串行，落盘
 *   node experiments/voice-provider-paired-quality/run.mjs --freeze       # 把 out/quality-cache.json 冻成 fixtures/paired.json
 *   node experiments/voice-provider-paired-quality/run.mjs --probe         # 只打印所驱动的出货模块
 *
 * 自检用的变异（都应当**非零退出**，AC1/AC2/AC4 的机检形态）：
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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { identifierFidelity } from '../../src/shared/identifierFidelity.ts';
import { trimVoiceAudio } from '../../src/shared/voiceTrim.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = HERE;
const FIXTURE_DIR = join(HERE, 'fixtures');
const FROZEN_PATH = join(FIXTURE_DIR, 'paired.json');
const OUT_DIR = join(HERE, 'out');
const CACHE_PATH = join(OUT_DIR, 'quality-cache.json');

/**
 * 出货树与出货模块 —— 绝对路径，probe 段打印它们，`assertShippingModules()` 断言
 * 两者都在出货树内且都不在本工装内。用导入说明符解析，而不是拼字符串：一个拼错的
 * 路径会打印得漂漂亮亮却指向不存在的东西，解析出来的不会。
 */
const REPO_ROOT = resolve(HERE, '..', '..');
const TRIM_MODULE = fileURLToPath(new URL('../../src/shared/voiceTrim.ts', import.meta.url));
const FIDELITY_MODULE = fileURLToPath(new URL('../../src/shared/identifierFidelity.ts', import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// WAV 编解码。不是被测算法：模块收 Float32Array，字节与样本之间的转换由调用方负责，
// 这里就是那个调用方。冻结快照里的 sha256 是**经这两个函数**取的，所以两者都导出。
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
 * 裁剪那一轴：把出货模块的输出编回字节。`trim` 为 `raw` 时不碰样本 —— 这一列的
 * 「没有裁剪」是它全部的意义，所以它走的是 `encodeWav(decodeWav(file))`，
 * 而不是把文件原字节当缓存键（文件的头可能与本编码器不同，字节就不是同一个东西）。
 */
function encodeColumn(samples, sampleRate, trim) {
  if (trim === 'raw') return { bytes: encodeWav(samples, sampleRate), stats: null };
  if (trim !== 'trimFrozen') throw new Error(`unknown trim column: ${trim}`);
  const result = trimVoiceAudio(samples, sampleRate, {});
  return { bytes: encodeWav(result.samples, sampleRate), stats: result.stats };
}

// ---------------------------------------------------------------------------
// 质量轴。都是「围绕出货算法的量具」，与 voice-trim 的 runner 同一口径；
// 被测算法本身（裁剪、标识符判定）一律 import，不在这里重写。
// ---------------------------------------------------------------------------

/**
 * 蒙掉标识符内部的点 —— 口径逐字沿用标点实验的 `maskInternalDots`。
 *
 * **没有 `\S*` 前缀**，那是一个已付过代价的 bug：`\S*\.(?=[\p{L}\p{N}])` 贪婪且只被空白
 * 界定，而中文没有空白，一次匹配会从句首吃到最后一个标识符点、把整句删空 —— 只测英文
 * 会得到一个干净且完全错误的中文结论（README 第 4 条的由来）。
 */
export const maskInternalDots = (text) => String(text).replace(/\.(?=[\p{L}\p{N}])/gu, '');

/** 句读/片段 —— 蒙版后的 `[.!?。！？]` 计数。这是本记录的主轴。 */
export const sentenceMarks = (text) => (maskInternalDots(text).match(/[.!?。！？]/g) ?? []).length;

/** 未蒙版的计数，只作旧读数（2.06 → 1.00）的连续性用。 */
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
// S0 条件表。三个轴交叉，所有条件在**同一批片段**上跑（协议第 1 条）。
//
// `punct` 与 `flat` 是同一个 prompt，只差句末标点，标识符的点两侧都保留 —— 所以这一对
// 的差值隔离出的就是「prompt 的标点」这一个变量，负对照才therefore 有意义。
// ---------------------------------------------------------------------------

export const PROMPTS = {
  punct:
    '把 voice.service.ts 的超时改成三十秒。然后看一下 useVoiceInput 这个 hook，再更新 voice.routes.ts。',
  flat: '把 voice.service.ts 的超时改成三十秒 然后看一下 useVoiceInput 这个 hook 再更新 voice.routes.ts',
};

export const CONDITIONS = [
  {
    key: 'turbo|raw|none',
    provider: 'whisper-large-v3-turbo',
    model: 'whisper-large-v3-turbo',
    trim: 'raw',
    context: 'none',
    note: '今天的产品行为：不裁剪、无 prompt —— 参照条件',
  },
  {
    key: 'turbo|raw|punct',
    provider: 'whisper-large-v3-turbo',
    model: 'whisper-large-v3-turbo',
    trim: 'raw',
    context: 'punct',
    note: '加带标点的 prompt',
  },
  {
    key: 'turbo|raw|flat',
    provider: 'whisper-large-v3-turbo',
    model: 'whisper-large-v3-turbo',
    trim: 'raw',
    context: 'flat',
    note: '同一个 prompt 去掉句末标点 —— 负对照',
    // 负对照的预测：相对参照条件（context=none，同一批片段）句读必须**下降**。
    control: { axis: 'marks', vs: 'turbo|raw|none', direction: 'down' },
  },
  {
    key: 'turbo|trim|none',
    provider: 'whisper-large-v3-turbo',
    model: 'whisper-large-v3-turbo',
    trim: 'trimFrozen',
    context: 'none',
    note: '出货停顿表裁剪、无 prompt',
  },
  {
    key: 'v3|raw|none',
    provider: 'whisper-large-v3',
    model: 'whisper-large-v3',
    trim: 'raw',
    context: 'none',
    note: '换识别模型（provider 轴）',
  },
];

/** 取条件表里被声明为负对照的那一条；没有就是调用错误，不是静默退化。 */
export const controlCondition = (conditions = CONDITIONS) =>
  conditions.find((c) => c.control) ?? null;

// ---------------------------------------------------------------------------
// S0 语料。固定：8 条中文 o65 片段（`d01..d08-o65`），是仓库外口述语料 o65 档的一个
// **连续前缀**（不是挑出来的）。语料音频不入库是既有决定；这 8 条进仓库，是为了让冻结
// 快照的对应关系能被**离线重算**（见 correspondence）。
// ---------------------------------------------------------------------------

export const CORPUS = [
  { clip: 'd01-o65.wav', reference: '把 server 里的 voice.service.ts 的超时改成三十秒' },
  { clip: 'd02-o65.wav', reference: '改一下 voice.service.ts，嗯不对，应该是 voice.routes.ts' },
  { clip: 'd03-o65.wav', reference: '看一下 useVoiceInput 这个 hook 是怎么处理 recording 的' },
  { clip: 'd04-o65.wav', reference: '不要动 voice.service.ts，只改 voice.module.ts' },
  { clip: 'd05-o65.wav', reference: '把超时从十五秒改成五十秒，不是五秒' },
  { clip: 'd06-o65.wav', reference: '嗯…那个…就是这个 composer 的按钮，嗯…再加个快捷键' },
  { clip: 'd07-o65.wav', reference: 'server 模块下的 voice 目录里加一个 call 的测试' },
  { clip: 'd08-o65.wav', reference: '把默认模型换成 whisper large，啊不，是 whisper turbo' },
];

// ---------------------------------------------------------------------------
// probe —— AC4 的机检形态：打印所驱动的出货模块的绝对路径 + 符号名，并断言两者都在
// 出货树内、都不在本工装内。一个把算法抄了一份的工装会在这里红，因为那条路径必然
// 落在 experiments/ 下。
// ---------------------------------------------------------------------------

export function assertShippingModules() {
  const failures = [];
  const inside = (p) => p === REPO_ROOT || p.startsWith(`${REPO_ROOT}/`);
  const inHarness = (p) => p === HARNESS_DIR || p.startsWith(`${HARNESS_DIR}/`);

  for (const [label, path, symbol] of [
    ['trim', TRIM_MODULE, 'trimVoiceAudio'],
    ['fidelity', FIDELITY_MODULE, 'identifierFidelity'],
  ]) {
    if (!existsSync(path)) failures.push(`${label}: ${path} does not exist`);
    if (!inside(path)) failures.push(`${label}: ${path} is outside the shipping tree (${REPO_ROOT})`);
    if (inHarness(path)) failures.push(`${label}: ${path} is inside this harness — a second implementation, not the shipping module`);
    if (existsSync(path) && !readFileSync(path, 'utf8').includes(`export function ${symbol}`)) {
      failures.push(`${label}: ${path} does not export ${symbol}`);
    }
  }
  return failures;
}

export function printProbe() {
  console.log('probe (the shipping modules this run drives — absolute paths, both inside the shipping tree):');
  console.log(`  tree    ${REPO_ROOT}`);
  console.log(`  drive   ${TRIM_MODULE}#trimVoiceAudio   (produces the ${CONDITIONS.map((c) => c.trim).filter((t) => t !== 'raw').filter((t, i, a) => a.indexOf(t) === i).join(', ') || 'raw'} column's audio)`);
  console.log(`  metric  ${FIDELITY_MODULE}#identifierFidelity   (verbatim identifier survival)`);
  console.log(`  harness ${HARNESS_DIR}   (declared: carries no second implementation of either)`);
}

// ---------------------------------------------------------------------------
// S1 冻结快照：读、写、以及「快照里的音频确实是出货模块的输出」这条对应关系。
// ---------------------------------------------------------------------------

function loadFrozen() {
  const parsed = JSON.parse(readFileSync(FROZEN_PATH, 'utf8'));
  if (!Array.isArray(parsed.entries)) throw new Error(`${FROZEN_PATH} carries no entries`);
  return parsed;
}

/**
 * 快照不存在时的起点：语料与参照文本来自 `CORPUS`（runner 里固定的那份），
 * 转录为空。只有 `--live` / `--freeze` 用得上它 —— 一次还没发生过的实验，
 * 没有快照可读，而这不该是「文件不存在」的错误。
 */
function bootstrapFrozen() {
  return {
    provenance: { generatedAt: null, note: 'bootstrap from CORPUS — no readings taken yet' },
    entries: CORPUS.map((c) => ({ clip: c.clip, language: 'zh', reference: c.reference, audio: {}, transcripts: {} })),
  };
}

function saveFrozen(frozen) {
  writeFileSync(FROZEN_PATH, `${JSON.stringify(frozen, null, 2)}\n`);
}

/**
 * 对应关系检查：快照里每条转录所对应的音频，必须**就是**本仓库当前代码产出的字节。
 *
 * 快照为每条片段 × 每条裁剪列钉了 sha256；这里从 fixture wav 重解、经 `trimVoiceAudio`
 * 重编、逐字节比对。一份「等价但不同」的裁剪、或一个陈旧的算法副本，会在 sha256 上红，
 * 而不是靠一个碰巧接近的时长蒙混过去。
 */
export function correspondenceFailures(entries) {
  const onDisk = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.wav')).sort();
  const named = entries.map((e) => e.clip);
  const failures = [];
  let checked = 0;

  for (const clip of onDisk) if (!named.includes(clip)) failures.push(`fixture ${clip} has no entry in the frozen snapshot`);
  for (const clip of named) if (!onDisk.includes(clip)) failures.push(`entry ${clip} names an audio file that is not in fixtures/`);

  for (const entry of entries) {
    if (!onDisk.includes(entry.clip)) continue;
    const { samples, sampleRate } = decodeWav(join(FIXTURE_DIR, entry.clip));
    for (const trim of [...new Set(CONDITIONS.map((c) => c.trim))]) {
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

/**
 * 上一条检查的**证伪器**：把一条片段的 sha 改坏，同一段代码路径必须报红。
 * 它不红就说明这条检查是瞎的，那么它在真快照上的绿读数一文不值。
 */
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

function readingOf(reference, text) {
  const fidelity = identifierFidelity(reference, text);
  return {
    marks: sentenceMarks(text),
    naive: naiveMarks(text),
    identifiers: fidelity.total,
    survived: fidelity.survived,
    missing: fidelity.missing,
    cer: cer(reference, text),
  };
}

/**
 * 把快照折成配对读数。
 *
 * `conditions` 与 `variant` 是两个可变异点（自检用）：`control=zero|inverted` 会把负对照
 * 条件的转录**换掉**，`control=absent` 会把该条件**拿掉**，`drop=<key>` 会把某个条件的
 * 转录清空。三者都必须在下面的判据上红 —— 否则这些判据就是「写了但触发不了」。
 *
 * 配对（协议第 1 条）：配对集合是**所有条件都有读数**的那些片段。某个条件少一条，
 * 配对集合就缩小，而不是拿另一个集合去比。`n` 就是它的大小。
 */
export function measure(frozen, { conditions = CONDITIONS, controlVariant = 'real', drop = null } = {}) {
  const control = controlCondition(conditions);
  const entries = frozen.entries;

  const textFor = (entry, condition) => {
    if (drop && condition.key === drop) return null;
    if (control && condition.key === control.key && controlVariant !== 'real') {
      // 变异：负对照的读数被**替换**（或被清空），与快照里本来有没有它无关 ——
      // 一个「只在缺失时才生效」的变异等于没有触发，而快照里它是有读数的。
      if (controlVariant === 'zero') {
        // 置零：负对照的读数就是参照条件的读数 ⇒ 位移恒为 0。
        const base = entry.transcripts[control.control.vs];
        if (typeof base !== 'string') return null;
        return base;
      }
      // 反方向：拿参照条件的读数再加一个句末标点。合成的文本在**证伪器**里是合法的
      // ——它测的是 checker 能不能看见反向位移，不是某次识别结果；一个真实的
      // 「反向移动」条件无法由快照保证存在（这里 `punct` 的中文读数恰好也低于 `none`）。
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
      ...readingOf(entry.reference, textFor(entry, condition)),
    }));
    const sum = (pick) => rows.reduce((a, r) => a + pick(r), 0);
    columns.set(condition.key, {
      condition,
      rows,
      n: rows.length,
      marks: sum((r) => r.marks),
      naive: sum((r) => r.naive),
      survived: sum((r) => r.survived),
      identifiers: sum((r) => r.identifiers),
      cerMean: rows.length ? sum((r) => r.cer) / rows.length : null,
    });
  }

  return { conditions, control, paired, columns, readings: paired.length * conditions.length };
}

/**
 * 负对照的方向判定，与它的三种「不能红」形态。
 *
 * 返回 `{ status, detail }`：`moved` 是按预测方向动了；`flat` 是没动（位移 0）；
 * `against` 是朝反方向动了；`absent` 是负对照根本不在条件表里；`empty` 是这一轴上
 * 参照条件自己就没有读数（「0 比 0」不是测量）。后四种都必须让运行红。
 */
export function controlVerdict(result) {
  const { control, columns } = result;
  if (!control) return { status: 'absent', detail: '条件表里没有声明负对照', delta: null, up: 0, same: 0, down: 0 };
  const axis = control.control.axis;
  const mine = columns.get(control.key);
  const theirs = columns.get(control.control.vs);
  if (!mine || !theirs) return { status: 'absent', detail: `负对照或参照条件不在本次条件表里（${control.key} vs ${control.control.vs}）`, delta: null, up: 0, same: 0, down: 0 };
  if (!theirs.n) return { status: 'empty', detail: `参照条件 ${control.control.vs} 在配对集合里一条读数都没有`, delta: null, up: 0, same: 0, down: 0 };

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
      `naive ${column.naive}  identifiers ${column.survived}/${column.identifiers}  CER ${fmt(column.cerMean, 4)}`,
  );
  for (const row of column.rows) {
    console.log(
      `      ${pad(row.clip, 14)} n=1  marks=${row.marks} naive=${row.naive}  ` +
        `id=${row.survived}/${row.identifiers}  cer=${fmt(row.cer, 4)}` +
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
// 七条变异，每条都必须红；真实快照必须绿。缺了正面的一半，一个「永远返回红」的
// checker 也能通过全部变异 —— 所以真实快照的绿读数与变异红是同一个断言的两半。
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
    ['drop=turbo|raw|none', { conditions, drop: 'turbo|raw|none' }, 'empty'],
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

function loadCredentials(envFile) {
  const file = envFile ?? process.env.VOICE_PAIRED_ENV_FILE ?? '/data/home/yale/work/tc-verify/.env';
  const fromFile = {};
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) fromFile[m[1]] = m[2];
    }
  }
  const pick = (name) => process.env[name] ?? fromFile[name] ?? '';
  return {
    envFile: file,
    baseUrl: pick('VOICE_PAIRED_BASE_URL') || pick('GROQ_BASE_URL'),
    apiKey: pick('VOICE_PAIRED_API_KEY') || pick('GROQ_API_KEY'),
  };
}

/** 与仓库外工装一致的最小间隔：Groq on_demand 约 20 RPM，并发会把预算花在 429 上。 */
const MIN_INTERVAL_MS = Number(process.env.VOICE_PAIRED_MIN_INTERVAL_MS ?? 3200);
let lastCallAt = 0;

async function transcribe(credentials, bytes, { model, prompt, retries = 3 }) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'clip.wav');
    form.append('model', model);
    form.append('response_format', 'json');
    if (prompt) form.append('prompt', prompt);
    let res;
    try {
      res = await fetch(`${credentials.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credentials.apiKey}` },
        body: form,
      });
    } finally {
      lastCallAt = Date.now();
    }
    const raw = await res.text();
    if (res.status === 429 && attempt < retries) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after') ?? 4) + 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`recogniser HTTP ${res.status}: ${raw.slice(0, 200)}`);
    const parsed = JSON.parse(raw);
    if (typeof parsed?.text !== 'string') throw new Error(`recogniser returned no text: ${raw.slice(0, 200)}`);
    return parsed.text;
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
 * 缓存跨进程是它的用处，也正是配对比较的陷阱：一批读数里混进两次运行的取数，
 * 「同一批语料上的配对」就不成立了。所以每条缓存项都带 `run`，冻结前要求它们
 * **同一个 run**；不同就红，并指路 `--fresh`。一个不做这个检查的 runner 会在
 * 第二次运行之后安静地产出一张跨运行的配对表。
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
 * 音频**只能**由 `trimVoiceAudio` 产生（协议第 3 条）：`raw` 列是解码后的样本直接重编，
 * 裁剪列经模块。缓存键含模型与 prompt tag，所以「同一个条件」是可复用的，
 * 而「不同条件」永远不会互相冒充。
 */
export async function runLive(frozen, credentials, { conditions = CONDITIONS, log = console.log, fresh = false } = {}) {
  // `--fresh` 换一个新的 run id 并**不使用**旧缓存：单次运行的快照只能这样取。
  const run = fresh ? new Date().toISOString() : null;
  const cache = fresh ? { entries: {} } : loadCache();
  const activeRun = run ?? cache.entries[Object.keys(cache.entries)[0]]?.run ?? new Date().toISOString();
  const entries = frozen.entries.map((entry) => ({ ...entry, audio: { ...entry.audio }, transcripts: { ...entry.transcripts } }));
  let fetched = 0;

  for (const entry of entries) {
    const { samples, sampleRate } = decodeWav(join(FIXTURE_DIR, entry.clip));
    entry.audio.baselineSec = samples.length / sampleRate;
    const trims = [...new Set(conditions.map((c) => c.trim))];
    for (const trim of trims) {
      const { bytes, stats } = encodeColumn(samples, sampleRate, trim);
      entry.audio[`${trim}Sha256`] = sha256(bytes);
      if (stats) entry.audio[`${trim}SavedRatio`] = stats.savedRatio;
    }
    // 串行：条件 × 片段，一个一个 await，没有并发（协议第 7 条）。
    for (const condition of conditions) {
      const key = `${condition.key}|${entry.clip}`;
      const hit = cache.entries[key];
      if (hit && typeof hit.text === 'string') {
        entry.transcripts[condition.key] = hit.text;
        entry.runs = { ...entry.runs, [condition.key]: hit.run };
        continue;
      }
      const { bytes } = encodeColumn(samples, sampleRate, condition.trim);
      const text = await transcribe(credentials, bytes, {
        model: condition.model,
        prompt: condition.context === 'none' ? undefined : PROMPTS[condition.context],
      });
      cache.entries[key] = { text, run: activeRun, takenAt: new Date().toISOString() };
      entry.transcripts[condition.key] = text;
      entry.runs = { ...entry.runs, [condition.key]: activeRun };
      fetched += 1;
      log(`  fetched ${key}`);
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
      endpoint: `${credentials.baseUrl.replace(/\/$/, '')}/audio/transcriptions`,
      request: 'POST /audio/transcriptions, response_format=json, no language parameter, prompt only for the context conditions',
      throttle: `${MIN_INTERVAL_MS} ms minimum interval between calls, one call in flight (serial)`,
      recipe:
        'For every clip × condition: decode fixtures/<clip> with the runner\'s decodeWav, encode the column with the runner\'s encodeWav (raw = encodeWav(decodeWav(file)); trimFrozen = trimVoiceAudio(samples, rate) — the shipping module), post the encoded buffer to the recogniser, keep the returned text verbatim. `--live` then `--freeze`; the cache is out/quality-cache.json.',
      corpus:
        'Eight Chinese clips at o65 occupancy (d01..d08-o65) — a contiguous prefix of the out-of-tree dictation corpus\'s o65 tier (tools/dictation-corpus.mjs SCRIPTS). The corpus itself does not enter the repo (a standing decision); these eight audio files do, so the correspondence check below can be recomputed offline.',
      referenceSource:
        'Authored scripts from the out-of-tree corpus generator (SCRIPTS), verbatim — the text the TTS was given, so the reference is ground truth by construction.',
      conditions: CONDITIONS.map((c) => ({ key: c.key, provider: c.provider, model: c.model, trim: c.trim, context: c.context, note: c.note })),
      prompts: PROMPTS,
      publishedReference:
        'The 16-clip o65 reading in docs/experiments/2026-09-22-voice-punctuation.md: marks/clip 1.13 (none) / 0.00 (punct) / 0.06 (flat). Different n, same 口径.',
    },
    entries,
  };
  saveFrozen(frozen);
  return frozen;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  // 两种写法都算：`--live` 与 `--corpus=empty`。只认前者会让所有 `--k=v` 变异**静默失效**
  // —— 一个「没生效的变异」与「变异生效但没红」在退出码上完全一样。
  const flag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const value = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const failures = [];
  console.log('voice-provider-paired-quality — paired comparison across provider × trim × context (a reading, not a gate)');
  printProbe();

  const probeFailures = assertShippingModules();
  for (const f of probeFailures) failures.push(`[probe] ${f}`);
  console.log(`  ${probeFailures.length ? 'FAIL' : 'ok  '} both modules resolve inside the shipping tree`);

  if (flag('probe')) {
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    return failures.length ? 1 : 0;
  }

  const credentials = loadCredentials(value('env-file'));

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

  // 一次运行取全部条件（`--live` / `--freeze` 共用同一次 pass：跑两遍会把请求数翻倍，
  // 且第二遍在缓存上无意义）。
  if (flag('live') || flag('freeze')) {
    if (!credentials.apiKey) {
      process.stderr.write(`FAIL: --live / --freeze need credentials (VOICE_PAIRED_API_KEY / GROQ_API_KEY, or a .env at ${credentials.envFile})\n`);
      return 2;
    }
    const live = await runLive(frozen, credentials, { fresh: flag('fresh') });
    frozen = { ...frozen, entries: live.entries };
    console.log(`\nlive: run=${live.run} fetched=${live.fetched} cached=${live.cached} cache=${CACHE_PATH} (serial, ${MIN_INTERVAL_MS} ms apart)`);
    if (flag('freeze')) {
      const straddles = assertSingleRun(runIdsOf(live.entries));
      if (straddles.length) {
        for (const f of straddles) process.stderr.write(`FAIL: ${f}\n`);
        return 1;
      }
      frozen = freeze(live.entries, credentials);
      console.log(`frozen: ${FROZEN_PATH} (${live.entries.length} entries, run ${live.run})`);
    }
  }

  // `--runs=straddle` 是**变异**：把一条读数挪到另一个 run id 上，配对断言必须红。
  if (flag('runs') && value('runs') === 'straddle') frozen = straddleSnapshot(frozen);

  // AC1 / AC4：配对集合与读数条数。空读数不是绿。
  // `--control=<zero|inverted|empty>` 让**主读数**也走那个变异，所以它必须让运行红；
  // `--control=absent` 走的是上面那条过滤（负对照不在条件表里）。
  const result = measure(frozen, { conditions, drop: value('drop'), controlVariant: value('control') ?? 'real' });
  console.log(`\ncorpus: ${frozen.entries.length} clip(s) in the snapshot, ${result.paired.length} in the paired set (every condition returned a reading)`);
  console.log(`readings: n=${result.paired.length} × ${conditions.length} condition(s) = ${result.readings} row(s), n = clips = ${result.paired.length}`);
  if (!result.paired.length) failures.push(`[n] the paired set is empty — n=0 is not a green reading (snapshot ${frozen.entries.length} clip(s), ${conditions.length} condition(s))`);
  if (!result.readings) failures.push('[n] zero reading rows — an empty reading is not a green reading');

  // AC4：配对集合内的读数必须来自**同一次运行**（协议第 1 条）。
  const runs = [...new Set(runIdsOf(frozen.entries).filter(Boolean))];
  const straddles = assertSingleRun(runIdsOf(frozen.entries));
  console.log(`\nrun: ${runs.length ? runs.join(', ') : '(no run id — snapshot taken before run ids were recorded)'} — ${runs.length <= 1 ? 'single run, so the pairing does not straddle runs' : 'MORE THAN ONE RUN'}`);
  for (const f of straddles) failures.push(`[pairing] ${f}`);

  // AC4：冻结快照的音频必须就是本模块的输出（含证伪器）。
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

  // AC3：负对照是否按预测方向移动 —— 报告的是**方向**，不是「跑过了」。
  const { verdict, ok } = printControl(result);
  console.log(`  predicted: ${result.control ? result.control.control.axis : '(none)'} down vs ${result.control ? result.control.control.vs : '(none)'}`);
  console.log(`  punct − flat: ${result.columns.get('turbo|raw|punct')?.marks ?? 'n/a'} − ${result.columns.get('turbo|raw|flat')?.marks ?? 'n/a'} marks (isolates the prompt's marks as the single variable)`);
  if (!ok) failures.push(`[control] ${verdict.detail}`);

  printPairedText(result);

  // AC2 / AC4：自检 —— 七条变异各自必须红，且红在预期的位置上。
  const selfTest = assertFalsifiers(frozen, { conditions });
  console.log('\nfalsifiers (each variant must red, and red for the stated reason):');
  console.log(`  ${selfTest.summary.join('  ')}`);
  for (const f of selfTest.failures) failures.push(`[falsifier] ${f}`);

  if (failures.length) {
    process.stderr.write(`\nvoice-provider-paired-quality: ${failures.length} failure(s)\n`);
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    return 1;
  }

  console.log(
    `\nvoice-provider-paired-quality: OK — n=${result.paired.length}, ${result.readings} paired reading(s), ` +
      `negative control moved ${verdict.delta} (${verdict.up}↑ ${verdict.same}= ${verdict.down}↓); ` +
      'quality numbers are a reading and are NOT a criterion (ADR-004 decision 8)',
  );
  return 0;
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
