// S2 草稿阶段：qwen3.8-flash。臂 a / b / b0 / c（ASR 路径）与 ga / gb（脚本原文）。可续跑，8 路并发。
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-draft/s2/run-draft.mts run
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { SCRIPTS, VOICES } from './scripts.mts';

const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const RES = process.env.DRAFT_RES ?? new URL('./drafts.jsonl', import.meta.url);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const CAPSULE = readFileSync(new URL('./capsule.txt', import.meta.url), 'utf8').trim();
const MANIFEST: any[] = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const asrRows = existsSync(new URL('./asr.jsonl', import.meta.url)) ? readFileSync(new URL('./asr.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
export const REPS = 3;
const BATCH_SECONDS = 20;

const SHARED = `你是编码 agent 的需求整理器。用户对着麦克风口述了一连串想法，被切成按顺序编号的「段」，每段给出语音识别的「逐字稿」和「整理稿」（识别可能有错）。你的任务是维护一份准备交给编码 agent 的需求草稿。规则：
1. 说话人当场更正（「嗯不对」「改成」「换成」「本来想…还是…」）时，只保留更正后的意思，不要留着被否定的内容。
2. 数字覆盖：后面说的数字取代前面的数字；数字一律写阿拉伯数字。
3. 说话人说「先记着」「这一版不做」「以后再说」「先别写进去」的想法，是暂存的想法，不要写成需求。
4. 语音命令：「删掉刚才那段」「撤销刚才那段」指删去紧挨着的前一段（命令本身之前最近的一个有内容的段）所表达的内容，命令本身不进入草稿。含「删掉」字样但属于要求内容的话（例如「要不要把这个逻辑删掉？不用，留着」）不是命令，应当按内容处理。
5. 不得添加说话人没有说过的要求；也不得丢掉说过的要求、限定（数字、否定、范围）。说话人没有说出名字的指称（「刚才那个」「左侧的列表」）按其含义保留，不要补成具体名字。
6. 标识符（文件名、函数名）：只有当识别结果明显是项目文件清单里某个名字被听坏的写法时，才改成清单里的写法；识别结果本身已经是完整名字就原样保留，不要换成清单里相近的名字；清单只用来校对拼写，清单里的内容不是需求。`;

const SYS_ONESHOT = `${SHARED}\n\n现在把全部的段一次整理成最终的需求草稿：用中文，条目式，一条一个要求，不要解释，不要复述被撤回的内容。`;
const SYS_INCR = `${SHARED}\n\n你每次只看到「当前草稿」和「新增的段」，只输出对草稿的操作，不要重写整份草稿。操作只有这些：
{"op":"add","text":"新条目","src":[段号]}                       新增一条要求
{"op":"modify","id":"i3","text":"改后的条目","src":[段号]}       修改已有条目（更正、补充、数字覆盖）
{"op":"remove","id":"i2"}                                        说话人明确撤回某条已有要求
{"op":"park","text":"暂存的想法","src":[段号]}                  暂存，不进入草稿
{"op":"delete_segment","seg":段号}                               语音命令删除某一段（填被删的那一段的段号）
{"op":"noop"}                                                    这些段没有产生任何要求（口头禅、无关的话）
src 填产生这个操作的新段的段号。一个新段可以对应多个操作。只输出一个 JSON 对象：{"ops":[...]}，不要输出其他内容。`;

type Seg = { n: number; transcript: string; instruction: string; seconds: number };
function segsFor(voice: string, scriptId: string, rep: number): Seg[] {
  const s = SCRIPTS.find((x) => x.id === scriptId)!;
  return s.units.map((u) => {
    const sec = MANIFEST.find((m) => m.voice === (voice === 'gold' ? VOICES[0] : voice) && m.script === scriptId && m.unit === u.n)?.seconds ?? 8;
    if (voice === 'gold') return { n: u.n, transcript: u.text, instruction: u.text, seconds: sec };
    const row = asrRows.find((r) => r.voice === voice && r.script === scriptId && r.unit === u.n && r.rep === rep && r.status === 200);
    if (!row) return { n: u.n, transcript: '（识别失败）', instruction: '（识别失败）', seconds: sec };
    const p = instructionOf(E, row.text);
    return { n: u.n, transcript: p.transcript ?? row.text, instruction: p.instruction, seconds: sec };
  });
}

async function chat(system: string, user: string) {
  const body = { model: 'qwen3.8-flash', enable_thinking: false, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
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
const parseJson = (t: string) => { const m = t.match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };
const segBlock = (segs: Seg[]) => segs.map((s) => `[段${s.n}] 逐字稿：${s.transcript}\n      整理稿：${s.instruction}`).join('\n');
const capsuleBlock = (on: boolean) => (on ? `<项目文件清单>\n${CAPSULE}\n</项目文件清单>\n\n` : '（本次没有提供项目文件清单。）\n\n');

type Item = { id: string; text: string; src: number[] };
type State = { items: Item[]; parked: Item[]; nextId: number };
function applyOps(st: State, ops: any[], knownSegs: Set<number>) {
  let valid = true;
  for (const o of ops) {
    const text = typeof o?.text === 'string' ? o.text.trim() : '';
    const src: number[] = Array.isArray(o?.src) ? o.src.filter((x: any) => Number.isInteger(x)) : [];
    if (o?.op === 'add' && text) st.items.push({ id: `i${st.nextId++}`, text, src });
    else if (o?.op === 'park' && text) st.parked.push({ id: `p${st.nextId++}`, text, src });
    else if (o?.op === 'modify' && text && st.items.some((i) => i.id === o.id)) { const it = st.items.find((i) => i.id === o.id)!; it.text = text; it.src = [...new Set([...it.src, ...src])]; }
    else if (o?.op === 'remove' && st.items.some((i) => i.id === o.id)) st.items = st.items.filter((i) => i.id !== o.id);
    else if (o?.op === 'delete_segment' && Number.isInteger(o.seg) && knownSegs.has(o.seg)) {
      const k: number = o.seg;
      st.items = st.items.filter((i) => !(i.src.length > 0 && i.src.every((x) => x === k))).map((i) => ({ ...i, src: i.src.filter((x) => x !== k) }));
      st.parked = st.parked.filter((i) => !(i.src.length > 0 && i.src.every((x) => x === k)));
    } else if (o?.op === 'noop') { /* nothing */ } else valid = false;
  }
  return valid;
}
const render = (st: State) => st.items.map((i, k) => `${k + 1}. ${i.text}`).join('\n');

type Arm = 'a' | 'b' | 'b0' | 'c' | 'ga' | 'gb';
async function runOne(arm: Arm, voice: string, scriptId: string, rep: number) {
  const segs = segsFor(voice, scriptId, rep); const t0 = Date.now();
  const useCtx = arm !== 'b0';
  if (arm === 'a' || arm === 'ga') {
    const r = await chat(SYS_ONESHOT, `${capsuleBlock(true)}<全部的段>\n${segBlock(segs)}\n</全部的段>\n\n输出最终的需求草稿。`);
    return { arm, voice, script: scriptId, rep, final: r.text.trim(), updates: [{ upd: 1, segs: segs.map((s) => s.n), status: r.status, ms: r.ms, usage: r.usage }], totalMs: Date.now() - t0 };
  }
  const st: State = { items: [], parked: [], nextId: 1 }; const updates: any[] = [];
  const groups: Seg[][] = [];
  if (arm === 'c') { let cur: Seg[] = []; let sec = 0; for (const s of segs) { cur.push(s); sec += s.seconds; if (sec >= BATCH_SECONDS) { groups.push(cur); cur = []; sec = 0; } } if (cur.length) groups.push(cur); }
  else for (const s of segs) groups.push([s]);
  const known = new Set<number>(); let k = 0;
  for (const g of groups) {
    for (const s of g) known.add(s.n);
    const cur = st.items.length ? st.items.map((i) => `${i.id} [来自段${i.src.join(',') || '—'}] ${i.text}`).join('\n') : '（空）';
    const user = `${capsuleBlock(useCtx)}<当前草稿>\n${cur}\n</当前草稿>\n\n<新增的段>\n${segBlock(g)}\n</新增的段>\n\n输出 JSON 操作。`;
    const r = await chat(SYS_INCR, user); const parsed = r.status === 200 ? parseJson(r.text) : null;
    const ops = Array.isArray(parsed?.ops) ? parsed.ops : null; const valid = ops ? applyOps(st, ops, known) : false;
    updates.push({ upd: ++k, segs: g.map((s) => s.n), status: r.status, ms: r.ms, usage: r.usage, parsed: !!ops, valid, nOps: ops?.length ?? 0, ops, raw: ops ? undefined : r.text.slice(0, 300) });
  }
  return { arm, voice, script: scriptId, rep, final: render(st), items: st.items, parked: st.parked, updates, totalMs: Date.now() - t0 };
}

if (process.argv[2] === 'run' && process.argv[1]?.endsWith('run-draft.mts')) {
  const key = (r: any) => `${r.arm}|${r.voice}|${r.script}|${r.rep}`;
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => key(JSON.parse(l))) : []);
  const jobs: [Arm, string, string, number][] = [];
  for (const rep of Array.from({ length: REPS }, (_, i) => i)) for (const s of SCRIPTS) {
    for (const v of VOICES) for (const arm of ['a', 'b', 'b0', 'c'] as Arm[]) {
      const have = Array.from({ length: s.units.length }, (_, i) => asrRows.some((r) => r.voice === v && r.script === s.id && r.unit === i + 1 && r.rep === rep && r.status === 200)).every(Boolean);
      if (have) jobs.push([arm, v, s.id, rep]);
    }
    for (const arm of ['ga', 'gb'] as Arm[]) jobs.push([arm, 'gold', s.id, rep]);
  }
  const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
  const todo = jobs.filter(([a, v, s, r]) => !done.has(`${a}|${v}|${s}|${r}`) && (!only || only.test(`${a}|${v}|${s}|${r}`)));
  console.log(`pending ${todo.length} runs of ${jobs.length}`);
  let n = 0;
  const worker = async () => { while (todo.length) { const [a, v, s, r] = todo.shift()!; const row = await runOne(a, v, s, r); appendFileSync(RES, JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n'); if (++n % 10 === 0) console.log(`${n} runs done`); } };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`ALL-DONE (${n} runs)`);
}
