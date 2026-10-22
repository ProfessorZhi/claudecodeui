// S2 补充 2：整份草稿重写，JSON 输出。臂 rj / rj0 / gj。见 ../PREREG-ADDENDUM-2.md。可续跑，8 路并发。
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/s2/run-rewrite-json.mts run
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { SCRIPTS, VOICES } from './scripts.mts';

const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const RES = process.env.REWRITE_RES ?? new URL('./rewrite-json.jsonl', import.meta.url);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const CAPSULE = readFileSync(new URL('./capsule.txt', import.meta.url), 'utf8').trim();
const MANIFEST: any[] = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const asrRows = readFileSync(new URL('./asr.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const REPS = 3;

const RULES = `你是一位帮用户把口述想法整理成「给编码 agent 的需求草稿」的助理。用户边想边说，口述被切成按顺序编号的「段」，每段给出语音识别的「逐字稿」和「整理稿」（识别可能有错）。你每次拿到：当前草稿、上一版草稿、最近几段的原话、以及新说的段，你要输出**更新后的整份草稿**。
规则：
1. 草稿用中文，条目式，一条一个要求，简洁；保留所有仍然有效的内容，不要因为改写而丢掉早先的要求或限定（数字、否定、范围）。
2. 说话人当场更正（「嗯不对」「改成」「换成」「本来想…还是…」）时，只保留更正后的意思，草稿里不留被否定的内容。数字用阿拉伯数字，后面说的数字取代前面的。
3. 说话人表示「先不用」「保持原样」「不用写进某处」「留着当兜底」「不要动某处」时，把它写成一条明确的约束（例如「现有的 X 逻辑保持原样，不要改」），不要因为它不是新功能就省略。
4. 说话人说「先记着」「这一版不做」「以后再说」「先别写进去」的想法，不属于本次任务：写进 JSON 的 parked 数组，不要写进 draft。
5. 语音命令：「删掉刚才那段」「撤销刚才那段」是让你把紧挨着的前一段所带来的内容从草稿里去掉（可对照「上一版草稿」和「最近几段的原话」），命令本身不进入草稿。含「删掉」字样但属于要求内容的话（例如「要不要把这个逻辑删掉？不用，留着」）不是命令，按内容处理。
6. 不得添加说话人没说过的要求；没有说出名字的指称（「刚才那个」「左侧的列表」）按其含义保留，不要补成具体名字。
7. 标识符（文件名、函数名）：只有当识别结果明显是项目文件清单里某个名字被听坏的写法时，才改成清单里的写法；识别结果本身已是完整名字就原样保留，不要换成相近的名字；清单只用来校对拼写，清单里的内容不是需求。`;
const SHAPE = `只输出一个 JSON 对象，形状如下，不要输出其他内容：
{"draft": "更新后的整份草稿，markdown 无序列表（每条以 \"- \" 开头，换行用 \\n）", "parked": ["被搁置的想法", ...], "ops": [{"op": "add|modify|remove|keep|park|revert|noop", "note": "一句话说明这次做了什么"}]}
draft 只含当前有效的要求；parked 是目前所有被搁置的想法（把输入里的暂存原样带上，再加上新增的）；ops 只是对本次更新的说明，供调试，可以为空数组。`;
const SYS_REWRITE = `${RULES}\n\n${SHAPE}`;

type Seg = { n: number; transcript: string; instruction: string };
function segsFor(voice: string, scriptId: string, rep: number): Seg[] {
  const s = SCRIPTS.find((x) => x.id === scriptId)!;
  return s.units.map((u) => {
    if (voice === 'gold') return { n: u.n, transcript: u.text, instruction: u.text };
    const row = asrRows.find((r) => r.voice === voice && r.script === scriptId && r.unit === u.n && r.rep === rep && r.status === 200);
    if (!row) return { n: u.n, transcript: '（识别失败）', instruction: '（识别失败）' };
    const p = instructionOf(E, row.text);
    return { n: u.n, transcript: p.transcript ?? row.text, instruction: p.instruction };
  });
}
async function chatJson(system: string, user: string) {
  const body = { model: 'qwen3.8-flash', enable_thinking: false, stream: false, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  const t0 = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      const j: any = await res.json().catch(() => null);
      if (res.ok) return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null };
      if (attempt === 1 || (res.status >= 400 && res.status < 500 && res.status !== 429)) return { status: res.status, ms: Date.now() - t0, text: '', usage: null, err: `${j?.error?.code ?? j?.code}` };
    } catch (e: any) { if (attempt === 1) return { status: 0, ms: Date.now() - t0, text: '', usage: null, err: e.name }; }
    await new Promise((s) => setTimeout(s, 3000));
  }
  return { status: 0, ms: 0, text: '', usage: null, err: 'unreachable' };
}
const capsuleBlock = (on: boolean) => (on ? `<项目文件清单>\n${CAPSULE}\n</项目文件清单>\n\n` : '（本次没有提供项目文件清单。）\n\n');
const segBlock = (segs: Seg[]) => segs.map((s) => `[段${s.n}] 逐字稿：${s.transcript}\n      整理稿：${s.instruction}`).join('\n');
const OPS = new Set(['add', 'modify', 'remove', 'keep', 'park', 'revert', 'noop']);
function parseOut(t: string) {
  const m = t.match(/\{[\s\S]*\}/); let j: any = null; try { j = JSON.parse(m ? m[0] : t); } catch { return null; }
  const draft = typeof j?.draft === 'string' ? j.draft.replace(/\\n/g, '\n').trim() : '';
  if (!draft) return null;
  const parked = Array.isArray(j.parked) ? j.parked.filter((x: any) => typeof x === 'string') : [];
  const ops = Array.isArray(j.ops) ? j.ops.map((o: any) => ({ op: String(o?.op ?? ''), note: String(o?.note ?? '') })) : [];
  return { draft, parked, ops, opsValid: Array.isArray(j.ops) && j.ops.every((o: any) => OPS.has(String(o?.op))), literalNewline: typeof j.draft === 'string' && /\\n/.test(j.draft) };
}

type Arm = 'rj' | 'rj0' | 'gj';
async function runOne(arm: Arm, voice: string, scriptId: string, rep: number) {
  const segs = segsFor(voice, scriptId, rep); const t0 = Date.now();
  let cur = ''; let prev = ''; let parked: string[] = []; const updates: any[] = []; const versions: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const recent = segs.slice(Math.max(0, i - 3), i);
    const user = `${capsuleBlock(arm !== 'rj0')}<当前草稿>\n${cur || '（空）'}\n</当前草稿>\n\n<上一版草稿>\n${prev || '（空）'}\n</上一版草稿>\n\n<当前暂存>\n${parked.length ? parked.map((p) => `- ${p}`).join('\n') : '（空）'}\n</当前暂存>\n\n<最近几段的原话>\n${recent.length ? recent.map((s) => `[段${s.n}] ${s.instruction}`).join('\n') : '（无）'}\n</最近几段的原话>\n\n<新说的段>\n${segBlock([segs[i]])}\n</新说的段>\n\n输出 JSON。`;
    const r = await chatJson(SYS_REWRITE, user); const p = r.status === 200 ? parseOut(r.text) : null;
    updates.push({ upd: i + 1, segs: [segs[i].n], status: r.status, ms: r.ms, usage: r.usage, parsed: !!p, ops: p?.ops, opsValid: p?.opsValid, literalNewline: p?.literalNewline, raw: p ? undefined : r.text.slice(0, 300) });
    if (p) { prev = cur; cur = p.draft; parked = p.parked; }
    versions.push(cur);
  }
  return { arm, voice, script: scriptId, rep, final: cur, parked, versions, updates, totalMs: Date.now() - t0 };
}

if (process.argv[2] === 'run' && process.argv[1]?.endsWith('run-rewrite-json.mts')) {
  const key = (r: any) => `${r.arm}|${r.voice}|${r.script}|${r.rep}`;
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => key(JSON.parse(l))) : []);
  const jobs: [Arm, string, string, number][] = [];
  for (const rep of Array.from({ length: REPS }, (_, i) => i)) for (const s of SCRIPTS) {
    for (const v of VOICES) for (const arm of ['rj', 'rj0'] as Arm[]) jobs.push([arm, v, s.id, rep]);
    jobs.push(['gj', 'gold', s.id, rep]);
  }
  const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
  const todo = jobs.filter(([a, v, s, r]) => !done.has(`${a}|${v}|${s}|${r}`) && (!only || only.test(`${a}|${v}|${s}|${r}`)));
  console.log(`pending ${todo.length} runs of ${jobs.length}`);
  let n = 0;
  const worker = async () => { while (todo.length) { const [a, v, s, r] = todo.shift()!; const row = await runOne(a, v, s, r); appendFileSync(RES, JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n'); if (++n % 10 === 0) console.log(`${n} runs done`); } };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`ALL-DONE (${n} runs)`);
}
