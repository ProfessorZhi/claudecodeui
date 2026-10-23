import { readFileSync } from 'node:fs';
import { normalizeNumerals } from '../../voice-webm-asr-paired-quality/run.mjs';
import { CONDS, instructionOf } from './written.mts';
const rows = readFileSync(new URL(process.env.GW === 'ds' ? './written-ds.jsonl' : './written.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const n = (s: string) => normalizeNumerals(s).toLowerCase().replace(/[\s`'"“”]/g, '');
const FACTS: Record<string, (t: string) => boolean> = {
  'd01-o65.wav': (t) => /server/.test(t) && /超时/.test(t) && /30/.test(t),
  'd02-o65.wav': (t) => /voice/.test(t) && !/不对|嗯/.test(t),
  'd03-o65.wav': (t) => /hook/.test(t) && /record/.test(t) && /voiceinput/.test(t),
  'd04-o65.wav': (t) => /(不要|别|勿)/.test(t) && /module/.test(t),
  'd05-o65.wav': (t) => /15/.test(t) && /50/.test(t),
  'd06-o65.wav': (t) => /composer/.test(t) && /按钮/.test(t) && /快捷键/.test(t),
  'd07-o65.wav': (t) => /server/.test(t) && /voice/.test(t) && /call/.test(t) && /测试/.test(t),
  'd08-o65.wav': (t) => /turbo/.test(t),
};
const TRUE = ['voice.service.ts', 'voice.routes.ts', 'voice.module.ts', 'useVoiceInput'];
const REFS: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference]));
console.log('cond'.padEnd(14), 'facts/24 fillers-left d02-fixed/3 d08-fixed/3 d08-inverted json-ok id/18 stable/8 lat-med');
const by: Record<string, any[]> = {}; for (const r of rows) (by[r.cond] ??= []).push(r);
for (const c of CONDS) {
  const rs = by[c.key] ?? []; let facts = 0, fill = 0, d02 = 0, d08 = 0, inv = 0, js = 0, id = 0, idN = 0;
  const out = rs.map((r) => ({ ...r, ins: instructionOf(c, r.text).instruction, parsed: instructionOf(c, r.text).parsed }));
  for (const r of out) { const t = n(r.ins); if (FACTS[r.clip](t)) facts++;
    if (['d02-o65.wav', 'd06-o65.wav', 'd08-o65.wav'].includes(r.clip) && /嗯|那个|就是|啊/.test(r.ins)) fill++;
    if (r.clip === 'd02-o65.wav' && !/不对|嗯/.test(r.ins) && !/se\b|service|\.se/.test(t.replace(/routes/g, ''))) d02++;
    if (r.clip === 'd08-o65.wav' && /turbo/.test(t) && !/不是whisperturbo|不是turbo|啊/.test(t)) d08++;
    if (r.clip === 'd08-o65.wav' && /不是whisperturbo|不是turbo/.test(t)) inv++;
    if (r.parsed) js++;
    for (const i of TRUE) if (REFS[r.clip].includes(i)) { idN++; if (r.ins.toLowerCase().includes(i.toLowerCase())) id++; } }
  let stable = 0; for (const clip of Object.keys(FACTS)) if (new Set(out.filter((r) => r.clip === clip).map((r) => r.ins)).size === 1) stable++;
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(c.key.padEnd(14), `${facts}/${rs.length}`.padEnd(8), `${fill}`.padEnd(12), `${d02}/3`.padEnd(11), `${d08}/3`.padEnd(11), `${inv}`.padEnd(12), c.json ? `${js}/${rs.length}` : '-'.padEnd(6), `${id}/${idN}`.padEnd(6), `${stable}/8`.padEnd(8), ms[Math.floor(ms.length / 2)]);
}
if (process.argv[2] === 'texts') for (const clip of Object.keys(FACTS)) { console.log(`\n## ${clip} 口述：${REFS[clip]}`);
  for (const c of CONDS) { const cnt: Record<string, number> = {}; for (const r of (by[c.key] ?? []).filter((r) => r.clip === clip)) { const s = instructionOf(c, r.text).instruction.replace(/\n/g, '⏎'); cnt[s] = (cnt[s] ?? 0) + 1; }
    for (const [s, k] of Object.entries(cnt).sort((a, b) => b[1] - a[1])) console.log(`  ${c.key.padEnd(14)} ×${k} ${s}`); } }
