// A2 analysis, exactly per PREREG.md. `npx tsx experiments/voice-omni-written/a2/an.mts [cells]`
import { readFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../raw/written.mts';
import { judge } from '../raw/judge.mts';
import { judgeExt } from '../raw/judge-ext.mts';
import { stratumOf, idsOf, has, TARGETS } from './strata.mjs';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const EXCLUDE = (process.env.EXCLUDE ?? '').split(',').filter(Boolean); // sensitivity check only, not part of PREREG
const rows = readFileSync(new URL('./results.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !EXCLUDE.includes(r.cond));
const CTX: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync(new URL('../fixtures/a2-contexts.json', import.meta.url), 'utf8')).contexts.map((c: any) => [c.key, c.text]));
const REF: Record<string, string> = { ...Object.fromEntries(JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference])), ...Object.fromEntries(JSON.parse(readFileSync(new URL('../fixtures/ext-refs.json', import.meta.url), 'utf8')).clips.map((c: any) => [c.id, c.text])) };
const W = { targetOnly: 45.3, targetAndCompetitor: 6.7, competitorOnly: 4.0, neither: 44.0 } as Record<string, number>;
const ok = rows.filter((r) => r.status === 200);
const ins = (r: any) => instructionOf(E, r.text).instruction;
const verdict = (r: any) => (r.set === 'base' ? judge(r.clip, ins(r)) : judgeExt(r.clip, ins(r)))[0];
const noneOf = (clip: string) => ok.filter((r) => r.cond === 'none' && r.clip === clip);
const inRef = (clip: string, name: string) => new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(REF[clip]);
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : NaN);
const pct = (x: number) => (Number.isNaN(x) ? '—' : `${(100 * x).toFixed(1)}%`);

// per (context, clip) pair
type Pair = { ctx: string; clip: string; set: string; stratum: string; comps: string[]; calls: any[] };
const pairs: Pair[] = [];
for (const ctx of Object.keys(CTX)) for (const clip of [...new Set(ok.map((r) => r.clip))]) {
  const calls = ok.filter((r) => r.cond === ctx && r.clip === clip); if (!calls.length) continue;
  const s = stratumOf(CTX[ctx], clip);
  pairs.push({ ctx, clip, set: calls[0].set, stratum: s ? s.stratum : 'noId', comps: s ? s.competitors.filter((c: string) => !inRef(clip, c)) : [], calls });
}
// R1
const R1: Record<string, any> = {};
for (const set of ['base', 'ext']) {
  const res: Record<string, any> = {}; let wsum = 0, ev = 0;
  for (const s of ['targetOnly', 'targetAndCompetitor', 'competitorOnly', 'neither']) {
    const ps = pairs.filter((p) => p.set === set && p.stratum === s); if (!ps.length) continue;
    const ctxOk = rate(ps.flatMap((p) => p.calls.map((r) => verdict(r) === '✅')));
    const noneOk = rate(ps.flatMap((p) => noneOf(p.clip).map((r) => verdict(r) === '✅'))); // same clips, weighted by pair multiplicity
    res[s] = { pairs: ps.length, calls: ps.reduce((a, p) => a + p.calls.length, 0), ctxOk: pct(ctxOk), noneOk: pct(noneOk), delta: `${((ctxOk - noneOk) * 100).toFixed(1)}pp` };
    wsum += W[s]; ev += W[s] * (ctxOk - noneOk);
  }
  R1[set] = { strata: res, expectedDeltaPp: +((ev / wsum) * 100).toFixed(2), pass: ev / wsum > 0 };
}
// R2
const R2: Record<string, any> = {};
for (const s of ['targetOnly', 'targetAndCompetitor', 'competitorOnly']) {
  const ps = pairs.filter((p) => p.stratum === s && p.comps.length); if (!ps.length) { R2[s] = 'no competitor pairs'; continue; }
  const up = (r: any, comps: string[]) => comps.some((c) => has(ins(r), c));
  const ctxRate = rate(ps.flatMap((p) => p.calls.map((r) => up(r, p.comps))));
  const noneRate = rate(ps.flatMap((p) => noneOf(p.clip).map((r) => up(r, p.comps))));
  const ex = ps.flatMap((p) => p.calls.filter((r) => up(r, p.comps)).map((r) => `${p.ctx}/${p.clip.slice(0, 3)}: ${p.comps.filter((c) => has(ins(r), c)).join('|')}`));
  R2[s] = { pairs: ps.length, ctxRate: pct(ctxRate), noneRate: pct(noneRate), pass: ctxRate <= noneRate + 0.05, examples: [...new Set(ex)].slice(0, 6) };
}
// R3
let fab = 0, fabN = 0; const fabEx: string[] = [];
for (const p of pairs) {
  const ctxIds = [...idsOf(CTX[p.ctx], ['file', 'camel']).keys()];
  const noneTxt = noneOf(p.clip).map((r) => ins(r)).join('\n');
  for (const r of p.calls) { fabN++; const o = ins(r);
    const f = ctxIds.filter((id) => id.length >= 4 && has(o, id) && !inRef(p.clip, id) && !has(noneTxt, id));
    if (f.length) { fab++; if (fabEx.length < 12) fabEx.push(`${p.ctx}/${p.clip.slice(0, 3)}: ${f.slice(0, 3).join('|')}`); } }
}
// R4, R5
const lat = ok.filter((r) => r.cond !== 'none').map((r) => r.ms).sort((a, b) => a - b); const q = (x: number) => lat[Math.floor(x * (lat.length - 1))];
const noneLat = ok.filter((r) => r.cond === 'none').map((r) => r.ms).sort((a, b) => a - b);
const result = {
  R1, R2, R3: { fabricated: fab, calls: fabN, rate: pct(fab / fabN), pass: fab / fabN <= 0.02, examples: fabEx },
  R4: { ctxP50: q(0.5), ctxP90: q(0.9), ctxMax: lat.at(-1), noneP50: noneLat[Math.floor(0.5 * (noneLat.length - 1))], noneP90: noneLat[Math.floor(0.9 * (noneLat.length - 1))], pass: q(0.9) <= 15000 },
  R5: { ok: ok.length, total: rows.length, pass: ok.length / rows.length >= 0.95 },
};
console.log(JSON.stringify(result, null, 1));
// supplementary: harm on clips without identifiers, per-context ✅
const harm: Record<string, string> = {};
for (const clip of ['d05-o65.wav', 'd06-o65.wav', 'd07-o65.wav', 'd08-o65.wav', 'n03-o65', 'n05-o65']) harm[clip] = `none ${pct(rate(noneOf(clip).map((r) => verdict(r) === '✅')))} → ctx ${pct(rate(pairs.filter((p) => p.clip === clip).flatMap((p) => p.calls.map((r) => verdict(r) === '✅'))))}`;
console.log('\nno-identifier clips ✅ (none → context arms):', JSON.stringify(harm, null, 1));
if (process.argv[2] === 'cells') {
  console.log('\nper pair ✅/◐/❌ (context arm, n=5)  vs none (n=10)');
  for (const clip of Object.keys(TARGETS)) { const n = noneOf(clip).map(verdict); const cnt = (v: string[]) => `${v.filter((x) => x === '✅').length}/${v.filter((x) => x === '◐').length}/${v.filter((x) => x === '❌').length}`;
    console.log(`${clip.slice(0, 3)}  none ${cnt(n)}  ` + pairs.filter((p) => p.clip === clip).map((p) => `${p.ctx}[${p.stratum.replace('targetAndCompetitor', 'T+C').replace('targetOnly', 'T').replace('competitorOnly', 'C').replace('neither', '-')}] ${cnt(p.calls.map(verdict))}`).join('  ')); }
}
