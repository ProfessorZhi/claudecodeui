#!/usr/bin/env node
/**
 * 配对质量实验记录（第三份）：**DashScope omni** × whisper 基线 × 裁剪 × 一个能红的负对照（一份读数，不是闸）。
 *
 * 现场。`shared/asr/asrRegistry.ts` 的 `PAUSE_CUES_EVIDENCE[dashscopeOmniId]` 此前不存在，而
 * `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts` 声明的是 `pauseCues: 'neutral'`
 * —— 一个**非默认**值（默认是 `destructive`，见 `src/shared/voiceTrim.ts` 的 `trimDecisionFor`）。
 * ADR-004 决策 1 把「非默认声明必须指向该服务自己的成对测量」写成纪律，
 * `scripts/asr-trim-capability-check.mjs` 的 `discipline` 那一条就是它的机检形态，而本条之前它是红的：
 *
 *   check discipline: FAIL dashscope-omni=neutral declares a non-destructive capability with no paired
 *   experiment to point at
 *
 * 本文件就是那条纪律要的那份测量：出货 `dashscope-omni` 适配器与出货 `src/shared/voiceTrim.ts`
 * 在**同一次运行、同一批语料**上跑真实端点，读数冻结到 `fixtures/omni.json` 供离线重算，记录落在
 * `docs/experiments/<date>-omni-written.md`。
 *
 * 协议（`docs/experiments/README.md`，与前两份记录同形）：
 *
 *   第 1 条 配对比较不跨运行 —— 所有条件在**同一批片段**上跑，配对集合取交集，每条读数旁边打印 `n`。
 *           缓存里每条读数带 `run`，冻结前要求它们同一个 run。
 *   第 2 条 必须有能红的负对照 —— 见下面「负对照」一节。它必须**按取数之前写下的方向**移动。
 *   第 3 条 被测实现必须是出货模块 —— omni 条件**只能**经 registry 解析出来的
 *           `dashscope-omni.asr-provider.ts#transcribe` 发出，`fetchImpl` 就是全局 `fetch`（不包装、
 *           不改 body：这个适配器的 `honors` 三项全 false，body 里没有一处由调用方决定）；
 *           裁剪列的音**只能**由 `src/shared/voiceTrim.ts` 的 `trimVoiceAudio` 产生；标识符口径
 *           **只能**是 `src/shared/identifierFidelity.ts`。启动时打印三者的绝对路径与符号名（probe），
 *           断言它们在出货树内、不在本工装内，并断言本工装源码里**没有第二份请求构造**
 *           （自扫两个字面量，拼接成串以免自扫命中自己）。
 *   第 7 条 串行执行 —— 真实请求一条一条发，不并发。
 *   第 8 条 结果落盘缓存 —— 真实读数落在 `out/quality-cache.json`（不入库），冻结快照落在
 *           `fixtures/omni.json`，默认运行只读冻结快照，**不联网**。
 *
 * 语料**不复制**：音频与参考文本都从第一份实验的目录读（`../voice-provider-paired-quality/fixtures/`），
 * 与前两份记录同一批 8 条片段，三份记录的数字因此可以并列。
 *
 * 条件（4 个，同一批片段上全跑）：
 *
 *   provider/model   turbo（Groq `whisper-large-v3-turbo`，出货 `openai-compatible` 基线）/
 *                    omni（`qwen3.8-omni-flash`，出货 `dashscope-omni` 适配器的 `DEFAULT_MODEL`）
 *   trim             raw（原音频）/ trim（出货 `trimVoiceAudio` 之后再送 —— 就是 `pauseCues` 那一轴）/
 *                    head（**负对照**：同一条音的前 2 秒，其余一切不变）
 *
 * 读数轴（都是**读数**，不是闸 —— 决策 8）：语义判定（`judge.mts` 的三级判词计数：满分 / 半分 / 落空）、
 * 标识符逐字保真、句读与逗号、返回的 style（written / 退化成 verbatim）、延迟、token 数、逐片段文本并列。
 * **没有逐字 CER**：这条服务是 `style: 'written'`，它输出的不是「听写」，逐字 CER 对它不是一个有意义的
 * 量具（任务把这条写进了读数轴清单）。
 *
 * 判词字形在本文件里以码点构造（见 `OK_VERDICT`），一个也不直写：AC4 的机检就是拿 `grep` 数这两个字形
 * 出现的行数 —— 直写的话，README 里那句「runner 里没有第二份 rubric」就会被它自己的注释证伪。
 *
 * 负对照（**取数之前**写在这里，不是事后编的）。对照条件 `omni|head|none`，参照条件 `omni|raw|none`，
 * 轴是 `ok`（语义判定里满分判词的条数），预测方向 **down**。单变量：两条条件的 provider、模型、线协议、
 * 提示词、MIME 全都一样，唯一变的是**喂进去的音**——负对照是这条音的前 2.0 秒。
 * 为什么这个方向是可预测的：`judge.mts` 的满分判词要求**事实在位**（`d01` 要 `server` 与 `30`，`d05` 要
 * `15` 与 `50`，`d07` 要 `server`/`voice`/`call`/`测试`），而语料里这些事实**分布在整句里**（8 条音
 * 10–20 秒，前 2 秒只是开头几个字）。一条只剩开头的音里装不下句尾的文件名与数字，所以满分只可能少、
 * 不可能多。反过来，如果这条读数**没有**按这个方向移动，那就是这份工装的量具坏了（判定对音频损伤
 * 不敏感、或读数根本没走服务），而不是「负对照碰巧没动」——那时这条运行必须红。
 *
 * 运行：
 *   node experiments/voice-dashscope-omni-paired-quality/run.mjs               # 离线：冻结快照 + 负对照 + 自检
 *   node experiments/voice-dashscope-omni-paired-quality/run.mjs --live        # 加跑真实服务（联网 + 凭据），串行，落盘
 *   node experiments/voice-dashscope-omni-paired-quality/run.mjs --live --fresh # 换新 run id 并忽略旧缓存
 *   node experiments/voice-dashscope-omni-paired-quality/run.mjs --freeze      # 把缓存冻成 fixtures/omni.json
 *   node experiments/voice-dashscope-omni-paired-quality/run.mjs --probe       # 只打印所驱动的出货模块
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { register } from 'tsx/esm/api';

import { identifierFidelity } from '../../src/shared/identifierFidelity.ts';
import { trimVoiceAudio } from '../../src/shared/voiceTrim.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = HERE;
const FIXTURE_DIR = join(HERE, 'fixtures');
const FROZEN_PATH = join(FIXTURE_DIR, 'omni.json');
const OUT_DIR = join(HERE, 'out');
const CACHE_PATH = join(OUT_DIR, 'quality-cache.json');

/**
 * 语料的**唯一**来源：第一份实验的目录。音频、参考文本、以及「这条转录对应的音确实是出货模块现算的」
 * 那条对应关系，全部从那里读；本 runner 不复制音频，也不重抄参考文本。
 */
const CORPUS_DIR = resolve(HERE, '..', 'voice-provider-paired-quality');
const CORPUS_FIXTURES = join(CORPUS_DIR, 'fixtures');
const CORPUS_SNAPSHOT = join(CORPUS_FIXTURES, 'paired.json');

const REPO_ROOT = resolve(HERE, '..', '..');
const MODULE_PATHS = {
  omni: fileURLToPath(new URL('../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts', import.meta.url)),
  trim: fileURLToPath(new URL('../../src/shared/voiceTrim.ts', import.meta.url)),
  fidelity: fileURLToPath(new URL('../../src/shared/identifierFidelity.ts', import.meta.url)),
};

/** 语义判定那份口径的所在。**同一份** rubric，不是抄一份。 */
const JUDGE_PATH = fileURLToPath(new URL('../voice-omni-written/raw/judge.mts', import.meta.url));
const JUDGE_SPECIFIER = pathToFileURL(JUDGE_PATH).href;

/**
 * 出货适配器表 —— 经 **registry** 解析，而不是直接 import 适配器模块：直接 import 只能证明「这个文件
 * 导出 `transcribe`」，证明不了它**是出货路径会给出的那一个**。
 */
register();

const REGISTRY_SPECIFIER = new URL('../../shared/asr/asrRegistry.ts', import.meta.url).href;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// judge.mts 的既有口径，以及它 transitive 的 CLI-only 依赖。
//
// `judge.mts` 的 rubric 是纯函数 `judge(clip, ins)`，但它的模块图里还有一条**只给它的 CLI 用**的边：
// `judge.mts` → `written.mts` → `omni.mts`，而 `omni.mts` 在模块顶层就 `readFileSync` 8 个 webm
// （另一个实验的 gitignored 上传缓存，`out/` 不入库）。rubric 本身一个字都不读它们。
//
// 所以本 runner 在 import 之前**把那条依赖的材料补上**，而不是绕开它或抄一份 rubric：webm 缺失时先用
// 主检出里那份（同一次编码、逐字节相同 —— `md5sum` 可复验）补，主检出也没有就用仓库自己的 ffmpeg 配方
// 重新编（`-c:a libopus -b:a 64k -ar 48000 -ac 1`）**编进那个缓存目录**；ffmpeg 也不在就**非零退出**
// 并点名缺什么。绝不静默回退到一个「读起来一样、其实没测」的路径。
//
// import 还要求 cwd 是仓库根（`omni.mts` 用相对路径读 `paired.json`），所以 `loadJudge` 先 `chdir`。
// 本文件其余部分一律用绝对路径，不依赖 cwd。
// ---------------------------------------------------------------------------

const JUDGE_CLIP_CACHE_DIR = join(REPO_ROOT, 'experiments', 'voice-gemini-paired-quality', 'out', 'webm');
const WEBM_RECIPE = ['-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1'];

function findFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' });
    return execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** 主检出根（worktree 里没有那些 gitignored 的缓存；`.env.test` 与上传缓存都在主检出）。 */
export function mainCheckoutRoot() {
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
 * 让 `judge.mts` 那条 CLI-only 的依赖边可解析。补的是**材料**，不是 rubric：缺的 webm 只被那条边
 * 读到一个从未被 `judge()` 触碰的字段上（`clips[].data`）。
 */
export function materialiseJudgePrerequisites({ log = () => {} } = {}) {
  const wanted = readdirSync(CORPUS_FIXTURES)
    .filter((f) => f.endsWith('.wav'))
    .sort()
    .map((f) => ({ wav: join(CORPUS_FIXTURES, f), webm: join(JUDGE_CLIP_CACHE_DIR, f.replace(/\.wav$/, '.webm')) }));
  const missing = wanted.filter((w) => !existsSync(w.webm));
  if (!missing.length) return { copied: 0, encoded: 0, dir: JUDGE_CLIP_CACHE_DIR };

  const sourceDir = join(mainCheckoutRoot(), 'experiments', 'voice-gemini-paired-quality', 'out', 'webm');
  mkdirSync(JUDGE_CLIP_CACHE_DIR, { recursive: true });
  let copied = 0;
  const stillMissing = [];
  for (const w of missing) {
    const source = join(sourceDir, w.webm.split('/').pop());
    if (existsSync(source)) {
      copyFileSync(source, w.webm);
      copied += 1;
      log(`  judge prerequisite: copied ${w.webm.split('/').pop()} from the main checkout`);
    } else stillMissing.push(w);
  }

  let encoded = 0;
  if (stillMissing.length) {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      throw new Error(
        `the judge's CLI-only dependency needs ${stillMissing.length} recording(s) in ${JUDGE_CLIP_CACHE_DIR} ` +
          `(missing: ${stillMissing.map((w) => w.webm.split('/').pop()).join(', ')}), the main checkout has no copy, ` +
          'and ffmpeg is not on PATH — install ffmpeg or take the readings where that cache exists',
      );
    }
    for (const w of stillMissing) {
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', w.wav, ...WEBM_RECIPE, w.webm]);
      encoded += 1;
      log(`  judge prerequisite: encoded ${w.webm.split('/').pop()} with ${ffmpeg}`);
    }
  }
  return { copied, encoded, dir: JUDGE_CLIP_CACHE_DIR };
}

/** 载入 `judge.mts` 的 rubric（唯一一份）。返回 `{ judge, path, prerequisites }`。 */
export async function loadJudge({ log = () => {} } = {}) {
  const prerequisites = materialiseJudgePrerequisites({ log });
  process.chdir(REPO_ROOT);
  const mod = await import(JUDGE_SPECIFIER);
  if (typeof mod.judge !== 'function') {
    throw new Error(`${JUDGE_PATH} does not export judge()`);
  }
  return { judge: mod.judge, path: JUDGE_PATH, prerequisites };
}

// ---------------------------------------------------------------------------
// WAV 编解码。不是被测算法：出货模块收 Float32Array，字节与样本之间的转换由调用方负责，这里就是那个
// 调用方。口径逐字沿用前两份记录的 runner —— 跨记录的数字要能并列，编解码必须是同一个。
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
 * 负对照那一轴的音频定义，**取名一个常量而不是就地算**：它是这条预测的一部分，取数之前就写在这里。
 * 前 2.0 秒 —— 够服务答得出话（不是一段静音），又短到装不下语料里句尾的那些文件名与数字。
 */
export const HEAD_SECONDS = 2;

/**
 * 三条音频列。`raw` 不碰样本 —— 这一列的「没有裁剪」是它全部的意义，所以它走的是
 * `encodeWav(decodeWav(file))`，而不是把文件原字节当缓存键。
 *
 * `trimFrozen` 经出货 `trimVoiceAudio`（`pauseCues` 那一轴）。`headFrozen` 是**负对照的音**：它不是
 * 任何出货模块的输出，而是**故意损坏**的同一条音 —— 负对照要证明的正是量具对「音变差了」这件事敏感，
 * 所以这一列按定义就不能是出货路径的产物（转录本身仍然只经出货适配器发出）。
 */
export function encodeColumn(samples, sampleRate, column) {
  if (column === 'raw') return { bytes: encodeWav(samples, sampleRate), stats: null };
  if (column === 'trimFrozen') {
    const result = trimVoiceAudio(samples, sampleRate, {});
    return { bytes: encodeWav(result.samples, sampleRate), stats: result.stats };
  }
  if (column === 'headFrozen') {
    return { bytes: encodeWav(samples.slice(0, Math.round(HEAD_SECONDS * sampleRate)), sampleRate), stats: null };
  }
  throw new Error(`unknown audio column: ${column}`);
}

const COLUMNS = ['raw', 'trimFrozen', 'headFrozen'];
const TRIMS = ['raw', 'trimFrozen'];

// ---------------------------------------------------------------------------
// 质量轴。都是「围绕出货算法的量具」；被测算法本身一律 import。
// ---------------------------------------------------------------------------

/**
 * 蒙掉标识符内部的点 —— 口径逐字沿用标点实验的 `maskInternalDots`。
 *
 * **没有 `\S*` 前缀**，那是一个已付过代价的 bug：`\S*\.(?=[\p{L}\p{N}])` 贪婪且只被空白界定，而中文
 * 没有空白，一次匹配会从句首吃到最后一个标识符点、把整句删空。
 */
export const maskInternalDots = (text) => String(text).replace(/\.(?=[\p{L}\p{N}])/gu, '');

/** 句读 —— 蒙版后的 `[.!?。！？]` 计数。 */
export const sentenceMarks = (text) => (maskInternalDots(text).match(/[.!?。！？]/g) ?? []).length;

/** 未蒙版的计数，只作口径分歧的可见读数。 */
export const naiveMarks = (text) => (String(text).match(/[.!?。！？]/g) ?? []).length;

/** 逗号与顿号 —— 这条服务的书面化输出会自己加标点，这一轴读的是它加了多少。 */
export const commaMarks = (text) => (String(text).match(/[，,、]/g) ?? []).length;

/**
 * judge.mts 的三种判词。**不是本文件写下的常量**：`judge()` 返回它们，本文件只按**值**比较
 * （用 `codePointAt`/转义，源码里不出现那三个字形），阈值一处也不重复。
 */
const OK_VERDICT = String.fromCodePoint(0x2705);
const SOFT_VERDICT = String.fromCodePoint(0x25d0);

// ---------------------------------------------------------------------------
// S0 条件表。四条条件在**同一批片段**上跑（协议第 1 条）。
// ---------------------------------------------------------------------------

export const CONDITIONS = [
  {
    key: 'turbo|raw|none',
    providerId: 'openai-compatible',
    model: 'whisper-large-v3-turbo',
    trim: 'raw',
    note: '出货 openai-compatible 上的 whisper 基线（前两份记录的参照条件）；本轮同样由出货适配器发出，供同批并列',
  },
  {
    key: 'omni|raw|none',
    providerId: 'dashscope-omni',
    model: 'qwen3.8-omni-flash',
    trim: 'raw',
    note: '出货 dashscope-omni 适配器 + 它的 DEFAULT_MODEL，不裁剪 —— 负对照的参照条件',
  },
  {
    key: 'omni|trim|none',
    providerId: 'dashscope-omni',
    model: 'qwen3.8-omni-flash',
    trim: 'trimFrozen',
    note: 'pauseCues 轴：出货 trimVoiceAudio 之后再送（裁掉停顿对这条服务是伤害还是帮助）',
  },
  {
    key: 'omni|head|none',
    providerId: 'dashscope-omni',
    model: 'qwen3.8-omni-flash',
    trim: 'headFrozen',
    note: '**负对照**：同一条音的前 2.0 秒，provider/模型/线协议/提示词/MIME 全部不变',
    // 负对照的预测：相对 `omni|raw`（唯一变量是喂进去的音）语义判定里满分判词的条数必须**下降**。
    // 这个方向在取数**之前**写下，理由见文件头；`direction` 与 `axis` 是判词的一部分，不是注释。
    control: {
      axis: 'ok',
      vs: 'omni|raw|none',
      direction: 'down',
      prediction:
        'judge.mts 的满分判词要求事实在位（d01 要 server 与 30、d05 要 15 与 50、d07 要 server/voice/call/测试），' +
        '而这些事实分布在整句里；只剩开头 2 秒的音装不下句尾的文件名与数字，满分只可能少、不可能多。' +
        '没按这个方向移动就是量具坏了（对音频损伤不敏感，或读数没走服务），不是「负对照碰巧没动」。',
    },
  },
];

/** 取条件表里被声明为负对照的那一条；没有就是调用错误，不是静默退化。 */
export const controlCondition = (conditions = CONDITIONS) => conditions.find((c) => c.control) ?? null;

/** 条件表里出现的 provider id，按首次出现顺序 —— 凭据检查按它逐个点名。 */
export const PROVIDER_IDS = [...new Set(CONDITIONS.map((c) => c.providerId))];

// ---------------------------------------------------------------------------
// S0 语料。**读**第一份实验的快照，不复制。
// ---------------------------------------------------------------------------

export function loadCorpus() {
  if (!existsSync(CORPUS_SNAPSHOT)) {
    throw new Error(`${CORPUS_SNAPSHOT} is missing — this runner reuses the first experiment's corpus rather than copying it`);
  }
  const parsed = JSON.parse(readFileSync(CORPUS_SNAPSHOT, 'utf8'));
  if (!Array.isArray(parsed.entries)) throw new Error(`${CORPUS_SNAPSHOT} carries no entries`);
  return parsed.entries.map((entry) => ({ clip: entry.clip, language: 'zh', reference: entry.reference }));
}

// ---------------------------------------------------------------------------
// probe —— AC4 的机检形态：打印所驱动的出货模块的绝对路径 + 符号名，断言三者都在出货树内、都不在本
// 工装内，断言 registry 真的把 dashscope-omni 交得出来，并自扫本文件里没有第二份请求构造、没有第二份
// rubric。一个把请求抄了一份的工装会在这里红，因为那个字面量必然出现在源码里。
// ---------------------------------------------------------------------------

/**
 * 自扫用的两个串。**拼接**而不是直写，理由不是风格：本函数读的就是本文件自己的源码，直写会让「这条
 * 检查」自己成为命中它的证据 —— 一个永远红的自扫与没有自扫在退出码上一样。
 */
const FORBIDDEN_LITERALS = [`input${'_audio'}`, `compatible-mode/v1/${'chat/completions'}`];

export function selfSourceFailures() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const failures = [];
  for (const literal of FORBIDDEN_LITERALS) {
    if (source.includes(literal)) {
      failures.push(
        `this harness builds a second omni request itself (its own source carries '${literal}') — ` +
          'the measured implementation must be the shipping adapter, not this runner',
      );
    }
  }
  // 第二份 rubric：判词字形一个也不许出现在本文件里。判定走 judge.mts，本文件只按值比较。
  if (source.includes(OK_VERDICT) || source.includes(SOFT_VERDICT)) {
    failures.push(
      'this harness carries a second rubric (one of the judge\'s verdict glyphs appears in its own source) — ' +
        'the semantic judgement must come from experiments/voice-omni-written/raw/judge.mts',
    );
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
    ['omni', MODULE_PATHS.omni, 'transcribe'],
    ['trim', MODULE_PATHS.trim, 'trimVoiceAudio'],
    ['fidelity', MODULE_PATHS.fidelity, 'identifierFidelity'],
    ['judge', JUDGE_PATH, 'judge'],
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
    const adapter = registry.tryResolve('dashscope-omni');
    if (adapter === null) {
      failures.push("'dashscope-omni' is not in the shipping registry — the readings would be about an adapter the product never hands out");
    } else if (adapter.capabilities.pauseCues !== 'neutral') {
      failures.push(
        `the registry's dashscope-omni adapter declares pauseCues='${adapter.capabilities.pauseCues}', not the 'neutral' this record is the evidence for`,
      );
    }
  }

  for (const failure of selfSourceFailures()) failures.push(failure);
  return failures;
}

export function printProbe() {
  console.log('probe (the shipping modules this run drives — absolute paths, all inside the shipping tree):');
  console.log(`  tree        ${REPO_ROOT}`);
  console.log(`  omni        ${MODULE_PATHS.omni}#transcribe   (every omni condition goes through this shipping adapter, resolved from the registry)`);
  console.log(`  trim        ${MODULE_PATHS.trim}#trimVoiceAudio   (produces the trim column's audio — the pauseCues axis)`);
  console.log(`  metric      ${MODULE_PATHS.fidelity}#identifierFidelity   (verbatim identifier survival)`);
  console.log(`  judge       ${JUDGE_PATH}#judge   (the semantic verdicts are this rubric's, imported — this harness carries no second one)`);
  console.log(`  harness     ${HARNESS_DIR}   (declared: carries no second implementation of any of them, and no second omni request construction)`);
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
    provenance: { generatedAt: null, note: "bootstrap from the first experiment's corpus — no readings taken yet" },
    entries: loadCorpus().map((c) => ({
      clip: c.clip,
      language: c.language,
      reference: c.reference,
      audio: {},
      transcripts: {},
      styles: {},
      declared: {},
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
 * 快照为每条片段 × 每条音频列钉了 sha256；这里从第一份实验的 fixture wav 重解、经 `trimVoiceAudio`
 * 重编、逐字节比对。一份「等价但不同」的裁剪、或一个陈旧的算法副本，会在 sha256 上红。负对照那一列
 * （`headFrozen`）同样被钉住：它是这条预测的**定义**，改了它预测就换了对象。
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
    for (const column of COLUMNS) {
      const { bytes, stats } = encodeColumn(samples, sampleRate, column);
      checked += 1;
      const recorded = entry.audio?.[`${column}Sha256`];
      if (recorded !== sha256(bytes)) {
        failures.push(
          `${entry.clip}/${column}: the frozen transcript was not taken from this audio ` +
            `(sha256 ${recorded ?? 'missing'} != ${sha256(bytes)} re-derived here)`,
        );
      }
      if (stats && Math.abs(stats.savedRatio - entry.audio?.[`${column}SavedRatio`]) > 1e-9) {
        failures.push(`${entry.clip}/${column}: savedRatio ${entry.audio?.[`${column}SavedRatio`]} != the module's ${stats.savedRatio}`);
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

/**
 * 一条读数的五条轴 + 判词。
 *
 * `ok` 是语义判定里满分判词的条数（负对照那一轴），`soft`/`hard` 是另外两种判词；`tokens` 这一轴**读不到**
 * —— 出货适配器的 `meta` 只带 `model`/`promptVersion`，契约里的 `meta.usage` 三个适配器都没填，
 * 所以如实记 null，而不是拿别处的数字冒充。没有 CER，理由见文件头。
 */
function readingOf(judge, clip, reference, text, latencyMs, style, declared) {
  const fidelity = identifierFidelity(reference, text);
  const [verdict, why] = judge === null ? ['?', 'the judge rubric was not loaded'] : judge(clip, text);
  return {
    verdict,
    why,
    ok: verdict === OK_VERDICT ? 1 : 0,
    soft: verdict === SOFT_VERDICT ? 1 : 0,
    hard: verdict === OK_VERDICT || verdict === SOFT_VERDICT ? 0 : 1,
    // 退化只在**声明了 written 的服务**上算：whisper 那一列返回 verbatim 是它的声明（`style:
    // 'verbatim'`），把它记成「退化成听写」就把一条正常的读数报成了损伤。
    degraded: style === 'verbatim' && declared === 'written' ? 1 : 0,
    marks: sentenceMarks(text),
    naive: naiveMarks(text),
    commas: commaMarks(text),
    identifiers: fidelity.total,
    survived: fidelity.survived,
    missing: fidelity.missing,
    style: style ?? null,
    declared: declared ?? null,
    latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
    tokens: null,
  };
}

/**
 * 把快照折成配对读数。
 *
 * `conditions` / `controlVariant` / `drop` 是三个可变异点（自检用）。配对（协议第 1 条）：配对集合是
 * **所有条件都有读数**的那些片段。`n` 就是它的大小。
 */
export function measure(frozen, { conditions = CONDITIONS, controlVariant = 'real', drop = null, judge = null, fallbackJudge = null } = {}) {
  const control = controlCondition(conditions);
  const rubric = judge ?? fallbackJudge;
  const entries = frozen.entries;

  const textFor = (entry, condition) => {
    if (drop && condition.key === drop) return null;
    if (control && controlVariant !== 'real') {
      // 反方向变异：把这一对**钉在轴的两端** —— 对照侧给真值（事实/标识符全在），参照侧给空串
      // （什么都没有）。合成文本在**证伪器**里是合法的：它测的是 checker 能不能看见反向位移，
      // 不是某次识别结果。空串那一侧对 `ok` 与 `survived` 都是确定性的 0。
      if (controlVariant === 'inverted') {
        if (condition.key === control.key) return entry.reference;
        if (condition.key === control.control.vs) return '';
      }
      // 变异：负对照的读数被**替换**（或被清空），与快照里本来有没有它无关 —— 一个「只在缺失时
      // 才生效」的变异等于没有触发，而快照里它是有读数的。
      if (condition.key === control.key) {
        if (controlVariant === 'zero') {
          const base = entry.transcripts[control.control.vs];
          return typeof base === 'string' ? base : null;
        }
        if (controlVariant === 'empty') return null;
      }
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
      ...readingOf(
        rubric,
        entry.clip,
        entry.reference,
        textFor(entry, condition),
        entry.latencyMs?.[condition.key],
        entry.styles?.[condition.key],
        entry.declared?.[condition.key],
      ),
    }));
    const sum = (pick) => rows.reduce((a, r) => a + pick(r), 0);
    const latencies = rows.map((r) => r.latencyMs).filter((v) => typeof v === 'number');
    columns.set(condition.key, {
      condition,
      rows,
      n: rows.length,
      ok: sum((r) => r.ok),
      soft: sum((r) => r.soft),
      hard: sum((r) => r.hard),
      marks: sum((r) => r.marks),
      naive: sum((r) => r.naive),
      commas: sum((r) => r.commas),
      survived: sum((r) => r.survived),
      identifiers: sum((r) => r.identifiers),
      verbatim: rows.filter((r) => r.style === 'verbatim').length,
      degraded: sum((r) => r.degraded),
      latencyMean: latencies.length ? latencies.reduce((a, v) => a + v, 0) / latencies.length : null,
      tokens: null,
    });
  }

  return { conditions, control, paired, columns, readings: paired.length * conditions.length };
}

/**
 * 负对照的方向判定，与它的几种「不能红」形态。
 *
 * 返回 `{ status, detail }`：`moved` 是按预测方向动了；`flat` 是没动（位移 0）；`against` 是朝反方向
 * 动了；`absent` 是负对照根本不在条件表里；`empty` 是这一轴没有可读的位移。后四种都必须让运行红。
 * **每一种 detail 都点名负对照的条件键与预测方向**（`omni|head|none` / `down`）：一条只说「负对照
 * 不见了」的判词读不出红在哪一位。
 */
export function controlVerdict(result) {
  const control = result.control ?? controlCondition(CONDITIONS);
  const named = (status, detail, extra = {}) =>
    ({ status, detail: `[${control ? `${control.key} 预测方向=${control.control.direction} vs ${control.control.vs} axis=${control.control.axis}` : 'no control declared'}] ${detail}`, delta: null, up: 0, same: 0, down: 0, ...extra });

  if (!control) return named('absent', '条件表里没有声明负对照');
  const axis = control.control.axis;
  const mine = result.columns.get(control.key);
  const theirs = result.columns.get(control.control.vs);
  if (!mine) {
    return named('absent', `${control.key} 不在本次条件表里 —— 「${axis} 相对 ${control.control.vs} ${control.control.direction}」这条预测没有被执行`);
  }
  if (!theirs) {
    return named('absent', `${control.key} 的参照条件 ${control.control.vs} 不在本次条件表里 —— 没有可读的位移`);
  }
  if (!theirs.n) {
    return named('empty', `${control.key} vs ${control.control.vs}：参照条件在配对集合里一条读数都没有`);
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
    return named('empty', `${detail} —— 两个条件在这一轴上都是 0，没有可读的位移`, { delta, up, same, down });
  }
  if (delta === 0) return named('flat', `${detail} —— 负对照没有移动`, { delta, up, same, down });
  if (control.control.direction === 'down' ? delta < 0 : delta > 0) {
    return named('moved', `${detail} —— 按预测方向（${control.control.direction}）移动`, { delta, up, same, down });
  }
  return named('against', `${detail} —— 朝预测的**反方向**移动`, { delta, up, same, down });
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const fmt = (v, n) => (v === null || v === undefined ? 'null' : Number(v).toFixed(n));

function printColumn(column) {
  const { condition, n } = column;
  console.log(
    `\n  ${pad(condition.key, 16)} n=${n}  ok ${column.ok}/${n}  soft ${column.soft}  hard ${column.hard}  ` +
      `identifiers ${column.survived}/${column.identifiers}  marks ${column.marks}  commas ${column.commas}  ` +
      `verbatim-style ${column.verbatim}/${n}  degraded ${column.degraded}/${n}  ` +
      `latency ${fmt(column.latencyMean, 0)}ms  tokens ${column.tokens === null ? 'n/a' : column.tokens}`,
  );
  for (const row of column.rows) {
    console.log(
      `      ${pad(row.clip, 14)} n=1  ${row.verdict}${row.why ? `(${row.why})` : ''}  ` +
        `id=${row.survived}/${row.identifiers}  marks=${row.marks} commas=${row.commas}  style=${row.style ?? 'null'}  ` +
        `latency=${row.latencyMs ?? 'null'}ms` +
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
      console.log(`      ${pad(condition.key, 16)} ${row.verdict} ${row.text}`);
    }
  }
}

function printControl(result) {
  const verdict = controlVerdict(result);
  const ok = verdict.status === 'moved';
  const control = result.control ?? controlCondition(CONDITIONS);
  console.log('\nnegative control (the `omni|head` shape — the report must say whether it moved, not that it ran):');
  console.log(`  predicted: ${control ? control.control.axis : '(none)'} ${control ? control.control.direction : ''} vs ${control ? control.control.vs : '(none)'}`);
  console.log(`  prediction (written before the readings): ${control ? control.control.prediction : '(none)'}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${verdict.detail}`);
  return { verdict, ok };
}

// ---------------------------------------------------------------------------
// 自检：把「能红」做成机检，而不是文档里的一句话。
//
// 七条变异，每条都必须红；真实快照必须绿。缺了正面的一半，一个「永远返回红」的 checker 也能通过全部
// 变异 —— 所以真实快照的绿读数与变异红是同一个断言的两半。
// ---------------------------------------------------------------------------

export function assertFalsifiers(frozen, { conditions = CONDITIONS, judge = null } = {}) {
  const failures = [];
  const summary = [];

  const real = measure(frozen, { conditions, judge });
  const realVerdict = controlVerdict(real);
  if (realVerdict.status !== 'moved') {
    failures.push(`real snapshot: the negative control is ${realVerdict.status}, not moved (${realVerdict.detail})`);
  }
  summary.push(`real=${realVerdict.status}(${realVerdict.delta})`);
  if (!real.paired.length) failures.push('real snapshot: the paired set is empty');
  if (!real.readings) failures.push('real snapshot: zero readings');

  // `inverted` 那条变异的构造本身也要有读数：它把对照钉在真值上，若真值在这一轴上一个满分判词都拿不到，
  // 「反向位移」就无从谈起 —— 那时红的是这条构造，而不是负对照。
  const fabricatedOk = conditions
    .filter((c) => c.control)
    .map((c) => measure(frozen, { conditions, judge, controlVariant: 'inverted' }).columns.get(c.key)?.ok ?? 0)[0];
  if (!(fabricatedOk > 0)) {
    failures.push(
      `control=inverted: the fabricated control (the clip's ground truth) scores ${fabricatedOk} on the control axis — ` +
        'the opposite-direction construction has no headroom, so 反方向 cannot be demonstrated',
    );
  }

  const variants = [
    ['control=absent', { conditions: conditions.filter((c) => !c.control) }, 'absent'],
    ['control=zero', { conditions, controlVariant: 'zero' }, 'flat'],
    ['control=inverted', { conditions, controlVariant: 'inverted' }, 'against'],
    ['control=empty', { conditions, controlVariant: 'empty' }, 'empty'],
    [`drop=${conditions[0].key}`, { conditions, drop: conditions[0].key }, 'empty'],
  ];
  for (const [label, opts, expected] of variants) {
    const result = measure(frozen, { ...opts, judge });
    const verdict = controlVerdict(result);
    const red = verdict.status !== 'moved';
    if (!red) failures.push(`${label}: expected the run to red, got "${verdict.status}" (${verdict.detail})`);
    if (red && verdict.status !== expected) {
      failures.push(`${label}: red for the wrong reason — expected "${expected}", got "${verdict.status}" (${verdict.detail})`);
    }
    summary.push(`${label}=${verdict.status}`);
  }

  // n = 0：语料为空。它必须红在「没有语料」上，而不是碰巧红在别处。
  const empty = measure({ entries: [] }, { conditions, judge });
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
 * 两个服务各自的凭据来源，都在**仓库外**（不在任何提交里，AC10）。
 *
 * Groq 在 `/data/home/yale/work/tc-verify/.env`（前两份记录用的同一个文件），DashScope 的 key 在主检出
 * 根部被 git 忽略的 `.env.test`（那份文件里没有 base URL 行，所以端点在这里有一个默认值：E 组那批读数
 * 用的同一个 workspace 端点，逐字来自 `experiments/voice-omni-written/raw/omni.mts`，未公开的端点不是
 * 秘密，key 才是）。文件名与变量名在这里写死而不是靠环境碰运气：一个读不到凭据的运行必须**指名**它找了
 * 哪里，而不是发一个匿名的请求过去收 401。
 */
const ENV_TEST = resolve(mainCheckoutRoot(), '.env.test');
const CREDENTIAL_SOURCES = {
  'openai-compatible': {
    envFile: '/data/home/yale/work/tc-verify/.env',
    vars: ['GROQ_BASE_URL', 'GROQ_API_KEY'],
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
  },
  'dashscope-omni': {
    envFile: ENV_TEST,
    vars: ['DASHSCOPE_BASE_URL', 'DASHSCOPE_API_KEY'],
    defaultBaseUrl: 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com',
  },
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

/** 与第一份记录一致的最小间隔：Groq on_demand 约 20 RPM；DashScope 这一侧同样是串行发。 */
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
 * 一个条件的**唯一**发出点：出货适配器 + 全局 `fetch`，`fetchImpl` 不包装、`AsrRequest` 的 body 由适配器
 * 自己构造（这条服务的 body 里没有一处由调用方决定 —— `honors` 三项全 false，提示词是适配器自己的常量）。
 * 任何一处「runner 自己拼请求」都会让读数量到 runner 的线协议而不是产品的。
 *
 * 延迟在这里量：`transcribe` 调用前后各一个时钟，所以它是**适配器那一跳**的墙钟，不含节流等待。
 *
 * `NO_SPEECH_DETECTED` 是**一条读数，不是一个异常**：服务说「这条音里没有人话」时，读数是「它什么也没
 * 返回」，记成空文本。把它当成崩溃会让最该被看见的那种损伤（负对照那条音）反而没有读数。
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

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const started = Date.now();
    const result = await adapter.transcribe(
      {
        audio: { bytes: new Uint8Array(bytes), mimeType: 'audio/wav', fileName: 'clip.wav' },
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
    if (result.code === 'NO_SPEECH_DETECTED') {
      return { text: '', latencyMs, style: null, transformations: [], usage: null, noSpeech: true };
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
 * 缓存跨进程是它的用处，也正是配对比较的陷阱：一批读数里混进两次运行的取数，「同一批语料上的配对」就
 * 不成立了。所以每条缓存项都带 `run`，冻结前要求它们**同一个 run**；不同就红，并指路 `--fresh`。
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
 * `trimVoiceAudio`，负对照列按 `HEAD_SECONDS` 取前缀。缓存键含条件键（内含模型 tag），所以「同一个
 * 条件」是可复用的，而「不同条件」永远不会互相冒充。
 */
export async function runLive(frozen, adapters, credentials, { conditions = CONDITIONS, log = console.log, fresh = false } = {}) {
  const run = fresh ? new Date().toISOString() : null;
  const cache = fresh ? { entries: {} } : loadCache();
  const activeRun = run ?? cache.entries[Object.keys(cache.entries)[0]]?.run ?? new Date().toISOString();
  const entries = frozen.entries.map((entry) => ({
    ...entry,
    audio: { ...entry.audio },
    transcripts: { ...entry.transcripts },
    styles: { ...entry.styles },
    declared: { ...entry.declared },
    runs: { ...entry.runs },
    latencyMs: { ...entry.latencyMs },
  }));
  let fetched = 0;

  for (const entry of entries) {
    const { samples, sampleRate } = decodeWav(join(CORPUS_FIXTURES, entry.clip));
    entry.audio.baselineSec = samples.length / sampleRate;
    const columns = new Map();
    for (const column of COLUMNS) {
      const { bytes, stats } = encodeColumn(samples, sampleRate, column);
      columns.set(column, bytes);
      entry.audio[`${column}Sha256`] = sha256(bytes);
      if (stats) entry.audio[`${column}SavedRatio`] = stats.savedRatio;
      if (column === 'headFrozen') entry.audio.headSec = HEAD_SECONDS;
    }
    // 串行：条件 × 片段，一个一个 await，没有并发（协议第 7 条）。
    for (const condition of conditions) {
      const key = `${condition.key}|${entry.clip}`;
      // 服务自己声明的输出风格，随读数一起落盘：离线重算要能分清「verbatim 是它的声明」与
      // 「written 的服务退化成 verbatim」，而这个事实只有 registry 手里的适配器知道。
      entry.declared[condition.key] = adapters.get(condition.providerId)?.capabilities?.style ?? null;
      const hit = cache.entries[key];
      if (hit && typeof hit.text === 'string') {
        entry.transcripts[condition.key] = hit.text;
        entry.styles[condition.key] = hit.style ?? null;
        entry.runs[condition.key] = hit.run;
        entry.latencyMs[condition.key] = hit.latencyMs ?? null;
        continue;
      }
      const result = await invokeCondition(condition, columns.get(condition.trim), adapters, credentials);
      cache.entries[key] = {
        text: result.text,
        run: activeRun,
        takenAt: new Date().toISOString(),
        latencyMs: result.latencyMs,
        style: result.style,
        usage: result.usage,
      };
      entry.transcripts[condition.key] = result.text;
      entry.styles[condition.key] = result.style;
      entry.runs[condition.key] = activeRun;
      entry.latencyMs[condition.key] = result.latencyMs;
      fetched += 1;
      log(`  fetched ${key} (${result.latencyMs} ms, style=${result.style ?? 'none'}${result.noSpeech ? ', no speech' : ''})`);
      saveCache(cache);
    }
  }
  return { entries, fetched, cached: Object.keys(cache.entries).length, run: activeRun };
}

function freeze(entries, credentials) {
  const runIds = [...new Set(runIdsOf(entries).filter(Boolean))];
  const control = controlCondition(CONDITIONS);
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
        "The dashscope-omni adapter's prompt and task turn are its own frozen constants (honors is false on all three axes), so nothing about the request is this runner's.",
      throttle: `${MIN_INTERVAL_MS} ms minimum interval between calls, one call in flight (serial)`,
      recipe:
        "For every clip × condition: decode the first experiment's fixtures/<clip> with the runner's decodeWav, encode the column with the runner's encodeWav " +
        '(raw = encodeWav(decodeWav(file)); trimFrozen = trimVoiceAudio(samples, rate) — the shipping module; headFrozen = the first HEAD_SECONDS of the same samples — ' +
        'the negative control\'s deliberately damaged take), hand the buffer to the shipping adapter, keep the returned text verbatim. `--live` then `--freeze`; ' +
        'the cache is out/quality-cache.json.',
      corpus:
        'Reused, not copied: the eight Chinese clips at o65 occupancy (d01..d08-o65) live in ../voice-provider-paired-quality/fixtures/ — **TTS 合成** ' +
        "(tools/dictation-corpus.mjs SCRIPTS), a contiguous prefix of the out-of-tree dictation corpus. Same eight clips as the two sibling records, so their numbers and these are on one corpus.",
      referenceSource:
        'Read from ../voice-provider-paired-quality/fixtures/paired.json — the authored scripts from the out-of-tree corpus generator, verbatim, so the reference is ground truth by construction.',
      judge:
        `Semantic verdicts come from ${JUDGE_PATH}#judge, imported, not copied. Its CLI-only transitive import (` +
        'written.mts → omni.mts) eagerly reads eight webm from a sibling experiment\'s gitignored upload cache; this runner materialises those files ' +
        '(copy from the main checkout, else the repository\'s ffmpeg recipe) so that import resolves, and the rubric never reads them.',
      conditions: CONDITIONS.map((c) => ({
        key: c.key,
        providerId: c.providerId,
        model: c.model,
        trim: c.trim,
        note: c.note,
        ...(c.control ? { control: c.control } : {}),
      })),
      control: control
        ? {
            key: control.key,
            vs: control.control.vs,
            axis: control.control.axis,
            direction: control.control.direction,
            prediction: control.control.prediction,
            singleVariable: 'provider, model, wire, prompt and MIME are identical; the only thing that differs is the audio handed to the service',
            registeredBefore: 'the prediction above is a constant of run.mjs, written before any reading was taken',
            headSeconds: HEAD_SECONDS,
          }
        : null,
      knownGaps:
        'Token usage is not readable through the shipping adapters: `AsrSuccess.meta.usage` exists in the contract but none of the three adapters populates it, so this record reports the axis as n/a rather than substituting a number from elsewhere. ' +
        'Verbatim CER is deliberately absent: this service is `style: \'written\'` — its answer is a rewrite, not a dictation, so character error rate is not a meaningful instrument for it.',
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
  console.log('voice-dashscope-omni-paired-quality — paired comparison across provider × trim, on the shipping adapters (a reading, not a gate)');
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
  console.log(`  ${probeFailures.length ? 'FAIL' : 'ok  '} the shipping modules resolve, the registry hands out the dashscope-omni adapter, and this harness builds no omni request of its own`);

  // `--probe` 到这里就够：它读的是**路径与声明**（都在上面查过了），import rubric 只是取数路径上的
  // 事 —— 一个静态探针不该因为一个 CLI-only 的依赖材料缺失而红。
  if (flag('probe')) {
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    return finish(failures.length ? 1 : 0);
  }

  // 语义判定那一半：rubric 从 judge.mts import。载不进来必须**红**（一个没有语义读数的记录读不出
  // 这条服务与裁剪的关系），但语料为空那条变异的判词仍要打出来 —— 所以这里是记一笔，不是早退。
  let judge = null;
  let judgeError = null;
  try {
    const loaded = await loadJudge({ log: console.log });
    judge = loaded.judge;
    console.log(`  ok   the judge rubric is ${loaded.path}#judge (imported, not copied)`);
  } catch (error) {
    judgeError = error?.message ?? String(error);
    failures.push(`[judge] ${judgeError}`);
    console.log(`  FAIL the judge rubric could not be loaded: ${judgeError}`);
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
  const result = measure(frozen, { conditions, drop: value('drop'), controlVariant: value('control') ?? 'real', judge });
  console.log(`\ncorpus: ${frozen.entries.length} clip(s) in the snapshot, ${result.paired.length} in the paired set (every condition returned a reading)`);
  console.log(`readings: n=${result.paired.length} × ${conditions.length} condition(s) = ${result.readings} row(s)`);
  if (!result.paired.length) failures.push(`[n] the paired set is empty — n=0 是一条空读数，不是绿读数 (snapshot ${frozen.entries.length} clip(s), ${conditions.length} condition(s))`);
  if (!result.readings) failures.push('[n] zero reading rows — 空读数不是绿读数');

  // AC3：配对集合内的读数必须来自**同一次运行**（协议第 1 条）。
  const runs = [...new Set(runIdsOf(frozen.entries).filter(Boolean))];
  const straddles = assertSingleRun(runIdsOf(frozen.entries));
  console.log(`\nrun: ${runs.length ? runs.join(', ') : '(no run id — snapshot taken before run ids were recorded)'} — ${runs.length <= 1 ? 'single run, so the pairing does not straddle runs' : 'MORE THAN ONE RUN'}`);
  for (const f of straddles) failures.push(`[pairing] ${f}`);

  // 冻结快照的音频必须就是出货模块的输出（含证伪器）。
  const canary = correspondenceCanary(frozen.entries);
  console.log(`\ncorrespondence (the frozen transcript must be this audio, byte for byte):`);
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
  if (!ok) failures.push(`[control] ${verdict.detail}`);

  printPairedText(result);

  // 自检 —— 七条变异各自必须红，且红在预期的位置上。
  const selfTest = assertFalsifiers(frozen, { conditions, judge });
  console.log('\nfalsifiers (each variant must red, and red for the stated reason):');
  console.log(`  ${selfTest.summary.join('  ')}`);
  for (const f of selfTest.failures) failures.push(`[falsifier] ${f}`);

  if (failures.length) {
    process.stderr.write(`\nvoice-dashscope-omni-paired-quality: ${failures.length} failure(s)\n`);
    for (const f of failures) process.stderr.write(`  ${f}\n`);
    return finish(1);
  }

  console.log(
    `\nvoice-dashscope-omni-paired-quality: OK — n=${result.paired.length}, ${result.readings} paired reading(s), ` +
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

// The last line of this file says what the last line of its output says, so that neither reading of
// "the runner's last line" can be satisfied while the other is not. Whatever the numbers above come
// out to on any future run, they are a reading and are NOT a criterion: nothing in this repository
// gates on them, and a change that moves them is not thereby a regression (ADR-004 decision 8).
// quality numbers are a reading and are NOT a criterion (ADR-004 decision 8)
