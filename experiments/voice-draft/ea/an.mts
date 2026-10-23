// E-A 分析（只打印聚合数字；`sample` 模式把盲评材料写到 /tmp，不入库）。
//   npx tsx experiments/voice-draft/ea/an.mts [sample]
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { cases, LOCAL, locate, overlap, units, squash, N } from './common.mts';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const rd = (f: string): any[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const cs = cases(); const byId = Object.fromEntries(cs.map((c) => [c.id, c])); const rows = rd(`${LOCAL}/anchor.jsonl`); const asr = rd(`${LOCAL}/asr.jsonl`);
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN); const pct = (x: number) => (Number.isNaN(x) ? '—' : `${(100 * x).toFixed(1)}%`);
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
const parse = (t: string) => { const m = t.match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };

type Res = { parsed: boolean; empty: boolean; valid: boolean; region: { start: number; end: number } | null; text: string; draft: string };
function resolve(r: any): Res {
  const c = byId[r.id]; const prev = r.arm.startsWith('W') ? byId[r.wrongId].prev : c.prev; const j = r.status === 200 ? parse(r.text) : null;
  if (!j) return { parsed: false, empty: true, valid: false, region: null, text: '', draft: '' };
  const draft = typeof j.draft === 'string' ? j.draft : '';
  if (r.arm.endsWith('-copy')) { const a = typeof j.anchor === 'string' ? j.anchor.trim() : ''; if (!a) return { parsed: true, empty: true, valid: true, region: null, text: '', draft }; const loc = locate(prev, a); return { parsed: true, empty: false, valid: !!loc, region: loc, text: a, draft }; }
  const ids: number[] = Array.isArray(j.anchor_ids) ? j.anchor_ids.filter((x: any) => Number.isInteger(x)) : []; if (!ids.length) return { parsed: true, empty: true, valid: true, region: null, text: '', draft };
  const U = units(prev); const sorted = [...new Set(ids)].sort((a, b) => a - b); const ok = sorted.length <= 5 && sorted.every((x, i) => i === 0 || x === sorted[i - 1] + 1) && sorted.every((x) => U.some((u) => u.id === x));
  if (!ok) return { parsed: true, empty: false, valid: false, region: null, text: '', draft };
  const a = U.find((u) => u.id === sorted[0])!, b = U.find((u) => u.id === sorted.at(-1))!; return { parsed: true, empty: false, valid: true, region: { start: a.start, end: b.end }, text: prev.slice(a.start, b.end), draft };
}
const grams = (s: string) => { const t = squash(s).out; const set = new Set<string>(); for (let i = 0; i + 14 <= t.length; i += 1) set.add(t.slice(i, i + 14)); return set; };
function contaminated(draft: string, prev: string, reply: string) { const P = grams(prev), R = grams(reply); for (const g of grams(draft)) if (P.has(g) && !R.has(g)) return true; return false; }
const TERM = /[A-Za-z_][\w.-]{2,}|\d+/g;
function termKeep(draft: string, reply: string) { const ts = [...new Set(reply.match(TERM) ?? [])]; if (!ts.length) return null; const d = draft.toLowerCase(); return ts.filter((t) => d.includes(t.toLowerCase())).length / ts.length; }

// B：词汇基线（字二元组 TF-IDF 余弦）
function lexical(prev: string, said: string) {
  const U = units(prev); const bi = (s: string) => { const t = squash(s).out; const m = new Map<string, number>(); for (let i = 0; i + 2 <= t.length; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1); return m; };
  const docs = U.map((u) => bi(u.text)); const df = new Map<string, number>(); for (const d of docs) for (const k of d.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const w = (m: Map<string, number>) => { const o = new Map<string, number>(); for (const [k, v] of m) o.set(k, v * Math.log(1 + U.length / (df.get(k) ?? 1))); return o; };
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((a, b) => a + b * b, 0)) || 1; const qv = w(bi(said)); const qn = norm(qv);
  let best = -1, bs = -1; docs.forEach((d, i) => { const dv = w(d); let dot = 0; for (const [k, v] of qv) dot += v * (dv.get(k) ?? 0); const s = dot / (qn * norm(dv)); if (s > bs) { bs = s; best = i; } });
  return best < 0 ? null : { start: U[best].start, end: U[best].end };
}
const asrSaid = (id: string, rep: number) => { const r = asr.find((x) => x.id === id && x.rep === rep && x.status === 200); if (!r) return ''; const p = instructionOf(E, r.text); return `${p.transcript ?? ''} ${p.instruction}`; };

if (process.argv[2] !== 'sample' && process.argv[2] !== 'sample2') {
  console.log(`案例 ${cs.length}；识别 ${asr.filter((r) => r.status === 200).length}/${asr.length} 成功；引用调用 ${rows.length}`);
  const bt = cs.map((c) => { const r = lexical(c.prev, c.reply); return r ? overlap(r, c.label) : { iou: 0, f1: 0, p: 0, r: 0 }; });
  const ba = cs.flatMap((c) => [0, 1, 2].map((rep) => { const r = lexical(c.prev, asrSaid(c.id, rep)); return r ? overlap(r, c.label) : { iou: 0, f1: 0, p: 0, r: 0 }; }));
  console.log(`\nB 词汇基线（打字回复）  命中 ${pct(mean(bt.map((x) => +(x.iou >= 0.5))))}  F1 ${pct(mean(bt.map((x) => x.f1)))}`);
  console.log(`B 词汇基线（识别结果）  命中 ${pct(mean(ba.map((x) => +(x.iou >= 0.5))))}  F1 ${pct(mean(ba.map((x) => x.f1)))}`);
  console.log('\n臂      n   可解析  逐字/有效  空引用  命中(IoU≥.5)  F1     污染   术语保真  p50/p90 ms');
  for (const arm of ['T-copy', 'T-ids', 'L-copy', 'L-ids', 'W-copy', 'W-ids']) {
    const rs = rows.filter((r) => r.arm === arm); if (!rs.length) continue; const res = rs.map(resolve); const isW = arm.startsWith('W');
    const hit = res.map((x, i) => { if (isW || !x.region) return 0; return overlap(x.region, byId[rs[i].id].label).iou >= 0.5 ? 1 : 0; }); const f1 = res.map((x, i) => (isW || !x.region ? 0 : overlap(x.region, byId[rs[i].id].label).f1));
    const cont = res.map((x, i) => (x.draft ? +contaminated(x.draft, isW ? byId[rs[i].wrongId].prev : byId[rs[i].id].prev, byId[rs[i].id].reply) : NaN)).filter((x) => !Number.isNaN(x)); const tk = res.map((x, i) => (x.draft ? termKeep(x.draft, byId[rs[i].id].reply) : null)).filter((x): x is number => x !== null);
    console.log(`${arm.padEnd(7)} ${String(rs.length).padStart(3)}  ${pct(mean(res.map((x) => +x.parsed))).padStart(6)}  ${pct(mean(res.filter((x) => !x.empty).map((x) => +x.valid))).padStart(7)}   ${pct(mean(res.map((x) => +x.empty))).padStart(6)}  ${isW ? '  —   ' : pct(mean(hit)).padStart(6)}      ${isW ? '  —  ' : pct(mean(f1)).padStart(6)}  ${pct(mean(cont)).padStart(6)} ${pct(mean(tk)).padStart(7)}    ${q(rs.map((r) => r.ms), 0.5)}/${q(rs.map((r) => r.ms), 0.9)}`);
  }
  console.log('\n（W 臂的「空引用」越高越好：错误上下文里没有正确的引用；非空引用 = 1 − 空引用。）');
  const byLen: Record<string, number[]> = {}; const L = rows.filter((r) => r.arm === 'L-ids'); for (const r of L) { const x = resolve(r); const c = byId[r.id]; const k = c.reply.length <= 15 ? '回复≤15字' : c.reply.length <= 45 ? '16–45字' : '>45字'; (byLen[k] ??= []).push(x.region ? +(overlap(x.region, c.label).iou >= 0.5) : 0); }
  console.log('L-ids 按回复长度分层命中:', Object.entries(byLen).map(([k, v]) => `${k} ${pct(mean(v))} (n=${v.length})`).join('  '));
} else if (process.argv[2] === 'sample2') {
  // 补充盲评：与第一批对调臂，使每个案例的 L-copy 与 L-ids 都被人读判过（第一批把两个臂分在不同的案例上，不可比）
  const pick: any[] = []; const take = (arm: string, ids: string[]) => { for (const id of ids) { const r = rows.find((x) => x.arm === arm && x.id === id && x.rep === 0); if (!r) continue; const x = resolve(r); const c = byId[id]; pick.push({ arm, id, reply: c.reply, prev: c.prev, anchor: x.text, draft: x.draft }); } };
  const ids = cs.map((c) => c.id); take('L-copy', ids.slice(0, 15)); take('L-ids', ids.slice(15, 30));
  let seed = 20261006; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
  pick.forEach((p, k) => (p.k = 100 + k)); writeFileSync('/tmp/ea-audit2-key.json', JSON.stringify(pick.map(({ k, arm, id }) => ({ k, arm, id })))); const blind = pick.map(({ k, reply, prev, anchor, draft }) => ({ k, reply, prev, system_anchor: anchor, system_draft: draft }));
  for (let i = 0; i < 3; i++) writeFileSync(`/tmp/ea-audit2-part${i}.json`, JSON.stringify(blind.slice(i * 10, (i + 1) * 10), null, 1)); console.log('wrote', pick.length);
} else {
  // 盲评材料：被测臂（L-ids / L-copy 各取 12 个案例，rep 0）+ W-ids 6 个；顺序打乱
  const pick: any[] = []; const take = (arm: string, ids: string[]) => { for (const id of ids) { const r = rows.find((x) => x.arm === arm && x.id === id && x.rep === 0); if (!r) continue; const x = resolve(r); const c = byId[id]; pick.push({ arm, id, reply: c.reply, prev: arm.startsWith('W') ? byId[r.wrongId].prev : c.prev, anchor: x.text, draft: x.draft }); } };
  const ids = cs.map((c) => c.id); take('L-ids', ids.slice(0, 15)); take('L-copy', ids.slice(15, 30)); take('W-ids', ids.filter((_, i) => i % 5 === 0));
  let seed = 20261004; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
  pick.forEach((p, k) => (p.k = k)); writeFileSync('/tmp/ea-audit-key.json', JSON.stringify(pick.map(({ k, arm, id }) => ({ k, arm, id })))); const blind = pick.map(({ k, reply, prev, anchor, draft }) => ({ k, reply, prev, system_anchor: anchor, system_draft: draft }));
  for (let i = 0; i < 3; i++) writeFileSync(`/tmp/ea-audit-part${i}.json`, JSON.stringify(blind.slice(i * Math.ceil(blind.length / 3), (i + 1) * Math.ceil(blind.length / 3)), null, 1)); console.log('wrote', pick.length);
}
