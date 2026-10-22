#!/usr/bin/env node
/**
 * ADR-004 后续任务 8 — 风格化（`style: written`）的**双向负对照**。
 *
 * 现场：ADR-004 决策 5 把输出信封从 `{text}` 扩为 `{text, style, transformations}`，
 * 因为 provider 优先返回书面化文本。出货的 `src/shared/identifierFidelity.ts` 量的是
 * **逐字存活**（大小写与点号敏感），而一份书面化文本本来就不逐字等于口语原话 ——
 * 于是那条判据对风格化会**失明或失义**。按 ADR-004 决策 5 与裁定 2，语义等价轴被拆成
 * 两半：质量半人读（不进判据，决策 8），**安全半机检**，就是本文件。
 *
 * 本文件量两件事，且两件事都必须能红：
 *
 *   happened   风格化"确实发生了"：`transformations` 非空、`style` 为 `written`、
 *              且声明与实际改写**一致**（声明了改写就必须真的改了；没声明就不许改）。
 *              惰性实现（原样返回 + `transformations: []`）必须让这一半红。
 *   verbatim   标识符"逐字保留"：句子里的每一个标识符（含文件路径、camelCase 符号、
 *              命令行开关、绝对路径）逐字出现在风格化后的文本里。
 *              把标识符一起改写的实现（`voice.service.ts` → `voice service ts`，
 *              决策 5 点名的失效形态）必须让这一半红。
 *
 * 一个恒绿的判据没有测量任何东西，但一个**恒红**的判据同样没有 —— 所以除三条负对照外
 * 还必须有正面控制：一条手写的、合格的风格化结果必须在两半上都绿。没有它，一个
 * "永远返回红"的 checker 也能通过全部负对照。
 *
 * 口径（`docs/experiments/README.md` 协议第 3 条）：标识符存活**必须**用出货模块
 * `src/shared/identifierFidelity.ts` 量，不得在本工装里放第二份算法。本文件直接
 * import 它。
 *
 * 运行：
 *   node experiments/voice-style-negative-control/run.mjs              # 离线负对照 + 正面控制
 *   node experiments/voice-style-negative-control/run.mjs --live       # 加跑真实服务，落盘缓存
 *   node experiments/voice-style-negative-control/run.mjs --replay     # 只读缓存重算（不联网）
 *
 * 真实服务按 ADR-004 决策 8 **不进判据集**：它联网、需凭据、且依赖一个具体服务。
 * 它在这里是**读数**，不是闸。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findIdentifiers, identifierFidelity } from '../../src/shared/identifierFidelity.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');
const CACHE_PATH = join(OUT_DIR, 'style-cache.json');

/** 信封里允许出现的改写声明（ADR-004 决策 5 的 `AsrTransformation`）。 */
const TRANSFORMATIONS = new Set([
  'punctuate',
  'de-disfluency',
  'written-style',
  'markdown',
  'identifier-canonicalized',
  'self-correction-applied',
]);

/**
 * S0 语料 —— 固定下来，含文件路径与代码片段。
 * 每一条都必须携带 ≥1 个标识符，否则「逐字保留」那一半会**空过**（total=0 ⇒ rate=null）。
 * 这个前提由 `assertCorpus()` 机检，不靠读的人记得。
 */
const CORPUS = [
  {
    id: 'zh-file-and-hook',
    text: '把 voice.service.ts 里的 timeout 从三十秒改成六十秒，然后看一下 useVoiceInput 这个 hook，再更新 voice.routes.ts。',
  },
  {
    id: 'en-file-and-hook',
    text: 'Change the timeout in voice.service.ts to sixty seconds, then look at the useVoiceInput hook and update voice.routes.ts.',
  },
  {
    id: 'zh-code-fragment',
    text: '在 server/modules/voice/voice.service.ts 里，const timeout = 30000 太短了，改成 60000，另外 --voice-trim 这个开关保持默认。',
  },
  {
    id: 'zh-path-and-symbol',
    text: 'GET /api/voice/health 现在只看服务端环境变量，客户端的 MIME_CANDIDATES 与 encodeWavBlob 也应该反映出来。',
  },
];

/**
 * 正面控制：一条合格的风格化结果长什么样。手写，离线，不联网。
 * 它必须两半都绿 —— 这是"checker 不是恒红"的证据。
 */
const GOOD = {
  'zh-file-and-hook':
    '请将 voice.service.ts 中的 timeout 从三十秒改为六十秒，随后查看 useVoiceInput 这个 hook，并更新 voice.routes.ts。',
  'en-file-and-hook':
    'Update the timeout in voice.service.ts to sixty seconds, then review the useVoiceInput hook and update voice.routes.ts.',
  'zh-code-fragment':
    '在 server/modules/voice/voice.service.ts 中，const timeout = 30000 过短，应改为 60000；此外 --voice-trim 这个开关保持默认。',
  'zh-path-and-symbol':
    'GET /api/voice/health 目前只反映服务端环境变量，客户端侧的 MIME_CANDIDATES 与 encodeWavBlob 也应体现出来。',
};

// ---------------------------------------------------------------------------
// 假实现（负对照）。三条各打一个不同的洞。
// ---------------------------------------------------------------------------

/** 惰性：风格化根本没发生。洞在 `happened`。 */
const lazyService = (sentence) => ({
  text: sentence,
  style: 'written',
  transformations: [],
});

/** 谎报：声明了改写，但原样返回。洞在 `happened` 的**一致性**那一支。 */
const lyingService = (sentence) => ({
  text: sentence,
  style: 'written',
  transformations: ['written-style', 'punctuate'],
});

/** 把标识符一起写"人话"。洞在 `verbatim` —— 决策 5 点名的失效形态。 */
const manglingService = (sentence) => ({
  text: mangleIdentifiers(sentence),
  style: 'written',
  transformations: ['written-style', 'punctuate'],
});

/** `voice.service.ts` -> `voice service ts`；`useVoiceInput` -> `use voice input`。 */
function flattenIdentifier(identifier) {
  return identifier
    .replace(/^--?/, '')
    .replace(/^\/+/, '')
    .replace(/[._/-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

/**
 * 按出货模块认出的标识符逐个改写。用 `findIdentifiers` 造**对手**而不是造**判据**：
 * 对手越是被保证"确实改掉了判据看得见的东西"，这条负对照就越严格。目标是同一个
 * 模块这一事实不会制造假绿 —— 若判据瞎了，对手改了而判据说没改，控制就会**失败**。
 */
function mangleIdentifiers(text) {
  let out = String(text);
  for (const identifier of findIdentifiers(text).sort((a, b) => b.length - a.length)) {
    out = out.split(identifier).join(flattenIdentifier(identifier));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 机检：安全半。两个读数，各自可红。
// ---------------------------------------------------------------------------

/**
 * @param {string} sentence 送进去的原句
 * @param {{text?: unknown, style?: unknown, transformations?: unknown}} envelope 服务返回的信封
 */
function checkStyleEnvelope(sentence, envelope) {
  const input = String(sentence);
  const text = typeof envelope?.text === 'string' ? envelope.text : null;
  const declared = Array.isArray(envelope?.transformations) ? envelope.transformations : null;

  const styleOk = envelope?.style === 'written';
  const vocabularyOk = declared !== null && declared.every((t) => TRANSFORMATIONS.has(t));
  const declarations = declared === null ? 0 : declared.length;

  const rewritten = text !== null && text.trim() !== input.trim();
  // 「声明与实际改写一致」：声明了就必须真的改了（否则是谎报），没声明就不许改
  // （否则是**未声明**的改写 —— 下游按 `transformations` 选轴，会选错）。
  const consistent = declared !== null && (declarations > 0) === rewritten;

  const fidelity = identifierFidelity(input, text ?? '');
  // total === 0 时 rate 是 null，「全数存活」是空话 —— 必须显式要求 total > 0，
  // 否则一个把整句删掉的实现在没有标识符的句子上会读成绿。
  const verbatim = text !== null && fidelity.total > 0 && fidelity.rate === 1;

  return {
    textOk: text !== null,
    styleOk,
    vocabularyOk,
    declarations,
    rewritten,
    consistent,
    happened: text !== null && styleOk && vocabularyOk && declarations > 0 && rewritten && consistent,
    verbatim,
    identifiers: fidelity.total,
    survived: fidelity.survived,
    missing: fidelity.missing,
  };
}

/** 语料前提：每条句子都要携带标识符，否则 `verbatim` 那一半会空过。 */
function assertCorpus() {
  const empty = CORPUS.filter((entry) => findIdentifiers(entry.text).length === 0);
  if (empty.length) {
    throw new Error(
      `corpus precondition failed: ${empty.map((e) => e.id).join(', ')} carry no identifier, so the verbatim half would pass vacuously`,
    );
  }
}

// ---------------------------------------------------------------------------
// 驱动：真实 `style: written` 服务（联网 + 凭据）。按协议第 7 条**串行**执行。
// ---------------------------------------------------------------------------

const STYLE_SYSTEM_PROMPT = [
  'You are the styling stage of a dictation pipeline.',
  'Rewrite the user sentence into written style: add punctuation, drop filler words, keep the meaning.',
  'HARD CONSTRAINT: every technical identifier, file name, path, command-line flag and code fragment must be preserved VERBATIM, character for character. Never split, re-space, re-case or translate them.',
  'Reply with JSON only, of the form {"text": <rewritten sentence>, "style": "written", "transformations": [<subset of "punctuate","de-disfluency","written-style","markdown","identifier-canonicalized","self-correction-applied">]}.',
].join(' ');

/** 凭据只从仓库外读，且永不打印。 */
function loadCredentials(envFilePath) {
  const file = envFilePath ?? process.env.VOICE_STYLE_ENV_FILE ?? '/data/home/yale/work/tc-verify/.env';
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
    // 默认落到标点实验工装所用的同一张凭据（Groq 的 OpenAI 兼容端点）。
    baseUrl: pick('VOICE_STYLE_BASE_URL') || pick('GROQ_BASE_URL'),
    apiKey: pick('VOICE_STYLE_API_KEY') || pick('GROQ_API_KEY'),
    model: pick('VOICE_STYLE_MODEL') || 'openai/gpt-oss-120b',
  };
}

function parseEnvelope(raw) {
  const trimmed = String(raw).trim();
  const candidates = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence) candidates.push(fence[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try the next shape
    }
  }
  throw new Error(`style service did not return a JSON envelope: ${trimmed.slice(0, 200)}`);
}

async function callStyleService(credentials, sentence) {
  const res = await fetch(`${credentials.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.apiKey}` },
    body: JSON.stringify({
      model: credentials.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STYLE_SYSTEM_PROMPT },
        { role: 'user', content: sentence },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`style service HTTP ${res.status}: ${body.slice(0, 200)}`);
  const payload = JSON.parse(body);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error(`style service returned no message content`);
  return parseEnvelope(content);
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const CONDITIONS = [
  { key: 'good', kind: 'positive', service: (sentence, id) => ({ text: GOOD[id], style: 'written', transformations: ['punctuate', 'written-style'] }) },
  { key: 'lazy', kind: 'negative', predictedRed: 'happened', service: lazyService },
  { key: 'mangle', kind: 'negative', predictedRed: 'verbatim', service: manglingService },
  { key: 'lie', kind: 'negative', predictedRed: 'happened', service: lyingService },
];

const HALVES = ['happened', 'verbatim'];

function runOffline() {
  const rows = [];
  for (const condition of CONDITIONS) {
    for (const entry of CORPUS) {
      rows.push({ condition: condition.key, id: entry.id, reading: checkStyleEnvelope(entry.text, condition.service(entry.text, entry.id)) });
    }
  }
  return rows;
}

/**
 * 每条负对照：预测红的那一半必须**在整批句子上**都红，**另一半不参与判定**
 * （mangle 的 happened 是绿的，那正是它与 lazy 互补的地方）。同时验证假实现真的动了
 * 文本 —— 否则控制是空过的（"改了 0 个"与"一个都没被抓到"读数相同）。
 */
function assertNegativeControls() {
  const failures = [];
  const summary = [];

  for (const condition of CONDITIONS.filter((c) => c.kind === 'negative')) {
    let caught = 0;
    for (const entry of CORPUS) {
      const envelope = condition.service(entry.text, entry.id);
      const reading = checkStyleEnvelope(entry.text, envelope);
      const moved = typeof envelope.text === 'string' && envelope.text.trim() !== entry.text.trim();
      if (reading[condition.predictedRed]) {
        failures.push(`${condition.key}/${entry.id}: predicted ${condition.predictedRed}=red, got green`);
      } else {
        caught += 1;
      }
      if (condition.key === 'mangle' && !moved) {
        failures.push(`${condition.key}/${entry.id}: the fake did not rewrite the sentence at all — the control would pass vacuously`);
      }
    }
    summary.push(`${condition.key}(${condition.predictedRed})=red ${caught}/${CORPUS.length}`);
  }

  // 正面控制：两半都必须绿。没有它，一个恒红的 checker 能通过上面全部负对照。
  let goodGreen = 0;
  for (const entry of CORPUS) {
    const reading = checkStyleEnvelope(entry.text, CONDITIONS[0].service(entry.text, entry.id));
    for (const half of HALVES) {
      if (!reading[half]) failures.push(`good/${entry.id}: positive control expected ${half}=green, got red`);
    }
    if (!reading.rewritten) failures.push(`good/${entry.id}: positive control is byte-identical to the input, so it is not a style reading at all`);
    if (HALVES.every((h) => reading[h])) goodGreen += 1;
  }
  summary.push(`good(both)=green ${goodGreen}/${CORPUS.length}`);

  return { failures, summary };
}

function formatReading(reading) {
  return [
    `happened=${reading.happened ? 'GREEN' : 'red'}`,
    `verbatim=${reading.verbatim ? 'GREEN' : 'red'}`,
    `declarations=${reading.declarations}`,
    `rewritten=${reading.rewritten}`,
    `consistent=${reading.consistent}`,
    `identifiers=${reading.survived}/${reading.identifiers}`,
  ].join(' ');
}

function loadCache() {
  if (!existsSync(CACHE_PATH)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function saveCache(cache) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const replay = argv.includes('--replay');
  const envFileIndex = argv.indexOf('--env-file');
  const envFilePath = envFileIndex >= 0 ? argv[envFileIndex + 1] : undefined;

  assertCorpus();

  const identifiers = CORPUS.reduce((sum, entry) => sum + findIdentifiers(entry.text).length, 0);

  // 负对照 + 正面控制（离线、确定）。这一半是机检，AC1/AC2 由它成立。
  const { failures, summary } = assertNegativeControls();
  console.log(`offline controls n=${CORPUS.length} identifiers=${identifiers} :: ${summary.join(' ')}`);
  if (failures.length) {
    for (const failure of failures) console.error(`CONTROL FAILED: ${failure}`);
    process.exit(1);
  }
  console.log(`OK: all ${CONDITIONS.length} controls moved in the predicted direction (offline, no network)`);

  if (!live && !replay) {
    console.log(`\n(pass --live to take the real \`style: written\` reading, --replay to recompute it from ${CACHE_PATH})`);
    return;
  }

  const credentials = loadCredentials(envFilePath);
  if (live && !credentials.apiKey) {
    console.error(`FAIL: --live needs credentials (VOICE_STYLE_API_KEY / GROQ_API_KEY, or a .env at ${credentials.envFile})`);
    process.exit(2);
  }
  const cache = loadCache();
  const conditionKey = `live:${credentials.model}`;

  if (live) {
    // 串行：一条一条发，不并发（协议第 7 条）。
    for (const entry of CORPUS) {
      const key = `${conditionKey}|${entry.id}`;
      if (cache.entries[key]) continue;
      const envelope = await callStyleService(credentials, entry.text);
      cache.entries[key] = { envelope, takenAt: new Date().toISOString() };
      console.log(`  fetched ${entry.id}`);
    }
    saveCache(cache);
  }

  // 真实读数与假实现**同一次运行、同一批句子**上配对（协议第 1 条）。
  const rows = runOffline();
  let paired = 0;
  const liveRows = [];
  for (const entry of CORPUS) {
    const cached = cache.entries[`${conditionKey}|${entry.id}`];
    if (!cached) {
      console.error(`  MISSING ${entry.id}: no cached live reading for ${conditionKey} (cache ${CACHE_PATH})`);
      continue;
    }
    paired += 1;
    liveRows.push({ id: entry.id, envelope: cached.envelope, reading: checkStyleEnvelope(entry.text, cached.envelope) });
  }

  if (!paired) {
    console.error(`FAIL: no live readings paired with the controls — the table would not be a paired comparison`);
    process.exit(3);
  }

  const halved = HALVES.map((half) => `${half}=${liveRows.filter((row) => row.reading[half]).length}/${paired}`);
  const survived = liveRows.reduce((sum, row) => sum + row.reading.survived, 0);
  const total = liveRows.reduce((sum, row) => sum + row.reading.identifiers, 0);
  console.log(`\nlive service=${credentials.model} n=${paired}/${CORPUS.length} ${halved.join(' ')} identifiers=${survived}/${total}`);
  console.log(`mode=${live ? 'live' : 'replay'} cache=${CACHE_PATH}`);

  console.log('\npaired table (this run, same sentences):');
  for (const condition of CONDITIONS) {
    for (const entry of CORPUS) {
      const row = rows.find((r) => r.condition === condition.key && r.id === entry.id);
      console.log(`  ${condition.key.padEnd(7)} ${entry.id.padEnd(20)} ${formatReading(row.reading)}`);
    }
  }
  for (const row of liveRows) {
    console.log(`  ${'live'.padEnd(7)} ${row.id.padEnd(20)} ${formatReading(row.reading)}`);
  }

  console.log('\nstyled text (real service):');
  for (const row of liveRows) {
    const entry = CORPUS.find((e) => e.id === row.id);
    console.log(`  [${row.id}]`);
    console.log(`    in : ${entry.text}`);
    console.log(`    out: ${row.reading.textOk ? row.envelope.text : '<no text>'}`);
    console.log(`    transformations=${JSON.stringify(row.envelope.transformations)} missing=${JSON.stringify(row.reading.missing)}`);
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exit(1);
});
