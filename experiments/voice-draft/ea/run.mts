// E-A 运行：逐案例 omni 识别（3 次）+ 引用选择各臂。可续跑。结果写到仓库外。
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/ea/run.mts asr|anchor
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { cases, LOCAL, units } from './common.mts';

const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const REPS = 3;
const KEY = () => ({ Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' });
const readJsonl = (f: string): any[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function post(body: any, timeout = 180000) {
  const t0 = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(URL_, { method: 'POST', headers: KEY(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
      const j: any = await res.json().catch(() => null);
      if (res.ok) return { status: 200, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null };
      if (attempt === 1 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return { status: res.status, ms: Date.now() - t0, text: '', usage: null, err: `${j?.error?.code ?? j?.code}` };
    } catch (e: any) { if (attempt === 1) return { status: 0, ms: Date.now() - t0, text: '', usage: null, err: e.name }; }
    await new Promise((s) => setTimeout(s, 3000));
  }
  return { status: 0, ms: 0, text: '', usage: null, err: 'unreachable' };
}
const asrCall = (data: string) => post({ model: 'qwen3.8-omni-flash', modalities: ['text'], reasoning_effort: E.effort, stream: false, messages: [{ role: 'system', content: E.system }, { role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'webm' } }, { type: 'text', text: E.user }] }] });
const textCall = (system: string, user: string) => post({ model: 'qwen3.8-flash', enable_thinking: false, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, 120000);

const BASE = `你是语音草稿助理。用户刚读完 Claude Code 上一轮的输出，然后口述了一句回复。回复可能指向上一轮输出里的某一段（用内容、编号或指示词指代，例如「第二种」「那个说样本太小的」「刚才那个表」「这一点」）。`;
const DRAFT = `draft：把用户的回复整理成清楚的一两句话，保持原意；不要展开、不要补充上一轮输出里的内容，不要把引用的内容复述进 draft；识别可能有错，只有明显是听坏的词才改。`;
const SYS_COPY = `${BASE}
任务：
1. anchor：如果回复指向上一轮输出里的某一段，把那一段（至多 5 行）的原文**逐字复制**到 anchor，不要改写、不要概括、不要加省略号；如果回复没有明确指向某一段，anchor 给空字符串。
2. ${DRAFT}
只输出一个 JSON 对象：{"anchor": "...", "draft": "..."}，不要输出其他内容。`;
const SYS_IDS = `${BASE}
上一轮输出被按行编号为 [P1]、[P2]……
任务：
1. anchor_ids：如果回复指向上一轮输出里的某几行，给出这些行的编号（连续，至多 5 行）；如果回复没有明确指向某一段，给空数组。
2. ${DRAFT}
只输出一个 JSON 对象：{"anchor_ids": [12, 13], "draft": "..."}，不要输出其他内容。`;
const prevBlock = (prev: string, ids: boolean) => (ids ? units(prev).map((u) => `[P${u.id}] ${u.text}`).join('\n') : prev);

if (process.argv[2] === 'asr' && process.argv[1]?.endsWith('run.mts')) {
  const RES = `${LOCAL}/asr.jsonl`; const done = new Set(readJsonl(RES).map((r) => `${r.id}|${r.rep}`));
  const jobs = cases().flatMap((c) => Array.from({ length: REPS }, (_, rep) => ({ c, rep }))).filter((j) => !done.has(`${j.c.id}|${j.rep}`));
  console.log(`pending ${jobs.length}`); let n = 0;
  const worker = async () => { while (jobs.length) { const { c, rep } = jobs.shift()!; const data = `data:audio/webm;base64,${readFileSync(`${LOCAL}/audio/${c.id}.webm`).toString('base64')}`; const r = await asrCall(data); appendFileSync(RES, JSON.stringify({ id: c.id, rep, ...r, at: new Date().toISOString() }) + '\n'); if (++n % 15 === 0) console.log(`${n} done`); } };
  await Promise.all(Array.from({ length: 4 }, worker)); console.log(`ALL-DONE (${n})`);
}
if (process.argv[2] === 'anchor' && process.argv[1]?.endsWith('run.mts')) {
  const RES = `${LOCAL}/anchor.jsonl`; const done = new Set(readJsonl(RES).map((r) => `${r.arm}|${r.id}|${r.rep}`));
  const cs = cases(); const asr = readJsonl(`${LOCAL}/asr.jsonl`);
  const heard = (id: string, rep: number) => { const r = asr.find((x) => x.id === id && x.rep === rep && x.status === 200); if (!r) return null; const p = instructionOf(E, r.text); return `逐字稿：${p.transcript ?? r.text}\n整理稿：${p.instruction}`; };
  const wrongOf = (i: number) => { let k = (i + 7) % cs.length; while (cs[k].session === cs[i].session) k = (k + 1) % cs.length; return cs[k]; };
  type Job = { arm: string; id: string; rep: number; sys: string; user: string; ids: boolean; wrongId?: string };
  const jobs: Job[] = [];
  cs.forEach((c, i) => {
    const mk = (arm: string, rep: number, said: string, prev: string, ids: boolean, wrongId?: string) => jobs.push({ arm, id: c.id, rep, ids, wrongId, sys: ids ? SYS_IDS : SYS_COPY, user: `<上一轮输出>\n${prevBlock(prev, ids)}\n</上一轮输出>\n\n<用户口述>\n${said}\n</用户口述>\n\n输出 JSON。` });
    mk('T-copy', 0, `逐字稿：${c.reply}\n整理稿：${c.reply}`, c.prev, false); mk('T-ids', 0, `逐字稿：${c.reply}\n整理稿：${c.reply}`, c.prev, true);
    for (let rep = 0; rep < REPS; rep++) { const h = heard(c.id, rep); if (!h) continue; const w = wrongOf(i);
      mk('L-copy', rep, h, c.prev, false); mk('L-ids', rep, h, c.prev, true); mk('W-copy', rep, h, w.prev, false, w.id); mk('W-ids', rep, h, w.prev, true, w.id); }
  });
  const todo = jobs.filter((j) => !done.has(`${j.arm}|${j.id}|${j.rep}`)); console.log(`pending ${todo.length} of ${jobs.length}`); let n = 0;
  const worker = async () => { while (todo.length) { const j = todo.shift()!; const r = await textCall(j.sys, j.user); appendFileSync(RES, JSON.stringify({ arm: j.arm, id: j.id, rep: j.rep, wrongId: j.wrongId, ...r, at: new Date().toISOString() }) + '\n'); if (++n % 40 === 0) console.log(`${n} done`); } };
  await Promise.all(Array.from({ length: 8 }, worker)); console.log(`ALL-DONE (${n})`);
}
