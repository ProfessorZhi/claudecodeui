import { readFileSync } from 'node:fs';
import { normalizeNumerals } from '../../voice-webm-asr-paired-quality/run.mjs';
import { CONDS, TRUE, WRITTEN_REF } from './omni.mts';
const rows = readFileSync(new URL('./results.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const refs: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference]));
const norm = (s: string) => normalizeNumerals(s).toLowerCase().replace(/[\s\p{P}\p{S}…]/gu, '');
const lev = (a: string[], b: string[]) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return d[a.length][b.length]; };
const cer = (r: string, h: string) => lev([...norm(r)], [...norm(h)]) / [...norm(r)].length;
const by: Record<string, any[]> = {}; for (const r of rows) (by[r.cond] ??= []).push(r);
const modal = (rs: any[]) => { const c: Record<string, number> = {}; for (const r of rs) c[r.text] = (c[r.text] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''; };
const base: Record<string, string> = {}; for (const clip of Object.keys(refs)) base[clip] = modal(by['p1-none'].filter((r) => r.clip === clip)).toLowerCase();
console.log('cond'.padEnd(15), 'ok'.padEnd(6), 'id/18', 'CERnn', 'CERvsWritten', 'stable', 'trunc', 'infl', 'falsePos', 'lat-med', 'promptTok', 'cached', 'reasonTok');
for (const c of CONDS) {
  const rs = by[c.key] ?? []; const ok = rs.filter((r) => r.status === 200);
  let id = 0, idN = 0, fp = 0, tr = 0, inf = 0, s1 = 0, s2 = 0, pt = 0, ca = 0, rt = 0; const fpEx: string[] = [];
  for (const r of ok) { const ref = refs[r.clip]; const low = r.text.toLowerCase(); const tgt = c.written ? WRITTEN_REF[r.clip] : ref;
    for (const t of TRUE) if (ref.includes(t)) { idN++; if (low.includes(t.toLowerCase())) id++; }
    const inj = c.injected.filter((t) => t.length >= 6 && /[._A-Z-]/.test(t) && !ref.toLowerCase().includes(t.toLowerCase()) && !base[r.clip].includes(t.toLowerCase()) && low.includes(t.toLowerCase()));
    if (inj.length) { fp++; if (fpEx.length < 3) fpEx.push(`${r.clip.slice(0, 3)}:${inj.slice(0, 2).join('|')}`); }
    const L = [...norm(r.text)].length; if (L < 0.6 * [...norm(tgt)].length) tr++; if (L > 1.5 * [...norm(tgt)].length) inf++;
    s1 += cer(ref, r.text); s2 += cer(WRITTEN_REF[r.clip], r.text);
    pt += r.usage?.prompt_tokens ?? 0; ca += r.usage?.prompt_tokens_details?.cached_tokens ?? 0; rt += r.usage?.completion_tokens_details?.reasoning_tokens ?? 0; }
  let stable = 0; for (const clip of Object.keys(refs)) if (new Set(rs.filter((r) => r.clip === clip).map((r) => r.text)).size === 1) stable++;
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b); const n = ok.length || 1;
  console.log(c.key.padEnd(15), `${ok.length}/${rs.length}`.padEnd(6), `${id}/${idN}`.padEnd(5), (s1 / n).toFixed(3), (s2 / n).toFixed(3).padEnd(12), `${stable}/8`.padEnd(6), `${tr}`.padEnd(5), `${inf}`.padEnd(4), `${fp}${fpEx.length ? ' ' + fpEx.join(' ') : ''}`.padEnd(9), ms[Math.floor(ms.length / 2)], Math.round(pt / n), Math.round(ca / n), Math.round(rt / n));
}
if (process.argv[2] === 'texts') for (const clip of Object.keys(refs)) { console.log(`\n${clip} ref: ${refs[clip]}${WRITTEN_REF[clip] !== refs[clip] ? `  | written-ref: ${WRITTEN_REF[clip]}` : ''}`); for (const c of CONDS) { const rs = by[c.key].filter((r) => r.clip === clip); const v = new Set(rs.map((r) => r.text)).size; console.log(`   ${c.key.padEnd(15)} ${v > 1 ? `[${v}v] ` : ''}${modal(rs).replace(/\n/g, '⏎')}`); } }
