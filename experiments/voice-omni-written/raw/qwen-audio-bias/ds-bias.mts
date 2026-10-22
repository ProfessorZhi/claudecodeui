import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const MODEL = 'qwen-audio-3.1-asr-flash';
const OUT = 'experiments/voice-omni-written/raw/qwen-audio-bias'; mkdirSync(OUT, { recursive: true });
const RES = `${OUT}/results.jsonl`;
const REPS = 3;
const paired = JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8'));
const clips = paired.entries.map((e: any) => ({ clip: e.clip, ref: e.reference, data: `data:audio/webm;base64,${readFileSync(`experiments/voice-gemini-paired-quality/out/webm/${e.clip.replace('.wav', '.webm')}`).toString('base64')}` }));

// ── seeded rng ──
let seed = 20260924; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const shuffle = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// ── project identifiers: shipped flattening rule over tracked files, in tree (sorted path) order ──
const paths = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
const proj: string[] = []; const seen = new Set<string>();
for (const p of paths) { const b = p.split('/').pop()!; for (const n of [b, b.replace(/\.[a-z]{1,5}$/i, '')]) if (n && !seen.has(n)) { seen.add(n); proj.push(n); } }
const TRUE = ['voice.service.ts', 'voice.routes.ts', 'voice.module.ts', 'useVoiceInput'];
const IRRELEVANT = ['tailwind.config.js', 'package-lock.json', 'playwright.config.ts', 'useLocalStorage'];
const DECOY = ['voice.controller.ts', 'voice.router.ts', 'voice.model.ts', 'useVoiceOutput'];
function pack(list: string[], rounds = 5, per = 400) { const out: string[] = []; let cur = ''; for (const t of list) { const next = cur ? `${cur}、${t}` : t; if (next.length <= per) { cur = next; continue; } out.push(cur); if (out.length === rounds) return out; cur = t; } if (cur && out.length < rounds) out.push(cur); return out; }
const treeRounds = pack(proj);
const hay = shuffle(proj.filter((n) => !TRUE.includes(n))); for (const t of TRUE) hay.splice(Math.floor(rnd() * 55), 0, t);
const hayRounds = pack(hay);
const vocabProj = shuffle([...TRUE, ...shuffle(proj.filter((n) => !TRUE.includes(n))).slice(0, 2000 - TRUE.length)]);
const ctx = (rounds: string[]) => rounds.map((t) => ({ role: 'user', content: [{ type: 'input_text', text: t }] }));
const vocab = (terms: string[], w: number) => Object.fromEntries(terms.map((t) => [t, w]));

// ≤50 super-hotwords (documented per-request cap): 'scoped' = every candidate from a path containing 'voice' (a module-scope heuristic), then random fill; 'random' = the 4 true + 46 random project names
const voiceScope = [...new Set(paths.filter((p) => /voice/i.test(p)).flatMap((p) => { const b = p.split('/').pop()!; return [b, b.replace(/\.[a-z]{1,5}$/i, '')]; }))];
const scoped50 = [...new Set([...TRUE, ...voiceScope, ...shuffle(proj)])].slice(0, 50);
const random50 = [...TRUE, ...shuffle(proj.filter((n) => !TRUE.includes(n))).slice(0, 46)];
type Cond = { key: string; group: string; pre: any[]; vocab?: Record<string, number>; injected: string[] };
export const CONDS: Cond[] = [
  { key: 'none', group: 'baseline', pre: [], injected: [] },
  { key: 'ctx-terms', group: 'context', pre: ctx([TRUE.join('、')]), injected: TRUE },
  { key: 'ctx-irrelevant', group: 'context', pre: ctx([IRRELEVANT.join('、')]), injected: IRRELEVANT },
  { key: 'ctx-decoy', group: 'context', pre: ctx([DECOY.join('、')]), injected: DECOY },
  { key: 'ctx-prose', group: 'context', pre: ctx([`这是 CloudCLI 项目的语音模块。服务端在 voice.service.ts、voice.routes.ts、voice.module.ts，前端的录音 hook 叫 useVoiceInput。`]), injected: TRUE },
  { key: 'vocab-terms-w4', group: 'hotword', pre: [], vocab: vocab(TRUE, 4), injected: TRUE },
  { key: 'vocab-terms-w50', group: 'hotword', pre: [], vocab: vocab(TRUE, 50), injected: TRUE },
  { key: 'vocab-variants-w4', group: 'hotword', pre: [], vocab: vocab([...TRUE, 'voice service', 'voice routes', 'voice module', 'use voice input'], 4), injected: TRUE },
  { key: 'vocab-decoy-w4', group: 'hotword', pre: [], vocab: vocab(DECOY, 4), injected: DECOY },
  { key: 'ctx-project-tree', group: 'project', pre: ctx(treeRounds), injected: treeRounds.join('、').split('、') },
  { key: 'ctx-project-haystack', group: 'project', pre: ctx(hayRounds), injected: hayRounds.join('、').split('、') },
  { key: 'vocab-project-w4', group: 'project', pre: [], vocab: vocab(vocabProj, 4), injected: vocabProj },
  { key: 'ctx+vocab-project', group: 'project', pre: ctx(hayRounds), vocab: vocab(vocabProj, 4), injected: [...new Set([...hayRounds.join('、').split('、'), ...vocabProj])] },
  { key: 'vocab-w50-scoped', group: 'project', pre: [], vocab: vocab(scoped50, 50), injected: scoped50 },
  { key: 'vocab-w50-random', group: 'project', pre: [], vocab: vocab(random50, 50), injected: random50 },
];
export const META = { projCandidates: proj.length, treeRoundsChars: treeRounds.map((r) => r.length), treeHasTrue: TRUE.map((t) => treeRounds.join('、').split('、').includes(t)), hayHasTrue: TRUE.map((t) => hayRounds.join('、').split('、').includes(t)), hayTerms: hayRounds.join('、').split('、').length, vocabProj: vocabProj.length, voiceScope: voiceScope.length, scoped50Sample: scoped50.slice(0, 24) };

async function call(c: Cond, clip: any) {
  const body = { model: MODEL, input: { messages: [...c.pre, { role: 'user', content: [{ type: 'input_audio', input_audio: { data: clip.data } }] }] }, parameters: { format: 'opus', sample_rate: '48000', ...(c.vocab ? { vocabulary: c.vocab } : {}) } };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.output?.text ?? '', err: res.ok ? '' : `${j?.code} ${String(j?.message).slice(0, 160)}`, usage: j?.usage ?? null };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', err: e.name, usage: null }; }
}

if (process.argv[2] === 'run') {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.cond}|${r.clip}|${r.rep}`; }) : []);
  const deadline = Date.now() + Number(process.env.BUDGET_MS ?? 540000);
  const only = process.env.ONLY?.split(',');
  let n = 0;
  for (const c of CONDS) { if (only && !only.includes(c.key)) continue;
    for (let rep = 0; rep < REPS; rep++) for (const clip of clips) {
      const k = `${c.key}|${clip.clip}|${rep}`; if (done.has(k)) continue;
      if (Date.now() > deadline) { console.log(`BUDGET-STOP after ${n} calls`); process.exit(0); }
      let r = await call(c, clip); if (r.status !== 200 && r.status !== 400) { await new Promise((s) => setTimeout(s, 2000)); r = await call(c, clip); }
      appendFileSync(RES, JSON.stringify({ cond: c.key, clip: clip.clip, rep, ...r, at: new Date().toISOString() }) + '\n'); n++;
      if (r.status !== 200) console.log(`${k} ${r.status} ${r.err}`);
    }
    console.log(`done ${c.key}`);
  }
  console.log(`ALL-DONE (${n} new calls)`);
}
if (process.argv[2] === 'meta') console.log(JSON.stringify(META));
