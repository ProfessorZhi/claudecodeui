// S2 逐段识别：qwen3.8-omni-flash，E 组两步 JSON，无上下文。每（音色 × 脚本 × 单元）3 次。可续跑，4 路并发。
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/s2/run-asr.mts run
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { CONDS } from '../../voice-omni-written/raw/written.mts';
import { SCRIPTS, VOICES } from './scripts.mts';

const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const DIR = '/data/home/yale/work/tc-verify/corpus/voice-draft';
const RES = new URL('./asr.jsonl', import.meta.url);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
export const REPS = 3;

async function call(data: string) {
  const body = { model: 'qwen3.8-omni-flash', modalities: ['text'], reasoning_effort: E.effort, stream: false,
    messages: [{ role: 'system', content: E.system }, { role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'webm' } }, { type: 'text', text: E.user }] }] };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 160)}`, usage: j?.usage ?? null };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', err: e.name, usage: null }; }
}

if (process.argv[2] === 'run' && process.argv[1]?.endsWith('run-asr.mts')) {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.voice}|${r.script}|${r.unit}|${r.rep}`; }) : []);
  const jobs: { voice: string; script: string; unit: number; rep: number; path: string }[] = [];
  for (const rep of Array.from({ length: REPS }, (_, i) => i)) for (const voice of VOICES) for (const s of SCRIPTS) for (const u of s.units) {
    const path = `${DIR}/${voice}/${s.id}/u${String(u.n).padStart(2, '0')}.webm`;
    if (!done.has(`${voice}|${s.id}|${u.n}|${rep}`) && existsSync(path)) jobs.push({ voice, script: s.id, unit: u.n, rep, path });
  }
  console.log(`pending ${jobs.length}`);
  const deadline = Date.now() + Number(process.env.BUDGET_MS ?? 3000000); let n = 0, fails = 0, stop = false;
  const worker = async () => { while (jobs.length && !stop) {
    if (Date.now() > deadline) { stop = true; break; }
    const j = jobs.shift()!; const data = `data:audio/webm;base64,${readFileSync(j.path).toString('base64')}`;
    let r = await call(data); if (r.status !== 200) { await new Promise((s) => setTimeout(s, 3000)); r = await call(data); }
    if (r.status >= 400 && r.status < 500) { console.log(`${j.voice}|${j.script}|${j.unit}|${j.rep} ${r.status} ${r.err}`); if (++fails >= 3) { console.log('ABORT'); stop = true; } continue; } fails = 0;
    appendFileSync(RES, JSON.stringify({ voice: j.voice, script: j.script, unit: j.unit, rep: j.rep, ...r, at: new Date().toISOString() }) + '\n');
    if (++n % 50 === 0) console.log(`${n} done`);
  } };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(stop && jobs.length ? `STOPPED after ${n}, ${jobs.length} left` : `ALL-DONE (${n} new)`);
}
