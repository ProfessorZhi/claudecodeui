import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen3.8-omni-flash';
const OUT = 'experiments/voice-omni-written/raw'; mkdirSync(OUT, { recursive: true });
const RES = `${OUT}/results.jsonl`;
const REPS = 3;
const paired = JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8'));
// Authored written-style references (rule: drop fillers 嗯/那个/就是, keep only the corrected part of a self-correction; identifiers verbatim)
export const WRITTEN_REF: Record<string, string> = {
  'd01-o65.wav': '把 server 里的 voice.service.ts 的超时改成三十秒',
  'd02-o65.wav': '改一下 voice.routes.ts',
  'd03-o65.wav': '看一下 useVoiceInput 这个 hook 是怎么处理 recording 的',
  'd04-o65.wav': '不要动 voice.service.ts，只改 voice.module.ts',
  'd05-o65.wav': '把超时从十五秒改成五十秒，不是五秒',
  'd06-o65.wav': '这个 composer 的按钮再加个快捷键',
  'd07-o65.wav': 'server 模块下的 voice 目录里加一个 call 的测试',
  'd08-o65.wav': '把默认模型换成 whisper turbo',
};
export const clips = paired.entries.map((e: any) => ({ clip: e.clip, ref: e.reference, data: `data:audio/webm;base64,${readFileSync(`experiments/voice-gemini-paired-quality/out/webm/${e.clip.replace('.wav', '.webm')}`).toString('base64')}` }));
let seed = 20260924; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const shuffle = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const paths = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
const proj: string[] = []; const seen = new Set<string>();
for (const p of paths) { const b = p.split('/').pop()!; for (const n of [b, b.replace(/\.[a-z]{1,5}$/i, '')]) if (n && !seen.has(n)) { seen.add(n); proj.push(n); } }
export const TRUE = ['voice.service.ts', 'voice.routes.ts', 'voice.module.ts', 'useVoiceInput'];
export const IRRELEVANT = ['tailwind.config.js', 'package-lock.json', 'playwright.config.ts', 'useLocalStorage'];
export const DECOY = ['voice.controller.ts', 'voice.router.ts', 'voice.model.ts', 'useVoiceOutput'];
export const hay = shuffle(proj.filter((n) => !TRUE.includes(n))).slice(0, 66); for (const t of TRUE) hay.splice(Math.floor(rnd() * 66), 0, t);
export const full = shuffle(proj);
const VERBATIM = '逐字转写这段音频。只输出转写文本，不要解释。代码标识符、文件名保持原样。';
const WRITTEN = '把这段口述转写成书面文字：加标点，删掉「嗯」「那个」「就是」等口头禅；说话人自我更正时只保留更正后的内容。代码标识符、文件名、英文词逐字保留，不要翻译、不要编造、不要省略实际说出的内容。只输出结果。';
export const CTX = (list: string[]) => `\n\n以下是本项目中可能出现的名字（文件名、标识符）：\n${list.join('、')}`;
export const GUARD = '\n只有音频里明确说到时才使用上面列表里的名字；听不清或不确定时按听到的写，不要替换成列表里的名字，也不要输出音频里没有说的名字。';
type Cond = { key: string; phase: number; effort?: string; prompt: string; injected: string[]; written?: boolean };
export const CONDS: Cond[] = [
  { key: 'p1-none', phase: 1, effort: 'none', prompt: VERBATIM, injected: [] },
  { key: 'p1-low', phase: 1, effort: 'low', prompt: VERBATIM, injected: [] },
  { key: 'p1-default', phase: 1, prompt: VERBATIM, injected: [] },
  { key: 'p2-written', phase: 2, effort: 'none', prompt: WRITTEN, injected: [], written: true },
  { key: 'p3-terms', phase: 3, effort: 'none', prompt: VERBATIM + CTX(TRUE), injected: TRUE },
  { key: 'p3-irrelevant', phase: 3, effort: 'none', prompt: VERBATIM + CTX(IRRELEVANT), injected: IRRELEVANT },
  { key: 'p3-decoy', phase: 3, effort: 'none', prompt: VERBATIM + CTX(DECOY), injected: DECOY },
  { key: 'p3-prose', phase: 3, effort: 'none', prompt: VERBATIM + '\n\n背景：这是 CloudCLI 项目的语音模块。服务端在 voice.service.ts、voice.routes.ts、voice.module.ts，前端的录音 hook 叫 useVoiceInput。', injected: TRUE },
  { key: 'p3-haystack70', phase: 3, effort: 'none', prompt: VERBATIM + CTX(hay), injected: hay },
  { key: 'p3-full', phase: 3, effort: 'none', prompt: VERBATIM + CTX(full), injected: full },
  { key: 'p3-full-guard', phase: 3, effort: 'none', prompt: VERBATIM + CTX(full) + GUARD, injected: full },
];
async function call(c: Cond, clip: any) {
  const body = { model: MODEL, modalities: ['text'], stream: false, ...(c.effort ? { reasoning_effort: c.effort } : {}),
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: clip.data, format: 'webm' } }, { type: 'text', text: c.prompt }] }] };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', finish: j?.choices?.[0]?.finish_reason ?? null, err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 160)}`, usage: j?.usage ?? null };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', finish: null, err: e.name, usage: null }; }
}
if (process.argv[2] === 'meta' && process.argv[1]?.endsWith('omni.mts')) console.log(JSON.stringify({ proj: proj.length, hay: hay.length, hayHasTrue: TRUE.every((t) => hay.includes(t)), fullChars: CTX(full).length }));
if (process.argv[2] === 'run' && process.argv[1]?.endsWith('omni.mts')) {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.cond}|${r.clip}|${r.rep}`; }) : []);
  const deadline = Date.now() + Number(process.env.BUDGET_MS ?? 540000);
  const only = process.env.ONLY?.split(','); let n = 0;
  for (const c of CONDS) { if (only && !only.includes(c.key)) continue;
    for (let rep = 0; rep < REPS; rep++) for (const clip of clips) {
      const k = `${c.key}|${clip.clip}|${rep}`; if (done.has(k)) continue;
      if (Date.now() > deadline) { console.log(`BUDGET-STOP after ${n} calls (at ${c.key})`); process.exit(0); }
      let r = await call(c, clip); if (r.status !== 200 && r.status !== 400) { await new Promise((s) => setTimeout(s, 3000)); r = await call(c, clip); }
      appendFileSync(RES, JSON.stringify({ cond: c.key, clip: clip.clip, rep, ...r, at: new Date().toISOString() }) + '\n'); n++;
      if (r.status !== 200) console.log(`${k} ${r.status} ${r.err}`);
    }
    console.log(`done ${c.key} (${new Date().toISOString().slice(11, 19)})`);
  }
  console.log(`ALL-DONE (${n} new calls)`);
}
