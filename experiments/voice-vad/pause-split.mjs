/**
 * pause-split — does cutting speech at a pause lose a self-correction?
 *
 * The question this measures, and every rule used to answer it, is registered in
 * `experiments/voice-vad/PREREG-pause-split.md` BEFORE any data was taken. The pre-registration is
 * also carried into the frozen snapshot as `prereg`, so a later reader can check the rule against
 * the readings without trusting this file's history.
 *
 * WHAT IS BEING COMPARED. One audio (half-1 + P seconds of silence + half-2, a spoken
 * self-correction) is recognised two ways, paired on the SAME audio:
 *   · `whole` — the entire audio as ONE request. The recogniser can resolve the correction across
 *     the silence.
 *   · `split` — the two halves as TWO requests (the cut the live segmenter makes when the pause
 *     exceeds `flushSilenceSec`), reassembled in order. The correction is no longer resolvable.
 * The reading is `resolved` (registered below): the reassembled text names the corrected target
 * and does NOT name the pre-correction target as an instruction object.
 *
 * THE RECOGNISER IS THE SHIPPING ADAPTER, RESOLVED FROM THE REGISTRY — not imported directly (a
 * direct import proves the file exports `transcribe`, not that it is the adapter the product hands
 * out), and never a request this harness builds (the adapter's own `buildChatRequestBody` does).
 *
 * MODES
 *   · (default)         generation: TTS-synthesise the corpus (edge-tts, free) and drive the
 *                       shipping adapter over the plan, freeze `fixtures/pause-split.json`.
 *   · `--offline`       load the frozen snapshot and recompute every reading. No network, no
 *                       credentials, no corpus. `--offline --variant=swap-order` runs the
 *                       registered negative control.
 *   · `--dry-run`       the budget gate, before any call: a missing pricing file, a placeholder
 *                       price and an over-budget estimate each abort with a NAMED reason.
 *   · `--provider=fake-huge`  the cumulative-budget falsifier: every answer carries an enormous
 *                       usage; assert no call is made once the cumulative spend has crossed
 *                       `budgetCny`, and that the readings taken so far are still written.
 *
 * The audio is never committed (it lives in `experiments/voice-vad/out/`, covered by the
 * repository's `out/` ignore); the snapshot keeps the raw transcripts, the usage and the cost, so
 * `--offline` recomputes the readings without any of it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = resolve(HERE, 'fixtures', 'pause-split.json');
const PRICING = resolve(HERE, 'pricing.json');
const OUT_DIR = resolve(HERE, 'out');

// ── the pre-registration, as data ────────────────────────────────────────────────────────────
// A copy of `experiments/voice-vad/PREREG-pause-split.md`. Only a human may change a bound here
// after the fact, and doing so voids the record.
const PREREG = {
  pauses: [2, 5, 10],
  reps: 5,
  scripts: ['d02', 'd08', 'e02', 'e08'],
  tolerance: 0.15,
  selectionRule:
    'smallest P with splitRate(P) >= wholeRate(P) - tolerance; if none qualifies, the P with the smallest GAP=wholeRate-splitRate, ties broken by the LARGER P (a later flush cuts fewer corrections; latency is the secondary term)',
  negativeControl: {
    variant: 'swap-order',
    minDrop: 0.3,
    resolvedCeiling: 0.25,
    realResolvedFloor: 0.5,
    description:
      'the whole-condition audio with the two halves reversed, so the recogniser resolves toward the pre-correction target; the pooled whole resolvedRate must drop per the registered red condition',
  },
  budgetCny: 1.0,
  worstTokensPerCall: 1024,
};

// ── the corpus, by construction ──────────────────────────────────────────────────────────────
// Halves and targets are the source generator's scripts verbatim (tools/dictation-corpus.mjs
// SCRIPTS / SCRIPTS_EN). The cut point is the correction marker; the ground truth (which target is
// before / after) is authored, not detected.
const SCRIPTS = [
  { id: 'd02', lang: 'zh', h1: '改一下 voice.service.ts，', h2: '嗯不对，应该是 voice.routes.ts', a: 'voice.service.ts', b: 'voice.routes.ts' },
  { id: 'd08', lang: 'zh', h1: '把默认模型换成 whisper large，', h2: '啊不，是 whisper turbo', a: 'whisper large', b: 'whisper turbo' },
  { id: 'e02', lang: 'en', h1: 'Update voice.service.ts,', h2: 'no wait, it should be voice.routes.ts', a: 'voice.service.ts', b: 'voice.routes.ts' },
  { id: 'e08', lang: 'en', h1: 'Switch the default model to whisper large,', h2: 'no, whisper turbo', a: 'whisper large', b: 'whisper turbo' },
];
const BY_ID = new Map(SCRIPTS.map((s) => [s.id, s]));

// ── the metric (registered) ──────────────────────────────────────────────────────────────────
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * `resolved` for one reassembled transcript against one script: it names the corrected target and
 * does NOT name the pre-correction target as an instruction object. Full normalised identifiers
 * (not stems), so `voiceRoutes.ts` still counts as the corrected target while `verse-roots.ts`
 * does not.
 */
function resolvedFor(text, script) {
  const t = norm(text);
  return t.includes(norm(script.b)) && !t.includes(norm(script.a));
}

/** Wilson 95% interval, the same formula as experiments/voice-vad/metrics.mjs#wilsonInterval. */
function wilsonInterval(successes, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// ── budget gate (pricing) ────────────────────────────────────────────────────────────────────
function priceIsPlaceholder(v) {
  return typeof v !== 'number' || !Number.isFinite(v) || v <= 0;
}

/** Read the price file, applying CLI overrides. Every failure names its cause and never guesses. */
function loadPricingFile(path, overrides = {}) {
  if (!existsSync(path)) {
    throw Object.assign(new Error(`pricing file not found: ${path}`), {
      reason: `缺 pricing.json：未找到单价文件 ${path}`,
    });
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw Object.assign(new Error(`pricing file is not valid JSON: ${path}`), {
      reason: `单价文件无法解析：${path}`,
    });
  }
  let inputPerMillionCny = raw.inputPerMillionCny;
  let outputPerMillionCny = raw.outputPerMillionCny;
  // This experiment's own hard ceiling (`budgetCny = 1.0`, registered) — NOT the shared file's
  // coarser ¥2.0 guard. The unit prices are reused from `pricing.json`; the budget is this task's.
  let budgetCny = PREREG.budgetCny;
  if (Number.isFinite(overrides.priceInput)) inputPerMillionCny = overrides.priceInput;
  if (Number.isFinite(overrides.priceOutput)) outputPerMillionCny = overrides.priceOutput;
  if (Number.isFinite(overrides.budget)) budgetCny = overrides.budget;
  if (priceIsPlaceholder(inputPerMillionCny) || priceIsPlaceholder(outputPerMillionCny)) {
    throw Object.assign(new Error('pricing file carries a placeholder price'), {
      reason:
        `单价为占位值：inputPerMillionCny=${JSON.stringify(inputPerMillionCny)} ` +
        `outputPerMillionCny=${JSON.stringify(outputPerMillionCny)}（人须从控制台填入真实单价，worker 不得猜测）`,
    });
  }
  return { budgetCny, inputPerMillionCny, outputPerMillionCny };
}

const worstCaseCostCny = (calls, tokensPerCall, outPrice) => (calls * tokensPerCall * outPrice) / 1e6;

/** The service's usage, flattened from the adapter's own `meta.usage` (its keys, verbatim). */
function usageFromAdapter(res) {
  const u = res?.meta?.usage ?? {};
  const num = (k) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? u[k] : 0);
  const inputTokens = num('prompt_tokens');
  const outputTokens = num('completion_tokens');
  return { inputTokens, outputTokens, reasoningTokens: num('completion_tokens_details.reasoning_tokens') };
}

const callCostCny = (usage, p) =>
  (usage.inputTokens * p.inputPerMillionCny + usage.outputTokens * p.outputPerMillionCny) / 1e6;

// ── the plan ─────────────────────────────────────────────────────────────────────────────────
/** Every call the generation run makes, in a fixed order. 4 scripts × 3 pauses × 5 reps × 4. */
function buildPlan() {
  const plan = [];
  for (const s of SCRIPTS) {
    for (const pause of PREREG.pauses) {
      for (let rep = 0; rep < PREREG.reps; rep++) {
        plan.push({ scriptId: s.id, pause, rep, condition: 'whole' });
        plan.push({ scriptId: s.id, pause, rep, condition: 'split', half: 1 });
        plan.push({ scriptId: s.id, pause, rep, condition: 'split', half: 2 });
        plan.push({ scriptId: s.id, pause, rep, condition: 'swapWhole' });
      }
    }
  }
  return plan;
}

// ── credentials (generation only; names the variable it looked for) ──────────────────────────
function mainCheckoutRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: HERE,
      encoding: 'utf8',
    }).trim();
    return dirname(common);
  } catch {
    return resolve(HERE, '..', '..');
  }
}

function readEnvFile(file) {
  const out = {};
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}

const DEFAULT_BASE_URL = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com';

/** Look for the credential in the environment, then in the main checkout's git-ignored .env.test. */
function loadCredentials() {
  const envFile = resolve(mainCheckoutRoot(), '.env.test');
  const fromFile = readEnvFile(envFile);
  const pick = (name) => process.env[name] ?? fromFile[name] ?? '';
  const apiKey = pick('DASHSCOPE_API_KEY');
  if (!apiKey) {
    throw Object.assign(new Error('missing credential'), {
      reason:
        `凭据缺失：未找到 DASHSCOPE_API_KEY（先在环境变量、再在 ${envFile} 里找过）。` +
        `--live 需要真实凭据；不得降级为假 provider 后报绿。`,
    });
  }
  return { apiKey, baseUrl: pick('DASHSCOPE_BASE_URL') || DEFAULT_BASE_URL, envFile, model: 'qwen3.8-omni-flash' };
}

// ── audio construction (generation only) ─────────────────────────────────────────────────────
let _tts = null;
async function ttsModule() {
  if (!_tts) {
    const tools = '/data/home/yale/work/tc-verify/tools';
    _tts = {
      speak: (await import(`${tools}/tts.mjs`)).speak,
      wav: await import(`${tools}/wav.mjs`),
    };
  }
  return _tts;
}

const audioCache = new Map();
/** The 16 kHz samples for a plan step's audio; memoised per (script, variant, pause). */
async function audioFor(step) {
  const { speak, wav } = await ttsModule();
  const key = `${step.scriptId}|${step.condition}|${step.half ?? ''}|${step.pause}`;
  if (audioCache.has(key)) return audioCache.get(key);
  const s = BY_ID.get(step.scriptId);
  const h1key = `${s.id}|h1`;
  const h2key = `${s.id}|h2`;
  if (!audioCache.has(h1key)) audioCache.set(h1key, await speak(s.h1));
  if (!audioCache.has(h2key)) audioCache.set(h2key, await speak(s.h2));
  const h1 = audioCache.get(h1key);
  const h2 = audioCache.get(h2key);
  let samples;
  if (step.condition === 'split') samples = step.half === 1 ? h1 : h2;
  else if (step.condition === 'whole') samples = wav.concat(h1, wav.silence(step.pause), h2);
  else samples = wav.concat(h2, wav.silence(step.pause), h1); // swapWhole
  audioCache.set(key, samples);
  return samples;
}

// ── providers ────────────────────────────────────────────────────────────────────────────────
const MIN_INTERVAL_MS = Number(process.env.PAUSE_SPLIT_MIN_INTERVAL_MS ?? 400);
const TIMEOUT_MS = Number(process.env.PAUSE_SPLIT_TIMEOUT_MS ?? 120000);
let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

/** The shipping adapter, resolved from the registry (generation path only). */
async function realProvider(creds) {
  const { register } = await import('tsx/esm/api');
  register();
  const registry = await import(resolve(HERE, '..', '..', 'shared', 'asr', 'asrRegistry.ts'));
  const adapter = registry.tryResolve('dashscope-omni');
  if (!adapter) throw new Error("the registry does not hand out 'dashscope-omni'");
  const { wav } = await ttsModule();
  return {
    name: 'dashscope-omni',
    async transcribe(step) {
      const bytes = new Uint8Array(wav.encodeWav(await audioFor(step), 16000));
      for (let attempt = 0; ; attempt++) {
        await throttle();
        let res;
        try {
          res = await adapter.transcribe(
            { audio: { bytes, mimeType: 'audio/wav', fileName: 'clip.wav' } },
            { baseUrl: creds.baseUrl, apiKey: creds.apiKey, model: creds.model, timeoutMs: TIMEOUT_MS, fetchImpl: fetch },
          );
        } catch (e) {
          if (attempt >= 4) throw e;
          await sleep(800 * (attempt + 1));
          continue;
        }
        if (res.ok) return { text: res.text, usage: usageFromAdapter(res) };
        if (attempt >= 4) throw new Error(`adapter refused: ${res.code} ${res.message}`);
        await sleep(1500 * (attempt + 1));
      }
    },
  };
}

/** A provider whose every answer carries an enormous usage — the cumulative-budget falsifier. */
function hugeUsageProvider() {
  let calls = 0;
  return {
    name: 'fake-huge',
    callCount: () => calls,
    transcribeSync(step) {
      calls++;
      const s = BY_ID.get(step.scriptId);
      // A deterministic, resolved-looking text; this provider measures the budget, not recognition.
      const text = step.condition === 'whole' || step.condition === 'swapWhole' ? s.b : step.half === 1 ? s.a : s.b;
      return { text, usage: { inputTokens: 2_000_000, outputTokens: 2_000_000, reasoningTokens: 0 } };
    },
  };
}

// ── reassembly + cells (shared by generation and --offline) ──────────────────────────────────
/** Rebuild one rep's reassembled transcript from its stored calls. */
function reassemble(callsForRep, condition) {
  if (condition === 'split') {
    const one = callsForRep.find((c) => c.half === 1);
    const two = callsForRep.find((c) => c.half === 2);
    return `${one?.text ?? ''}。${two?.text ?? ''}`;
  }
  return callsForRep[0]?.text ?? '';
}

/** Group calls by (condition, scriptId, pause) × rep and compute resolved cells + pooled rates. */
function computeCells(calls) {
  const conditions = ['whole', 'split', 'swapWhole'];
  const cells = { whole: {}, split: {}, swapWhole: {} };
  const pooled = {};
  for (const condition of conditions) {
    let successes = 0;
    let total = 0;
    for (const s of SCRIPTS) {
      for (const pause of PREREG.pauses) {
        const repTexts = [];
        for (let rep = 0; rep < PREREG.reps; rep++) {
          const forRep = calls.filter(
            (c) => c.condition === condition && c.scriptId === s.id && c.pause === pause && c.rep === rep,
          );
          if (!forRep.length) continue;
          repTexts.push(resolvedFor(reassemble(forRep, condition), s));
        }
        const n = repTexts.length;
        const resolved = repTexts.filter(Boolean).length;
        const [lo, hi] = wilsonInterval(resolved, n);
        cells[condition][`${s.id}|${pause}`] = {
          scriptId: s.id,
          pause,
          n,
          resolved,
          resolvedRate: n ? resolved / n : null,
          wilson95: [Number(lo.toFixed(4)), Number(hi.toFixed(4))],
        };
        successes += resolved;
        total += n;
      }
    }
    const [lo, hi] = wilsonInterval(successes, total);
    pooled[condition] = {
      n: total,
      resolved: successes,
      resolvedRate: total ? successes / total : null,
      wilson95: [Number(lo.toFixed(4)), Number(hi.toFixed(4))],
    };
  }
  // One cell per (condition, pause): the reading the selection rule compares, with n = 4 scripts × 5
  // reps = 20. The `cells` above are the per-script breakdown (n=5); this is the pooled grid the
  // pre-registration calls a 格.
  const byPause = {};
  for (const condition of conditions) {
    byPause[condition] = {};
    for (const pause of PREREG.pauses) {
      const repTexts = [];
      for (const s of SCRIPTS) {
        for (let rep = 0; rep < PREREG.reps; rep++) {
          const forRep = calls.filter(
            (c) => c.condition === condition && c.scriptId === s.id && c.pause === pause && c.rep === rep,
          );
          if (!forRep.length) continue;
          repTexts.push(resolvedFor(reassemble(forRep, condition), s));
        }
      }
      const n = repTexts.length;
      const resolved = repTexts.filter(Boolean).length;
      const [lo, hi] = wilsonInterval(resolved, n);
      byPause[condition][pause] = {
        condition,
        pause,
        n,
        resolved,
        resolvedRate: n ? resolved / n : null,
        wilson95: [Number(lo.toFixed(4)), Number(hi.toFixed(4))],
      };
    }
  }
  return { cells, pooled, byPause };
}

/** Count how many of the 24 (script × pause × condition) real cells are present. */
function missingCells(cells) {
  let missing = 0;
  for (const condition of ['whole', 'split']) {
    for (const s of SCRIPTS) {
      for (const pause of PREREG.pauses) {
        const c = cells[condition][`${s.id}|${pause}`];
        if (!c || c.n !== PREREG.reps) missing++;
      }
    }
  }
  return missing;
}

// ── reporting ────────────────────────────────────────────────────────────────────────────────
function printCells(cells, pooled) {
  for (const condition of ['whole', 'split']) {
    console.log(`  ${condition}: pooled resolved ${pooled[condition].resolved}/${pooled[condition].n} = ` +
      `${(pooled[condition].resolvedRate ?? 0).toFixed(3)} [${pooled[condition].wilson95.join(', ')}]`);
    for (const s of SCRIPTS) {
      const row = PREREG.pauses.map((p) => {
        const c = cells[condition][`${s.id}|${p}`];
        return c ? `${p}s:${c.resolved}/${c.n}` : `${p}s:--`;
      });
      console.log(`    ${condition} ${s.id}  ${row.join('  ')}`);
    }
  }
}

// ── selection ────────────────────────────────────────────────────────────────────────────────
function selectP(cells) {
  const rows = PREREG.pauses.map((pause) => {
    const whole = pooledRate(cells, 'whole', pause);
    const split = pooledRate(cells, 'split', pause);
    return { pause, whole, split, gap: whole - split };
  });
  const qualifies = rows.filter((r) => r.split >= r.whole - PREREG.tolerance);
  if (qualifies.length) {
    const min = Math.min(...qualifies.map((r) => r.pause));
    return { pause: min, reason: 'smallest P within tolerance', rows, fallback: false };
  }
  const minGap = Math.min(...rows.map((r) => r.gap));
  const tied = rows.filter((r) => Math.abs(r.gap - minGap) < 1e-9).map((r) => r.pause);
  const pause = Math.max(...tied);
  return { pause, reason: 'no P within tolerance; least GAP, tie broken to the larger P', rows, fallback: true };
}

function pooledRate(cells, condition, pause) {
  let resolved = 0;
  let n = 0;
  for (const s of SCRIPTS) {
    const c = cells[condition][`${s.id}|${pause}`];
    if (c) {
      resolved += c.resolved;
      n += c.n;
    }
  }
  return n ? resolved / n : 0;
}

// ── offline recompute ────────────────────────────────────────────────────────────────────────
function loadSnapshot(path) {
  if (!existsSync(path)) {
    throw Object.assign(new Error(`snapshot not found: ${path}`), {
      reason: `缺冻结快照：未找到 ${path}`,
    });
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runOffline(opts) {
  const snap = loadSnapshot(opts.out ?? SNAPSHOT);
  const { cells, pooled, byPause } = computeCells(snap.calls);
  const missing = missingCells(cells);
  console.log(`pause-split --offline (snapshot=${opts.out ?? SNAPSHOT}, variant=${opts.variant ?? 'none'})`);
  printCells(cells, pooled);
  console.log('  每格 (做法 × 停顿) n=20（4 脚本 × 5 重复）的 resolved 率与 Wilson 95%:');
  for (const condition of ['whole', 'split']) {
    const row = PREREG.pauses.map((p) => {
      const c = byPause[condition]?.[p];
      return c ? `${p}s:${c.resolved}/${c.n} [${c.wilson95.join(', ')}]` : `${p}s:--`;
    });
    console.log(`    ${condition}  ${row.join('  ')}`);
  }
  console.log(`  缺格数=${missing}（4×3×2=24 格，每格 n=${PREREG.reps}×4=${PREREG.reps * 4}）`);

  const sel = selectP(cells);
  console.log('  P 对照 (whole vs split pooled):');
  for (const r of sel.rows) {
    console.log(`    P=${r.pause}s  whole=${r.whole.toFixed(3)}  split=${r.split.toFixed(3)}  GAP=${r.gap.toFixed(3)}`);
  }
  console.log(`  推荐 flushSilenceSec = ${sel.pause}（${sel.reason}${sel.fallback ? '；无 P 落在容差内' : ''}）`);

  // `--write` persists the derived readings (recomputed from the frozen `calls`, no network, no
  // new calls) back into the snapshot, so the per-格 n=20 cells live in the frozen artifact.
  if (opts.write) {
    const target = opts.out ?? SNAPSHOT;
    writeFileSync(
      target,
      `${JSON.stringify({ ...snap, cells, pooled, byPause, missingCells: missing })}\n`,
    );
    console.log(`  已按冻结 calls 重算派生读数并回写 ${target}（未联网、未发起调用）`);
  }

  if (opts.variant === 'swap-order') {
    const whole = pooled.whole.resolvedRate ?? 0;
    const swap = pooled.swapWhole.resolvedRate ?? 0;
    const drop = whole - swap;
    const nc = PREREG.negativeControl;
    const red = swap <= whole - nc.minDrop && swap <= nc.resolvedCeiling && whole >= nc.realResolvedFloor;
    console.log(
      `  负对照 swap-order: whole=${whole.toFixed(3)} → swap=${swap.toFixed(3)}（Δ=${drop.toFixed(3)}）；` +
        `判红需 Δ≥${nc.minDrop} 且 swap≤${nc.resolvedCeiling} 且 whole≥${nc.realResolvedFloor}`,
    );
    if (red) {
      console.log('负对照红: 对调顺序把整段的 resolved 率按 PREREG 登记的方向推下去了，量具对「更正是否被解决」敏感');
      return 0;
    }
    console.error('pause-split: 负对照未按登记方向变红 —— 量具不敏感，整份记录作废重做');
    return 1;
  }
  return missing === 0 ? 0 : 1;
}

// ── dry run (budget gate) ────────────────────────────────────────────────────────────────────
function runDryRun(opts) {
  let pricing;
  try {
    pricing = loadPricingFile(opts.pricing ?? PRICING, opts);
  } catch (err) {
    console.error(`pause-split: ${err.reason ?? err.message}`);
    return 3;
  }
  const calls = buildPlan().length;
  const worst = worstCaseCostCny(calls, PREREG.worstTokensPerCall, pricing.outputPerMillionCny);
  if (worst > pricing.budgetCny) {
    console.error(
      `pause-split: 预估花费 ¥${worst.toFixed(4)} > budgetCny=¥${pricing.budgetCny} ` +
        `（calls=${calls}, ${PREREG.worstTokensPerCall} tokens/call, ¥${pricing.outputPerMillionCny}/M output）`,
    );
    return 3;
  }
  console.log(
    `预估最坏花费 = ¥${worst.toFixed(4)}（calls=${calls}, ${PREREG.worstTokensPerCall} tokens/call, ` +
      `¥${pricing.outputPerMillionCny}/M output）≤ budgetCny=¥${pricing.budgetCny}`,
  );
  return 0;
}

// ── cumulative budget gate (fake-huge) ───────────────────────────────────────────────────────
function runBudgetGate(opts) {
  let pricing;
  try {
    pricing = loadPricingFile(opts.pricing ?? PRICING, opts);
  } catch (err) {
    console.error(`pause-split: ${err.reason ?? err.message}`);
    return 3;
  }
  const plan = buildPlan();
  const worst = worstCaseCostCny(plan.length, PREREG.worstTokensPerCall, pricing.outputPerMillionCny);
  if (worst > pricing.budgetCny) {
    console.error(
      `pause-split: 预估花费 ¥${worst.toFixed(4)} > budgetCny=¥${pricing.budgetCny} —— 未发起任何调用`,
    );
    return 3;
  }
  // The fake provider counts its own calls, so the assertion is on the loop, not on arithmetic.
  const provider = hugeUsageProvider();
  const calls = [];
  let cumulative = 0;
  let stoppedOnBudget = false;
  for (const step of plan) {
    if (cumulative > pricing.budgetCny) {
      stoppedOnBudget = true;
      break;
    }
    const { text, usage } = provider.transcribeSync(step);
    const cost = callCostCny(usage, pricing);
    cumulative += cost;
    calls.push({
      index: calls.length,
      scriptId: step.scriptId,
      pause: step.pause,
      condition: step.condition,
      ...(step.half ? { half: step.half } : {}),
      rep: step.rep,
      usage,
      costCny: Number(cost.toFixed(6)),
      text,
    });
  }

  // Assertion: no call was issued after the cumulative spend had crossed the budget.
  let running = 0;
  let afterCrossing = 0;
  for (const c of calls) {
    if (running > pricing.budgetCny) afterCrossing++;
    running += c.costCny;
  }
  if (afterCrossing > 0) {
    console.error(`pause-split: 累计超预算后仍发起了 ${afterCrossing} 次调用`);
    return 1;
  }
  console.log(
    `累计预算闸: 假 provider 记录调用 ${provider.callCount()} 次后停发；累计 ¥${running.toFixed(4)} 越过 ` +
      `budgetCny=¥${pricing.budgetCny}，其后再无新调用（已有 ${calls.length} 条读数已落盘）`,
  );

  const outPath = opts.out ?? SNAPSHOT;
  const snap = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { schema: 1 };
  const usage = calls.reduce(
    (a, c) => ({ inputTokens: a.inputTokens + c.usage.inputTokens, outputTokens: a.outputTokens + c.usage.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  );
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  snap.budgetGate = {
    provider: provider.name,
    plannedCalls: plan.length,
    callCount: calls.length,
    stoppedOnBudget,
    budgetCny: pricing.budgetCny,
    pricing: { inputPerMillionCny: pricing.inputPerMillionCny, outputPerMillionCny: pricing.outputPerMillionCny },
    usage,
    costCny: Number(cumulative.toFixed(6)),
    calls,
    note:
      'fake-huge provider (every answer carries 2M input + 2M output tokens): this measures the cumulative ' +
      'budget halt, NOT recognition. The real readings live under `calls`/`cells` and are untouched.',
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snap)}\n`);
  console.log(`budget gate written to ${outPath} (budgetGate.callCount=${calls.length}); readings untouched`);
  return 0;
}

// ── generation (real calls) ──────────────────────────────────────────────────────────────────
async function runGenerate(opts) {
  let pricing;
  try {
    pricing = loadPricingFile(opts.pricing ?? PRICING, opts);
  } catch (err) {
    console.error(`pause-split: ${err.reason ?? err.message}`);
    return 3;
  }
  let creds;
  try {
    creds = loadCredentials();
  } catch (err) {
    console.error(`pause-split: ${err.reason ?? err.message}`);
    return 3;
  }
  const plan = buildPlan();
  const worst = worstCaseCostCny(plan.length, PREREG.worstTokensPerCall, pricing.outputPerMillionCny);
  if (worst > pricing.budgetCny) {
    console.error(
      `pause-split: 预估花费 ¥${worst.toFixed(4)} > budgetCny=¥${pricing.budgetCny} —— 未发起任何调用`,
    );
    return 3;
  }
  console.error(`generation: provider=${creds.model} via registry('dashscope-omni'); calls=${plan.length}; worst=¥${worst.toFixed(4)}`);
  const provider = await realProvider(creds);
  const calls = [];
  let cumulative = 0;
  let stoppedOnBudget = false;
  for (const step of plan) {
    if (cumulative > pricing.budgetCny) {
      stoppedOnBudget = true;
      break;
    }
    const { text, usage } = await provider.transcribe(step);
    const cost = callCostCny(usage, pricing);
    cumulative += cost;
    calls.push({
      index: calls.length,
      scriptId: step.scriptId,
      pause: step.pause,
      condition: step.condition,
      ...(step.half ? { half: step.half } : {}),
      rep: step.rep,
      usage,
      costCny: Number(cost.toFixed(6)),
      text,
    });
    if (calls.length % 20 === 0) {
      console.error(`  ...${calls.length}/${plan.length} calls, cumulative ¥${cumulative.toFixed(4)}`);
    }
  }
  const { cells, pooled, byPause } = computeCells(calls);
  const missing = missingCells(cells);
  const usage = calls.reduce(
    (a, c) => ({ inputTokens: a.inputTokens + c.usage.inputTokens, outputTokens: a.outputTokens + c.usage.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  );
  usage.totalTokens = usage.inputTokens + usage.outputTokens;

  const outPath = opts.out ?? SNAPSHOT;
  const prior = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
  const snap = {
    schema: 1,
    prereg: PREREG,
    provenance: {
      date: '2026-10-04',
      recogniser: 'dashscope-omni (shipping adapter, resolved via shared/asr/asrRegistry.ts)',
      model: creds.model,
      endpoint: creds.baseUrl,
      throttleMs: MIN_INTERVAL_MS,
      note:
        'Real dashscope-omni calls. Audio is TTS (edge-tts) — half-1 + P s silence + half-2 — and is not ' +
        'committed; the snapshot keeps the transcripts, usage and cost so --offline recomputes every reading.',
    },
    grid: { scripts: PREREG.scripts, pauses: PREREG.pauses, conditions: ['whole', 'split'], repsPerCell: PREREG.reps },
    pricing: { inputPerMillionCny: pricing.inputPerMillionCny, outputPerMillionCny: pricing.outputPerMillionCny },
    budgetCny: pricing.budgetCny,
    worstCaseCny: Number(worst.toFixed(6)),
    stoppedOnBudget,
    usage,
    costCny: Number(cumulative.toFixed(6)),
    missingCells: missing,
    cells,
    byPause,
    pooled,
    calls,
  };
  if (prior.budgetGate) snap.budgetGate = prior.budgetGate;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snap)}\n`);
  console.log(`generation done: calls=${calls.length} cost=¥${cumulative.toFixed(4)} usage=${JSON.stringify(usage)} missing=${missing}`);
  console.log(`written ${outPath}`);
  printCells(cells, pooled);
  return missing === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { offline: false, variant: null, dryRun: false, provider: 'real', pricing: null, out: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--write') opts.write = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--variant') opts.variant = argv[++i];
    else if (a.startsWith('--variant=')) opts.variant = a.slice('--variant='.length);
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a.startsWith('--provider=')) opts.provider = a.slice('--provider='.length);
    else if (a === '--pricing') opts.pricing = argv[++i];
    else if (a.startsWith('--pricing=')) opts.pricing = a.slice('--pricing='.length);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a === '--budget') opts.budget = Number(argv[++i]);
    else if (a.startsWith('--budget=')) opts.budget = Number(a.slice('--budget='.length));
    else if (a === '--price-input') opts.priceInput = Number(argv[++i]);
    else if (a.startsWith('--price-input=')) opts.priceInput = Number(a.slice('--price-input='.length));
    else if (a === '--price-output') opts.priceOutput = Number(argv[++i]);
    else if (a.startsWith('--price-output=')) opts.priceOutput = Number(a.slice('--price-output='.length));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.variant !== null && opts.variant !== 'swap-order') {
    throw new Error(`unknown variant: ${opts.variant} (expected "swap-order")`);
  }
  if (opts.provider !== 'real' && opts.provider !== 'fake-huge') {
    throw new Error(`unknown provider: ${opts.provider} (expected "real" or "fake-huge")`);
  }
  if (opts.variant !== null && !opts.offline) throw new Error('--variant requires --offline');
  return opts;
}

/** Throw on any network entry point — the offline recompute must not touch one. */
function installNoNetworkGuard() {
  const boom = () => {
    throw new Error('NO_NETWORK guard: the pause-split harness attempted a network call');
  };
  globalThis.fetch = boom;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`pause-split: ${err.message}`);
    return 2;
  }
  if (opts.offline) installNoNetworkGuard();
  if (opts.dryRun) return runDryRun(opts);
  if (opts.provider === 'fake-huge') return runBudgetGate(opts);
  if (opts.offline) return runOffline(opts);
  return runGenerate(opts);
}

process.exitCode = await main();
