// Dump for the human semantic audit: every distinct output per (clip), with the rule verdict and the flags.
import { readFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../raw/written.mts';
import { judge } from '../raw/judge.mts';
import { judgeExt } from '../raw/judge-ext.mts';
import { stratumOf, idsOf, has } from './strata.mjs';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const rows = readFileSync(new URL('./results.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200);
const CTX: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync(new URL('../fixtures/a2-contexts.json', import.meta.url), 'utf8')).contexts.map((c: any) => [c.key, c.text]));
const REF: Record<string, string> = { ...Object.fromEntries(JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference])), ...Object.fromEntries(JSON.parse(readFileSync(new URL('../fixtures/ext-refs.json', import.meta.url), 'utf8')).clips.map((c: any) => [c.id, c.text])) };
const ins = (r: any) => instructionOf(E, r.text).instruction.replace(/\n/g, '⏎');
const V = (r: any) => (r.set === 'base' ? judge(r.clip, ins(r)) : judgeExt(r.clip, ins(r)))[0];
const inRef = (clip: string, n: string) => new RegExp(`(?<![\\w])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(REF[clip]);
const clips = (process.argv[2] ?? '').split(',').filter(Boolean);
for (const clip of clips) {
  console.log(`\n## ${clip}  参考：${REF[clip]}`);
  const noneTxt = rows.filter((r) => r.cond === 'none' && r.clip === clip).map(ins).join('\n');
  const groups = new Map<string, { n: number; v: string; conds: Set<string>; flags: Set<string> }>();
  for (const r of rows.filter((r) => r.clip === clip)) {
    const t = ins(r); const flags = new Set<string>();
    if (r.cond !== 'none') {
      const s = stratumOf(CTX[r.cond], clip); if (s) flags.add(s.stratum.replace('targetAndCompetitor', 'T+C').replace('targetOnly', 'T').replace('competitorOnly', 'C').replace('neither', '-'));
      if (s && s.competitors.some((c: string) => !inRef(clip, c) && has(t, c))) flags.add('COMP');
      if ([...idsOf(CTX[r.cond], ['file', 'camel']).keys()].some((id) => id.length >= 4 && has(t, id) && !inRef(clip, id) && !has(noneTxt, id))) flags.add('FAB');
    }
    const g = groups.get(t) ?? { n: 0, v: V(r), conds: new Set(), flags: new Set() }; g.n++; g.conds.add(r.cond); flags.forEach((f) => g.flags.add(f)); groups.set(t, g);
  }
  for (const [t, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) console.log(`  ×${String(g.n).padEnd(2)} 规则${g.v} [${[...g.conds].join(',')}]${g.flags.size ? ' {' + [...g.flags].join(',') + '}' : ''}  ${t}`);
}
