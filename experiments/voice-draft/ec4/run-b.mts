// E-C4b 第二批新案例运行：gen（TTS）→ asr（omni，3 次）→ extract（E-C3 的抽取提示词，整段一次调用，无上下文）。
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/ec4/run-b.mts gen|asr|extract
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { CHAINS } from './scripts-b.mts';
import { readJsonl } from '../ec/common.mts';
const LOCAL = '/data/home/yale/work/tc-verify/corpus/voice-draft-ec4b'; const VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural']; const REPS = 3;
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions'; const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const SYS = readFileSync(new URL('../ec3/run.mts', import.meta.url), 'utf8').match(/export const SYS = `([\s\S]*?)`;/)![1];
async function post(body: any, timeout = 180000) { const t0 = Date.now(); for (let a = 0; a < 2; a++) { try { const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); const j: any = await res.json().catch(() => null); if (res.ok) return { status: 200, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null }; if (a === 1 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return { status: res.status, ms: Date.now() - t0, text: '', usage: null }; } catch { if (a === 1) return { status: 0, ms: Date.now() - t0, text: '', usage: null }; } await new Promise((s) => setTimeout(s, 3000)); } return { status: 0, ms: 0, text: '', usage: null }; }
const mode = process.argv[2]; mkdirSync(LOCAL, { recursive: true });
if (mode === 'gen') {
  const TC = '/data/home/yale/work/tc-verify'; const { buildClip } = await import(`${TC}/tools/dictation-corpus.mjs`); const { writeWav, RATE } = await import(`${TC}/tools/wav.mjs`); const failed: string[] = [];
  for (const voice of VOICES) for (const c of CHAINS) { const dir = `${LOCAL}/audio/${voice}/${c.id}`; mkdirSync(dir, { recursive: true });
    for (const u of c.units) { const base = `${dir}/u${String(u.n).padStart(2, '0')}`; if (existsSync(`${base}.webm`)) continue;
      try { const clip = await buildClip({ id: `${c.id}u${String(u.n).padStart(2, '0')}`, kind: 'eh', text: u.text }, 'o75', { voice, seed: 20261011 }); writeWav(`${base}.wav`, clip.samples, RATE); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.wav`, '-c:a', 'libopus', '-b:a', '48k', `${base}.webm`]); console.log(voice.slice(6, 12), c.id, u.n, clip.seconds.toFixed(1) + 's'); } catch (e: any) { console.log('FAILED', voice, c.id, u.n, String(e.message).slice(0, 80)); failed.push(`${voice}|${c.id}|${u.n}`); } } }
  console.log('GEN-DONE failed=' + failed.length, failed.join(','));
}
if (mode === 'asr') {
  const RES = `${LOCAL}/asr.jsonl`; const done = new Set(readJsonl(RES).map((r) => `${r.voice}|${r.chain}|${r.unit}|${r.rep}`));
  const jobs = VOICES.flatMap((voice) => CHAINS.flatMap((c) => c.units.flatMap((u) => Array.from({ length: REPS }, (_, rep) => ({ voice, chain: c.id, unit: u.n, rep }))))).filter((j) => !done.has(`${j.voice}|${j.chain}|${j.unit}|${j.rep}`) && existsSync(`${LOCAL}/audio/${j.voice}/${j.chain}/u${String(j.unit).padStart(2, '0')}.webm`)); console.log(`pending ${jobs.length}`); let n = 0;
  const worker = async () => { while (jobs.length) { const j = jobs.shift()!; const data = `data:audio/webm;base64,${readFileSync(`${LOCAL}/audio/${j.voice}/${j.chain}/u${String(j.unit).padStart(2, '0')}.webm`).toString('base64')}`; const r = await post({ model: 'qwen3.8-omni-flash', modalities: ['text'], reasoning_effort: E.effort, stream: false, messages: [{ role: 'system', content: E.system }, { role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'webm' } }, { type: 'text', text: E.user }] }] }); appendFileSync(RES, JSON.stringify({ ...j, ...r }) + '\n'); if (++n % 30 === 0) console.log(`${n} done`); } };
  await Promise.all(Array.from({ length: 4 }, worker)); console.log(`ALL-DONE (${n})`);
}
if (mode === 'extract') {
  const RES = `${LOCAL}/extract.jsonl`; const asr = readJsonl(`${LOCAL}/asr.jsonl`); const done = new Set(readJsonl(RES).map((r) => `${r.voice}|${r.chain}|${r.rep}`)); const jobs: { voice: string; chain: string; rep: number; segs: string }[] = [];
  for (const c of CHAINS) for (let rep = 0; rep < REPS; rep++) { for (const voice of VOICES) { const us = c.units.map((u) => { const r = asr.find((x) => x.voice === voice && x.chain === c.id && x.unit === u.n && x.rep === rep && x.status === 200); return r ? `[段${u.n}] ${instructionOf(E, r.text).transcript ?? ''}` : null; }); if (us.some((x) => x === null)) continue; jobs.push({ voice, chain: c.id, rep, segs: us.join('\n') }); } jobs.push({ voice: 'gold', chain: c.id, rep, segs: c.units.map((u) => `[段${u.n}] ${u.text}`).join('\n') }); }
  const todo = jobs.filter((j) => !done.has(`${j.voice}|${j.chain}|${j.rep}`)); console.log(`pending ${todo.length}`); let n = 0;
  const worker = async () => { while (todo.length) { const j = todo.shift()!; const r = await post({ model: 'qwen3.8-flash', enable_thinking: false, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS }, { role: 'user', content: `（没有提供最近的对话。）\n\n<口述>\n${j.segs}\n</口述>\n\n输出 JSON。` }] }, 120000); appendFileSync(RES, JSON.stringify({ voice: j.voice, chain: j.chain, rep: j.rep, ...r }) + '\n'); if (++n % 10 === 0) console.log(`${n} done`); } };
  await Promise.all(Array.from({ length: 8 }, worker)); console.log(`ALL-DONE (${n})`);
}
