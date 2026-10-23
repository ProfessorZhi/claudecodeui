import { readFileSync } from 'node:fs';
import { normalizeNumerals } from '../../../voice-webm-asr-paired-quality/run.mjs';
import { CONDS } from './ds-bias.mts';
const rows = readFileSync('experiments/voice-omni-written/raw/qwen-audio-bias/results.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const refs: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference]));
const TRUE = ['voice.service.ts', 'voice.routes.ts', 'voice.module.ts', 'useVoiceInput'];
const norm = (s: string) => normalizeNumerals(s).toLowerCase().replace(/[\s\p{P}\p{S}…]/gu, '');
const lev = (a: string[], b: string[]) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return d[a.length][b.length]; };
const cer = (r: string, h: string) => lev([...norm(r)], [...norm(h)]) / [...norm(r)].length;
const byCond: Record<string, any[]> = {}; for (const r of rows) (byCond[r.cond] ??= []).push(r);
const modal = (rs: any[]) => { const c: Record<string, number> = {}; for (const r of rs) c[r.text] = (c[r.text] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; };
const noneModal: Record<string, string> = {}; for (const clip of Object.keys(refs)) noneModal[clip] = modal(byCond['none'].filter((r) => r.clip === clip));
console.log('cond'.padEnd(22), 'ok', 'idHit/18', 'CERnn', 'stable/8', 'diff-vs-none/8', 'falsePos', 'inflated', 'lat-med');
for (const c of CONDS) {
  const rs = byCond[c.key] ?? []; const ok = rs.filter((r) => r.status === 200);
  let id = 0, idN = 0, fp = 0, infl = 0, sc = 0; const fpEx: string[] = [];
  for (const r of ok) { const ref = refs[r.clip]; const low = r.text.toLowerCase();
    for (const t of TRUE) if (ref.includes(t)) { idN++; if (low.includes(t.toLowerCase())) id++; }
    const base = noneModal[r.clip].toLowerCase(); const inj = c.injected.filter((t) => t.length >= 4 && !ref.toLowerCase().includes(t.toLowerCase()) && !base.includes(t.toLowerCase()) && low.includes(t.toLowerCase()));
    if (inj.length) { fp++; if (fpEx.length < 3) fpEx.push(`${r.clip.slice(0,3)}:${inj.slice(0,3).join('|')}`); }
    if ([...norm(r.text)].length > 1.5 * [...norm(ref)].length) infl++;
    sc += cer(ref, r.text); }
  let stable = 0, diff = 0; for (const clip of Object.keys(refs)) { const t = new Set(rs.filter((r) => r.clip === clip).map((r) => r.text)); if (t.size === 1) stable++; if (modal(rs.filter((r) => r.clip === clip)) !== noneModal[clip]) diff++; }
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  console.log(c.key.padEnd(22), `${ok.length}/${rs.length}`, `${id}/${idN}`.padEnd(8), (sc / ok.length).toFixed(3), `${stable}/8`.padEnd(8), `${diff}/8`.padEnd(14), `${fp}${fpEx.length ? ' ' + fpEx.join(' ') : ''}`, infl, ms[Math.floor(ms.length / 2)]);
}
console.log('\n-- modal outputs for identifier clips d01-d04 (+d07,d08)');
for (const clip of ['d01-o65.wav', 'd02-o65.wav', 'd03-o65.wav', 'd04-o65.wav']) { console.log(`${clip} ref: ${refs[clip]}`); for (const c of CONDS) { const rs = byCond[c.key].filter((r) => r.clip === clip); const texts = [...new Set(rs.map((r) => r.text))]; console.log(`   ${c.key.padEnd(22)} ${texts.length > 1 ? `[${texts.length} variants] ` : ''}${modal(rs)}`); } }
const errs = rows.filter((r) => r.status !== 200); console.log('\nerrors:', errs.length, errs.slice(0, 3).map((r) => `${r.cond} ${r.status} ${r.err}`));
