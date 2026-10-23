// E-A2 运行：asr，然后 correct。  set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/ea2/run.mts asr|correct
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { cases, LOCAL, topParagraphs } from './common.mts';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!; const REPS = 3;
const readJsonl = (f: string): any[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function post(body: any, timeout = 180000) { const t0 = Date.now(); for (let a = 0; a < 2; a++) { try { const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); const j: any = await res.json().catch(() => null); if (res.ok) return { status: 200, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null }; if (a === 1 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return { status: res.status, ms: Date.now() - t0, text: '', usage: null }; } catch { if (a === 1) return { status: 0, ms: Date.now() - t0, text: '', usage: null }; } await new Promise((s) => setTimeout(s, 3000)); } return { status: 0, ms: 0, text: '', usage: null }; }
const SYS = `你是语音转写之后的校对员。输入是用户读完 Claude Code 上一轮输出之后口述的一句回复，经语音识别得到「逐字稿」和「整理稿」。口述里的专有名词（文件名、函数名、命令、产品名、英文术语）常常来自用户刚读到的上一轮输出。你只修正识别错误：把整理稿里听坏的词改成上一轮输出里的写法。
规则：
1. 只有当整理稿里的某个片段明显是上一轮输出里某个词被听坏的结果（读音相近、字母相近）时，才改成上一轮输出里的写法。
2. 整理稿里已经是上一轮输出里存在的写法，或本身是完整合法的词，不要改。
3. 说话人新造的、上一轮输出里没有的词，不要硬套成上一轮里相近的词。
4. 不要增加、删除、改写任何要求，不要解释。拿不准就不改。
只输出一个 JSON 对象：{"replacements":[{"from":"整理稿里的原文片段","to":"上一轮输出里的写法"}]}；没有需要改的就给空数组。`;
if (process.argv[2] === 'asr' && process.argv[1]?.endsWith('run.mts')) {
  const RES = `${LOCAL}/asr.jsonl`; const done = new Set(readJsonl(RES).map((r) => `${r.id}|${r.rep}`));
  const jobs = cases().flatMap((c) => Array.from({ length: REPS }, (_, rep) => ({ c, rep }))).filter((j) => !done.has(`${j.c.id}|${j.rep}`)); console.log(`pending ${jobs.length}`); let n = 0;
  const worker = async () => { while (jobs.length) { const { c, rep } = jobs.shift()!; const data = `data:audio/webm;base64,${readFileSync(`${LOCAL}/audio/${c.id}.webm`).toString('base64')}`; const r = await post({ model: 'qwen3.8-omni-flash', modalities: ['text'], reasoning_effort: E.effort, stream: false, messages: [{ role: 'system', content: E.system }, { role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'webm' } }, { type: 'text', text: E.user }] }] }); appendFileSync(RES, JSON.stringify({ id: c.id, rep, ...r }) + '\n'); if (++n % 30 === 0) console.log(`${n} done`); } };
  await Promise.all(Array.from({ length: 4 }, worker)); console.log(`ALL-DONE (${n})`);
}
if (process.argv[2] === 'correct' && process.argv[1]?.endsWith('run.mts')) {
  const RES = `${LOCAL}/correct.jsonl`; const done = new Set(readJsonl(RES).map((r) => `${r.arm}|${r.id}|${r.rep}`)); const cs = cases(); const asr = readJsonl(`${LOCAL}/asr.jsonl`);
  const wrongOf = (i: number) => { let k = (i + 7) % cs.length; while (cs[k].session === cs[i].session) k = (k + 1) % cs.length; return cs[k]; };
  const jobs: { arm: string; id: string; rep: number; ctx: string; user: string; wrongId?: string }[] = [];
  cs.forEach((c, i) => { for (let rep = 0; rep < REPS; rep++) { const r = asr.find((x) => x.id === c.id && x.rep === rep && x.status === 200); if (!r) continue; const p = instructionOf(E, r.text); const heard = `逐字稿：${p.transcript ?? ''}\n整理稿：${p.instruction}`; const mk = (arm: string, ctx: string, wrongId?: string) => jobs.push({ arm, id: c.id, rep, ctx, wrongId, user: `<上一轮输出>\n${ctx}\n</上一轮输出>\n\n<用户口述>\n${heard}\n</用户口述>\n\n输出 JSON。` });
    mk('D-full', c.prev); mk('D-top3', topParagraphs(c.prev, `${p.transcript ?? ''} ${p.instruction}`)); const w = wrongOf(i); mk('W', w.prev, w.id); } });
  const todo = jobs.filter((j) => !done.has(`${j.arm}|${j.id}|${j.rep}`)); console.log(`pending ${todo.length} of ${jobs.length}`); let n = 0;
  const worker = async () => { while (todo.length) { const j = todo.shift()!; const r = await post({ model: 'qwen3.8-flash', enable_thinking: false, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS }, { role: 'user', content: j.user }] }, 120000); appendFileSync(RES, JSON.stringify({ arm: j.arm, id: j.id, rep: j.rep, wrongId: j.wrongId, ctx: j.ctx.length, ...r }) + '\n'); if (++n % 60 === 0) console.log(`${n} done`); } };
  await Promise.all(Array.from({ length: 8 }, worker)); console.log(`ALL-DONE (${n})`);
}
