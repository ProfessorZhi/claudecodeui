// E-C3 运行：一次调用抽取（S0/S1/W1/G0 整段；P1 逐段）。原始输出落盘，代码流水线在分析时重放。
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/ec3/run.mts
import { readFileSync, appendFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { CHAINS } from '../ec/scripts.mts';
import { LOCAL, VOICES, WRONG, readJsonl } from '../ec/common.mts';
import { cleanItems } from './pipeline.mts';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!; const REPS = 3; const RES = `${LOCAL}/compose3.jsonl`;
async function post(body: any, timeout = 120000) { const t0 = Date.now(); for (let a = 0; a < 2; a++) { try { const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }); const j: any = await res.json().catch(() => null); if (res.ok) return { status: 200, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null }; if (a === 1 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return { status: res.status, ms: Date.now() - t0, text: '', usage: null }; } catch { if (a === 1) return { status: 0, ms: Date.now() - t0, text: '', usage: null }; } await new Promise((s) => setTimeout(s, 3000)); } return { status: 0, ms: 0, text: '', usage: null }; }
export const SYS = `你是语音草稿的抽取器。你**不写提示**，只做抽取；提示由程序按模板渲染。输入是用户口述的逐字稿（可能有识别错误），按段编号。用户一边想一边说：读完 Claude Code 的输出之后，向自己连续提问、自答、试探、转向。
任务：
1. items：把每一段拆成若干条话语（按句），每条给出 id（递增）、unit（段号）、type、span、answers。
   - span 必须从该段逐字稿里**逐字复制**，不得改写、不得概括、不得补充；每一句有意义的话都要被覆盖（口头禅可以不覆盖）。
   - type 只能是下面六种之一：
     事实：说话人陈述的已知情况（来自他的记忆、观察或 Claude Code 之前说过的话）。
     问题：说话人希望 Claude Code 回答、检查或查明的事。
     探路：说话人为走向别的问题而问的前置或中间问题（答案是后续问题的前提）。
     假设：说话人的猜测、判断、倾向（「我认为」「我猜」「我倾向」「会不会」「难道」）；还没有被验证。求证式的问句（「也就是说……？」「所以……的确……？」「难道……？」「是不是……」）也是假设，不是事实，也不是问题。
     决定：说话人已经做出的选择或接受（「要」「接受」「按…」）。
     约束：说话人要求保持或避免的事（「先不动」「不要」「可以接受…」）。
   - answers：如果这条话语是说话人对更早某个问句的**自己回答**（他先问、紧接着自己回答），填那个问句的 id；否则 null。
2. replacements：只用于**明显是听坏的**专有名词（文件名、命令、产品名、英文术语），把逐字稿里的写法改成「最近对话」里**逐字出现**的写法。from 是逐字稿里的片段，to 必须从最近对话里逐字复制。没有就给空数组。没有提供最近对话时一律给空数组。
3. anchors：只有当某段指向最近对话里的某一段具体内容（用内容复述、序号或指示词，如「那个表」「第二种」「你刚才说的」）时，给出 {"unit": 段号, "lines": [行号…]}，行号是该内容在最近对话里的行号（连续，至多 5 行）。否则给空数组。没有提供最近对话时一律给空数组。
只输出一个 JSON：{"items":[{"id":1,"unit":1,"type":"问题","span":"…","answers":null}],"replacements":[{"from":"…","to":"…"}],"anchors":[]}`;
const asr = readJsonl(`${LOCAL}/asr.jsonl`); const ctx2 = JSON.parse(readFileSync(`${LOCAL}/contexts2.json`, 'utf8')) as Record<string, string>;
const numbered = (c: string) => (c ? c.split('\n').filter((l) => l.trim()).map((l, i) => `[L${i + 1}] ${l}`).join('\n') : '');
const ctxBlock = (c: string) => (c ? `<最近几轮对话（带行号）>\n${numbered(c)}\n</最近几轮对话>\n\n` : '（没有提供最近的对话。）\n\n');
type Job = { arm: string; voice: string; chain: string; rep: number; ctx: string; units: { n: number; t: string }[] };
const jobs: Job[] = [];
for (const c of CHAINS) for (let rep = 0; rep < REPS; rep++) {
  for (const voice of VOICES) { const units = c.units.map((u) => { const r = asr.find((x) => x.voice === voice && x.chain === c.id && x.unit === u.n && x.rep === rep && x.status === 200); return r ? { n: u.n, t: instructionOf(E, r.text).transcript ?? '' } : null; }); if (units.some((u) => u === null)) continue; const us = units as { n: number; t: string }[];
    jobs.push({ arm: 'S0', voice, chain: c.id, rep, ctx: '', units: us }); jobs.push({ arm: 'S1', voice, chain: c.id, rep, ctx: ctx2[c.id], units: us }); jobs.push({ arm: 'W1', voice, chain: c.id, rep, ctx: ctx2[WRONG[c.id]], units: us }); jobs.push({ arm: 'P1', voice, chain: c.id, rep, ctx: ctx2[c.id], units: us }); }
  jobs.push({ arm: 'G0', voice: 'gold', chain: c.id, rep, ctx: '', units: c.units.map((u) => ({ n: u.n, t: u.text })) }); }
const done = new Set(readJsonl(RES).map((r) => `${r.arm}|${r.voice}|${r.chain}|${r.rep}`)); const todo = jobs.filter((j) => !done.has(`${j.arm}|${j.voice}|${j.chain}|${j.rep}`)); console.log(`pending ${todo.length} of ${jobs.length}`); let n = 0;
async function runJob(j: Job) {
  const calls: any[] = [];
  if (j.arm !== 'P1') { const user = `${ctxBlock(j.ctx)}<口述>\n${j.units.map((u) => `[段${u.n}] ${u.t}`).join('\n')}\n</口述>\n\n输出 JSON。`; calls.push({ unit: null, ...(await post({ model: 'qwen3.8-flash', enable_thinking: false, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }] })) }); }
  else { const state: any[] = []; let nextId = 1; const transcripts: Record<number, string> = {};
    for (const u of j.units) { transcripts[u.n] = u.t; const prev = j.units.filter((x) => x.n < u.n).slice(-2); const user = `${ctxBlock(j.ctx)}<已处理的口述（回看，供理解上下文用，不要重复抽取）>\n${prev.map((x) => `[段${x.n}] ${x.t}`).join('\n') || '（无）'}\n</已处理的口述>\n\n<已抽取的话语（状态；answers 只能引用这里的 id 或本段新话语的 id）>\n${state.map((s) => `#${s.id} 段${s.unit} ${s.type}：${s.span.slice(0, 40)}`).join('\n') || '（无）'}\n</已抽取的话语>\n\n<现在要处理的这一段>\n[段${u.n}] ${u.t}\n</现在要处理的这一段>\n\nid 从 ${nextId} 开始递增，只抽取这一段。输出 JSON。`;
      const r = await post({ model: 'qwen3.8-flash', enable_thinking: false, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS }, { role: 'user', content: user }] }); calls.push({ unit: u.n, ...r });
      let raw: any = null; try { const m = r.text.match(/\{[\s\S]*\}/); raw = JSON.parse(m ? m[0] : r.text); } catch { /* 解析失败：该段没有话语 */ }
      if (raw) { const c = cleanItems({ items: raw.items }, { [u.n]: u.t }); for (const it of c.items) { state.push(it); nextId = Math.max(nextId, it.id + 1); } } } }
  appendFileSync(RES, JSON.stringify({ arm: j.arm, voice: j.voice, chain: j.chain, rep: j.rep, calls }) + '\n');
}
const worker = async () => { while (todo.length) { const j = todo.shift()!; await runJob(j); if (++n % 20 === 0) console.log(`${n} done`); } };
await Promise.all(Array.from({ length: 8 }, worker)); console.log(`ALL-DONE (${n})`);
