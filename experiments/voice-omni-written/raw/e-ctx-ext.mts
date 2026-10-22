/**
 * E 组 × 上下文，跑在**扩展集**（`n01`…`n05`）上。
 *
 * 与 `e-ctx.mts` 的唯一区别是语料：那个跑既有的 8 条 `d0X-o65`，这个跑 2026-09-24 新增的 5 条。
 * 臂、提示词、上下文构造、放置位置全部 import 自同一批模块——这是刻意的：扩展集要回答的问题是
 * 「换一批更长的、来自真实会话的语料，E 组与 E+上下文 的读数还成立吗」，那它就必须是同一台仪器
 * 换了试卷，而不是另一台仪器。
 *
 * 语料来源与生成配方见 `fixtures/ext-refs.json` 的 provenance 与 `raw/README.md`：脚本由本项目的
 * 真实会话消息改写成口语，音频按**未修版**配方生成（`trimChunks: false`），与盘上既有 80 条中文
 * 语料同声学域（实测语音占比 0.274–0.333，旧 8 条 0.206–0.331）。
 *
 * 运行（必须在仓库根，凭据从 .env.test 载入）：
 *   set -a; . ./.env.test; set +a
 *   REPS=10 npx tsx experiments/voice-omni-written/raw/e-ctx-ext.mts run
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { ARMS } from './e-ctx.mts';
import { CONDS } from './written.mts';

const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const RES = new URL('./e-ctx-ext.jsonl', import.meta.url);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const REFS_FILE = new URL('../fixtures/ext-refs.json', import.meta.url);

const refs = JSON.parse(readFileSync(REFS_FILE, 'utf8')) as { clips: { id: string; kind: string; text: string }[] };
export const CLIPS = refs.clips.map((c) => ({
  clip: c.id,
  ref: c.text,
  kind: c.kind,
  data: `data:audio/webm;base64,${readFileSync(new URL(`../fixtures/webm/${c.id}.webm`, import.meta.url)).toString('base64')}`,
}));

async function call(arm: (typeof ARMS)[number], clip: (typeof CLIPS)[number]) {
  const body = {
    model: 'qwen3.8-omni-flash', modalities: ['text'], reasoning_effort: E.effort, stream: false,
    messages: [
      { role: 'system', content: E.system },
      { role: 'user', content: [
        { type: 'input_audio', input_audio: { data: clip.data, format: 'webm' } },
        ...(arm.context ? [{ type: 'text', text: arm.context }] : []),
        { type: 'text', text: E.user },
      ] },
    ],
  };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 160)}`, usage: j?.usage ?? null, ctxChars: arm.context.length };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', err: e.name, usage: null, ctxChars: arm.context.length }; }
}

if (process.argv[2] === 'meta') {
  console.log(JSON.stringify({ clips: CLIPS.map((c) => [c.clip, c.kind, c.ref.length]), arms: ARMS.map((a) => a.key) }));
}
// Third time this guard has been needed in this directory, so it is worth naming the pattern:
// every runner here is ALSO an importable module (the next experiment reuses its clip list or its
// arm table), and an unguarded `argv[2] === 'run'` turns that import into a run. `omni.mts` had it
// from the start, `written.mts`, `e-ctx.mts` and now this file each had to be taught it — and each
// time the symptom was identical: the importing script's own output preceded by a full pass of the
// imported one's. The cost has been zero wasted calls every time only because the source run was
// already complete; that is luck, not safety.
if (process.argv[2] === 'run' && process.argv[1]?.endsWith('e-ctx-ext.mts')) {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.cond}|${r.clip}|${r.rep}`; }) : []);
  const deadline = Date.now() + Number(process.env.BUDGET_MS ?? 480000);
  const REPN = Number(process.env.REPS ?? 10); const ONLY = process.env.ONLY?.split(',');
  let n = 0, fails = 0;
  for (const arm of ARMS) { if (ONLY && !ONLY.includes(arm.key)) continue;
    for (let rep = 0; rep < REPN; rep++) for (const clip of CLIPS) {
      const k = `${arm.key}|${clip.clip}|${rep}`; if (done.has(k)) continue;
      if (Date.now() > deadline) { console.log(`BUDGET-STOP after ${n}`); process.exit(0); }
      let r = await call(arm, clip); if (r.status !== 200) { await new Promise((s) => setTimeout(s, 3000)); r = await call(arm, clip); }
      if (r.status >= 400 && r.status < 500) { console.log(`${k} ${r.status} ${r.err}`); if (++fails >= 3) { console.log(`ABORT: ${r.status} ${r.err}`); process.exit(2); } continue; } fails = 0;
      appendFileSync(RES, JSON.stringify({ cond: arm.key, clip: clip.clip, rep, ...r, at: new Date().toISOString() }) + '\n'); n++;
      if (r.status !== 200) console.log(`${k} ${r.status} ${r.err}`);
    } console.log(`done ${arm.key}`); }
  console.log(`ALL-DONE (${n} new)`);
}
