// S1 人读审计：列出每一处文本阶段改动（输入 → 输出）及规则判定的前后变化。npx tsx experiments/voice-draft/s1/audit-dump.mts [C|D]
import { readFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { judge } from '../../voice-omni-written/raw/judge.mts';
import { judgeExt } from '../../voice-omni-written/raw/judge-ext.mts';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const arm = process.argv[2] ?? 'D';
const rows = readFileSync(new URL('./results.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.arm === arm && r.status === 200);
const v = (r: any, t: string) => (r.set === 'base' ? judge(r.clip, t) : judgeExt(r.clip, t))[0];
const cnt: Record<string, { n: number; line: string }> = {};
let changed = 0;
for (const r of rows) { const out = instructionOf(E, r.text).instruction; if (out === r.input) continue; changed++;
  const k = `${r.clip.slice(0, 3)} ${v(r, r.input)}→${v(r, out)} | ${r.input.replace(/\n/g, '⏎')} ⟹ ${out.replace(/\n/g, '⏎').slice(0, 220)}`;
  (cnt[k] ??= { n: 0, line: k }).n++; }
console.log(`${arm}: ${changed}/${rows.length} outputs differ from input`);
for (const o of Object.values(cnt).sort((a, b) => b.n - a.n)) console.log(`×${o.n} ${o.line}`);
