/**
 * E 组 × **真实会话历史**。
 *
 * 这一格此前没人跑过。仓库外的工装有一族做"前文作偏置"的实验（TEST 7 / 7b / 7c / 8），但它们
 * 都是 Groq + whisper 单步提示词；本仓的 p3 / e-ctx 一族注入的是**项目名列表**，一次对话历史都没有。
 * 两个族各自都指向"加了不如不加"，但没有一格是「E 组 + 真实会话文本」。
 *
 * 上下文（`fixtures/real-ctx.json`，逐字节冻结）：
 *   · 来源 = 本项目真实会话 78a2065f 里**一条真实的助手回复**（7748 字符），逐字取用，不裁剪改写。
 *   · 它含 `voice.service.ts`、`useVoiceInput`、`ChatComposer`、`blob`，**不含** `voice.routes.ts`、
 *     `resend`、`dev server`、`HMR`、`ds-bias` —— 即覆盖旧 8 条的标识符，不覆盖扩展集要的那些。
 *     这让两批片段对同一个上下文有**不同的可预期收益**，是刻意留下的判别力。
 *   · 形态 = 每条片段都用同一份（TEST 8 的约定）。逐片段取"本会话前文尾巴"在这里做不到：
 *     语料片段不是一个真实会话，硬拼出来的前文是虚构的。
 *   · 已查泄漏：与 8 条 paired 参考、5 条扩展参考逐一比对，无 12 字符归一化子串命中。
 *
 * 臂：`r-none`（同一轮内的基线）、`r-asst-1k` / `r-asst-8k`（同一条消息截到两个预算，隔离长度）、
 * `r-asst-8k-guard`（加护栏句——前两轮它都被证伪，这次在真实上下文上再测一次）。
 * 放置与 e-ctx 相同：独立的 `text` part，在 JSON_TASK 之前。
 *
 * 运行：set -a; . ./.env.test; set +a
 *       REPS=10 npx tsx experiments/voice-omni-written/raw/e-ctx-real.mts run
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { clips as baseClips } from './omni.mts';
import { CLIPS as extClips } from './e-ctx-ext.mts';
import { CONDS } from './written.mts';

const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const RES = new URL('./e-ctx-real.jsonl', import.meta.url);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const CTX = JSON.parse(readFileSync(new URL('../fixtures/real-ctx.json', import.meta.url), 'utf8')) as {
  strings: Record<string, { chars: number; text: string }>;
};

/** 旧 8 条（`d0X-o65`）+ 扩展 5 条（`n0X-o65`），两批各自的判据在分析侧分派。 */
export const CLIPS = [
  ...baseClips.map((c: { clip: string; ref: string; data: string }) => ({ clip: c.clip, data: c.data, set: 'base' as const })),
  ...extClips.map((c: { clip: string; data: string }) => ({ clip: c.clip, data: c.data, set: 'ext' as const })),
];

export const ARMS: { key: string; context: string; injected: string[] }[] = [
  { key: 'r-none', context: '', injected: [] },
  { key: 'r-asst-1k', context: CTX.strings['r-asst-1k'].text, injected: [] },
  { key: 'r-asst-8k', context: CTX.strings['r-asst-8k'].text, injected: [] },
  { key: 'r-asst-8k-guard', context: CTX.strings['r-asst-8k-guard'].text, injected: [] },
];

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
  console.log(JSON.stringify({ clips: CLIPS.map((c) => [c.clip, c.set]), arms: ARMS.map((a) => [a.key, a.context.length]) }));
}
if (process.argv[2] === 'run' && process.argv[1]?.endsWith('e-ctx-real.mts')) {
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
      appendFileSync(RES, JSON.stringify({ cond: arm.key, clip: clip.clip, set: clip.set, rep, ...r, at: new Date().toISOString() }) + '\n'); n++;
      if (r.status !== 200) console.log(`${k} ${r.status} ${r.err}`);
    } console.log(`done ${arm.key}`); }
  console.log(`ALL-DONE (${n} new)`);
}
