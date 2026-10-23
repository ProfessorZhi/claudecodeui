// A2 runner: none + c1..c8 over the 13 clips, per PREREG.md. Resumable; 4 calls in flight.
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-omni-written/a2/run.mts run
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { CLIPS } from '../raw/e-ctx-real.mts';
import { CONDS } from '../raw/written.mts';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const RES = new URL('./results.jsonl', import.meta.url);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const CTX = JSON.parse(readFileSync(new URL('../fixtures/a2-contexts.json', import.meta.url), 'utf8')).contexts as { key: string; text: string }[];
export const ARMS = [{ key: 'none', context: '', reps: 10 }, ...CTX.map((c) => ({ key: c.key, context: c.text, reps: 5 }))];
async function call(arm: (typeof ARMS)[number], clip: (typeof CLIPS)[number]) {
  const body = { model: 'qwen3.8-omni-flash', modalities: ['text'], reasoning_effort: E.effort, stream: false,
    messages: [{ role: 'system', content: E.system }, { role: 'user', content: [
      { type: 'input_audio', input_audio: { data: clip.data, format: 'webm' } },
      ...(arm.context ? [{ type: 'text', text: arm.context }] : []),
      { type: 'text', text: E.user }] }] };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 160)}`, usage: j?.usage ?? null };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', err: e.name, usage: null }; }
}
if (process.argv[2] === 'run' && process.argv[1]?.endsWith('run.mts')) {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.cond}|${r.clip}|${r.rep}`; }) : []);
  const jobs: [typeof ARMS[number], typeof CLIPS[number], number][] = [];
  for (const arm of ARMS) for (let rep = 0; rep < arm.reps; rep++) for (const clip of CLIPS) if (!done.has(`${arm.key}|${clip.clip}|${rep}`)) jobs.push([arm, clip, rep]);
  const deadline = Date.now() + Number(process.env.BUDGET_MS ?? 540000); let n = 0, fails = 0, stop = false;
  console.log(`pending ${jobs.length}`);
  const worker = async () => { while (jobs.length && !stop) {
    if (Date.now() > deadline) { stop = true; break; }
    const [arm, clip, rep] = jobs.shift()!;
    let r = await call(arm, clip); if (r.status !== 200) { await new Promise((s) => setTimeout(s, 3000)); r = await call(arm, clip); }
    if (r.status >= 400 && r.status < 500) { console.log(`${arm.key}|${clip.clip}|${rep} ${r.status} ${r.err}`); if (++fails >= 3) { console.log('ABORT'); stop = true; } continue; } fails = 0;
    appendFileSync(RES, JSON.stringify({ cond: arm.key, clip: clip.clip, set: clip.set, rep, ...r, at: new Date().toISOString() }) + '\n'); n++;
  } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(stop && jobs.length ? `STOPPED after ${n}, ${jobs.length} left` : `ALL-DONE (${n} new)`);
}
