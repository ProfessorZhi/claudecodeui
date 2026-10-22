// Human semantic audit of A2 (2026-09-24): the rule verdict, overridden where a human reading of every distinct
// output disagreed. Overrides are keyed by clip + a substring of the output, each with the reason read.
//   npx tsx experiments/voice-omni-written/a2/semantic.mts [leaks]
import { readFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../raw/written.mts';
import { judge } from '../raw/judge.mts';
import { judgeExt } from '../raw/judge-ext.mts';
import { stratumOf } from './strata.mjs';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const rows = readFileSync(new URL('./results.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200);
const CTX: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync(new URL('../fixtures/a2-contexts.json', import.meta.url), 'utf8')).contexts.map((c: any) => [c.key, c.text]));
const REF: Record<string, string> = { ...Object.fromEntries(JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference])), ...Object.fromEntries(JSON.parse(readFileSync(new URL('../fixtures/ext-refs.json', import.meta.url), 'utf8')).clips.map((c: any) => [c.id, c.text])) };
const ins = (r: any) => instructionOf(E, r.text).instruction;
const rule = (r: any) => (r.set === 'base' ? judge(r.clip, ins(r)) : judgeExt(r.clip, ins(r)))[0];

/** LEAK: the output carries text that did not come from the audio — the context echoed back, a JSON envelope that
 * swallowed the context, or the model continuing as the assistant. Every flagged output is printed by `leaks` and was
 * read by a human; the detector is only kept because that reading found no false positive. */
export function leak(clip: string, t: string) {
  if (/```|"transcript"\s*:/.test(t)) return 'json/fence';
  if (/Now the code|现在(处理|给出)代码|以下是相关|按以下方案|评审反馈如下|I'll look at/.test(t)) return 'assistant continuation';
  if (/GOAL-\d+/.test(t)) return 'second task invented';
  if (t.length > 2.5 * REF[clip].length + 40) return 'length';
  return null;
}
/** Per-output overrides from reading every distinct output. [clip, substring, semantic verdict, why] */
const OVERRIDES: [string, string, '✅' | '◐' | '❌', string][] = [
  ['d01-o65.wav', 'voice.routes.ts', '❌', 'names a different, real file as the target'],
  ['d01-o65.wav', 'voice.rouse.ts', '❌', 'points at routes, a different file'],
  ['d02-o65.wav', '修改 `voice.service.ts`', '❌', 'edits the file the speaker rejected'],
  ['d03-o65.wav', 'useScrollInput', '❌', 'a different hook'],
  ['d06-o65.wav', '语音输入按钮', '◐', 'button specified beyond what was said'],
  ['d06-o65.wav', '发送按钮', '◐', 'button specified beyond what was said'],
  ['d07-o65.wav', '`called`', '◐', 'call → called'],
  ['n02-o65', '如果没有则修复', '◐', 'fix added; speaker asked to check'],
  ['n04-o65', '不要区合成', '✅', 'typo of 区分; negation intact'],
  ['n04-o65', '不要再区分', '✅', 'negation intact'],
  ['n04-o65', '都算有效命中，别把它们拆开', '◐', 'what counts as valid is re-read'],
  ['n05-o65', '修复', '◐', 'fix added; speaker asked a question'],
];
export function semantic(r: any): [string, string] {
  const t = ins(r); const L = leak(r.clip, t);
  if (L) return ['❌', `leak: ${L}`];
  for (const [clip, sub, v, why] of OVERRIDES) if (r.clip === clip && t.includes(sub)) return [v, why];
  return [rule(r), 'rule'];
}
if (process.argv[1]?.endsWith('semantic.mts')) {
  if (process.argv[2] === 'leaks') { for (const r of rows) { const L = leak(r.clip, ins(r)); if (L) console.log(`${r.cond.padEnd(4)} ${r.clip.slice(0, 3)} rule${rule(r)} [${L}] ${ins(r).replace(/\n/g, '⏎').slice(0, 150)}`); } process.exit(0); }
  // agreement
  let agree = 0; const flips: Record<string, number> = {};
  for (const r of rows) { const a = rule(r), b = semantic(r)[0]; if (a === b) agree++; else flips[`${a}→${b}`] = (flips[`${a}→${b}`] ?? 0) + 1; }
  console.log(`rule vs human: agree ${agree}/${rows.length} = ${((100 * agree) / rows.length).toFixed(1)}%  flips ${JSON.stringify(flips)}`);
  // leaks by arm
  const la: Record<string, [number, number]> = {}; for (const r of rows) { const k = r.cond === 'none' ? 'none' : 'context'; la[k] ??= [0, 0]; la[k][1]++; if (leak(r.clip, ins(r))) la[k][0]++; }
  console.log('leak rate:', Object.entries(la).map(([k, [a, b]]) => `${k} ${a}/${b} = ${((100 * a) / b).toFixed(1)}%`).join('  '));
  // R1 recomputed with semantic verdicts, same weights and same pairing as an.mts
  const W: Record<string, number> = { targetOnly: 45.3, targetAndCompetitor: 6.7, competitorOnly: 4.0, neither: 44.0 };
  const rate = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;
  for (const judgeName of ['rule', 'semantic'] as const) {
    const J = (r: any) => (judgeName === 'rule' ? rule(r) : semantic(r)[0]);
    const line: string[] = [];
    for (const set of ['base', 'ext']) {
      let ev = 0, ws = 0; const parts: string[] = [];
      for (const s of Object.keys(W)) {
        const pairs = Object.keys(CTX).flatMap((ctx) => [...new Set(rows.filter((r) => r.set === set).map((r) => r.clip))].filter((clip) => stratumOf(CTX[ctx], clip)?.stratum === s).map((clip) => ({ ctx, clip })));
        if (!pairs.length) continue;
        const c = rate(pairs.flatMap((p) => rows.filter((r) => r.cond === p.ctx && r.clip === p.clip).map((r) => J(r) === '✅')));
        const n = rate(pairs.flatMap((p) => rows.filter((r) => r.cond === 'none' && r.clip === p.clip).map((r) => J(r) === '✅')));
        ev += W[s] * (c - n); ws += W[s]; parts.push(`${s} ${((c - n) * 100).toFixed(1)}pp`);
      }
      line.push(`${set}: expected ${((ev / ws) * 100).toFixed(1)}pp (${parts.join(', ')})`);
    }
    console.log(`R1 [${judgeName}] ${line.join(' | ')}`);
  }
  // overall ✅/❌ by arm, all 13 clips
  for (const judgeName of ['rule', 'semantic'] as const) {
    const J = (r: any) => (judgeName === 'rule' ? rule(r) : semantic(r)[0]);
    const s = (arr: any[]) => `✅ ${((100 * arr.filter((r) => J(r) === '✅').length) / arr.length).toFixed(1)}% ❌ ${((100 * arr.filter((r) => J(r) === '❌').length) / arr.length).toFixed(1)}%`;
    console.log(`all clips [${judgeName}]  none ${s(rows.filter((r) => r.cond === 'none'))}  |  context ${s(rows.filter((r) => r.cond !== 'none'))}`);
  }
}
