/**
 * E 组 × 上下文：GOAL-009 缺的那一格。
 *
 * 为什么需要它：`written-ds.jsonl` 的六个臂（V/A/B/C/D/E）全部无上下文，`results.jsonl` 的
 * p3 上下文臂全部挂在 VERBATIM 单步提示词上。两个结论各自被测过，而它们的组合从未跑过——
 * 偏偏 E 组相对 C 组的全部净增（✅50 → ✅58）都来自含标识符的 d01/d02，机制正是「逐字转写把
 * 标识符逐字母拼出、改写阶段按读音合成完整名字」；上下文注入的作用面（供给名字）落在同一个
 * 环节上。所以这是一个必须实测、不能由两个单独读数外推的格子。
 *
 * 设计（与 p3 臂一一对应，便于与逐字臂的读数并排看）：
 *   · 提示词 = `written.mts` 的 `E-twostep-low`（system = ROLE+RULES+EXAMPLES，user = JSON_TASK，
 *     reasoning_effort = low）——直接取那个模块的常量，不在这里重写一遍。
 *   · 上下文 = `omni.mts` 的 CTX/GUARD 与同一批名单构造器（terms / haystack70 / full），
 *     同样不重写：两个实验的名单必须是同一份代码的产物。
 *   · 放置 = 独立的 `text` part，位于 JSON_TASK 之前。这是出货 multimodal 适配器渲染
 *     `hints.context` 的约定（`shared/asr/list/multimodal/multimodal.asr-provider.ts:214` 先推
 *     context part、`:222` 再推 prompt），所以这一格测的是「真按现有约定接上去会怎样」。
 *
 * 一条必须记住的不可比点：`full` 与 `hay` 是**导入时**由 `git ls-files` 现算的，仓库自
 * 2026-09-23 起长大了（当时 2387 个候选，今天 2425 个），所以这两臂的名单字节与 p3 那次不同；
 * 构造相同、内容漂移。`terms` 臂是字面量数组，与 p3 逐字节相同，是完全可比的那一臂。
 *
 * 运行（必须在仓库根，凭据从 .env.test 载入）：
 *   set -a; . ./.env.test; set +a
 *   REPS=10 npx tsx experiments/voice-omni-written/raw/e-ctx.mts run
 * 超时预算每次调用 9 分钟，到点打 BUDGET-STOP 退出，重跑即续（靠 jsonl 里的 cond|clip|rep 去重）。
 */
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { clips, TRUE, hay, full, CTX, GUARD } from './omni.mts';
import { CONDS } from './written.mts';

const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const RES = new URL('./e-ctx.jsonl', import.meta.url);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;

type Arm = { key: string; context: string; injected: string[] };
export const ARMS: Arm[] = [
  { key: 'e-none', context: '', injected: [] },
  { key: 'e-ctx-terms', context: CTX(TRUE), injected: TRUE },
  { key: 'e-ctx-haystack70', context: CTX(hay), injected: hay },
  { key: 'e-ctx-full', context: CTX(full), injected: full },
  { key: 'e-ctx-full-guard', context: CTX(full) + GUARD, injected: full },
];

async function call(arm: Arm, clip: { clip: string; data: string }) {
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
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 160)}`, usage: j?.usage ?? null, ctxChars: arm.context.length };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', err: e.name, usage: null, ctxChars: arm.context.length }; }
}

if (process.argv[2] === 'meta') {
  console.log(JSON.stringify({ arms: ARMS.map((a) => [a.key, a.ctxChars ?? a.context.length]), projCandidates: full.length, hay: hay.length, hayHasTrue: TRUE.every((t) => hay.includes(t)) }));
}
// The argv[1] guard, for the same reason `written.mts` needed one: `e-ctx-ext.mts` imports THIS
// module to reuse the arm table, and without the guard that import runs this whole loop first.
// It was missing here even though this file's own header complains about the identical defect
// elsewhere — which is the useful part of the incident: knowing the failure mode is not the same
// as having applied it.
if (process.argv[2] === 'run' && process.argv[1]?.endsWith('e-ctx.mts')) {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.cond}|${r.clip}|${r.rep}`; }) : []);
  const deadline = Date.now() + Number(process.env.BUDGET_MS ?? 540000);
  const REPN = Number(process.env.REPS ?? 10); const ONLY = process.env.ONLY?.split(',');
  let n = 0, fails = 0;
  for (const arm of ARMS) { if (ONLY && !ONLY.includes(arm.key)) continue;
    for (let rep = 0; rep < REPN; rep++) for (const clip of clips) {
      const k = `${arm.key}|${clip.clip}|${rep}`; if (done.has(k)) continue;
      if (Date.now() > deadline) { console.log(`BUDGET-STOP after ${n}`); process.exit(0); }
      let r = await call(arm, clip); if (r.status !== 200) { await new Promise((s) => setTimeout(s, 3000)); r = await call(arm, clip); }
      if (r.status >= 400 && r.status < 500) { console.log(`${k} ${r.status} ${r.err}`); if (++fails >= 3) { console.log(`ABORT: ${r.status} ${r.err}`); process.exit(2); } continue; } fails = 0;
      appendFileSync(RES, JSON.stringify({ cond: arm.key, clip: clip.clip, rep, ...r, at: new Date().toISOString() }) + '\n'); n++;
      if (r.status !== 200) console.log(`${k} ${r.status} ${r.err}`);
    } console.log(`done ${arm.key}`); }
  console.log(`ALL-DONE (${n} new)`);
}
