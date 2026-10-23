// E-C 运行：asr（逐单元）与 compose（各臂）。  set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/ec/run.mts asr|compose
import { readFileSync, appendFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { CHAINS } from './scripts.mts';
import { LOCAL, VOICES, contexts, WRONG, readJsonl } from './common.mts';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!; const REPS = 3;
async function post(body: any, timeout = 180000) { const t0 = Date.now(); for (let a = 0; a < 2; a++) { try { const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); const j: any = await res.json().catch(() => null); if (res.ok) return { status: 200, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null }; if (a === 1 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return { status: res.status, ms: Date.now() - t0, text: '', usage: null }; } catch { if (a === 1) return { status: 0, ms: Date.now() - t0, text: '', usage: null }; } await new Promise((s) => setTimeout(s, 3000)); } return { status: 0, ms: 0, text: '', usage: null }; }
const SYS = `你是语音草稿助理。用户一边想一边说：他读完 Claude Code 的输出之后，向自己连续提问、自答、试探、转向，最后落到他真正关心的问题或决定上。口述被切成按顺序编号的段，每段给出语音识别的「逐字稿」和「整理稿」（可能有错）。你的任务是找出通向他真正关心的那件事的路径，生成一份准备发给 Claude Code 的提示。
规则：
1. core_ask：他最终真正想要 Claude Code 做或回答的事，1 到 2 句，具体（说出对象和想要的结果）。它通常出现在口述的后半，被他的结论、转折或最后的追问落到；开头的探路问题不是核心诉求，除非后面没有更具体的东西。
2. premises：他自己说出的、Claude Code 必须知道的前提、限定、结论或判断（保留他的措辞要点；数字、否定、范围不能丢）。
3. dropped：他为了走到核心诉求而问过、但最后不是诉求的探路问题或试探（每条一句话）。这些不要写成提示里的要求。
4. prompt：写给 Claude Code 的完整提示：先写核心诉求，再列前提；可简要说明背景；不要把 dropped 里的问题当成要它做的事；不要添加他没有说过的要求或事实。
5. 识别可能有错，只有明显是听坏的词才改。有「上一轮输出」时，仅用它理解他指的是什么，不要把它的内容当作他的要求写进提示；它与口述无关时忽略它。
只输出一个 JSON：{"core_ask":"…","premises":["…"],"dropped":["…"],"prompt":"…"}`;
if (process.argv[2] === 'asr' && process.argv[1]?.endsWith('run.mts')) {
  const RES = `${LOCAL}/asr.jsonl`; const done = new Set(readJsonl(RES).map((r) => `${r.voice}|${r.chain}|${r.unit}|${r.rep}`));
  const jobs = VOICES.flatMap((voice) => CHAINS.flatMap((c) => c.units.flatMap((u) => Array.from({ length: REPS }, (_, rep) => ({ voice, chain: c.id, unit: u.n, rep }))))).filter((j) => !done.has(`${j.voice}|${j.chain}|${j.unit}|${j.rep}`)); console.log(`pending ${jobs.length}`); let n = 0;
  const worker = async () => { while (jobs.length) { const j = jobs.shift()!; const data = `data:audio/webm;base64,${readFileSync(`${LOCAL}/audio/${j.voice}/${j.chain}/u${String(j.unit).padStart(2, '0')}.webm`).toString('base64')}`;
    const r = await post({ model: 'qwen3.8-omni-flash', modalities: ['text'], reasoning_effort: E.effort, stream: false, messages: [{ role: 'system', content: E.system }, { role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'webm' } }, { type: 'text', text: E.user }] }] });
    appendFileSync(RES, JSON.stringify({ ...j, ...r }) + '\n'); if (++n % 40 === 0) console.log(`${n} done`); } };
  await Promise.all(Array.from({ length: 4 }, worker)); console.log(`ALL-DONE (${n})`);
}
if (process.argv[2] === 'compose' && process.argv[1]?.endsWith('run.mts')) {
  const RES = `${LOCAL}/compose.jsonl`; const done = new Set(readJsonl(RES).map((r) => `${r.arm}|${r.voice}|${r.chain}|${r.rep}`)); const asr = readJsonl(`${LOCAL}/asr.jsonl`); const ctx = contexts();
  type Job = { arm: string; voice: string; chain: string; rep: number; ctx: string; segs: string };
  const jobs: Job[] = [];
  for (const c of CHAINS) { for (let rep = 0; rep < REPS; rep++) {
    for (const voice of VOICES) { const parts = c.units.map((u) => { const r = asr.find((x) => x.voice === voice && x.chain === c.id && x.unit === u.n && x.rep === rep && x.status === 200); if (!r) return null; const p = instructionOf(E, r.text); return `[段${u.n}] 逐字稿：${p.transcript ?? ''}\n      整理稿：${p.instruction}`; }); if (parts.some((p) => p === null)) continue; const segs = parts.join('\n');
      jobs.push({ arm: 'C0', voice, chain: c.id, rep, ctx: '', segs }); jobs.push({ arm: 'C1', voice, chain: c.id, rep, ctx: ctx[c.id], segs }); jobs.push({ arm: 'CW', voice, chain: c.id, rep, ctx: ctx[WRONG[c.id]], segs }); }
    jobs.push({ arm: 'G0', voice: 'gold', chain: c.id, rep, ctx: '', segs: c.units.map((u) => `[段${u.n}] 逐字稿：${u.text}\n      整理稿：${u.text}`).join('\n') }); } }
  const todo = jobs.filter((j) => !done.has(`${j.arm}|${j.voice}|${j.chain}|${j.rep}`)); console.log(`pending ${todo.length} of ${jobs.length}`); let n = 0;
  const worker = async () => { while (todo.length) { const j = todo.shift()!; const user = `${j.ctx ? `<上一轮输出>\n${j.ctx}\n</上一轮输出>\n\n` : '（没有上一轮输出。）\n\n'}<口述>\n${j.segs}\n</口述>\n\n输出 JSON。`;
    const r = await post({ model: 'qwen3.8-flash', enable_thinking: false, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }] }, 120000);
    appendFileSync(RES, JSON.stringify({ arm: j.arm, voice: j.voice, chain: j.chain, rep: j.rep, ...r }) + '\n'); if (++n % 20 === 0) console.log(`${n} done`); } };
  await Promise.all(Array.from({ length: 8 }, worker)); console.log(`ALL-DONE (${n})`);
}
