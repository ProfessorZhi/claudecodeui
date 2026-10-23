// S1 runner：文本阶段消歧（C0 / C / D 三个臂）。见 ../PREREG.md。可续跑，6 路并发。
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/s1/run.mts run
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { idsOf } from '../../voice-omni-written/a2/strata.mjs';

const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const SHA = '02ecb6d2dc3c59990a56132a4a8d1d2b09a06186';
const RES = new URL('./results.jsonl', import.meta.url);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
export const CTX: { key: string; text: string }[] = JSON.parse(readFileSync(new URL('../../voice-omni-written/fixtures/a2-contexts.json', import.meta.url), 'utf8')).contexts;

/** 仓库名字集：基线提交里所有文件的基名与去后缀词干。 */
export const REPO_NAMES: Set<string> = (() => {
  const s = new Set<string>();
  for (const p of execFileSync('git', ['ls-tree', '-r', '--name-only', SHA], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean)) {
    const b = p.split('/').pop()!; s.add(b); s.add(b.replace(/\.[a-z0-9]{1,5}$/i, ''));
  }
  return s;
})();

const RULES = `你是语音转写之后的校对员。输入是一段口述指令经语音识别得到的「逐字稿」和「整理稿」。你只修正识别错误，例如把听坏的文件名、标识符修成正确拼写。
规则：
1. 只有当整理稿里的某个片段明显是「上下文」里某个名字被听坏的结果（读音相近、字母相近）时，才把它改成上下文里的写法。
2. 整理稿里已经是完整、合法的名字时不要改；即使上下文里有相近的名字，也不要换。
3. 说话人没有说出名字的指称（例如「那个实验」「左侧的列表」）不要补成具体名字。
4. 不要增加、删除、改写任何要求，不要添加解释，不要把上下文里的内容写进结果。
5. 拿不准就保持原样。`;
const OUT_C = '只输出一个 JSON 对象：{"instruction": "校对后的整理稿"}，不要输出其他内容。';
const OUT_D = '只输出一个 JSON 对象：{"replacements":[{"from":"整理稿里的原文片段","to":"上下文里的写法"}]}；没有需要改的就给空数组。不要输出其他内容。';

const low = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** D 的四条机械校验。返回应用后的整理稿与逐条处置。 */
export function applyReplacements(instruction: string, reps: { from: string; to: string }[], ctx: string) {
  const ctxIds = new Set(idsOf(ctx, ['file', 'camel']).keys());
  let out = instruction; const accepted: any[] = []; const rejected: any[] = [];
  for (const r of reps) {
    const why = typeof r?.from !== 'string' || typeof r?.to !== 'string' || !r.from || !r.to ? 'shape'
      : !out.includes(r.from) ? 'from-not-substring'
      : REPO_NAMES.has(r.from.replace(/^`|`$/g, '')) || ctxIds.has(r.from.replace(/^`|`$/g, '')) ? 'from-is-valid-name'
      : !(ctx.includes(r.to) || REPO_NAMES.has(r.to)) ? 'to-not-in-ctx-or-repo'
      : lev(low(r.from), low(r.to)) / Math.max(low(r.from).length, low(r.to).length, 1) > 0.5 ? 'too-far' : '';
    if (why) { rejected.push({ ...r, why }); continue; }
    out = out.split(r.from).join(r.to); accepted.push(r);
  }
  return { out, accepted, rejected };
}

async function chat(system: string, user: string) {
  const body = { model: 'qwen3.8-flash', enable_thinking: false, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 160)}`, usage: j?.usage ?? null };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', err: e.name, usage: null }; }
}
const parseJson = (t: string) => { const m = t.match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };

type Job = { arm: 'C0' | 'C' | 'D'; cond: string; clip: string; set: string; rep: number; transcript: string; instruction: string; ctx: string };
export function jobs(): Job[] {
  const a2 = readFileSync(new URL('../../voice-omni-written/a2/results.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const none = a2.filter((r) => r.cond === 'none' && r.status === 200 && r.rep < 5);
  const out: Job[] = [];
  for (const r of none) {
    const p = instructionOf(E, r.text); if (!p.parsed) continue;
    const base = { clip: r.clip, set: r.set, rep: r.rep, transcript: p.transcript ?? '', instruction: p.instruction };
    out.push({ ...base, arm: 'C0', cond: 'none-c0', ctx: '' });
    for (const c of CTX) { out.push({ ...base, arm: 'C', cond: c.key, ctx: c.text }); out.push({ ...base, arm: 'D', cond: c.key, ctx: c.text }); }
  }
  return out;
}

async function run(j: Job) {
  const user = `${j.ctx ? `<上下文>\n${j.ctx}\n</上下文>\n\n` : '（本次没有提供上下文。）\n\n'}<逐字稿>\n${j.transcript}\n</逐字稿>\n\n<整理稿>\n${j.instruction}\n</整理稿>\n\n${j.arm === 'D' ? OUT_D : OUT_C}`;
  let r = await chat(RULES, user); if (r.status !== 200) { await new Promise((s) => setTimeout(s, 3000)); r = await chat(RULES, user); }
  const parsed = r.status === 200 ? parseJson(r.text) : null;
  let instruction = j.instruction; let extra: any = {};
  if (j.arm === 'D') {
    const reps = Array.isArray(parsed?.replacements) ? parsed.replacements : null;
    if (reps) { const a = applyReplacements(j.instruction, reps, j.ctx); instruction = a.out; extra = { proposed: reps, accepted: a.accepted, rejected: a.rejected }; }
    extra.parsed = !!reps;
  } else { const s = typeof parsed?.instruction === 'string' ? parsed.instruction : null; if (s) instruction = s; extra.parsed = !!s; }
  return { arm: j.arm, cond: j.cond, clip: j.clip, set: j.set, rep: j.rep, status: r.status, ms: r.ms, err: r.err, usage: r.usage,
    text: JSON.stringify({ transcript: j.transcript, instruction }), input: j.instruction, ...extra, at: new Date().toISOString() };
}

if (process.argv[2] === 'run' && process.argv[1]?.endsWith('run.mts')) {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.arm}|${r.cond}|${r.clip}|${r.rep}`; }) : []);
  const todo = jobs().filter((j) => !done.has(`${j.arm}|${j.cond}|${j.clip}|${j.rep}`));
  console.log(`pending ${todo.length}`);
  const deadline = Date.now() + Number(process.env.BUDGET_MS ?? 3600000); let n = 0, fails = 0, stop = false;
  const worker = async () => { while (todo.length && !stop) {
    if (Date.now() > deadline) { stop = true; break; }
    const j = todo.shift()!; const row = await run(j);
    if (row.status >= 400 && row.status < 500) { console.log(`${j.arm}|${j.cond}|${j.clip}|${j.rep} ${row.status} ${row.err}`); if (++fails >= 3) { console.log('ABORT'); stop = true; } continue; } fails = 0;
    appendFileSync(RES, JSON.stringify(row) + '\n'); if (++n % 100 === 0) console.log(`${n} done`);
  } };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(stop && todo.length ? `STOPPED after ${n}, ${todo.length} left` : `ALL-DONE (${n} new)`);
}
