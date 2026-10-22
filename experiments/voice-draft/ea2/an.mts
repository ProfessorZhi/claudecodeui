// E-A2 分析。  npx tsx experiments/voice-draft/ea2/an.mts [list]   （list：逐条打印被接受的替换，人读用，只在本地）
import { readFileSync, existsSync } from 'node:fs';
import { cases, LOCAL, TERM, applyReplacements, mechanical } from './common.mts';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const rd = (f: string): any[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const cs = cases(); const byId = Object.fromEntries(cs.map((c) => [c.id, c])); const asr = rd(`${LOCAL}/asr.jsonl`); const corr = rd(`${LOCAL}/correct.jsonl`);
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN); const pct = (x: number) => (Number.isNaN(x) ? '—' : `${(100 * x).toFixed(1)}%`);
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
const parse = (t: string) => { const m = t.match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };
const strip = (s: string) => s.replace(/`/g, '');
const tokens = (s: string) => new Set((s.match(/[A-Za-z][A-Za-z0-9_.\-]{2,}/g) ?? []).map((x) => x.toLowerCase()));
type Out = { arm: string; id: string; rep: number; base: string; out: string; accepted: any[]; parsed: boolean; ms?: number; ctx: string };
const outs: Out[] = [];
for (const c of cs) for (let rep = 0; rep < 3; rep++) {
  const r = asr.find((x) => x.id === c.id && x.rep === rep && x.status === 200); if (!r) continue; const p = instructionOf(E, r.text); const base = p.instruction;
  outs.push({ arm: 'N', id: c.id, rep, base, out: base, accepted: [], parsed: true, ctx: c.prev });
  const m = mechanical(base, c.prev); outs.push({ arm: 'M', id: c.id, rep, base, out: m.out, accepted: m.accepted, parsed: true, ctx: c.prev });
}
for (const r of corr) {
  const c = byId[r.id]; const a = asr.find((x) => x.id === r.id && x.rep === r.rep && x.status === 200); if (!a) continue; const base = instructionOf(E, a.text).instruction; const ctxFull = r.arm === 'W' ? byId[r.wrongId].prev : c.prev;
  const j = r.status === 200 ? parse(r.text) : null; const reps = Array.isArray(j?.replacements) ? j.replacements : null;
  // top3 的上下文是 prev 的子集；这里按完整 prev 重放校验会放宽 ③，故用记录下来的段落长度无法重建 → 重新计算段落
  let ctx = ctxFull; if (r.arm === 'D-top3') { const { topParagraphs } = await import('./common.mts'); const ps = instructionOf(E, a.text); ctx = topParagraphs(c.prev, `${ps.transcript ?? ''} ${ps.instruction}`); }
  const ap = reps ? applyReplacements(base, reps, ctx) : { out: base, accepted: [] as any[] };
  outs.push({ arm: r.arm, id: r.id, rep: r.rep, base, out: ap.out, accepted: ap.accepted, parsed: !!reps, ms: r.ms, ctx: ctxFull });
}
const arms = ['N', 'M', 'D-full', 'D-top3', 'W'];
function metrics(arm: string) {
  const os = outs.filter((o) => o.arm === arm); let inT = 0, inK = 0, outT = 0, outK = 0, regress = 0, allT = 0, wrongOut = 0, acc = 0, accOk = 0, accWrong = 0;
  for (const o of os) { const c = byId[o.id]; const O = strip(o.out).toLowerCase(); const B = strip(o.base).toLowerCase(); const reply = new Set(c.terms.map((t) => t.toLowerCase()));
    for (const t of c.terms) { const inPrev = c.inPrev.includes(t); const kept = O.includes(t.toLowerCase()); allT++; if (inPrev) { inT++; if (kept) inK++; } else { outT++; if (kept) outK++; } if (B.includes(t.toLowerCase()) && !kept) regress++; }
    const bt = tokens(o.base); const ctxl = o.ctx.toLowerCase(); let w = false; for (const t of tokens(o.out)) if (!bt.has(t) && ctxl.includes(t) && !reply.has(t)) w = true; if (w) wrongOut++;
    for (const a of o.accepted) { acc++; const to = a.to.toLowerCase(), from = a.from.toLowerCase(); if (reply.has(to) && !reply.has(from)) accOk++; else accWrong++; } }
  const ms = os.map((o) => o.ms).filter((x): x is number => !!x);
  return { arm, n: os.length, fin: inK / inT, fout: outK / outT, regress, regressPct: regress / allT, wrongOut: wrongOut / os.length, accepted: acc, per100: (100 * acc) / os.length, precision: acc ? accOk / acc : NaN, parsed: mean(os.map((o) => +o.parsed)), p50: q(ms, 0.5), p90: q(ms, 0.9), inT, outT };
}
if (process.argv[2] === 'list') {
  for (const arm of ['D-full', 'D-top3', 'W', 'M']) { console.log(`\n== ${arm} 被接受的替换`); for (const o of outs.filter((x) => x.arm === arm && x.accepted.length)) { const reply = new Set(byId[o.id].terms.map((t: string) => t.toLowerCase())); for (const a of o.accepted) console.log(`  ${o.id} r${o.rep}: ${a.from} → ${a.to}  ${reply.has(a.to.toLowerCase()) && !reply.has(a.from.toLowerCase()) ? '✓' : '✗'}`); } }
} else {
  console.log(`案例 ${cs.length}；识别 ${asr.filter((r) => r.status === 200).length}/${asr.length}；校正调用 ${corr.length}；术语（按重复）在上一轮 ${metrics('N').inT}，不在 ${metrics('N').outT}`);
  console.log('\n臂      n    fidelity_in  fidelity_out  回退(项/占比)  错换输出率  接受替换(每100)  替换精度  可解析   p50/p90 ms');
  for (const a of arms) { const m = metrics(a); console.log(`${a.padEnd(7)} ${String(m.n).padStart(3)}  ${pct(m.fin).padStart(9)}   ${pct(m.fout).padStart(9)}   ${String(m.regress).padStart(3)}/${pct(m.regressPct).padStart(5)}   ${pct(m.wrongOut).padStart(7)}   ${String(m.accepted).padStart(4)}(${m.per100.toFixed(1)})   ${pct(m.precision).padStart(7)}  ${pct(m.parsed).padStart(6)}   ${Number.isNaN(m.p50) ? '—' : m.p50 + '/' + m.p90}`); }
}
