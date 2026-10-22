// S1 分析，按 PREREG.md 的 1–7 条。从仓库根运行：
//   npx tsx experiments/voice-draft/s1/an.mts            # 各臂判定表
//   npx tsx experiments/voice-draft/s1/an.mts texts D    # 某臂的全部不同输出（人读用）
// 基线 A = A2 的 none 臂 rep 0–4（文本阶段实际看到的那 5 次输入，配对）；另报 A10（全部 10 次）。
import { readFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { judge } from '../../voice-omni-written/raw/judge.mts';
import { judgeExt } from '../../voice-omni-written/raw/judge-ext.mts';
import { stratumOf, idsOf, has, TARGETS } from '../../voice-omni-written/a2/strata.mjs';

const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const lines = (u: URL) => readFileSync(u, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const a2 = lines(new URL('../../voice-omni-written/a2/results.jsonl', import.meta.url)).filter((r) => r.status === 200);
const s1 = lines(new URL('./results.jsonl', import.meta.url));
const CTX: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync(new URL('../../voice-omni-written/fixtures/a2-contexts.json', import.meta.url), 'utf8')).contexts.map((c: any) => [c.key, c.text]));
const REF: Record<string, string> = {
  ...Object.fromEntries(JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference])),
  ...Object.fromEntries(JSON.parse(readFileSync(new URL('../../voice-omni-written/fixtures/ext-refs.json', import.meta.url), 'utf8')).clips.map((c: any) => [c.id, c.text])),
};
const W: Record<string, number> = { targetOnly: 45.3, targetAndCompetitor: 6.7, competitorOnly: 4.0, neither: 44.0 };
const NOID = ['d05-o65.wav', 'd06-o65.wav', 'd07-o65.wav', 'd08-o65.wav', 'n03-o65', 'n05-o65'];
const ins = (r: any) => instructionOf(E, r.text).instruction;
const verdict = (r: any) => (r.set === 'base' ? judge(r.clip, ins(r)) : judgeExt(r.clip, ins(r)))[0];
const inRef = (clip: string, name: string) => new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(REF[clip]);
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : NaN);
const pct = (x: number) => (Number.isNaN(x) ? '—' : `${(100 * x).toFixed(1)}%`);
const pp = (x: number) => `${(x * 100).toFixed(1)}pp`;
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };

const noneAll = a2.filter((r) => r.cond === 'none');
const noneOf = (clip: string, reps5 = true) => noneAll.filter((r) => r.clip === clip && (!reps5 || r.rep < 5));

type Arm = { name: string; rows: any[]; ctxRows: boolean };
const ARMS: Arm[] = [
  { name: 'B (omni+ctx, A2)', rows: a2.filter((r) => r.cond !== 'none'), ctxRows: true },
  { name: 'C0 (text, no ctx)', rows: s1.filter((r) => r.arm === 'C0' && r.status === 200), ctxRows: false },
  { name: 'C (text rewrite)', rows: s1.filter((r) => r.arm === 'C' && r.status === 200), ctxRows: true },
  { name: 'D (text replacements)', rows: s1.filter((r) => r.arm === 'D' && r.status === 200), ctxRows: true },
];

function evaluate(arm: Arm, reps5 = true) {
  const rows = arm.rows.filter((r) => !reps5 || r.rep < 5);
  const total = (arm.name.startsWith('B') ? a2.length : s1.filter((r) => r.arm === arm.name.split(' ')[0]).length) || 1;
  const out: any = { arm: arm.name, calls: rows.length };
  if (arm.ctxRows) {
    const pairs: any[] = [];
    for (const ctx of Object.keys(CTX)) for (const clip of [...new Set(rows.map((r) => r.clip))]) {
      const calls = rows.filter((r) => r.cond === ctx && r.clip === clip); if (!calls.length) continue;
      const s = stratumOf(CTX[ctx], clip);
      const comps = s ? s.competitors.filter((c: string) => !inRef(clip, c)) : [];
      pairs.push({ ctx, clip, set: calls[0].set, stratum: s ? s.stratum : 'noId', comps, calls });
    }
    // R1 + R4(stratum)
    const R1: any = {}; const strata: any = {};
    for (const set of ['base', 'ext']) {
      let wsum = 0, ev = 0; strata[set] = {};
      for (const s of Object.keys(W)) {
        const ps = pairs.filter((p) => p.set === set && p.stratum === s); if (!ps.length) continue;
        const a = rate(ps.flatMap((p) => p.calls.map((r: any) => verdict(r) === '✅')));
        const b = rate(ps.flatMap((p) => noneOf(p.clip).map((r) => verdict(r) === '✅')));
        strata[set][s] = { pairs: ps.length, arm: pct(a), A: pct(b), delta: pp(a - b) }; wsum += W[s]; ev += W[s] * (a - b);
      }
      R1[set] = { expectedDelta: pp(ev / wsum), pass: ev / wsum > 0, strata: strata[set] };
    }
    out.R1 = R1;
    // R2
    const R2: any = {};
    for (const s of ['targetOnly', 'targetAndCompetitor', 'competitorOnly']) {
      const ps = pairs.filter((p) => p.stratum === s && p.comps.length); if (!ps.length) { R2[s] = 'n/a'; continue; }
      const up = (r: any, comps: string[]) => comps.some((c) => has(ins(r), c));
      const a = rate(ps.flatMap((p) => p.calls.map((r: any) => up(r, p.comps)))); const b = rate(ps.flatMap((p) => noneOf(p.clip).map((r) => up(r, p.comps))));
      R2[s] = { pairs: ps.length, arm: pct(a), A: pct(b), pass: a <= b + 0.05 };
    }
    out.R2 = R2;
    // R3
    let fab = 0, n = 0; const ex: string[] = [];
    for (const p of pairs) { const ids = [...idsOf(CTX[p.ctx], ['file', 'camel']).keys()]; const noneTxt = noneOf(p.clip, false).map(ins).join('\n');
      for (const r of p.calls) { n++; const o = ins(r); const f = ids.filter((id) => id.length >= 4 && has(o, id) && !inRef(p.clip, id) && !has(noneTxt, id)); if (f.length) { fab++; if (ex.length < 8) ex.push(`${p.ctx}/${p.clip.slice(0, 3)}: ${f.slice(0, 3).join('|')}`); } } }
    out.R3 = { fabricated: fab, calls: n, rate: pct(fab / n), pass: fab / n <= 0.02, examples: ex };
    // R4 (T+C stratum, both sets together)
    const tc = pairs.filter((p) => p.stratum === 'targetAndCompetitor');
    const tcA = rate(tc.flatMap((p) => p.calls.map((r: any) => verdict(r) === '✅'))); const tcB = rate(tc.flatMap((p) => noneOf(p.clip).map((r) => verdict(r) === '✅')));
    out.R4_TC = { pairs: tc.length, arm: pct(tcA), A: pct(tcB), delta: pp(tcA - tcB), pass: tcA >= tcB - 0.05 };
    // R5 no-id harm
    const noid = pairs.filter((p) => NOID.includes(p.clip));
    const nA = rate(noid.flatMap((p) => p.calls.map((r: any) => verdict(r) === '✅'))); const nB = rate(noid.flatMap((p) => noneOf(p.clip).map((r) => verdict(r) === '✅')));
    out.R5_noId = { pairs: noid.length, arm: pct(nA), A: pct(nB), delta: pp(nA - nB), pass: nA >= nB - 0.05 };
  } else {
    // C0: no context; compare ✅ rate to A on the same clips
    const clips = [...new Set(rows.map((r) => r.clip))];
    const a = rate(rows.map((r) => verdict(r) === '✅')); const b = rate(clips.flatMap((c) => noneOf(c).map((r) => verdict(r) === '✅')));
    out.C0 = { arm: pct(a), A: pct(b), delta: pp(a - b), exceedsThreePp: b - a > 0.03 };
  }
  const lat = rows.map((r) => r.ms).filter((x) => x);
  out.latency = { p50: q(lat, 0.5), p90: q(lat, 0.9), max: Math.max(...lat) };
  if (!arm.name.startsWith('B')) {
    const armKey = arm.name.split(' ')[0];
    const all = s1.filter((r) => r.arm === armKey);
    out.R6 = { status200: pct(all.filter((r) => r.status === 200).length / (all.length || 1)), parsed: pct(all.filter((r) => r.parsed).length / (all.length || 1)), n: all.length };
    if (armKey === 'D') { const rej: any = {}; let acc = 0; for (const r of all) { acc += (r.accepted ?? []).length; for (const x of r.rejected ?? []) rej[x.why] = (rej[x.why] ?? 0) + 1; } out.D_replacements = { accepted: acc, rejected: rej }; }
  }
  return out;
}

if (process.argv[2] === 'texts') {
  const key = process.argv[3] ?? 'D'; const rows = key === 'B' ? ARMS[0].rows : s1.filter((r) => r.arm === key && r.status === 200);
  for (const clip of [...new Set(rows.map((r) => r.clip))].sort()) {
    console.log(`\n## ${clip}  (A: ${noneOf(clip).map(verdict).join('')})`);
    const cnt: Record<string, { n: number; v: string; ctxs: Set<string> }> = {};
    for (const r of rows.filter((r) => r.clip === clip)) { const t = ins(r).replace(/\n/g, '⏎'); (cnt[t] ??= { n: 0, v: verdict(r), ctxs: new Set() }).n++; cnt[t].ctxs.add(r.cond); }
    for (const [t, o] of Object.entries(cnt).sort((a, b) => b[1].n - a[1].n)) console.log(`   ×${String(o.n).padEnd(3)} ${o.v} ${t}`);
  }
} else {
  const a10 = rate([...new Set(noneAll.map((r) => r.clip))].flatMap((c) => noneOf(c, false).map((r) => verdict(r) === '✅')));
  const a5 = rate([...new Set(noneAll.map((r) => r.clip))].flatMap((c) => noneOf(c).map((r) => verdict(r) === '✅')));
  console.log(`A: ✅ ${pct(a5)} (rep 0-4, paired)  ${pct(a10)} (all 10)\n`);
  for (const arm of ARMS) console.log(JSON.stringify(evaluate(arm), null, 1) + '\n');
}
