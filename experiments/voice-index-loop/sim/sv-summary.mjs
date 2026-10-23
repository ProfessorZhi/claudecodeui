// S1 / S4 side by side: one row per recogniser text source, same corpus (v3, 466 clips), same judge, same system (L2a + D1 silent).
import { readFileSync, existsSync } from 'node:fs';
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/';   // replay.mjs is imported dynamically, after ASR_FILE is set
const SRC = [['Qwen3-ASR 1.7B (OpenRouter)', 'asr-v3.jsonl', ''], ['SenseVoice (sherpa text)', 'asr-sv.jsonl', 'sv'], ['SenseVoice (own CTC text)', 'asr-svown.jsonl', 'svown'], ['Omni transcript', 'asr-omni-t.jsonl', 'omnit'], ['Omni instruction (rewritten)', 'asr-omni-i.jsonl', 'omnii'], ['SenseVoice (patched sherpa)', 'asr-sv2.jsonl', 'sv2']];
const only = process.argv[2];   // child mode: print one JSON line for one source
if (only !== undefined) {
  process.env.ASR_FILE = SRC[Number(only)][1];
  const { replay } = await import('./replay.mjs');
  const tag = SRC[Number(only)][2]; const rd = (f) => readFileSync(ROOT + f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { recs } = replay({ name: 'sum', sources: new Set(['P', 'C', 'U']), variants: ['templates'] });
  const toks = recs.filter((r) => r.tok); const msgs = recs.filter((r) => r.msg);
  const itemsF = `e4-items${tag ? '-' + tag : ''}.json`, judgeF = `e4-judge${tag ? '-' + tag : ''}.jsonl`;
  let verdict = new Map(), items = [];
  if (existsSync(ROOT + itemsF) && existsSync(ROOT + judgeF)) { items = JSON.parse(readFileSync(ROOT + itemsF, 'utf8')); verdict = new Map(rd(judgeF).filter((r) => r.verdict).map((r) => [r.k, r.verdict])); }
  const hp = new Map(toks.map((r) => [`${r.id}|${r.tok}`, r.hitPost]));
  const err = toks.filter((r) => r.wrongAsr); const harmfulAll = items.filter((i) => verdict.get(i.k) === 'wrong');
  console.log(JSON.stringify({ n: toks.length, correct: toks.filter((r) => r.hitAsr).length, err: err.length, judged: items.filter((i) => verdict.has(i.k)).length, harmful: harmfulAll.length, harmfulResidual: harmfulAll.filter((i) => !hp.get(`${i.id}|${i.tok}`)).length, broken: toks.filter((r) => r.hitAsr && !r.hitPost).length, msgs: msgs.length }));
} else {
  const { execFileSync } = await import('node:child_process');
  console.log('source'.padEnd(32) + 'tokens  raw-correct  errors  harmful(judge)  harmful left after L2a+D1  correct-broken');
  SRC.forEach(([name], i) => { try { const o = JSON.parse(execFileSync('npx', ['tsx', new URL(import.meta.url).pathname, String(i)], { encoding: 'utf8', env: process.env }).trim().split('\n').pop()); console.log(name.padEnd(32) + `${String(o.n).padStart(6)}  ${String(o.correct).padStart(5)} (${Math.round(100 * o.correct / o.n)}%)  ${String(o.err).padStart(6)}  ${String(o.harmful).padStart(6)} (${(100 * o.harmful / o.n).toFixed(1)}% of tokens)  ${String(o.harmfulResidual).padStart(6)} (${(100 * o.harmfulResidual / o.n).toFixed(1)}%)  ${String(o.broken).padStart(5)}  [judged ${o.judged}/${o.err}, msgs ${o.msgs}]`); } catch (e) { console.log(name.padEnd(32) + 'n/a ' + String(e.message).slice(0, 60)); } });
}
