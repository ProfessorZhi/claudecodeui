import { readFileSync } from 'node:fs';
import { CONDS, instructionOf } from './written.mts';
import { judge } from './judge.mts';
const rows = readFileSync(new URL('./written-ds.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const refs = Object.fromEntries(JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference]));
const C = CONDS.find((c) => c.key === 'C-fewshot')!, E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
for (const clip of Object.keys(refs)) {
  console.log(`\n**${clip.slice(0, 3)}** 口述：${refs[clip]}\n`);
  console.log('| # | C 输出 | 判 | E 输出（instruction） | 判 | E 的逐字转写（transcript） | E 耗时 |');
  console.log('|---|---|---|---|---|---|---|');
  for (let rep = 0; rep < 10; rep++) {
    const c = rows.find((r) => r.cond === 'C-fewshot' && r.clip === clip && r.rep === rep);
    const e = rows.find((r) => r.cond === 'E-twostep-low' && r.clip === clip && r.rep === rep);
    const ci = instructionOf(C, c.text).instruction, eo = instructionOf(E, e.text);
    console.log(`| ${rep + 1} | ${esc(ci)} | ${judge(clip, ci)[0]} | ${esc(eo.instruction)} | ${judge(clip, eo.instruction)[0]} | ${esc(eo.transcript ?? '')} | ${(e.ms / 1000).toFixed(1)}s |`);
  }
}
