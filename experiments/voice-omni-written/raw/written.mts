import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { clips } from './omni.mts';
const DS = process.env.GW === 'ds';
const URL_ = DS ? 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
const RES = new URL(process.env.GW === 'ds' ? './written-ds.jsonl' : './written.jsonl', import.meta.url);
const ROLE = '你是编码 agent 的语音指令整理器。用户对着麦克风口述了一条给编码 agent 的指令，你收到的是这段录音。你的任务不是逐字转写，而是输出一条清晰、书面化、可以直接交给编码 agent 执行的指令。';
const RULES = `规则：
1. 说话人自我更正（如“嗯不对”“啊不”“不是…是…”）时，只保留更正后的意思，删掉被否定的部分。
2. 删掉口头禅和填充词（嗯、那个、就是、啊）。
3. 文件名、函数名、hook 名等代码标识符用反引号包起来，按听到的拼写写出，不要猜测或替换。
4. 数字一律用阿拉伯数字。
5. 不得添加录音里没有的信息，不得省略录音里的任何要求。
6. 只输出整理后的指令本身，不要解释。`;
const EXAMPLES = `示例（口述 → 整理后的指令）：
口述：嗯，那个，把 README 里的端口，就是 3000，改成八千零八十
指令：把 \`README\` 里的端口从 3000 改成 8080。
口述：给 login 页面加个校验，啊不对，是 signup 页面
指令：给 signup 页面加上校验。
口述：删掉 utils 目录下那个 date 的 helper，嗯，别动测试
指令：删掉 \`utils\` 目录下的 date helper，不要改动测试。`;
const JSON_TASK = '先逐字转写录音，再按规则整理成指令。只输出一个 JSON 对象：{"transcript": "逐字转写", "instruction": "整理后的指令"}，不要输出其他内容。';
type Cond = { key: string; system: string; user?: string; effort: string; json?: boolean };
export const CONDS: Cond[] = [
  { key: 'V-verbatim', system: '', user: '逐字转写这段音频。只输出转写文本，不要解释。代码标识符、文件名保持原样。', effort: 'none' },
  { key: 'A-system', system: ROLE, effort: 'none' },
  { key: 'B-rules', system: `${ROLE}\n\n${RULES}`, effort: 'none' },
  { key: 'C-fewshot', system: `${ROLE}\n\n${RULES}\n\n${EXAMPLES}`, effort: 'none' },
  { key: 'D-twostep', system: `${ROLE}\n\n${RULES}\n\n${EXAMPLES}`, user: JSON_TASK, effort: 'none', json: true },
  { key: 'E-twostep-low', system: `${ROLE}\n\n${RULES}\n\n${EXAMPLES}`, user: JSON_TASK, effort: 'low', json: true },
];
export function instructionOf(c: Cond, text: string) {
  if (!c.json) return { instruction: text, transcript: null, parsed: null };
  const m = text.match(/\{[\s\S]*\}/); try { const j = JSON.parse(m ? m[0] : text); return { instruction: String(j.instruction ?? ''), transcript: String(j.transcript ?? ''), parsed: true }; } catch { return { instruction: text, transcript: null, parsed: false }; }
}
async function call(c: Cond, clip: any) {
  const body = { ...(DS ? { model: 'qwen3.8-omni-flash', modalities: ['text'], reasoning_effort: c.effort } : { model: 'qwen/qwen3.8-omni-flash', reasoning: { effort: c.effort }, provider: { order: ['Alibaba'], allow_fallbacks: false } }), stream: false,
    messages: [...(c.system ? [{ role: 'system', content: c.system }] : []), { role: 'user', content: [{ type: 'input_audio', input_audio: { data: DS ? clip.data : clip.data.replace(/^data:[^,]+,/, ''), format: 'webm' } }, ...(c.user ? [{ type: 'text', text: c.user }] : [])] }] };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${DS ? process.env.DASHSCOPE_API_KEY : process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', err: res.ok ? '' : `${j?.error?.code} ${String(j?.error?.message).slice(0, 160)}`, usage: j?.usage ?? null, provider: j?.provider ?? null };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', err: e.name, usage: null }; }
}
// The argv[1] guard is not decoration: this module is imported by `e-ctx.mts` (E 组 × 上下文),
// and without the guard an `import` of it runs THIS loop instead — with `GW` unset it appends
// OpenRouter readings to `written.jsonl` before the importing script gets a single line of its own
// executed. `omni.mts` has carried the same guard since it was written; this one was missing it.
if (process.argv[2] === 'run' && process.argv[1]?.endsWith('written.mts')) {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.cond}|${r.clip}|${r.rep}`; }) : []);
  const deadline = Date.now() + 540000; let n = 0, fails = 0; const REPN = Number(process.env.REPS ?? 3); const ONLY = process.env.ONLY?.split(',');
  for (const c of CONDS) { if (ONLY && !ONLY.includes(c.key)) continue; for (let rep = 0; rep < REPN; rep++) for (const clip of clips) {
    const k = `${c.key}|${clip.clip}|${rep}`; if (done.has(k)) continue;
    if (Date.now() > deadline) { console.log(`BUDGET-STOP after ${n}`); process.exit(0); }
    let r = await call(c, clip); if (r.status !== 200) { await new Promise((s) => setTimeout(s, 3000)); r = await call(c, clip); }
    if (r.status >= 400 && r.status < 500) { if (++fails >= 3) { console.log(`ABORT: ${r.status} ${r.err}`); process.exit(2); } continue; } fails = 0;
    appendFileSync(RES, JSON.stringify({ cond: c.key, clip: clip.clip, rep, ...r }) + '\n'); n++;
    if (r.status !== 200) console.log(`${k} ${r.status} ${r.err}`);
  } console.log(`done ${c.key}`); }
  console.log(`ALL-DONE (${n})`);
}
