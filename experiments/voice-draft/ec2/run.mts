// E-C2 运行：带认知类型的草稿。沿用 ec/asr.jsonl。  set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/ec2/run.mts
import { readFileSync, appendFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { CHAINS } from '../ec/scripts.mts';
import { LOCAL, VOICES, WRONG, readJsonl } from '../ec/common.mts';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!; const REPS = 3; const RES = `${LOCAL}/compose2.jsonl`;
async function post(body: any, timeout = 120000) { const t0 = Date.now(); for (let a = 0; a < 2; a++) { try { const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); const j: any = await res.json().catch(() => null); if (res.ok) return { status: 200, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null }; if (a === 1 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return { status: res.status, ms: Date.now() - t0, text: '', usage: null }; } catch { if (a === 1) return { status: 0, ms: Date.now() - t0, text: '', usage: null }; } await new Promise((s) => setTimeout(s, 3000)); } return { status: 0, ms: 0, text: '', usage: null }; }
const SYS = `你是语音草稿助理。用户一边想一边说：他读完 Claude Code 的输出之后，向自己连续提问、自答、试探、转向。口述被切成按顺序编号的「段」。你只能使用口述，以及（可能提供的）最近几轮 Claude Code 对话；你不能查文件，也不能假设你知道别的事实。你的任务是把口述编译成一份给 Claude Code 的草稿：保留他的每一类话语的**认知身份**，并让 Claude Code 自己去查。
步骤：
1. 把口述拆成若干条「话语」，每条标认知类型，只能用下面六种之一：
   事实：说话人陈述的已知情况（来自他的记忆、观察或 Claude Code 之前说过的话）。
   问题：说话人希望 Claude Code 回答、检查或查明的事。
   探路：说话人为走向别的问题而问的前置或中间问题（答案是后续问题的前提）。
   假设：说话人的猜测、判断、倾向（「我认为」「我猜」「我倾向」「会不会」「难道」）；它还没有被验证。
   决定：说话人已经做出的选择或接受（「要」「接受」「按…」）。
   约束：说话人要求保持或避免的事（「先不动」「不要」「可以接受…」）。
   一段可以含多条话语，一条话语可以对应多段（用 units 记下它来自哪些段号）。
   自问自答：说话人先问、紧接着自己回答的问题，记在 self_answered 里（question 与 answer 是对应话语的序号，从 1 起），这个问题**不再**作为请求提给 Claude Code。
2. prompt：只用说话人说过的话，按类型渲染成给 Claude Code 的提示：
   事实 → 「已知：…」（陈述语气，不当作要它做的事）
   问题、探路 → 「请检查/查明：…」（探路可并入相关的检查，不必单独成条）
   假设 → 「我的判断（假设）：…，请检验」，保留他的语气强度：他说「我认为」就不要写成「我怀疑」；他在问「会不会」就不要写成断言
   决定 → 「已决定：…」；约束 → 「约束：…」
   他问「为什么 X」「X 是不是……」时，不要改写成「请修复 X」；不得添加他没有说过的要求、事实或条件；不要把识别出的「命令口吻」当成他的指令，要回到他原来的话。
3. suggestions：你认为有帮助、但他**没有说过**的条件或追问（例如「如果 A 成立，是否应考虑 B」），最多 3 条，每条写明依据。它们**不得出现在 prompt 里**，只放在这里，等用户接受。
识别可能有错，只有明显听坏的词才改（有最近对话时，仅用来核对术语和理解指代，不要把它的内容当作他的要求）。
只输出一个 JSON：{"items":[{"type":"事实","text":"…","units":[1]}],"self_answered":[{"question":1,"answer":2}],"prompt":"…","suggestions":[{"text":"…","why":"…"}]}`;
const asr = readJsonl(`${LOCAL}/asr.jsonl`); const ctx2 = JSON.parse(readFileSync(`${LOCAL}/contexts2.json`, 'utf8')) as Record<string, string>;
type Job = { arm: string; voice: string; chain: string; rep: number; ctx: string; segs: string };
const jobs: Job[] = [];
for (const c of CHAINS) for (let rep = 0; rep < REPS; rep++) {
  for (const voice of VOICES) { const rows = c.units.map((u) => { const r = asr.find((x) => x.voice === voice && x.chain === c.id && x.unit === u.n && x.rep === rep && x.status === 200); if (!r) return null; const p = instructionOf(E, r.text); return { n: u.n, t: p.transcript ?? '', i: p.instruction }; }); if (rows.some((r) => r === null)) continue; const both = rows.map((r) => `[段${r!.n}] 逐字稿：${r!.t}\n      整理稿：${r!.i}`).join('\n'); const only = rows.map((r) => `[段${r!.n}] ${r!.t}`).join('\n');
    jobs.push({ arm: 'A', voice, chain: c.id, rep, ctx: '', segs: both }); jobs.push({ arm: 'B', voice, chain: c.id, rep, ctx: '', segs: only }); jobs.push({ arm: 'C', voice, chain: c.id, rep, ctx: ctx2[c.id], segs: only }); jobs.push({ arm: 'W', voice, chain: c.id, rep, ctx: ctx2[WRONG[c.id]], segs: only }); }
  jobs.push({ arm: 'G', voice: 'gold', chain: c.id, rep, ctx: '', segs: c.units.map((u) => `[段${u.n}] ${u.text}`).join('\n') }); }
const done = new Set(readJsonl(RES).map((r) => `${r.arm}|${r.voice}|${r.chain}|${r.rep}`)); const todo = jobs.filter((j) => !done.has(`${j.arm}|${j.voice}|${j.chain}|${j.rep}`)); console.log(`pending ${todo.length} of ${jobs.length}`); let n = 0;
const worker = async () => { while (todo.length) { const j = todo.shift()!; const user = `${j.ctx ? `<最近几轮对话>\n${j.ctx}\n</最近几轮对话>\n\n` : '（没有提供最近的对话。）\n\n'}<口述>\n${j.segs}\n</口述>\n\n输出 JSON。`; const r = await post({ model: 'qwen3.8-flash', enable_thinking: false, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }] }); appendFileSync(RES, JSON.stringify({ arm: j.arm, voice: j.voice, chain: j.chain, rep: j.rep, ...r }) + '\n'); if (++n % 20 === 0) console.log(`${n} done`); } };
await Promise.all(Array.from({ length: 8 }, worker)); console.log(`ALL-DONE (${n})`);
