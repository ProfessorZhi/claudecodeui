import { readFileSync } from 'node:fs';
import { normalizeNumerals } from '../../voice-webm-asr-paired-quality/run.mjs';
import { CONDS, instructionOf } from './written.mts';
const rows = readFileSync(new URL('./written-ds.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const low = (s: string) => normalizeNumerals(s).toLowerCase();
const has = (t: string, re: RegExp) => re.test(t);
// Rubric = the manual judgments of the previous round, written down. ❌ = would mislead an agent; ✅ = intent fully right; ◐ = recoverable.
const RENAME = /(改成|改为|修改为|替换为|重命名|更正为|路径从)/;
const CODEBLOCK = /```/;
export function judge(clip: string, ins: string): [string, string] {
  const t = low(ins);
  if (CODEBLOCK.test(ins)) return ['❌', 'code block'];
  switch (clip) {
    case 'd01-o65.wav':
      if (/voice\/se\//.test(t)) return ['❌', 'invented path'];
      if (!/server/.test(t) || !/30/.test(t)) return ['❌', 'fact lost'];
      if (/voice\.service/.test(t)) return ['✅', 'service'];
      if (/`?voice\.ts`?/.test(t) && !/voice\.se/.test(t)) return ['❌', 'collapsed to voice.ts'];
      if (/voice\.ts`?\s*中/.test(t)) return ['❌', 'invented symbol'];
      return ['◐', 'garbled name'];
    case 'd02-o65.wav':
      if (RENAME.test(ins)) return ['❌', 'rename invented'];
      if (/和/.test(ins) && /use\.?ts/.test(t)) return ['❌', 'two targets'];
      if (/usevoicero/.test(t)) return ['❌', 'invented name'];
      if (/voice\.routes\b/.test(t) && !/不对|嗯/.test(ins)) return ['✅', 'routes'];
      return ['◐', 'garbled target'];
    case 'd03-o65.wav':
      return /usevoiceinput/.test(t) && /hook/.test(t) && /record/.test(t) ? ['✅', ''] : ['◐', 'id or word garbled'];
    case 'd04-o65.wav':
      if (!/(不要|别|勿)/.test(ins)) return ['❌', 'negation lost'];
      if (/voice\.service\.ts/.test(t) && /voice\.module\.ts/.test(t)) return ['✅', 'both'];
      if (/voice\.module\.ts|voicemodule\.ts/.test(t)) return ['◐', 'target ok, forbidden garbled'];
      return ['◐', 'target garbled'];
    case 'd05-o65.wav':
      return /15/.test(t) && /50/.test(t) ? ['✅', ''] : ['❌', 'numbers lost'];
    case 'd06-o65.wav':
      if (/嗯|那个/.test(ins)) return ['◐', 'fillers left'];
      return /composer/.test(t) && /按钮/.test(t) && /快捷键/.test(t) ? ['✅', ''] : ['❌', 'fact lost'];
    case 'd07-o65.wav':
      if (/code/.test(t) && !/call/.test(t)) return ['❌', 'call→code'];
      return /server/.test(t) && /voice/.test(t) && /call/.test(t) && /测试/.test(t) ? ['✅', ''] : ['◐', 'fact garbled'];
    case 'd08-o65.wav':
      if (/不是\s*`?whisper[\s-]?turbo/.test(t)) return ['❌', 'inverted'];
      if (/啊|不对/.test(ins)) return ['◐', 'correction not resolved'];
      return /turbo/.test(t) && !/large/.test(t) ? ['✅', ''] : ['◐', 'large kept'];
  }
  return ['?', ''];
}
if (process.argv[1]?.endsWith('judge.mts')) {
const keys = (process.env.CONDS ?? 'C-fewshot,E-twostep-low').split(',');
const summary: string[] = [];
for (const key of keys) {
  const c = CONDS.find((x) => x.key === key)!;
  const rs = rows.filter((r) => r.cond === key && r.status === 200);
  const tally = { '✅': 0, '◐': 0, '❌': 0 } as Record<string, number>; const perClip: Record<string, Record<string, number>> = {};
  const lines: string[] = [];
  for (const clip of [...new Set(rs.map((r) => r.clip))].sort()) {
    const cnt: Record<string, { n: number; v: string; why: string }> = {};
    for (const r of rs.filter((r) => r.clip === clip)) { const ins = instructionOf(c, r.text).instruction.replace(/\n/g, '⏎'); const [v, why] = judge(clip, ins); tally[v]++; (perClip[clip] ??= { '✅': 0, '◐': 0, '❌': 0 })[v]++; (cnt[ins] ??= { n: 0, v, why }).n++; }
    lines.push(`\n## ${clip}  ✅${perClip[clip]['✅']} ◐${perClip[clip]['◐']} ❌${perClip[clip]['❌']}`);
    for (const [ins, o] of Object.entries(cnt).sort((a, b) => b[1].n - a[1].n)) lines.push(`   ×${String(o.n).padEnd(2)} ${o.v} ${ins}${o.why ? `   [${o.why}]` : ''}`);
  }
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b); const p = (q: number) => ms[Math.floor(q * (ms.length - 1))];
  const parsed = c.json ? rs.filter((r) => instructionOf(c, r.text).parsed).length : null;
  summary.push(`${key.padEnd(14)} n=${rs.length} ✅${tally['✅']} ◐${tally['◐']} ❌${tally['❌']}  latency p50=${p(0.5)} p90=${p(0.9)} max=${ms.at(-1)}${parsed !== null ? `  json=${parsed}/${rs.length}` : ''}`);
  if (process.argv[2] === 'texts') console.log(`\n==================== ${key} ====================` + lines.join('\n'));
}
console.log('\n' + summary.join('\n'));
}
