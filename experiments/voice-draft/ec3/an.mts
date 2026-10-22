// E-C3 分析：重放代码流水线，计算机械指标；`sample` 生成盲评材料。  npx tsx experiments/voice-draft/ec3/an.mts [sample]
import { readFileSync, writeFileSync } from 'node:fs';
import { CHAINS } from '../ec/scripts.mts';
import { LOCAL, WRONG, readJsonl } from '../ec/common.mts';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { run, cleanItems, type Item } from './pipeline.mts';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!; const gold = JSON.parse(readFileSync(new URL('../ec2/gold.json', import.meta.url), 'utf8')); const SC = Object.fromEntries(CHAINS.map((c) => [c.id, c]));
const rows = readJsonl(`${LOCAL}/compose3.jsonl`); const asr = readJsonl(`${LOCAL}/asr.jsonl`); const ctx2 = JSON.parse(readFileSync(`${LOCAL}/contexts2.json`, 'utf8')) as Record<string, string>; const c2 = readJsonl(`${LOCAL}/compose2.jsonl`);
const parse = (t: string) => { const m = (t ?? '').match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };
const mean = (x: number[]) => { const v = x.filter((y) => !Number.isNaN(y)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; }; const f = (x: number) => (Number.isNaN(x) ? '—' : (100 * x).toFixed(1) + '%'); const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
const transcripts = (r: any) => { const t: Record<number, string> = {}; if (r.voice === 'gold') for (const u of SC[r.chain].units) t[u.n] = u.text; else for (const u of SC[r.chain].units) { const a = asr.find((x) => x.voice === r.voice && x.chain === r.chain && x.unit === u.n && x.rep === r.rep && x.status === 200); t[u.n] = a ? instructionOf(E, a.text).transcript ?? '' : ''; } return t; };
const ctxOf = (r: any) => (r.arm === 'S1' || r.arm === 'P1' ? ctx2[r.chain] : r.arm === 'W1' ? ctx2[WRONG[r.chain]] : ''); const useCtx = (r: any) => r.arm === 'S1' || r.arm === 'P1' || r.arm === 'W1';
export function processRow(r: any) {
  const T = transcripts(r);
  if (r.arm !== 'P1') { const raw = parse(r.calls[0].text); if (!raw) return null; return run(raw, T, ctxOf(r), useCtx(r)); }
  // P1：逐段合并各次调用的 items / replacements / anchors
  const merged = { items: [] as any[], replacements: [] as any[], anchors: [] as any[] }; let okAny = false; for (const c of r.calls) { const raw = parse(c.text); if (!raw) continue; okAny = true; merged.items.push(...(raw.items ?? [])); merged.replacements.push(...(raw.replacements ?? [])); merged.anchors.push(...(raw.anchors ?? [])); }
  return okAny ? run(merged, T, ctxOf(r), true) : null;
}
function typeAgree(items: Item[], chain: string, relaxed: boolean) { const g: Record<string, string[]> = gold.chains[chain]; const norm = (t: string) => (relaxed && (t === '探路' || t === '问题') ? '问题' : t); let ok = 0, tot = 0; for (const [u, types] of Object.entries(g)) for (const t of types) { tot++; if (items.some((it) => it.unit === Number(u) && norm(it.type) === norm(t))) ok++; } return ok / tot; }
const TERM = /[A-Za-z][A-Za-z0-9_.\-]{2,}|\d+/g;
function termStats(prompt: string, chain: string, ctx: string, T: Record<number, string>) { const truth = [...new Set(SC[chain].units.flatMap((u) => u.text.match(TERM) ?? []))].filter((t) => t.length >= 3 || /\d/.test(t)).map((t) => t.toLowerCase()); const P = prompt.toLowerCase(); const keptTruth = truth.filter((t) => P.includes(t)).length / (truth.length || 1);
  const tr = Object.values(T).join(' ').toLowerCase(); const cl = ctx.toLowerCase(); const wrong = [...new Set(prompt.match(TERM) ?? [])].map((t) => t.toLowerCase()).filter((t) => t.length >= 4 && !truth.includes(t) && !tr.includes(t) && cl.includes(t)).length > 0; return { keptTruth, wrong }; }
if (process.argv[2] !== 'sample') {
  console.log('臂   n   可解析  跨度有效  覆盖规则触发/份  类型严格  宽松   自问自答(EC1)  术语保真(提示)  错换输出率  接受替换/100  接受引用/100  调用/份  每次调用p50/p90 ms  提示字数');
  const out: Record<string, any> = {};
  for (const a of ['S0', 'S1', 'W1', 'P1', 'G0']) { const rs = rows.filter((r) => r.arm === a); const ps = rs.map((r) => ({ r, p: processRow(r) })); const ok = ps.filter((x) => x.p); const calls = rs.flatMap((r) => r.calls); const raws = rs.flatMap((r) => r.calls.map((c: any) => parse(c.text)).filter(Boolean)); const nItems = raws.reduce((s: number, x: any) => s + (x.items ?? []).length, 0);
    const sa = ok.filter((x) => x.r.chain === 'EC1').map((x) => { const q7 = x.p!.items.find((i) => i.unit === 7), ans = x.p!.items.find((i) => i.unit === 8); return q7 && ans ? +(q7.answeredBy === ans.id) : 0; });
    const ts = ok.map((x) => termStats(x.p!.prompt, x.r.chain, ctxOf(x.r), transcripts(x.r)));
    out[a] = { n: rs.length, strict: mean(ok.map((x) => typeAgree(x.p!.items, x.r.chain, false))) };
    console.log(`${a.padEnd(3)} ${String(rs.length).padStart(3)}  ${f(ok.length / rs.length).padStart(6)}  ${f(1 - ok.reduce((s, x) => s + x.p!.dropped, 0) / Math.max(1, nItems)).padStart(7)}   ${mean(ok.map((x) => x.p!.overridden)).toFixed(2).padStart(6)}      ${f(out[a].strict).padStart(7)}  ${f(mean(ok.map((x) => typeAgree(x.p!.items, x.r.chain, true)))).padStart(6)}  ${f(mean(sa)).padStart(8)}      ${f(mean(ts.map((t) => t.keptTruth))).padStart(8)}      ${f(mean(ts.map((t) => +t.wrong))).padStart(6)}     ${(100 * mean(ok.map((x) => x.p!.replacements.accepted.length))).toFixed(1).padStart(6)}      ${(100 * mean(ok.map((x) => x.p!.anchors.ok.length))).toFixed(1).padStart(6)}    ${mean(rs.map((r) => r.calls.length)).toFixed(1).padStart(4)}   ${q(calls.map((c: any) => c.ms), 0.5)}/${q(calls.map((c: any) => c.ms), 0.9)}      ${mean(ok.map((x) => x.p!.prompt.length)).toFixed(0)}`); }
  // 对照：E-C2 B 臂（自由生成）的同口径术语保真
  const b = c2.filter((r) => r.arm === 'B'); const bt = b.map((r) => { const o = parse(r.text); return o?.prompt ? termStats(o.prompt, r.chain, '', {}) : null; }).filter(Boolean) as any[]; console.log(`\n对照 E-C2 B（自由生成）: 术语保真(提示) ${f(mean(bt.map((t) => t.keptTruth)))}`);
  const rawT = rows.filter((r) => r.arm === 'S0').map((r) => { const T = transcripts(r); return termStats(Object.values(T).join('\n'), r.chain, '', T).keptTruth; }); console.log(`对照 原始逐字稿: 术语保真 ${f(mean(rawT))}`);
  console.log('\n被拒绝的替换原因（S1+P1+W1）:'); const why: Record<string, number> = {}; let acc = 0; for (const r of rows.filter((x) => ['S1', 'P1', 'W1'].includes(x.arm))) { const p = processRow(r); if (!p) continue; acc += p.replacements.accepted.length; for (const x of p.replacements.rejected) why[`${r.arm}:${x.why}`] = (why[`${r.arm}:${x.why}`] ?? 0) + 1; } console.log(' 接受', acc, JSON.stringify(why));
  console.log('\n按链（S0 严格类型一致 / 假设单元命中）:'); for (const id of Object.keys(gold.chains)) { const ps = rows.filter((r) => r.arm === 'S0' && r.chain === id).map(processRow).filter(Boolean) as any[]; console.log(`  ${id}: ${f(mean(ps.map((p) => typeAgree(p.items, id, false))))}`); }
} else {
  const pick: any[] = []; for (const c of CHAINS) { for (const voice of ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural']) for (const arm of ['S0', 'S1', 'W1', 'P1']) { const r = rows.find((x) => x.arm === arm && x.voice === voice && x.chain === c.id && x.rep === 0); const p = r ? processRow(r) : null; if (p && p.prompt) pick.push({ arm, voice, chain: c.id, p }); } const g = rows.find((x) => x.arm === 'G0' && x.chain === c.id && x.rep === 0); const gp = g ? processRow(g) : null; if (gp && gp.prompt) pick.push({ arm: 'G0', voice: 'gold', chain: c.id, p: gp }); }
  let seed = 20261010; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; } pick.forEach((p, k) => (p.k = k));
  writeFileSync('/tmp/ec3-audit-key.json', JSON.stringify(pick.map(({ k, arm, voice, chain }) => ({ k, arm, voice, chain }))));
  const ofType = (chain: string, t: string) => Object.entries(gold.chains[chain] as Record<string, string[]>).filter(([, ts]) => ts.includes(t)).map(([u]) => Number(u));
  const blind = pick.map((p) => ({ k: p.k, chain: p.chain, spoken_units: SC[p.chain].units.map((u) => `[段${u.n}] ${u.text}`), gold_types: Object.fromEntries(Object.entries(gold.chains[p.chain] as Record<string, string[]>).map(([u, t]) => [`段${u}`, t])), hyp_units: ofType(p.chain, '假设'), ask_units: ofType(p.chain, '问题'), fact_units: ofType(p.chain, '事实'), dc_units: [...ofType(p.chain, '决定'), ...ofType(p.chain, '约束')], reask_units: p.chain === 'EC1' ? [7] : p.chain === 'EC6' ? [2, 4, 6] : [], system_output: { prompt: p.p.prompt } }));
  const per = Math.ceil(blind.length / 4); for (let i = 0; i < 4; i++) writeFileSync(`/tmp/ec3-audit-part${i}.json`, JSON.stringify(blind.slice(i * per, (i + 1) * per), null, 1)); console.log('wrote', blind.length, '每份', per);
}
